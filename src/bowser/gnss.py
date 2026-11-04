"""GNSS stations and daily positions from the Nevada Geodetic Laboratory (UNR).

UNR sends no CORS header, so the page reads them through the server. Velocities are
MIDAS, North America fixed; positions are the NA-fixed IGS20 ``.tenv3`` files. Ported
from the OPERA DISP portal (scripts/build_gnss_snapshot.py, api/gnss.py).
"""

from __future__ import annotations

import re
import threading
import time
import urllib.request
from collections import OrderedDict
from datetime import UTC, datetime

MIDAS_URL = "https://geodesy.unr.edu/velocities/midas.NA.txt"
SERIES_URL = "https://geodesy.unr.edu/gps_timeseries/IGS20/tenv3/NA/{station}.NA.tenv3"
STATION_PAGE = "https://geodesy.unr.edu/NGLStationPages/stations/{station}.sta"
STEPS_URL = "https://geodesy.unr.edu/NGLStationPages/steps.txt"
MONUMENTS_URL = "https://geodesy.unr.edu/monuments/MonumentTable.txt"
MONUMENT_FIELDS = (
    "monument",
    "monument_height_m",
    "foundation",
    "foundation_depth_m",
    "geology",
)
STATION_ID = re.compile(r"^[A-Z0-9]{4}$")
#: Stations with a shorter record have no reliable MIDAS velocity.
MIN_YEARS = 3.0
MIDAS_MAX_AGE_S = 86400.0
#: The steps file (7 MB) and monument table (2 MB) are read once a day too.
TABLE_MAX_AGE_S = 86400.0
SERIES_CACHE_SIZE = 32

_lock = threading.Lock()
_midas: dict = {"at": 0.0, "rows": []}
_series: OrderedDict[str, dict] = OrderedDict()
_steps: dict = {"at": 0.0, "by_station": {}}
_monuments: dict = {"at": 0.0, "by_station": {}}


def fetch_text(url: str, timeout: float = 90) -> str:
    """GET a UNR file as text.

    Uses certifi's CA bundle when installed, as /wms_capabilities does.
    """
    import ssl  # noqa: PLC0415

    try:
        import certifi  # noqa: PLC0415

        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    with urllib.request.urlopen(url, timeout=timeout, context=ctx) as r:  # noqa: S310
        return r.read().decode()


def parse_midas(text: str) -> list[dict]:
    """Parse the stations with at least MIN_YEARS of data.

    Each has id, lon, lat, first/last year and velocities in mm/yr.
    """
    rows = []
    for line in text.splitlines():
        f = line.split()
        try:
            if len(f) < 27 or float(f[4]) < MIN_YEARS:
                continue
            lat, lon = float(f[24]), float(f[25])
            ve, vn, vu, su = (round(float(f[i]) * 1000, 2) for i in (8, 9, 10, 13))
            first, last = round(float(f[2]), 2), round(float(f[3]), 2)
        except ValueError:
            continue
        lon = lon - 360 if lon > 180 else lon
        rows.append(
            {
                "id": f[0],
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "first": first,
                "last": last,
                "ve_mm_yr": ve,
                "vn_mm_yr": vn,
                "vu_mm_yr": vu,
                "sigma_vu_mm_yr": su,
            }
        )
    return rows


def stations_in(
    rows: list[dict],
    west: float,
    south: float,
    east: float,
    north: float,
    limit: int = 300,
) -> list[dict]:
    """Stations inside a lon/lat box, nearest its centre first, at most ``limit``."""
    cx, cy = (west + east) / 2, (south + north) / 2
    inside = [
        r for r in rows if west <= r["lon"] <= east and south <= r["lat"] <= north
    ]
    inside.sort(key=lambda r: (r["lon"] - cx) ** 2 + (r["lat"] - cy) ** 2)
    return inside[:limit]


def midas_rows() -> list[dict]:
    """UNR's MIDAS table, read once a day."""
    with _lock:
        if _midas["rows"] and time.time() - _midas["at"] < MIDAS_MAX_AGE_S:
            return _midas["rows"]
    rows = parse_midas(fetch_text(MIDAS_URL, timeout=120))
    with _lock:
        _midas.update(at=time.time(), rows=rows)
    return rows


def _yymmmdd(text: str) -> str:
    """UNR's '05NOV17' -> '2005-11-17'."""
    return (
        datetime.strptime(text.title(), "%y%b%d").replace(tzinfo=UTC).date().isoformat()
    )


