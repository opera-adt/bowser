"""Read a user's own GNSS station time series from a CSV (or similar) text file.

Liberal in what it accepts (see docs/gnss.md for the format, with examples):

- delimited text: comma, semicolon, tab or whitespace, with a header row naming
  the columns; without a header, the columns are date, east, north, up and
  optionally the east, north and up sigmas;
- dates as ISO dates (``2021-03-04``, with or without a time; ``2021/03/04``),
  ``YYYYMMDD``, decimal years (``2021.1712``), Modified Julian Days (``59277``)
  or UNR's ``21MAR04``;
- east, north and up displacements (or positions: only changes are used) in
  metres, millimetres or centimetres, from the header (``east (mm)``,
  ``up_m``), a ``# units: mm`` line, or the caller; else guessed from the size
  of the values (and said so);
- optional sigmas, and the station's name, longitude and latitude as columns or
  as metadata lines before the data (``# station: ABCD``, ``# lon: -118.2``,
  ``# lat: 34.1``); several stations in one file when it has a station column;
- EarthScope (UNAVCO) position CSVs (``4-character ID:``, ``Reference position
  : 36.0 North Latitude, -119.0 East Longitude``) and NGL ``.tenv3`` files.

Rows that cannot be read (no date, a value that is not a number) are skipped and
counted; a file with fewer than two usable rows is refused with a message saying
why. Pure Python: bowser-lite reads these files too.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, NamedTuple

#: Bytes a file may have (about 30 years of daily rows is 2-3 MB).
MAX_BYTES = 50 * 1024 * 1024
#: Years a date must fall in to be taken as a date.
YEARS = (1980, 2100)
COMPONENTS = ("east", "north", "up")
#: Millimetres per unit.
UNIT_MM = {"m": 1000.0, "cm": 10.0, "mm": 1.0}
_UNIT_WORDS = {
    "m": "m",
    "meter": "m",
    "meters": "m",
    "metre": "m",
    "metres": "m",
    "cm": "cm",
    "centimeter": "cm",
    "centimeters": "cm",
    "centimetre": "cm",
    "centimetres": "cm",
    "mm": "mm",
    "millimeter": "mm",
    "millimeters": "mm",
    "millimetre": "mm",
    "millimetres": "mm",
}
_MJD0 = date(1858, 11, 17)
_COMMENT = ("#", "%", "//", "*")

_DATE_WORDS = {
    "date",
    "time",
    "datetime",
    "epoch",
    "t",
    "day",
    "yyyymmdd",
    "yymmmdd",
    "mjd",
    "decyear",
    "decimalyear",
    "year",
    "yyyyyyyy",
    "yr",
    "decyr",
}
_STATION_WORDS = {"station", "site", "name", "id", "stationid", "sitename", "code"}
_LON_WORDS = {"lon", "longitude", "lng", "long"}
_LAT_WORDS = {"lat", "latitude"}
_SIGMA_WORDS = {
    "sig",
    "sigma",
    "std",
    "stdev",
    "stddev",
    "sd",
    "err",
    "error",
    "unc",
    "uncertainty",
    "dev",
    "deviation",
}
_COMPONENT_WORDS = {
    "east": {"east", "e", "de", "deast", "dx"},
    "north": {"north", "n", "dn", "dnorth", "dy"},
    "up": {"up", "u", "du", "dup", "dh", "dz", "vertical", "vert", "height", "h"},
}
#: ``se`` = sigma east, and so on.
_SIGMA_SHORT = {"se": "east", "sn": "north", "su": "up"}
_IGNORE_WORDS = {"corr", "cor", "rho", "correlation", "quality", "solution"}

_META_STATION = (
    "4characterid",
    "stationid",
    "station",
    "site",
    "siteid",
    "id",
    "marker",
    "markername",
    "code",
    "name",
    "stationname",
    "sitename",
)
_META_NAME = ("stationname", "sitename", "name")


class GnssCsvError(ValueError):
    """A file with nothing usable in it; the message says why."""


@dataclass
class _Column:
    role: str  # date, east, north, up, sig_east..., station, lon, lat
    unit: str | None = None


class _Row(NamedTuple):
    day: date
    enu: tuple[float, float, float]
    sig: tuple[float, ...] | None


@dataclass
class _Station:
    key: str
    rows: list[_Row] = field(default_factory=list)
    skipped: int = 0
    lon: float | None = None
    lat: float | None = None


def _norm(word: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", word.lower())


def _unit_in(header: str) -> tuple[str, str | None]:
    """Split a column header into its name and unit: ``east (mm)`` -> east, mm."""
    h = header.strip().strip("\"'")
    m = re.search(r"[\(\[]\s*([A-Za-z]+)\s*[\)\]]", h)
    if m and m.group(1).lower() in _UNIT_WORDS:
        return (h[: m.start()] + h[m.end() :]).strip(), _UNIT_WORDS[m.group(1).lower()]
    m = re.search(r"[_\s-](m|mm|cm|meters?|metres?)$", h, re.IGNORECASE)
    if m:
        return h[: m.start()], _UNIT_WORDS[m.group(1).lower()]
    return h, None


def classify(header: str) -> _Column | None:
    """Return what a column header names, or None for a column not used."""
    name, unit = _unit_in(header)
    tokens = [t for t in re.split(r"[^a-z0-9]+", name.lower()) if t]
    joined = "".join(tokens)
    if not tokens or set(tokens) & _IGNORE_WORDS:
        return None
    if joined in _DATE_WORDS or tokens[0] in {"date", "datetime", "time", "epoch"}:
        return _Column("date")
    if joined in _LON_WORDS or tokens[0] in _LON_WORDS:
        return _Column("lon")
    if joined in _LAT_WORDS or tokens[0] in _LAT_WORDS:
        return _Column("lat")
    if joined in _STATION_WORDS or joined in {"stationname", "markername"}:
        return _Column("station")
    if joined in _SIGMA_SHORT:
        return _Column("sig_" + _SIGMA_SHORT[joined], unit)
    sigma = any(t in _SIGMA_WORDS or t.startswith("sig") for t in tokens)
    words = {t for t in tokens if t not in _SIGMA_WORDS and not t.startswith("sig")}
    words |= {t[3:] for t in tokens if t.startswith("sig") and len(t) > 3}
    if "delta" in words:
        words.discard("delta")
    found = [c for c, names in _COMPONENT_WORDS.items() if words & names]
    if len(found) != 1:
        return None
    return _Column(("sig_" if sigma else "") + found[0], unit)


def _split(line: str, delim: str | None) -> list[str]:
    cells = line.split(delim) if delim else line.split()
    cells = [c.strip().strip("\"'") for c in cells]
    while cells and cells[-1] == "":  # a trailing delimiter (EarthScope's CSVs)
        cells.pop()
    return cells


def _delimiter(line: str) -> str | None:
    for d in (",", ";", "\t"):
        if d in line:
            return d
    return None


# --- dates -------------------------------------------------------------------------


def _from_decimal_year(v: float) -> date:
    year = int(math.floor(v))
    start = date(year, 1, 1)
    days = (date(year + 1, 1, 1) - start).days
    # A day's mid-point (UNR's yyyy.yyyy) or its start both land on that day, even
    # rounded to four decimals (0.04 days).
    return start + timedelta(days=int(math.floor((v - year) * days + 0.25)))


def parse_date(text: str) -> tuple[date, str]:
    """Return a date and its format; raise ValueError for anything else."""
    s = text.strip().strip("\"'")
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[T\s_])", s)
    if m:
        d, fmt = date(int(m[1]), int(m[2]), int(m[3])), "iso"
    elif re.fullmatch(r"\d{2}[A-Za-z]{3}\d{2}", s):
        d = datetime.strptime(s.title(), "%y%b%d").date()
        fmt = "yymmmdd"
    elif re.fullmatch(r"\d{8}(?:[T_ ]?\d{4,6}(?:\.\d+)?Z?)?", s):
        d, fmt = date(int(s[:4]), int(s[4:6]), int(s[6:8])), "yyyymmdd"
    else:
        v = float(s)
        if not math.isfinite(v):
            raise ValueError(s)
        if YEARS[0] <= v < YEARS[1] + 1:
            d, fmt = _from_decimal_year(v), "decimal_year"
        elif 30000 <= v < 100000:
            d, fmt = _MJD0 + timedelta(days=int(math.floor(v))), "mjd"
        else:
            raise ValueError(f"{s} is not a date")
    if not YEARS[0] <= d.year <= YEARS[1]:
        raise ValueError(f"{s} is outside {YEARS[0]}-{YEARS[1]}")
    return d, fmt


def decimal_year(d: date) -> float:
    """Return a day's mid-point as a decimal year."""
    start = date(d.year, 1, 1)
    days = (date(d.year + 1, 1, 1) - start).days
    return d.year + ((d - start).days + 0.5) / days


