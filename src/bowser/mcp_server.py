"""MCP server for Bowser: ``bowser mcp``.

A thin layer over Bowser's HTTP API (see docs/rest-api.md). Every tool calls a
running Bowser server, full (``bowser run``) or lite (``bowser lite``), and turns
its JSON into a compact answer a model can read: dates and values, the unit, and
a note saying what the values are relative to. No data is read or computed here;
the server does that, so the tools give the same numbers as the web page.

Needs the optional ``mcp`` extra (``pip install 'bowser-insar[mcp]'``). Nothing
else in Bowser imports this module.
"""

import contextlib
import functools
import inspect
import json
import math
import os
import sys
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlencode

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

DEFAULT_URL = "http://127.0.0.1:8000"

#: Lengths stored in metres are reported in millimetres, rates in mm/yr.
_METRES = {"m", "meter", "meters", "metre", "metres"}
_METRES_PER_YEAR = {
    "m/yr",
    "m/y",
    "m/year",
    "m yr-1",
    "m/a",
    "meters/year",
    "metres/year",
    "meters per year",
    "metres per year",
}

INSTRUCTIONS = """\
Bowser is a viewer for InSAR time series: a cube of satellite radar displacement
(for example OPERA DISP-S1 from Sentinel-1, or NISAR), with quality layers such as
temporal coherence, phase similarity and a recommended mask. These tools read the
cube that a Bowser server has open. Start with server_info and list_layers: they
name the layers, their dates and units, the reference point and what this server
can do (bowser-lite cannot compute polygon statistics or export GeoTIFFs).

Typical flows:
- "Is this place moving?": list_layers -> point_timeseries (or trend_at_point) at
  the point, and the same at a nearby point that should be stable, for comparison.
- "Compare places": multi_point_timeseries with all of them and one reference.
- "How does an area behave?": polygon_statistics (full server), or several points.
- "Where does it change?": profile along a line across the feature at one date.
- "Is the colour scale sensible / how big are values on this date?": layer_statistics.

What the numbers are. Displacement is measured along the radar's line of sight
(LOS), not vertical: a value can be vertical motion, horizontal motion or both, and
north-south motion is barely seen. The sign convention comes from the producer
(for OPERA DISP-S1, positive is towards the satellite). Values are relative, not
absolute: relative to a reference point (the point is assumed stable, which is not
guaranteed) and to a reference date (which can be before the first date shown,
so a series need not start at 0). Every result says which reference was used.
Changing the reference point changes every value; a moving reference makes
stable ground look like it moves. Lengths stored in metres are given in mm,
rates in mm/yr.

Reading a time series: never interpret displacement from the curve alone. First
establish what is on the ground at that point (ask the user, or use other tools you
have for geology, land cover, terrain, wetlands, snow, earthquakes, wells or GNSS),
and the quality there (temporal_coherence, phase_similarity or recommended_mask at
the same point), then say which effects could explain the signal and how sure you
are. Wetlands, flooded vegetation, irrigated fields and watered turf can bias the
phase and look like seasonal motion or slow sinking. Snow can cause jumps or gaps.
Bedrock is expected to be stable, so a large trend there needs an explanation
(slope motion, mining, the reference point, atmosphere, unwrapping errors).
Unconsolidated sediment can compact (compare wells and pumping); peat can really
subside; expansive clay swells and shrinks with moisture. Seasonal cycles can be
groundwater, soil moisture, snow, thermal expansion or atmosphere. Sudden lasting
offsets of about half the radar wavelength (about 28 mm for Sentinel-1, about
12 cm for NISAR's L-band) or a multiple of it are likely unwrapping errors,
especially when they end at a sharp line or show on one pass only. Fast or sharp
motion (landslide margins, mine collapse, fault rupture) can alias and look slower
than it is, or lose coherence and go blank. A trend is a straight line through
the dates: check the series for steps, seasonal cycles and gaps before quoting
a rate, and say there is no clear trend when the rate is small compared with the
scatter between dates. Blank or masked does not mean stable.

Say what you checked and what you could not. These are screening results from
satellite data, not findings: tell the user that any motion reported must be
confirmed by a qualified expert (GNSS, levelling, field inspection) before it
informs a decision, and never state that a specific building or property is
damaged, unsafe or at risk. A pixel is about 30 m (Sentinel-1) or 20-80 m (NISAR),
so it does not describe a single structure.
"""

# --- descriptions of the shared parameters ---------------------------------------