def parse_tenv3(text: str) -> dict:
    """Dates and east, north, up in mm from the first day, from a .tenv3 file."""
    dates: list[str] = []
    enu: list[tuple[float, float, float]] = []
    for line in text.splitlines()[1:]:
        f = line.split()
        if len(f) < 17:
            continue
        try:
            enu.append(
                (
                    float(f[7]) + float(f[8]),
                    float(f[9]) + float(f[10]),
                    float(f[11]) + float(f[12]),
                )
            )
            dates.append(_yymmmdd(f[1]))
        except ValueError:
            continue
    if not enu:
        return {"dates": [], "east_mm": [], "north_mm": [], "up_mm": []}
    e0, n0, u0 = enu[0]
    return {
        "dates": dates,
        "east_mm": [round((e - e0) * 1000, 2) for e, _, _ in enu],
        "north_mm": [round((n - n0) * 1000, 2) for _, n, _ in enu],
        "up_mm": [round((u - u0) * 1000, 2) for _, _, u in enu],
    }


def parse_steps(text: str) -> dict[str, list[dict]]:
    """Parse UNR's steps file by station.

    Steps are equipment changes (type 1) and nearby earthquakes (type 2).
    """
    out: dict[str, list[dict]] = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) < 4:
            continue
        try:
            date = _yymmmdd(f[1])
        except ValueError:
            continue
        if f[2] == "1":
            step = {
                "date": date,
                "kind": "equipment",
                "detail": " ".join(f[3:]).replace("_", " "),
            }
        elif f[2] == "2" and len(f) >= 7:
            step = {
                "date": date,
                "kind": "earthquake",
                "detail": f"M{f[5]}, {float(f[4]):.0f} km away",
                "event": f[6],
            }
        else:
            continue
        out.setdefault(f[0], []).append(step)
    return out


def parse_monuments(text: str) -> dict[str, dict[str, str | None]]:
    """Parse UNR's monument table by station.

    Columns are fixed-width (a description can hold a colon), read from its header.
    """
    lines = text.splitlines()
    if not lines:
        return {}
    bars = [i for i, ch in enumerate(lines[0]) if ch == ":"]
    if len(bars) != len(MONUMENT_FIELDS):
        raise ValueError(f"unexpected monument table header: {lines[0][:80]!r}")
    out: dict[str, dict[str, str | None]] = {}
    for line in lines[1:]:
        if not line.strip() or line.startswith("="):
            continue
        site = line[: bars[0]].strip()
        if not site:
            continue
        cells = [
            line[a + 1 : b].strip()
            for a, b in zip(bars, [*bars[1:], len(line)], strict=True)
        ]
        out[site] = {
            k: (None if v.upper() in ("", "UNKNOWN") else v)
            for k, v in zip(MONUMENT_FIELDS, cells, strict=True)
        }
    return out


def _daily_table(cache: dict, url: str, parse) -> dict:
    with _lock:
        if cache["by_station"] and time.time() - cache["at"] < TABLE_MAX_AGE_S:
            return cache["by_station"]
    by_station = parse(fetch_text(url, timeout=120))
    with _lock:
        cache.update(at=time.time(), by_station=by_station)
    return by_station


def station_extras(station: str, first: str, last: str) -> dict:
    """Return steps within the record and how the station is built.

    Each is left out if UNR can't be read.
    """
    out: dict = {"steps": [], "monument": None}
    try:
        steps = _daily_table(_steps, STEPS_URL, parse_steps).get(station, [])
        out["steps"] = [s for s in steps if first <= s["date"] <= last]
    except Exception:  # noqa: BLE001  the positions are still good without them
        pass
    try:
        out["monument"] = _daily_table(_monuments, MONUMENTS_URL, parse_monuments).get(
            station
        )
    except Exception:  # noqa: BLE001
        pass
    return out


def station_series(station: str) -> dict:
    """Return a station's daily positions (cached), with its page link.

    Raises ValueError for a bad id.
    """
    station = station.strip().upper()
    if not STATION_ID.fullmatch(station):
        raise ValueError(
            f"{station!r} is not a UNR station id (four letters or digits)"
        )
    with _lock:
        if station in _series:
            _series.move_to_end(station)
            return _series[station]
    out = {
        "station": station,
        "frame": "North America fixed (NA, IGS20)",
        "station_page": STATION_PAGE.format(station=station),
        **parse_tenv3(fetch_text(SERIES_URL.format(station=station))),
    }
    if out["dates"]:
        out.update(station_extras(station, out["dates"][0], out["dates"][-1]))
    with _lock:
        _series[station] = out
        while len(_series) > SERIES_CACHE_SIZE:
            _series.popitem(last=False)
    return out