# --- metadata lines ----------------------------------------------------------------


def _first_number(text: str) -> float | None:
    m = re.search(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", text)
    return float(m.group()) if m else None


def _read_meta(line: str, meta: dict[str, str]) -> None:
    """Pick station, name, lon, lat, units and frame from a ``key: value`` line."""
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*(?:deg\w*\s*)?North Latitude", line, re.I)
    if m:
        meta.setdefault("lat", m.group(1))
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*(?:deg\w*\s*)?East Longitude", line, re.I)
    if m:
        meta.setdefault("lon", m.group(1))
    m = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9 _.()-]*?)\s*[:=]\s*(.+?)\s*$", line)
    if not m:
        return
    key, value = _norm(m.group(1).split("(")[0]), m.group(2).strip().strip("\"'")
    if not value:
        return
    if key in _META_STATION:
        meta.setdefault(f"station:{key}", value.split(",")[0].strip())
    elif key in _LON_WORDS or key in {"reflon", "longitudedeg"}:
        meta.setdefault("lon", value)
    elif key in _LAT_WORDS or key in {"reflat", "latitudedeg"}:
        meta.setdefault("lat", value)
    elif key in {"units", "unit", "displacementunits", "displacementunit"}:
        word = _norm(value)
        if word in _UNIT_WORDS:
            meta.setdefault("units", _UNIT_WORDS[word])
    elif key == "frame" or key.endswith("referenceframe"):
        meta.setdefault("frame", value)