Lon = Annotated[float, Field(ge=-180, le=180, description="WGS84 longitude.")]
Lat = Annotated[float, Field(ge=-90, le=90, description="WGS84 latitude.")]
Layer = Annotated[
    str,
    Field(
        description="Layer name, as list_layers gives it (for example "
        "'displacement', 'velocity', 'temporal_coherence')."
    ),
]
RefLon = Annotated[
    float | None,
    Field(
        ge=-180,
        le=180,
        description="Longitude of a reference point to subtract; give with "
        "ref_lat. Omit to use the cube's reference point (see list_layers).",
    ),
]
RefLat = Annotated[
    float | None,
    Field(ge=-90, le=90, description="Latitude of the reference point."),
]
RefBuffer = Annotated[
    float,
    Field(
        ge=0,
        description="Radius (m) of a circle around the reference point whose "
        "median is subtracted; 0 uses the one pixel.",
    ),
]
UseCubeReference = Annotated[
    bool,
    Field(
        description="When no ref_lon/ref_lat is given, subtract the cube's "
        "reference point as the Bowser page does (true), or return the values as "
        "stored (false)."
    ),
]
Dataset = Annotated[
    str | None,
    Field(
        description="Catalog dataset id (see server_info). Omit when the server "
        "serves a single cube."
    ),
]
TimeIndex = Annotated[
    int,
    Field(
        ge=0,
        description="Index into the layer's dates (0 = first; see list_layers). "
        "Clamped to the last date.",
    ),
]


class PointIn(BaseModel):
    """A point for multi_point_timeseries."""

    lon: Lon
    lat: Lat
    name: str | None = Field(None, description="Label for the point.")


class LayerMask(BaseModel):
    """Keep pixels by the value of another layer (as the page's mask panel does)."""

    dataset: str = Field(description="Layer to mask with, e.g. temporal_coherence.")
    threshold: float = Field(description="Threshold value.")
    mode: Literal["min", "max"] = Field(
        "min", description="min keeps pixels >= threshold, max keeps <= threshold."
    )


class BowserError(RuntimeError):
    """An expected failure, with a message for the model."""


# --- HTTP ------------------------------------------------------------------------


class BowserAPI:
    """Calls to one Bowser server, with failures turned into readable messages."""

    def __init__(
        self,
        base_url: str = DEFAULT_URL,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 300.0,
    ) -> None:
        """Set up a client for the server at ``base_url`` (or ``transport``)."""
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url, transport=transport, timeout=timeout
        )

    def url(self, path: str, params: dict[str, Any] | None = None) -> str:
        """Return the full URL of ``path`` with ``params`` (None values dropped)."""
        query = urlencode({k: v for k, v in (params or {}).items() if v is not None})
        return f"{self.base_url}{path}" + (f"?{query}" if query else "")

    async def request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: Any = None,
    ) -> httpx.Response:
        """Send one request; raise BowserError on a failure the model should see."""
        params = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            r = await self._client.request(method, path, params=params, json=json)
        except httpx.TransportError as e:
            raise BowserError(
                f"Cannot reach the Bowser server at {self.base_url} "
                f"({type(e).__name__}). Start it with `bowser run` or `bowser lite`, "
                "or point `bowser mcp --url` at it."
            ) from e
        if r.status_code >= 400:
            detail = _detail(r)
            if r.status_code == 501:
                raise BowserError(f"Not available on this server (HTTP 501): {detail}")
            raise BowserError(f"Bowser answered HTTP {r.status_code}: {detail}")
        return r

    async def get(self, path: str, **params: Any) -> Any:
        """GET ``path`` and return its JSON."""
        return (await self.request("GET", path, params)).json()

    async def post(self, path: str, body: Any, **params: Any) -> Any:
        """POST ``body`` as JSON to ``path`` and return the answer's JSON."""
        return (await self.request("POST", path, params, json=body)).json()

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text[:300] or r.reason_phrase
    detail = body.get("detail", body) if isinstance(body, dict) else body
    return detail if isinstance(detail, str) else str(detail)[:500]


# --- formatting ------------------------------------------------------------------


def unit_scale(unit: str | None) -> tuple[float, str]:
    """Return the factor and unit to report a layer's values in.

    Metres become millimetres and metres per year mm/yr, the units InSAR results
    are usually discussed in; anything else is reported as stored.
    """
    u = (unit or "").strip().lower()
    if u in _METRES:
        return 1000.0, "mm"
    if u in _METRES_PER_YEAR:
        return 1000.0, "mm/yr"
    return 1.0, unit or "unknown (not given by the cube)"


def _num(v: Any, factor: float = 1.0) -> float | None:
    """Scale and round a value for the model; None for missing."""
    if v is None:
        return None
    v = float(v) * factor
    if not math.isfinite(v):
        return None
    if factor == 1000.0:
        return round(v, 2)
    return float(f"{v:.6g}")


def _n_steps(info: dict) -> int:
    if info.get("n_time_steps") is not None:
        return int(info["n_time_steps"])
    if info.get("file_list"):
        return len(info["file_list"])
    return len(info.get("x_values") or []) or 1


