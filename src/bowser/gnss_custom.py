"""The user's own GNSS stations, read from their CSV files: kept for the session.

Routes shared by the full server and bowser-lite (no GDAL: :mod:`bowser.gnss_csv`
is pure Python):

- ``POST /gnss/custom``: read a file, sent as text by the page (allowed on any
  server, as an upload is) or named by its path on the server (only with
  ``BOWSER_ALLOW_OPEN``, as Load file);
- ``GET /gnss/custom``: the stations read so far;
- ``GET /gnss/custom/{station_id}``: one station's series, shaped as
  ``GET /gnss/series/{station}`` so the page compares it with InSAR the same way;
- ``DELETE /gnss/custom/{station_id}``: forget one.

Stations live in this server process (at most :data:`MAX_STATIONS`, oldest
dropped first): they last until the server stops, like other session state.
Loading a station with the same id again replaces it.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi import Path as PathParam
from pydantic import BaseModel, ConfigDict, Field

from . import api_models as api
from .assistant.relay import get_settings
from .gnss_csv import MAX_BYTES, GnssCsvError, parse_gnss_csv, read_file

MAX_STATIONS = 200
#: Keys of a station's summary (the series has these and the data).
SUMMARY_KEYS = tuple(api.CustomGnssStation.model_fields)
OPEN_OFF = (
    "Reading files on the server from the page is off here "
    "(set BOWSER_ALLOW_OPEN=true, or run `bowser run` locally). "
    "Load the file from your computer instead."
)

_lock = threading.Lock()
_stations: OrderedDict[str, dict[str, Any]] = OrderedDict()

router = APIRouter()


class GnssCsvBody(BaseModel):
    """``POST /gnss/custom``: one file, by its text or its path, and overrides."""

    model_config = ConfigDict(extra="forbid")

    path: str | None = Field(
        None,
        description="The file's path on the server (needs BOWSER_ALLOW_OPEN).",
        examples=["/data/gnss/ABCD.csv"],
    )
    text: str | None = Field(
        None, max_length=MAX_BYTES, description="The file's text (from the page)."
    )
    name: str | None = Field(
        None,
        max_length=200,
        description="The file's name, for a station that names none.",
    )
    units: Literal["auto", "m", "mm", "cm"] = Field(
        "auto",
        description="Units of east, north and up; auto: from the file's header or "
        "a '# units:' line, else guessed from the values.",
    )
    station: str | None = Field(
        None, max_length=80, description="The station's name, over the file's."
    )
    lon: float | None = Field(
        None, ge=-180, le=360, description="Longitude, over the file's."
    )
    lat: float | None = Field(
        None, ge=-90, le=90, description="Latitude, over the file's."
    )


def summary(station: dict[str, Any]) -> dict[str, Any]:
    """Return a station without its series."""
    return {k: station[k] for k in SUMMARY_KEYS if k in station}


def load(body: GnssCsvBody, allow_open: bool) -> dict[str, Any]:
    """Read one file into the session; return what was read.

    Raises ``PermissionError`` for a server path when opening is off, and
    ``GnssCsvError`` for a file with nothing usable.
    """
    if (body.path is None) == (body.text is None):
        raise GnssCsvError("Give the file's path or its text (one of them).")
    name = body.name or ""
    if body.path is not None:
        if not allow_open:
            raise PermissionError(OPEN_OFF)
        path = Path(body.path.strip()).expanduser()
        if not path.is_file():
            raise GnssCsvError(f"No such file: {path}")
        text = read_file(path)
        name = name or path.name
    else:
        text = body.text or ""
    result = parse_gnss_csv(
        text,
        name=name,
        units=body.units,
        station=body.station,
        lon=body.lon,
        lat=body.lat,
    )
    with _lock:
        for st in result["stations"]:
            _stations.pop(st["id"], None)
            _stations[st["id"]] = st
        while len(_stations) > MAX_STATIONS:
            _stations.popitem(last=False)
    return {**result, "stations": [summary(s) for s in result["stations"]]}


def stations() -> list[dict[str, Any]]:
    """Return the session's stations, in the order they were loaded."""
    with _lock:
        return [summary(s) for s in _stations.values()]


def series(station_id: str) -> dict[str, Any]:
    """Return one station's series; KeyError for an unknown id."""
    with _lock:
        st = _stations[station_id]
    return {
        **summary(st),
        "station": st["id"],
        "station_page": None,
        **{k: st[k] for k in st if k == "dates" or k.endswith("_mm")},
    }


def forget(station_id: str) -> None:
    """Drop one station; KeyError for an unknown id."""
    with _lock:
        del _stations[station_id]


def clear() -> None:
    """Drop every station (tests)."""
    with _lock:
        _stations.clear()


def _unknown(station_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail=f"No GNSS station {station_id!r} loaded from a file here "
        "(stations are kept until the server stops; load the file again).",
    )


StationId = PathParam(
    ...,
    max_length=40,
    pattern=r"^[A-Za-z0-9_.-]+$",
    description="A loaded station's id (GET /gnss/custom).",
)


@router.post(
    "/gnss/custom",
    responses={200: {"model": api.GnssCsvLoaded}},
    **api.route_doc("POST /gnss/custom"),
)
def load_gnss_csv(body: GnssCsvBody = Body(...), settings: Any = Depends(get_settings)):
    """Read a GNSS time-series file (text or server path); keep its stations."""
    try:
        return load(body, bool(settings.BOWSER_ALLOW_OPEN))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except GnssCsvError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not read the file: {exc}"
        ) from exc


@router.get(
    "/gnss/custom",
    responses={200: {"model": api.CustomGnssStations}},
    **api.route_doc("GET /gnss/custom"),
)
def list_gnss_custom():
    """List the stations read from files in this session."""
    return {"stations": stations()}


@router.get(
    "/gnss/custom/{station_id}",
    responses={200: {"model": api.CustomGnssSeries}},
    **api.route_doc("GET /gnss/custom/{station_id}"),
)
def gnss_custom_series(station_id: str = StationId):
    """Return a loaded station's east, north and up (mm from its first date)."""
    try:
        return series(station_id)
    except KeyError:
        raise _unknown(station_id) from None


@router.delete(
    "/gnss/custom/{station_id}",
    responses={200: {"model": api.RemovedGnssStation}},
    **api.route_doc("DELETE /gnss/custom/{station_id}"),
)
def delete_gnss_custom(station_id: str = StationId):
    """Forget a loaded station."""
    try:
        forget(station_id)
    except KeyError:
        raise _unknown(station_id) from None
    return {"removed": station_id}