def _meta_station(meta: dict[str, str]) -> tuple[str | None, str | None]:
    def first(keys: tuple[str, ...]) -> str | None:
        return next(
            (meta[f"station:{k}"] for k in keys if f"station:{k}" in meta), None
        )

    return first(_META_STATION), first(_META_NAME)


# --- the file ----------------------------------------------------------------------


def _is_header(cells: list[str]) -> list[_Column | None] | None:
    cols = [classify(c) for c in cells]
    roles = [c.role for c in cols if c]
    if "date" in roles and any(r in COMPONENTS for r in roles):
        return cols
    return None


def _looks_like_data(cells: list[str]) -> bool:
    if len(cells) < 4:
        return False
    try:
        parse_date(cells[0])
        [float(c) for c in cells[1:4]]
    except ValueError:
        return False
    return True


def _tenv3(lines: list[str]) -> tuple[dict[str, _Station], int, dict[str, Any]]:
    """NGL's .tenv3: positions in metres, lat/lon in columns 21-22."""
    stations: dict[str, _Station] = {}
    skipped = 0
    for line in lines[1:]:
        f = line.split()
        if not f:
            continue
        st = stations.setdefault(f[0], _Station(f[0]))
        try:
            if len(f) < 17:
                raise ValueError("short row")
            d, _ = parse_date(f[1])
            e, n, u = (float(f[i]) + float(f[i + 1]) for i in (7, 9, 11))
            sig = tuple(float(f[i]) for i in (14, 15, 16))
            if not all(math.isfinite(x) for x in (e, n, u)):
                raise ValueError("not finite")
        except (ValueError, IndexError):
            st.skipped += 1
            skipped += 1
            continue
        st.rows.append(_Row(d, (e, n, u), sig))
        if st.lat is None and len(f) >= 22:
            try:
                st.lat, st.lon = float(f[20]), float(f[21])
            except ValueError:
                pass
    info = {
        "units": {c: "m" for c in COMPONENTS},
        "units_from": "header",
        "date_format": "yymmmdd",
        "frame": "as in the .tenv3 file",
        "has_sigma": True,
        "components": list(COMPONENTS),
    }
    return stations, skipped, info