def _inside(info: dict, lon: float, lat: float) -> bool:
    b = info.get("latlon_bounds")
    if not b or len(b) != 4:
        return True
    west, south, east, north = b
    return west <= lon <= east and south <= lat <= north


# --- the server ------------------------------------------------------------------


def build_server(
    base_url: str = DEFAULT_URL,
    transport: httpx.AsyncBaseTransport | None = None,
) -> MCPServer:
    """Build the MCP server whose tools call the Bowser server at ``base_url``.

    Parameters
    ----------
    base_url : str
        Root URL of a running Bowser server (full or lite).
    transport : httpx.AsyncBaseTransport, optional
        HTTP transport to use instead of the network, e.g.
        ``httpx.ASGITransport(app=app)`` to call an app in this process.

    Returns
    -------
    MCPServer
        The server; call ``.run("stdio")`` or ``.run("streamable-http", ...)``.

    """
    api = BowserAPI(base_url, transport)
    server = MCPServer("bowser", instructions=INSTRUCTIONS, log_level="WARNING")
    read_only = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

    def tool(fn=None, *, annotations: ToolAnnotations = read_only):
        """Register ``fn`` with its docstring as the description.

        Expected failures become tool errors with a message the model can act on.
        """

        def register(fn):
            @functools.wraps(fn)
            async def wrapped(*args, **kwargs):
                try:
                    return await fn(*args, **kwargs)
                except BowserError as e:
                    raise ToolError(str(e)) from e

            server.add_tool(
                wrapped,
                name=fn.__name__,
                description=_describe(fn),
                annotations=annotations,
            )
            return fn

        return register(fn) if fn is not None else register

    async def layers(dataset: str | None) -> dict[str, dict]:
        return await api.get("/datasets", dataset=dataset)

    async def layer_info(dataset: str | None, name: str) -> dict:
        all_layers = await layers(dataset)
        if name not in all_layers:
            raise BowserError(
                f"No layer {name!r}. Layers: {', '.join(sorted(all_layers))}."
            )
        return all_layers[name]

    def reference(
        info: dict,
        ref_lon: float | None,
        ref_lat: float | None,
        use_cube_reference: bool,
    ) -> tuple[float | None, float | None, dict]:
        """Choose the reference point; return it and a note saying what it is."""
        if (ref_lon is None) != (ref_lat is None):
            raise BowserError("Give both ref_lon and ref_lat, or neither.")
        relative = bool(info.get("uses_spatial_ref"))
        series = relative and bool(info.get("x_values"))
        date = info.get("reference_date") if series else None
        if ref_lon is not None and ref_lat is not None:
            check_point(info, ref_lon, ref_lat, "Reference point")
            where = f"the reference point you gave ({ref_lon}, {ref_lat})"
            point: list[float] | None = [ref_lon, ref_lat]
        elif use_cube_reference and relative and info.get("reference_lonlat"):
            point = [float(v) for v in info["reference_lonlat"]]
            ref_lon, ref_lat = point
            where = f"the cube's reference point ({ref_lon}, {ref_lat})"
        else:
            where = ""
            point = None
        if point:
            note = f"Relative to {where}"
        elif relative:
            note = "Values as stored, nothing subtracted: relative to the "
            note += "producer's reference point"
        else:
            note = "Values as stored, nothing subtracted"
        if date:
            note += f" and to the reference date {date}."
        elif series:
            note += ". The cube does not name its reference date: values are "
            note += "changes since the producer's, which can be before the first "
            note += "date shown, so the first value need not be 0."
        else:
            note += "."
        if relative and not point and use_cube_reference:
            note += " The cube names no reference point; give ref_lon and "
            note += "ref_lat to choose one on stable ground."
        if not relative and point:
            note += " This layer is not normally re-referenced (it is not a "
            note += "displacement or velocity); compare the raw values instead."
        out = {"point": point, "note": note}
        if date:
            out["date"] = date
        return ref_lon, ref_lat, out

    def check_point(info: dict, lon: float, lat: float, what: str = "Point") -> None:
        if not _inside(info, lon, lat):
            raise BowserError(
                f"{what} ({lon}, {lat}) is outside the cube "
                f"(west, south, east, north = {info.get('latlon_bounds')}). Bowser "
                "would return the nearest edge pixel, which is not that place."
            )

    # --- tools: what is there ----------------------------------------------------

    @tool
    async def server_info(dataset: Dataset = None) -> dict[str, Any]:
        """Return what the Bowser server serves and can do.

        Returns the page title, the server kind (full or lite), the data mode
        (md = GeoZarr cube, cog = GeoTIFF stack), whether polygon statistics and
        GeoTIFF export work, and the catalog of datasets when the server has one
        (pass an id as `dataset` to the other tools). Call this first.
        """
        config = await api.get("/config", dataset=dataset)
        mode = await api.get("/mode", dataset=dataset)
        catalog = await api.get("/catalog")
        full = bool(config.get("geotiff_export"))
        unsupported = [
            name
            for name, ok in (
                ("polygon_statistics", config.get("polygon_stats")),
                ("export_geotiff", config.get("geotiff_export")),
            )
            if not ok
        ]
        return {
            "url": api.base_url,
            "title": config.get("title") or None,
            "server": "full" if full else "lite",
            "mode": mode.get("mode"),
            "polygon_stats": bool(config.get("polygon_stats")),
            "geotiff_export": full,
            "unsupported_tools": unsupported,
            "catalog": [
                {k: e.get(k) for k in ("id", "name", "bbox", "description")}
                for e in catalog.get("datasets", [])
            ],
            "note": "Without a catalog, the server serves one cube; omit `dataset`."
            if not catalog.get("datasets")
            else "Pass a catalog id as `dataset` to the other tools.",
        }

    @tool
    async def list_layers(dataset: Dataset = None) -> dict[str, Any]:
        """List the cube's layers, with dates, units and reference information.

        For each layer: label, unit (as stored, and the unit the tools report),
        number of dates with the first and last, whether it is a displacement-like
        layer re-referenced to a point (`relative_to_reference_point`), and the
        producer's description. Also the cube's area (west, south, east, north),
        reference point, reference date and radar look geometry.
        """
        all_layers = await layers(dataset)
        out: dict[str, Any] = {"layers": {}}
        for name, info in all_layers.items():
            labels = info.get("x_values") or []
            n = _n_steps(info)
            _, unit = unit_scale(info.get("unit"))
            entry = {
                "label": info.get("label") or name,
                "unit_stored": info.get("unit") or None,
                "unit_reported": unit,
                "n_time_steps": n,
                "has_time_axis": bool(labels) and n > 1,
                "relative_to_reference_point": bool(info.get("uses_spatial_ref")),
                "description": info.get("description"),
            }
            if labels:
                entry["first_date"], entry["last_date"] = labels[0], labels[-1]
            if info.get("uses_spatial_ref"):
                entry["reference_date"] = info.get("reference_date")
            for key in ("guidance", "metadata_notes"):
                if info.get(key):
                    entry[key] = info[key]
            out["layers"][name] = entry
            out.setdefault("latlon_bounds", info.get("latlon_bounds"))
            if info.get("reference_lonlat"):
                out.setdefault("reference_lonlat", info["reference_lonlat"])
            los = info.get("los_metadata")
            if los:
                out.setdefault(
                    "look_geometry",
                    {
                        "heading_deg": los.get("heading_deg"),
                        "incidence_deg": los.get("incidence_deg"),
                        "los_enu_ground_to_satellite": los.get("los_enu_ground_to_sat"),
                    },
                )
        out["note"] = (
            "Coordinates are WGS84 lon/lat; latlon_bounds is [west, south, east, "
            "north]. Time indexes count from 0 over a layer's dates."
        )
        return out

    # --- tools: time series --------------------------------------------------------

    @tool
    async def point_timeseries(
        lon: Lon,
        lat: Lat,
        layer: Layer = "displacement",
        ref_lon: RefLon = None,
        ref_lat: RefLat = None,
        ref_buffer_m: RefBuffer = 0.0,
        use_cube_reference: UseCubeReference = True,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Return a layer's time series at a point (nearest pixel), as on the page.

        Displacement is relative to a reference point (yours, or the cube's) and
        to the reference date; the result says which. Dates with no data are left
        out (`n_missing`). Layers without a time axis (e.g. velocity) give one
        value: use value_at_point for those.
        """
        info = await layer_info(dataset, layer)
        check_point(info, lon, lat)
        if not info.get("x_values") or _n_steps(info) <= 1:
            raise BowserError(
                f"{layer!r} has no time axis; use value_at_point for its value."
            )
        ref_lon, ref_lat, ref = reference(info, ref_lon, ref_lat, use_cube_reference)
        factor, unit = unit_scale(info.get("unit"))
        if ref_buffer_m > 0 and ref_lon is not None:
            res = await api.post(
                "/multi_point",
                {
                    "points": [{"id": "p", "lon": lon, "lat": lat}],
                    "dataset_name": layer,
                    "ref_lon": ref_lon,
                    "ref_lat": ref_lat,
                    "ref_buffer_m": ref_buffer_m,
                },
                dataset=dataset,
            )
            if not res["datasets"]:
                raise BowserError(f"Bowser could not read {layer!r} at the point.")
            labels, data = res["labels"], res["datasets"][0]["data"]
            ref["note"] += f" Reference is the median within {ref_buffer_m:g} m."
        else:
            res = await api.get(
                "/chart_point",
                dataset_name=layer,
                lon=lon,
                lat=lat,
                ref_lon=ref_lon,
                ref_lat=ref_lat,
                dataset=dataset,
            )
            labels, data = res["labels"], res["datasets"][0]["data"]
        dates = [d["x"] for d in data]
        values = [_num(d["y"], factor) for d in data]
        out: dict[str, Any] = {
            "layer": layer,
            "point": [lon, lat],
            "unit": unit,
            "reference": ref,
            "n_dates": len(labels),
            "n_missing": len(labels) - len(dates),
            "dates": dates,
            "values": values,
        }
        if values:
            out["summary"] = (
                f"{len(dates)} of {len(labels)} dates from {dates[0]} to "
                f"{dates[-1]}; last value {values[-1]} {unit}."
            )
        else:
            out["summary"] = "No valid data at this point (masked or nodata)."
        return out

    @tool
    async def multi_point_timeseries(
        points: Annotated[
            list[PointIn],
            Field(min_length=1, max_length=50, description="Points to read."),
        ],
        layer: Layer = "displacement",
        ref_lon: RefLon = None,
        ref_lat: RefLat = None,
        ref_buffer_m: RefBuffer = 0.0,
        use_cube_reference: UseCubeReference = True,
        trends: Annotated[
            bool, Field(description="Add a straight-line rate to each point.")
        ] = True,
        layer_masks: Annotated[
            list[LayerMask] | None,
            Field(
                description="Drop dates where another layer fails a threshold at "
                "the point, as the page's masks do."
            ),
        ] = None,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Return the time series of several points against one reference.

        `values` of each point line up with `dates`, with null where the point has
        no data. With `trends`, each point gets a linear rate per year and its
        standard error and R^2. Points outside the cube are rejected.
        """
        info = await layer_info(dataset, layer)
        for p in points:
            check_point(info, p.lon, p.lat, f"Point {p.name or ''}".strip())
        if not info.get("x_values") or _n_steps(info) <= 1:
            raise BowserError(
                f"{layer!r} has no time axis; use value_at_point for its value."
            )
        ref_lon, ref_lat, ref = reference(info, ref_lon, ref_lat, use_cube_reference)
        if ref_buffer_m > 0 and ref_lon is not None:
            ref["note"] += f" Reference is the median within {ref_buffer_m:g} m."
        factor, unit = unit_scale(info.get("unit"))
        names = [p.name or f"point {i + 1}" for i, p in enumerate(points)]
        res = await api.post(
            "/multi_point",
            {
                "points": [
                    {"id": f"p{i}", "lon": p.lon, "lat": p.lat, "name": names[i]}
                    for i, p in enumerate(points)
                ],
                "dataset_name": layer,
                "ref_lon": ref_lon,
                "ref_lat": ref_lat,
                "ref_buffer_m": ref_buffer_m,
                "calculate_trends": trends,
                "layer_masks": [m.model_dump() for m in layer_masks or []],
            },
            dataset=dataset,
        )
        labels = res["labels"]
        got = {s["pointId"]: s for s in res["datasets"]}
        rate_unit = "mm/yr" if factor == 1000.0 else f"{unit} per year"
        rows = []
        for i, p in enumerate(points):
            s = got.get(f"p{i}")
            row: dict[str, Any] = {"name": names[i], "lon": p.lon, "lat": p.lat}
            if s is None:
                row["error"] = "Bowser could not read this point."
                rows.append(row)
                continue
            by_date = {d["x"]: d["y"] for d in s["data"]}
            row["values"] = [_num(by_date.get(x), factor) for x in labels]
            row["n_valid"] = len(by_date)
            if s.get("trend"):
                t = s["trend"]
                row["rate_per_year"] = _num(t["mmPerYear"] / 1000, factor)
                row["rate_std_err"] = _num(t["stdMmPerYear"] / 1000, factor)
                row["r_squared"] = _num(t["rSquared"])
            rows.append(row)
        return {
            "layer": layer,
            "unit": unit,
            "rate_unit": rate_unit if trends else None,
            "reference": ref,
            "dates": labels,
            "points": rows,
        }

    @tool
    async def trend_at_point(
        lon: Lon,
        lat: Lat,
        layer: Layer = "displacement",
        ref_lon: RefLon = None,
        ref_lat: RefLat = None,
        ref_buffer_m: RefBuffer = 0.0,
        use_cube_reference: UseCubeReference = True,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Fit a straight-line rate (velocity) through a point's time series.

        Least squares over all dates with data: rate per year, its standard
        error and R^2, relative to the reference. A line hides steps, seasonal
        cycles and gaps; look at point_timeseries before quoting the rate.
        """
        info = await layer_info(dataset, layer)
        check_point(info, lon, lat)
        labels = info.get("x_values") or []
        if not labels or _n_steps(info) <= 1:
            raise BowserError(
                f"{layer!r} has no time axis to fit a trend to; use value_at_point "
                "(a velocity layer already holds a rate)."
            )
        ref_lon, ref_lat, ref = reference(info, ref_lon, ref_lat, use_cube_reference)
        factor, unit = unit_scale(info.get("unit"))
        if ref_buffer_m > 0 and ref_lon is not None:
            res = await api.post(
                "/multi_point",
                {
                    "points": [{"id": "p", "lon": lon, "lat": lat}],
                    "dataset_name": layer,
                    "ref_lon": ref_lon,
                    "ref_lat": ref_lat,
                    "ref_buffer_m": ref_buffer_m,
                    "calculate_trends": True,
                },
                dataset=dataset,
            )
            t = (res["datasets"] or [{}])[0].get("trend")
            if not t:
                raise BowserError("Too few dates with data at the point for a trend.")
            mm, std, r2 = t["mmPerYear"], t["stdMmPerYear"], t["rSquared"]
            ref["note"] += f" Reference is the median within {ref_buffer_m:g} m."
        else:
            t = await api.get(
                f"/trend_analysis/{layer}",
                lon=lon,
                lat=lat,
                ref_lon=ref_lon,
                ref_lat=ref_lat,
                dataset=dataset,
            )
            mm, std, r2 = t["mm_per_year"], t["std_mm_per_year"], t["r_squared"]
        # Bowser's fit reports mm/yr assuming metres; undo that for other units.
        rate = _num(mm / 1000 if mm is not None else None, factor)
        return {
            "layer": layer,
            "point": [lon, lat],
            "rate_per_year": rate,
            "rate_std_err": _num(std / 1000 if std is not None else None, factor),
            "r_squared": _num(r2),
            "unit": "mm/yr" if factor == 1000.0 else f"{unit} per year",
            "period": [labels[0], labels[-1]],
            "reference": ref,
            "note": "Rate 0 with R^2 0 means fewer than two dates had data. A "
            "small R^2 means the line explains little of the series.",
        }

    @tool
    async def value_at_point(
        lon: Lon,
        lat: Lat,
        layer: Layer = "velocity",
        time_index: Annotated[
            int | None,
            Field(
                ge=0,
                description="Date index for layers with a time axis; omit for "
                "layers without one.",
            ),
        ] = None,
        ref_lon: RefLon = None,
        ref_lat: RefLat = None,
        use_cube_reference: UseCubeReference = True,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Return one value at a point: of a 2-D layer (velocity) or one date.

        For displacement-like layers the reference point's value is subtracted
        (yours, or the cube's); quality layers are given as stored.
        """
        info = await layer_info(dataset, layer)
        check_point(info, lon, lat)
        ref_lon, ref_lat, ref = reference(info, ref_lon, ref_lat, use_cube_reference)
        factor, unit = unit_scale(info.get("unit"))
        labels = info.get("x_values") or []
        if labels and time_index is None:
            raise BowserError(
                f"{layer!r} has {len(labels)} dates: give time_index, or use "
                "point_timeseries for all of them."
            )
        idx = None if time_index is None else min(time_index, max(len(labels) - 1, 0))
        value = (
            await api.get(
                "/point",
                dataset_name=layer,
                lon=lon,
                lat=lat,
                time_idx=idx,
                dataset=dataset,
            )
        )[0]
        if ref_lon is not None and value is not None:
            ref_value = (
                await api.get(
                    "/point",
                    dataset_name=layer,
                    lon=ref_lon,
                    lat=ref_lat,
                    time_idx=idx,
                    dataset=dataset,
                )
            )[0]
            value = None if ref_value is None else value - ref_value
        out = {
            "layer": layer,
            "point": [lon, lat],
            "value": _num(value, factor),
            "unit": unit,
            "reference": ref,
        }
        if labels and idx is not None:
            out["date"] = labels[idx]
        return out

    # --- tools: areas, lines and value ranges -------------------------------------

    @tool
    async def polygon_statistics(
        geometry: Annotated[
            dict[str, Any],
            Field(
                description="GeoJSON Polygon or MultiPolygon in WGS84 lon/lat (a "
                "Feature is accepted too). Rings must be closed."
            ),
        ],
        layer: Layer = "displacement",
        support: Annotated[
            Literal["common", "per_date"],
            Field(
                description="common: only pixels with data on every date, so "
                "dates compare like with like; per_date: every valid pixel on "
                "each date."
            ),
        ] = "common",
        percentiles: Annotated[
            list[float],
            Field(
                min_length=1,
                max_length=20,
                description="Percentiles (0-100) to add to each date.",
            ),
        ] = [10.0, 90.0],
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Summarize the pixels inside a polygon, date by date (full server only).

        Count, median, mean, spatial standard deviation, min, max and
        percentiles of the stored values, per date, as columns aligned with
        `dates`. Values are as stored (relative to the producer's reference),
        not re-referenced to a point, and no quality mask is applied.
        bowser-lite does not do this and says so.
        """
        if geometry.get("type") == "Feature":
            geometry = geometry.get("geometry") or {}
        info = await layer_info(dataset, layer)
        factor, unit = unit_scale(info.get("unit"))
        res = await api.post(
            "/polygon_timeseries",
            {
                "variable": layer,
                "geometry": geometry,
                "support": support,
                "percentiles": percentiles,
            },
            dataset=dataset,
        )
        stats = res["statistics"]
        columns: dict[str, list] = {
            "count": [s["count"] for s in stats],
            **{
                key: [_num(s[key], factor) for s in stats]
                for key in ("median", "mean", "spatial_std", "minimum", "maximum")
            },
        }
        for key in stats[0]["percentiles"] if stats else []:
            columns[f"p{key}"] = [_num(s["percentiles"][key], factor) for s in stats]
        return {
            "layer": layer,
            "unit": unit,
            "dates": res["labels"],
            "support": res["support"],
            "polygon_pixels": res["polygon_pixels"],
            "common_pixels": res["common_pixels"],
            "statistics": columns,
            "warnings": res.get("warnings", []),
            "reference": {
                "point": None,
                "note": "Values as stored (the producer's reference); not "
                "re-referenced to a point and no quality mask applied.",
            },
            "calculation": res.get("calculation"),
        }

    @tool
    async def profile(
        coords: Annotated[
            list[list[float]],
            Field(
                min_length=2,
                description="The line's vertices as [lon, lat] pairs (at least two).",
            ),
        ],
        layer: Layer = "displacement",
        time_index: TimeIndex = 0,
        n_samples: Annotated[
            int, Field(ge=2, le=1000, description="Evenly spaced points.")
        ] = 50,
        radius: Annotated[
            float,
            Field(
                ge=0,
                description="Half-width (m) of a strip around the line; > 0 also "
                "returns the median across the strip at each distance.",
            ),
        ] = 0.0,
        sampling_interval: Annotated[
            float,
            Field(
                ge=0,
                description="Bin length (m) along the line, with radius > 0: each "
                "value is the median of a bin. 0 uses n_samples points.",
            ),
        ] = 0.0,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Return a layer's values along a line at one date, by distance.

        Values are as stored (relative to the producer's reference point and
        date), not re-referenced to a point. Use it to see where a signal starts
        and stops, e.g. across a dam, a fault or a subsidence bowl.
        """
        info = await layer_info(dataset, layer)
        for c in coords:
            if len(c) != 2:
                raise BowserError("Each vertex must be [lon, lat].")
            check_point(info, c[0], c[1], "Vertex")
        factor, unit = unit_scale(info.get("unit"))
        labels = info.get("x_values") or []
        res = await api.post(
            "/profile",
            {
                "coords": coords,
                "dataset_name": layer,
                "time_index": time_index,
                "n_samples": n_samples,
                "radius": radius,
                "n_random": 0,
                "sampling_interval": sampling_interval,
            },
            dataset=dataset,
        )
        centre = res if isinstance(res, list) else res["centre"]
        out: dict[str, Any] = {
            "layer": layer,
            "unit": unit,
            "date": labels[min(time_index, len(labels) - 1)] if labels else None,
            "distance_m": [round(s["dist"], 1) for s in centre],
            "values": [_num(s["value"], factor) for s in centre],
            "reference": {
                "point": None,
                "note": "Values as stored (the producer's reference point and "
                "date); not re-referenced to a point.",
            },
        }
        if isinstance(res, dict):
            out["strip_median"] = [_num(s["value"], factor) for s in res["median"]]
            out["strip_median_distance_m"] = [
                round(s["dist"], 1) for s in res["median"]
            ]
            if res.get("binned"):
                out["bin_width_m"] = res.get("bin_width")
        return out

    @tool
    async def layer_statistics(
        layer: Layer = "displacement",
        time_index: TimeIndex = 0,
        nbins: Annotated[
            int, Field(ge=4, le=256, description="Number of histogram bins.")
        ] = 20,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Return the value range and histogram of a layer at one date.

        Min, max and the 2/16/84/98 percentiles of the valid pixels, and a
        histogram (edges and counts). Values are as stored (the producer's
        reference). A cube that stores its histograms returns those, whose bin
        count may differ from nbins.
        """
        info = await layer_info(dataset, layer)
        factor, unit = unit_scale(info.get("unit"))
        labels = info.get("x_values") or []
        res = await api.get(
            f"/histogram/{layer}",
            time_index=time_index,
            nbins=nbins,
            dataset=dataset,
        )
        return {
            "layer": layer,
            "unit": unit,
            "date": labels[min(time_index, len(labels) - 1)] if labels else None,
            **{
                key: _num(res.get(key), factor)
                for key in ("min", "max", "p2", "p16", "p84", "p98")
            },
            "histogram": {
                "edges": [_num(b, factor) for b in res.get("bins", [])],
                "counts": res.get("counts", []),
            },
            "note": "Valid pixels of the whole cube; no quality mask applied."
            + (" No valid pixels on this date." if not res.get("counts") else ""),
        }

    # --- tools: export -----------------------------------------------------------

    @tool(annotations=ToolAnnotations(readOnlyHint=False, openWorldHint=False))
    async def export_geotiff(
        layer: Layer = "displacement",
        time_index: Annotated[
            int | None,
            Field(ge=0, description="Date index; omit for layers without dates."),
        ] = None,
        ref_lon: Annotated[
            float | None,
            Field(
                ge=-180,
                le=180,
                description="Reference longitude to subtract; omit to keep the "
                "stored reference.",
            ),
        ] = None,
        ref_lat: RefLat = None,
        ref_buffer_m: RefBuffer = 0.0,
        layer_masks: Annotated[
            list[LayerMask] | None,
            Field(description="Masks to apply; masked pixels become nodata."),
        ] = None,
        save_to: Annotated[
            str | None,
            Field(
                description="File or folder to save the GeoTIFF to. Omit to get "
                "a download URL only."
            ),
        ] = None,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Export one date of a layer as a GeoTIFF (full server only).

        Gives the download URL, or saves the file when `save_to` is given (an
        existing file is never overwritten). Masked pixels are nodata; with a
        reference point the reference's value is subtracted. bowser-lite cannot
        write GeoTIFFs and says so.
        """
        if (ref_lon is None) != (ref_lat is None):
            raise BowserError("Give both ref_lon and ref_lat, or neither.")
        config = await api.get("/config", dataset=dataset)
        if not config.get("geotiff_export"):
            raise BowserError(
                "This server cannot export GeoTIFFs (it is bowser-lite, which has "
                "no GDAL). Run the full server (`bowser run`) to export."
            )
        info = await layer_info(dataset, layer)
        if ref_lon is not None and ref_lat is not None:
            check_point(info, ref_lon, ref_lat, "Reference point")
        params: dict[str, Any] = {
            "variable": layer,
            "dataset": dataset,
            "time_idx": time_index,
            "ref_lon": ref_lon,
            "ref_lat": ref_lat,
            "ref_buffer_m": ref_buffer_m or None,
        }
        if layer_masks:
            params["layer_masks"] = json.dumps([m.model_dump() for m in layer_masks])
        url = api.url("/export/geotiff", params)
        out: dict[str, Any] = {"layer": layer, "url": url}
        labels = info.get("x_values") or []
        if labels and time_index is not None:
            out["date"] = labels[min(time_index, len(labels) - 1)]
        if save_to is None:
            out["note"] = "Open the URL to download the GeoTIFF."
            return out
        r = await api.request("GET", "/export/geotiff", params)
        dest = Path(save_to).expanduser()
        if dest.is_dir():
            dest = dest / _filename(r, layer, time_index)
        if dest.exists():
            raise BowserError(f"{dest} exists; give another path.")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        out.update(path=str(dest.resolve()), bytes=len(r.content))
        return out

    return server


def _filename(r: httpx.Response, layer: str, time_index: int | None) -> str:
    disposition = r.headers.get("content-disposition", "")
    if "filename=" in disposition:
        name = disposition.split("filename=")[-1].strip().strip('"')
        if name and "/" not in name and "\\" not in name:
            return name
    return f"{layer}" + ("" if time_index is None else f"_{time_index}") + ".tif"


def _describe(fn) -> str:
    """Return a function's docstring as one tool description (dedented)."""
    return inspect.cleandoc(fn.__doc__ or "")


def lite_transport(stack_file: str) -> httpx.ASGITransport:
    """Open ``stack_file`` in a bowser-lite app in this process.

    Returns a transport for :func:`build_server`, so ``bowser mcp --stack-file``
    needs no separate server. bowser-lite reads its settings from the
    environment when first imported, so this must run before anything else
    imports it. Its start-up messages go to stderr: on the stdio transport,
    stdout carries the MCP messages.
    """
    os.environ["BOWSER_STACK_DATA_FILE"] = str(Path(stack_file).expanduser())
    with contextlib.redirect_stdout(sys.stderr):
        from bowser.lite.main import app  # noqa: PLC0415

    return httpx.ASGITransport(app=app)