def _table(
    lines: list[str], meta: dict[str, str]
) -> tuple[dict[str, _Station], int, dict[str, Any]]:
    cols: list[_Column | None] | None = None
    delim: str | None = None
    data: list[list[str]] = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        comment = line.startswith(_COMMENT)
        body = line.lstrip("#%/* ").strip() if comment else line
        if cols is None:
            sep = _delimiter(body)
            cells = _split(body, sep)
            header = _is_header(cells)
            if header:
                cols, delim = header, sep
                continue
            if not comment and _looks_like_data(cells):
                delim = sep
                cols = [_Column(r) for r in ("date", *COMPONENTS)]
                if len(cells) >= 7:
                    cols += [_Column(f"sig_{c}") for c in COMPONENTS]
                data.append(cells)
                continue
            _read_meta(body, meta)
            continue
        if comment:
            _read_meta(body, meta)
            continue
        data.append(_split(line, delim))
    if cols is None:
        raise GnssCsvError(
            "No columns found: give a header row with a date column and east, "
            "north and up columns (see docs/gnss.md), or rows of date, east, north, up."
        )
    where = {c.role: i for i, c in reversed(list(enumerate(cols))) if c}
    comps = [c for c in COMPONENTS if c in where]
    if "up" not in where:
        raise GnssCsvError(
            "No up (vertical) column: name the columns east, north and up "
            f"(found {', '.join(sorted(where)) or 'none'})."
        )
    sigmas = [f"sig_{c}" for c in COMPONENTS]
    has_sigma = all(s in where for s in sigmas)

    stations: dict[str, _Station] = {}
    skipped = 0
    formats: dict[str, int] = {}
    for cells in data:
        key = (
            cells[where["station"]]
            if "station" in where and where["station"] < len(cells)
            else ""
        )
        st = stations.setdefault(key, _Station(key))
        try:
            d, fmt = parse_date(cells[where["date"]])
            enu = [float(cells[where[c]]) if c in where else 0.0 for c in COMPONENTS]
            if not all(math.isfinite(v) for v in enu):
                raise ValueError("not finite")
            sig = tuple(float(cells[where[s]]) for s in sigmas) if has_sigma else None
        except (ValueError, IndexError):
            st.skipped += 1
            skipped += 1
            continue
        formats[fmt] = formats.get(fmt, 0) + 1
        st.rows.append(_Row(d, (enu[0], enu[1], enu[2]), sig))
        if st.lon is None and "lon" in where and "lat" in where:
            try:
                st.lon, st.lat = float(cells[where["lon"]]), float(cells[where["lat"]])
            except (ValueError, IndexError):
                pass
    units = {c: cols[where[c]].unit for c in comps}  # type: ignore[union-attr]
    for s in sigmas:
        if s in where:
            units[s] = cols[where[s]].unit  # type: ignore[union-attr]
    info = {
        "units": units,
        "units_from": "header" if any(units.values()) else None,
        "date_format": max(formats, key=lambda k: formats[k]) if formats else None,
        "frame": meta.get("frame"),
        "has_sigma": has_sigma,
        "components": comps,
    }
    return stations, skipped, info


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("._")[:40]


def _fit(t: list[float], y: list[float]) -> tuple[float, float]:
    """Return the least-squares rate of ``y`` over ``t`` and its formal sigma."""
    n = len(t)
    tm, ym = sum(t) / n, sum(y) / n
    stt = sum((a - tm) ** 2 for a in t)
    if stt <= 0:
        return 0.0, 0.0
    rate = sum((a - tm) * (b - ym) for a, b in zip(t, y, strict=True)) / stt
    if n <= 2:
        return rate, 0.0
    res = sum((b - ym - rate * (a - tm)) ** 2 for a, b in zip(t, y, strict=True))
    return rate, math.sqrt(res / (n - 2) / stt)


def _guess_units(stations: dict[str, _Station]) -> str:
    """Millimetres when the values change by more than 3 (3 m is rare), else metres."""
    spans = []
    for st in stations.values():
        for k in (0, 1, 2):
            vals = [r.enu[k] for r in st.rows]
            if vals:
                spans.append(max(vals) - min(vals))
    return "mm" if spans and max(spans) > 3 else "m"


def parse_gnss_csv(
    text: str,
    name: str = "",
    units: str | None = None,
    station: str | None = None,
    lon: float | None = None,
    lat: float | None = None,
) -> dict[str, Any]:
    """Read the stations in a GNSS time-series file.

    Parameters
    ----------
    text : str
        The file's text.
    name : str
        The file's name: the station's name when the file gives none, and
        ``.tenv3`` picks NGL's format.
    units : str, optional
        ``m``, ``mm`` or ``cm`` for the displacements, over what the file says;
        None or ``auto`` reads them from the file (or guesses, and says so).
    station, lon, lat : optional
        The station's name and location, over what the file says (one station).

    Returns
    -------
    dict
        ``file``, ``rows`` (usable), ``skipped`` and ``stations``: each with
        ``id``, ``name``, ``lon``, ``lat``, ``dates`` (YYYY-MM-DD), ``east_mm``,
        ``north_mm`` and ``up_mm`` from the first date, sigmas when given, a
        linear rate per component in mm/yr, the units and where they came from,
        the date format and any warnings.

    Raises
    ------
    GnssCsvError
        Nothing usable: no columns, fewer than two rows, or no location.

    """
    if units in ("", "auto"):
        units = None
    if units is not None and units not in UNIT_MM:
        raise GnssCsvError(f"units is m, mm or cm, not {units!r}.")
    lines = text.lstrip("﻿").splitlines()
    if not any(line.strip() for line in lines):
        raise GnssCsvError("The file is empty.")
    meta: dict[str, str] = {}
    first = lines[0].split()
    if name.lower().endswith(".tenv3") or first[:2] == ["site", "YYMMMDD"]:
        stations, skipped, info = _tenv3(lines)
    else:
        stations, skipped, info = _table(lines, meta)
    stations = {k: s for k, s in stations.items() if s.rows or s.skipped}
    total = sum(len(s.rows) for s in stations.values())
    if total < 2:
        raise GnssCsvError(
            f"Fewer than two usable rows ({total}; {skipped} skipped): each row "
            "needs a date and numbers for east, north and up."
        )
    warnings: list[str] = []
    if "east" not in info["components"] or "north" not in info["components"]:
        warnings.append(
            "No east or north column: taken as 0, so the line of sight uses the "
            "vertical only."
        )
    col_units = info["units"]
    if units:
        if any(u and u != units for u in col_units.values()):
            warnings.append(f"The header's units are overridden: {units} as asked.")
        col_units = {k: units for k in col_units}
        units_from = "option"
    elif all(col_units.get(c) for c in info["components"]):
        units_from = "header"
    elif meta.get("units"):
        col_units = {k: v or meta["units"] for k, v in col_units.items()}
        units_from = "file"
    else:
        guess = _guess_units(stations)
        col_units = {k: v or guess for k, v in col_units.items()}
        units_from = "guessed"
        warnings.append(
            f"The file does not say its units: read as {guess} from the size of the "
            "values. Give the units to be sure."
        )
    comp_unit = col_units.get("up") or "mm"

    meta_id, meta_name = _meta_station(meta)
    stem = Path(name).name.split(".")[0] if name else ""
    single = len(stations) == 1
    out = []
    for key, st in stations.items():
        if len(st.rows) < 2:
            warnings.append(f"{key or stem}: fewer than two usable rows, left out.")
            continue
        sid = (station if single and station else None) or key or meta_id or stem
        sid = sid or "station"
        slon = lon if lon is not None else st.lon
        slat = lat if lat is not None else st.lat
        if slon is None and single and meta.get("lon"):
            slon = _first_number(meta["lon"])
        if slat is None and single and meta.get("lat"):
            slat = _first_number(meta["lat"])
        if slon is None or slat is None:
            raise GnssCsvError(
                f"No location for {sid}: add lon and lat columns, or lines "
                "'# lon: <degrees>' and '# lat: <degrees>' before the data."
            )
        if slon > 180:
            slon -= 360
        if not (-180 <= slon <= 180 and -90 <= slat <= 90):
            raise GnssCsvError(f"{sid}: lon {slon}, lat {slat} is not a place.")
        rows = sorted(st.rows, key=lambda r: r.day)
        scale = {c: UNIT_MM[col_units.get(c) or comp_unit] for c in COMPONENTS}
        base = rows[0]
        enu = {
            c: [round((r.enu[k] - base.enu[k]) * scale[c], 2) for r in rows]
            for k, c in enumerate(COMPONENTS)
        }
        t = [decimal_year(r.day) for r in rows]
        rates = {c: _fit(t, enu[c]) for c in COMPONENTS}
        item: dict[str, Any] = {
            "id": _slug(sid) or "station",
            "name": (meta_name if single and meta_name else None) or sid,
            "custom": True,
            "lon": round(slon, 6),
            "lat": round(slat, 6),
            "first": round(t[0], 4),
            "last": round(t[-1], 4),
            "first_date": rows[0].day.isoformat(),
            "last_date": rows[-1].day.isoformat(),
            "ve_mm_yr": round(rates["east"][0], 2),
            "vn_mm_yr": round(rates["north"][0], 2),
            "vu_mm_yr": round(rates["up"][0], 2),
            "sigma_vu_mm_yr": round(rates["up"][1], 2),
            "rows": len(rows),
            "skipped": st.skipped,
            "units": comp_unit,
            "units_from": units_from,
            "date_format": info["date_format"],
            "components": info["components"],
            "source": Path(name).name if name else "",
            "frame": info["frame"] or "as given in the file",
            "warnings": list(warnings),
            "dates": [r.day.isoformat() for r in rows],
            **enu_named(enu),
        }
        sigs = [r.sig for r in rows]
        if info["has_sigma"]:
            for k, c in enumerate(COMPONENTS):
                f = UNIT_MM[col_units.get(f"sig_{c}") or col_units.get(c) or comp_unit]
                item[f"sigma_{c}_mm"] = [round(g[k] * f, 2) for g in sigs if g]
        out.append(item)
    if not out:
        raise GnssCsvError("No station has two usable rows.")
    ids = [s["id"] for s in out]
    for s in out:
        if ids.count(s["id"]) > 1:
            raise GnssCsvError(f"Two stations are named {s['id']}.")
    return {
        "file": Path(name).name if name else "",
        "rows": sum(s["rows"] for s in out),
        "skipped": skipped,
        "stations": out,
    }


def enu_named(enu: dict[str, list[float]]) -> dict[str, list[float]]:
    """Return east, north and up as the series' ``east_mm``... keys."""
    return {f"{c}_mm": enu[c] for c in COMPONENTS}


def read_file(path: str | Path) -> str:
    """Return a file's text, refusing one over :data:`MAX_BYTES`."""
    p = Path(path)
    size = p.stat().st_size
    if size > MAX_BYTES:
        raise GnssCsvError(
            f"{p.name} is {size >> 20} MB; GNSS files up to {MAX_BYTES >> 20} MB "
            "are read."
        )
    return p.read_bytes().decode("utf-8", errors="replace")
