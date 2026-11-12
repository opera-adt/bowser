"""Bowser's data tools for AI assistants, defined once.

Shared by the MCP server (``bowser mcp``, :mod:`bowser.mcp_server`) and the
page's Assistant tab (:mod:`bowser.assistant`), so both offer the same tools
with the same names, descriptions and input schemas. Each tool is a thin call to
Bowser's HTTP API (see docs/rest-api.md) that turns its JSON into a compact
answer a model can read: dates and values, the unit, and a note saying what the
values are relative to. No data is read or computed here; the server does that,
so the tools give the same numbers as the web page.

A tool's input schema is built from its signature the way the MCP SDK builds
it, so this module needs pydantic and httpx but not the ``mcp`` package.
"""

from __future__ import annotations

import functools
import inspect
import json
import math
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel, Field, create_model

from .chart_tools import CHART_COMMANDS, CHART_INSTRUCTIONS, register_chart_tools
from .file_tools import register_file_tools

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
from any producer or sensor, often with quality layers such as temporal
coherence, phase similarity and a recommended mask. These tools read the cube
that a Bowser server has open. Start with server_info and list_layers: they name
the layers, their dates and units, the reference point, what the values measure
and what this server can do (bowser-lite cannot export GeoTIFFs).

Typical flows:
- "Is this place moving?": list_layers -> point_timeseries (or trend_at_point) at
  the point, and the same at a nearby point that should be stable, for comparison.
- "Compare places": multi_point_timeseries with all of them and one reference.
- "How does an area behave?": polygon_statistics, or several points.
- "Where does it change?": profile along a line across the feature at one date.
- "Is the colour scale sensible / how big are values on this date?": layer_statistics.
- "Who and what is affected by motion in X?": go_to X -> deformation_zones (look
  at the velocity's spread first, layer_statistics on velocity, to pick a
  threshold) -> infrastructure_in_area with a zone id ("Z1") -> highlight_infrastructure
  for what the user asked about. clear_highlights removes the drawings.
- "What is around this point?": infrastructure_at (roads, buildings, rail,
  bridges, pipelines, dams, levees within a radius, from OpenStreetMap).
- Read the ground first: before interpreting a time series at a point, call
  site_context there (land cover, geology, wetlands, soil, slope, nearby
  infrastructure and the cube's coherence at the point).
- Context on the map: list_context_layers, then add_context_layer (roads,
  buildings, land cover, geology, soils, GNSS stations...) or
  remove_context_layer, as the Overlays › Services toggles.

Finding places. Each question comes with what the page shows (its view, layer,
reference and points) when a page is open: use it for "here", "this area" or
"the middle of the view" without a tool call (get_view otherwise). For a named
place (a dam, a town, an address) call geocode or go_to first. Never search for
a place by scanning with profile or by sampling points; profile is only for a
line the user asked for. If the place is ambiguous or not found, offer the
geocoder's candidates or ask the user to click it on the map; do not guess. Use
few tool calls: a question has a limited number.

The page tools act on the Bowser page the user has open (on their own computer):
- Moving the map: use go_to for place names and addresses, fly_to for
  coordinates, fit_bounds for an area, pan and zoom for small moves; call
  get_view first if unsure where the user is looking. geocode only looks a place
  up (no page needed).
- The reference: to change it, use set_reference_point (radius_m samples a
  circle around it); to choose a good one, use find_reference_candidates and
  then set_reference_point with the recommended lon/lat and radius_m.
  get_reference and reset_reference read and undo it.
- Masks: get_masks, set_masks, clear_masks, set_recommended_mask. Mode min keeps
  pixels >= threshold, mode max keeps pixels <= threshold; say how you read the
  user's words. The data tools apply the page's masks by default.
- Display: get_display, set_colormap, set_color_range (presets for 'one sigma',
  'two sigma', 2-98%, full, symmetric), set_opacity, set_split_screen,
  set_terrain.
- For a toolbar or panel option not covered by a specific tool, call
  list_commands, then run_command. Ask the user before a command marked
  destructive.

What the numbers are. What a value measures (along the radar line of sight,
vertical, east-west...), what its sign means and which directions of motion it
is sensitive to differ between products and are given in server_info's
measurement section, read from the cube's metadata. Use those; when they are
unknown, say so and do not assume them. A line-of-sight value can be vertical
motion, horizontal motion or both. Values are relative, not
absolute: relative to a reference point (the point is assumed stable, which is not
guaranteed) and to a reference date (which can be before the first date shown,
so a series need not start at 0). Every result says which reference was used.
Changing the reference point changes every value; a moving reference makes
stable ground look like it moves. Lengths stored in metres are given in mm,
rates in mm/yr.

Reading a time series: never interpret displacement from the curve alone. First
establish what is on the ground at that point (site_context; or ask the user, or
use other tools you have for snow, earthquakes, wells or GNSS),
and the quality there (temporal_coherence, phase_similarity or recommended_mask at
the same point), then say which effects could explain the signal and how sure you
are. Wetlands, flooded vegetation, irrigated fields and watered turf can bias the
phase and look like seasonal motion or slow sinking. Snow can cause jumps or gaps.
Bedrock is expected to be stable, so a large trend there needs an explanation
(slope motion, mining, the reference point, atmosphere, unwrapping errors).
Unconsolidated sediment can compact (compare wells and pumping); peat can really
subside; expansive clay swells and shrinks with moisture. Seasonal cycles can be
groundwater, soil moisture, snow, thermal expansion or atmosphere. Sudden lasting
offsets of about half the radar wavelength (server_info's measurement gives it
when the cube records it) or a multiple of it are likely unwrapping errors,
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
damaged, unsafe or at risk. A pixel is typically tens of metres across, so it
does not describe a single structure.
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
Side = Annotated[
    Literal["left", "right"],
    Field(
        description="Which layer: left is the main layer; right is the split "
        "screen's right layer."
    ),
]
UsePageMasks = Annotated[
    bool,
    Field(
        description="Apply the open page's layer masks (as its map and chart "
        "do), so the answer matches what the user sees; false reads unmasked "
        "values. Without a connected page nothing is masked. The result's "
        "`masks` says what was applied."
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


#: The context layers of Overlays › Services (src/map/contextServices.ts).
CONTEXT_LAYER_IDS = (
    "roads",
    "boundaries",
    "buildings",
    "land_cover",
    "geology",
    "soils",
    "gnss",
)
ContextLayerId = Annotated[
    Literal[
        "roads", "boundaries", "buildings", "land_cover", "geology", "soils", "gnss"
    ],
    Field(
        description="Context layer id (list_context_layers): roads (with railways), "
        "boundaries, buildings, land_cover, geology, soils or gnss."
    ),
]
#: The kinds of infrastructure the tools look up (OpenStreetMap).
KIND_NAMES = ("roads", "buildings", "rail", "bridges", "pipelines", "dams", "levees")
InfraKind = Literal[
    "roads", "buildings", "rail", "bridges", "pipelines", "dams", "levees"
]
Kinds = Annotated[
    list[InfraKind] | None,
    Field(
        min_length=1,
        description="Kinds to look up; omit for all of roads, buildings, rail, "
        "bridges, pipelines, dams and levees.",
    ),
]
ShowOnMap = Annotated[
    bool,
    Field(
        description="Also draw what was found on the open page, as a highlight "
        "layer (when a page is connected)."
    ),
]
AreaGeometry = Annotated[
    dict[str, Any] | None,
    Field(description="GeoJSON Polygon or MultiPolygon (or Feature), lon/lat."),
]
AreaBbox = Annotated[
    list[float] | None,
    Field(
        min_length=4, max_length=4, description="[west, south, east, north], lon/lat."
    ),
]
AreaName = Annotated[
    str | None,
    Field(
        max_length=120,
        description="Name of a shape drawn on the page or of a chart area (get_areas).",
    ),
]
ZoneId = Annotated[
    str | None,
    Field(
        max_length=80,
        description='A zone of deformation_zones: "Z1" (latest zones) or its '
        '"<zones_id>/Z1".',
    ),
]
EXPOSURE_NOTE = (
    "Being in or near moving ground says nothing about the condition of any "
    "feature: never call a road, building or structure damaged, unsafe or at "
    "risk from this; motion must be confirmed by a qualified expert."
)


def _downslope_in_los(
    terrain: dict, los: dict | None, kind: str = "unknown"
) -> dict[str, Any]:
    """How much of a downslope motion the cube's line of sight sees (+ = towards)."""
    slope = terrain.get("slope_deg")
    aspect = terrain.get("aspect_deg")
    if slope is None or aspect is None or slope < 2:
        return {}
    if kind not in ("line_of_sight", "unknown"):
        return {
            "downslope_seen_in_los": None,
            "downslope_note": f"The cube's values are {kind.replace('_', '-')} "
            "motion, not along a line of sight (server_info's measurement).",
        }
    if not los or not all(k in los for k in ("east", "north", "up")):
        return {
            "downslope_seen_in_los": None,
            "downslope_note": "The cube gives no look direction.",
        }
    s, a = math.radians(slope), math.radians(aspect)
    down = (math.cos(s) * math.sin(a), math.cos(s) * math.cos(a), -math.sin(s))
    share = down[0] * los["east"] + down[1] * los["north"] + down[2] * los["up"]
    return {
        "downslope_seen_in_los": round(share, 2),
        "downslope_note": "Share of a downslope movement seen along the line of "
        "sight (1 = all of it, as motion towards the satellite; negative = away), "
        "with the cube's look direction. The sign of the values themselves is "
        "in server_info's measurement.",
    }


def _measurement_summary(all_layers: dict[str, dict]) -> dict[str, Any]:
    """Summarise what the cube's values measure, from ``/datasets`` per layer.

    The displacement layer's (else the first measured layer's), with the other
    layers that measure the same and, under ``differs_in``, those that do not
    (a cube can hold line-of-sight and vertical layers).
    """
    measured = {
        n: i["measurement"] for n, i in all_layers.items() if i.get("measurement")
    }
    if not measured:
        return {
            "layer": None,
            "kind": "unknown",
            "summary": "No layer of this cube is recorded as measuring motion, so "
            "what its values measure, their sign and sensitivity are unknown.",
        }
    main = "displacement" if "displacement" in measured else next(iter(measured))
    first = measured[main]

    def same(m: dict) -> bool:
        return (m.get("kind"), m.get("positive_direction")) == (
            first.get("kind"),
            first.get("positive_direction"),
        )

    out: dict[str, Any] = {
        "layer": main,
        **first,
        "same_for": [n for n, m in measured.items() if n != main and same(m)],
    }
    differ = {
        n: {k: m.get(k) for k in ("kind", "positive_direction", "summary")}
        for n, m in measured.items()
        if not same(m)
    }
    if differ:
        out["differs_in"] = differ
    return out


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
        headers: dict[str, str] | None = None,
        page_token: str | None = None,
    ) -> None:
        """Set up a client for the server at ``base_url`` (or ``transport``).

        ``headers`` go with every request (the Assistant passes on the page's
        Authorization header, so a server behind Basic Auth answers its tools).
        ``page_token`` lets the page tools act on the open page (see
        :mod:`bowser.page_token`); without it, ``BOWSER_PAGE_TOKEN`` or the
        server's token file (when the server runs on this computer) is used.
        """
        self.base_url = base_url.rstrip("/")
        self._page_token = page_token
        #: The page's layer masks, when the caller knows them (the Assistant).
        self.page_masks: list[dict[str, Any]] | None = None
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            transport=transport,
            timeout=timeout,
            headers=headers,
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

    async def page(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Run page tool ``name`` on the user's open page; return its answer.

        Goes through the server's page channel (``POST /page/command``). Raises
        BowserError with the server's or the page's message: no page open, not
        allowed on this server, the page did not answer, or the page refused.
        """
        from . import page_token  # noqa: PLC0415

        token = (
            self._page_token
            or os.environ.get(page_token.ENV)
            or page_token.for_url(self.base_url)
        )
        headers = {}
        if token:
            # Keep an Authorization header the server needs (Basic Auth).
            if "authorization" in self._client.headers:
                headers[page_token.HEADER] = token
            else:
                headers["Authorization"] = f"Bearer {token}"
        try:
            r = await self._client.post(
                "/page/command", json={"name": name, "input": args}, headers=headers
            )
        except httpx.TransportError as e:
            raise BowserError(
                f"Cannot reach the Bowser server at {self.base_url} "
                f"({type(e).__name__})."
            ) from e
        if r.status_code >= 400:
            raise BowserError(_detail(r))
        answer = r.json()
        if not answer.get("ok"):
            raise BowserError(answer.get("error") or "The page could not do that.")
        result = answer.get("result")
        return result if isinstance(result, dict) else {"result": result}

    async def current_page_masks(self) -> list[dict[str, Any]] | None:
        """Return the page's layer masks for the API, or None without a page.

        The Assistant sets :attr:`page_masks` from the chat request; otherwise the
        open page is asked (``get_masks``).
        """
        if self.page_masks is not None:
            return self.page_masks
        try:
            res = await self.page("get_masks", {"layer_ranges": False})
        except BowserError:
            return None
        return [
            {"dataset": m["layer"], "threshold": m["threshold"], "mode": m["mode"]}
            for m in res.get("masks") or []
            if isinstance(m, dict) and {"layer", "threshold", "mode"} <= set(m)
        ]

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


@dataclass
class ToolSpec:
    """One data tool: its name, description and implementation.

    The input schema comes from the implementation's signature (see
    :attr:`input_schema`); ``read_only`` is false for a tool that writes (an
    export saved to disk).
    """

    name: str
    description: str
    fn: Callable[..., Awaitable[dict[str, Any]]]
    read_only: bool = True
    #: Runs on the user's open page (the page channel, or the Assistant's page).
    page: bool = False
    #: Offered by ``bowser mcp`` (false for a tool only the Assistant's page has).
    mcp: bool = True
    #: Talks to a service outside Bowser (the geocoder).
    open_world: bool = False
    #: Runs without asking the user first: it only reads, or only moves the map.
    #: (A signed-in agent's permission requests for it are answered at once.)
    quiet: bool | None = None
    #: What the tool is doing, for a status line ("Reading the time series");
    #: empty: made from the name (:attr:`status_text`).
    status: str = ""

    def __post_init__(self) -> None:
        """Tools that only read are quiet unless said otherwise."""
        if self.quiet is None:
            self.quiet = self.read_only

    @property
    def status_text(self) -> str:
        """Return the status line: :attr:`status`, or the name in words."""
        return self.status or self.name.replace("_", " ").capitalize()

    @functools.cached_property
    def arg_model(self) -> type[BaseModel]:
        """Return the pydantic model of the arguments, built as the MCP SDK does."""
        return arguments_model(self.fn)

    @property
    def input_schema(self) -> dict[str, Any]:
        """Return the JSON schema of the arguments."""
        return self.arg_model.model_json_schema(by_alias=True)

    async def call(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Validate ``arguments`` against the schema and run the tool.

        Raises pydantic's ``ValidationError`` for arguments that do not fit the
        schema and :class:`BowserError` for an expected failure.
        """
        args = self.arg_model.model_validate(arguments)
        return await self.fn(
            **{name: getattr(args, name) for name in type(args).model_fields}
        )


def arguments_model(fn: Callable[..., Any]) -> type[BaseModel]:
    """Return a pydantic model of ``fn``'s parameters, named ``<fn>Arguments``.

    The same construction as the MCP SDK's ``func_metadata``, so the schema an
    MCP client sees and the one the Assistant sends to a model are identical
    (tests/test_assistant.py checks this).
    """
    fields: dict[str, Any] = {}
    for param in inspect.signature(fn, eval_str=True).parameters.values():
        annotation = (
            Any if param.annotation is inspect.Parameter.empty else param.annotation
        )
        field: Any = Annotated[annotation, Field()]  # type: ignore[valid-type]
        fields[param.name] = (
            field
            if param.default is inspect.Parameter.empty
            else (field, param.default)
        )
    return create_model(f"{fn.__name__}Arguments", **fields)


def build_tools(api: BowserAPI) -> list[ToolSpec]:
    """Return Bowser's data tools, each calling the server behind ``api``.

    Parameters
    ----------
    api : BowserAPI
        Client for a running Bowser server (or an app in this process).

    Returns
    -------
    list[ToolSpec]
        The tools in a fixed order: what is there, time series, areas and
        lines, export.

    """
    specs: list[ToolSpec] = []

    def tool(
        fn=None,
        *,
        read_only: bool = True,
        page: bool = False,
        mcp: bool = True,
        open_world: bool = False,
        status: str = "",
    ):
        """Register ``fn`` with its docstring as the description."""

        def register(fn):
            specs.append(
                ToolSpec(
                    fn.__name__,
                    _describe(fn),
                    fn,
                    read_only,
                    page=page,
                    mcp=mcp,
                    open_world=open_world,
                    status=status,
                )
            )
            return fn

        return register(fn) if fn is not None else register

    def page_tool(
        fn=None,
        *,
        read_only: bool = False,
        mcp: bool = True,
        quiet: bool = False,
        open_world: bool = False,
        status: str = "",
    ):
        """Register a tool that runs on the page (see :data:`PAGE_COMMANDS`)."""

        def register(fn):
            specs.append(
                ToolSpec(
                    fn.__name__,
                    _describe(fn),
                    fn,
                    read_only,
                    page=True,
                    mcp=mcp,
                    open_world=open_world,
                    quiet=quiet or read_only,
                    status=status,
                )
            )
            return fn

        return register(fn) if fn is not None else register

    async def on_page(tool_name: str, /, **args: Any) -> dict[str, Any]:
        """Run page tool ``tool_name`` on the open page (None arguments left out)."""
        return await api.page(
            tool_name, {k: v for k, v in args.items() if v is not None}
        )

    async def page_masks(use: bool, given: list[LayerMask] | None):
        """Return ``(masks for the API, a note on them)`` for a data tool."""
        if given:
            masks = [m.model_dump() for m in given]
            return masks, {"applied": masks, "source": "argument"}
        if not use:
            return [], {"applied": [], "source": "none", "note": "Unmasked values."}
        current = await api.current_page_masks()
        if current is None:
            return [], {
                "applied": [],
                "source": "none",
                "note": "No Bowser page is connected: values are unmasked.",
            }
        return current, {
            "applied": current,
            "source": "page",
            "note": "The page's masks (as on its map and chart): dates where a "
            "mask fails at the point are left out."
            if current
            else "The page has no masks: values are unmasked.",
        }

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

    @tool(status="Asking the server what it serves")
    async def server_info(dataset: Dataset = None) -> dict[str, Any]:
        """Return what the Bowser server serves and can do.

        Returns the page title, the server kind (full or lite), the data mode
        (md = GeoZarr cube, cog = GeoTIFF stack), whether polygon statistics and
        GeoTIFF export work, the catalog of datasets when the server has one
        (pass an id as `dataset` to the other tools), and `measurement`: what
        the values measure (line of sight, vertical...), their sign, which
        directions of motion they are sensitive to and half the radar
        wavelength, from the cube's metadata (unknown when it does not say).
        Call this first.
        """
        config = await api.get("/config", dataset=dataset)
        mode = await api.get("/mode", dataset=dataset)
        catalog = await api.get("/catalog")
        try:
            measurement = _measurement_summary(await layers(dataset))
        except BowserError as e:
            measurement = {"kind": "unknown", "summary": f"Not read: {e}"}
        full = bool(config.get("geotiff_export"))
        unsupported = [
            name
            for name, ok in (
                ("polygon_statistics", config.get("polygon_stats")),
                ("export_geotiff", config.get("geotiff_export")),
                ("convert_to_cog", config.get("geotiff_export")),
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
            "measurement": measurement,
            "note": "Without a catalog, the server serves one cube; omit `dataset`."
            if not catalog.get("datasets")
            else "Pass a catalog id as `dataset` to the other tools.",
        }

    @tool(status="Listing the layers")
    async def list_layers(dataset: Dataset = None) -> dict[str, Any]:
        """List the cube's layers, with dates, units and reference information.

        For each layer: label, unit (as stored, and the unit the tools report),
        number of dates with the first and last, whether it is a displacement-like
        layer re-referenced to a point (`relative_to_reference_point`), the
        producer's description and, for layers of motion, what they measure
        (`measures`; details in server_info's measurement). Also the cube's area
        (west, south, east, north), reference point, reference date and radar
        look geometry.
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
            if m := info.get("measurement"):
                sign = m.get("positive_direction")
                entry["measures"] = m.get("kind", "unknown").replace("_", " ") + (
                    f", positive {sign}" if sign else ", sign not recorded"
                )
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

    @tool(status="Reading the time series")
    async def point_timeseries(
        lon: Lon,
        lat: Lat,
        layer: Layer = "displacement",
        ref_lon: RefLon = None,
        ref_lat: RefLat = None,
        ref_buffer_m: RefBuffer = 0.0,
        use_cube_reference: UseCubeReference = True,
        use_page_masks: UsePageMasks = True,
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
        masks, mask_note = await page_masks(use_page_masks, None)
        buffered = ref_buffer_m > 0 and ref_lon is not None
        if buffered or masks:
            res = await api.post(
                "/multi_point",
                {
                    "points": [{"id": "p", "lon": lon, "lat": lat}],
                    "dataset_name": layer,
                    "ref_lon": ref_lon,
                    "ref_lat": ref_lat,
                    "ref_buffer_m": ref_buffer_m if buffered else 0.0,
                    "layer_masks": masks,
                },
                dataset=dataset,
            )
            if not res["datasets"]:
                raise BowserError(f"Bowser could not read {layer!r} at the point.")
            labels, data = res["labels"], res["datasets"][0]["data"]
            if buffered:
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
            "masks": mask_note,
        }
        if values:
            out["summary"] = (
                f"{len(dates)} of {len(labels)} dates from {dates[0]} to "
                f"{dates[-1]}; last value {values[-1]} {unit}."
            )
        else:
            out["summary"] = "No valid data at this point (masked or nodata)."
        return out

    @tool(status="Reading the time series")
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
                "the point, as the page's masks do. Given, these replace the "
                "page's masks."
            ),
        ] = None,
        use_page_masks: UsePageMasks = True,
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
        masks, mask_note = await page_masks(use_page_masks, layer_masks)
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
                "layer_masks": masks,
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
            "masks": mask_note,
        }

    @tool(status="Fitting the trend")
    async def trend_at_point(
        lon: Lon,
        lat: Lat,
        layer: Layer = "displacement",
        ref_lon: RefLon = None,
        ref_lat: RefLat = None,
        ref_buffer_m: RefBuffer = 0.0,
        use_cube_reference: UseCubeReference = True,
        use_page_masks: UsePageMasks = True,
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
        masks, mask_note = await page_masks(use_page_masks, None)
        buffered = ref_buffer_m > 0 and ref_lon is not None
        if buffered or masks:
            res = await api.post(
                "/multi_point",
                {
                    "points": [{"id": "p", "lon": lon, "lat": lat}],
                    "dataset_name": layer,
                    "ref_lon": ref_lon,
                    "ref_lat": ref_lat,
                    "ref_buffer_m": ref_buffer_m if buffered else 0.0,
                    "calculate_trends": True,
                    "layer_masks": masks,
                },
                dataset=dataset,
            )
            t = (res["datasets"] or [{}])[0].get("trend")
            if not t:
                raise BowserError("Too few dates with data at the point for a trend.")
            mm, std, r2 = t["mmPerYear"], t["stdMmPerYear"], t["rSquared"]
            if buffered:
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
            "masks": mask_note,
            "note": "Rate 0 with R^2 0 means fewer than two dates had data. A "
            "small R^2 means the line explains little of the series.",
        }

    @tool(status="Reading the value")
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

    @tool(status="Computing the area's statistics")
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
        """Summarize the pixels inside a polygon, date by date.

        Count, median, mean, spatial standard deviation, min, max and
        percentiles of the stored values, per date, as columns aligned with
        `dates`. Values are as stored (relative to the producer's reference),
        not re-referenced to a point, and no quality mask is applied.
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

    @tool(status="Reading the profile")
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
        date), not re-referenced to a point. Only for an explicit cross-section
        the user asked for (where a signal starts and stops across a dam, a
        fault or a subsidence bowl), never to find a feature or a place: for a
        named place use geocode or go_to.
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

    @tool(status="Computing the layer's statistics")
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

    @tool(read_only=False, status="Exporting the GeoTIFF")
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

    # --- tools: choosing a reference point ----------------------------------------

    @tool(status="Finding a stable reference (the first run reads the whole stack)")
    async def find_reference_candidates(
        radius_m: Annotated[
            float,
            Field(
                ge=0,
                le=5000,
                description="Radius (m) of the circle scored around each pixel.",
            ),
        ] = 100.0,
        n: Annotated[
            int, Field(ge=1, le=50, description="Most candidates to return.")
        ] = 5,
        min_separation_m: Annotated[
            float | None,
            Field(
                ge=0,
                description="Least distance (m) between candidates; omit for the "
                "server's default.",
            ),
        ] = None,
        use_masks: Annotated[
            bool,
            Field(
                description="Apply the cube's recommended mask to the pixels "
                "considered."
            ),
        ] = False,
        coherence_min: Annotated[
            float | None,
            Field(
                ge=0,
                le=1,
                description="Least median temporal coherence; omit for the top "
                "quantile.",
            ),
        ] = None,
        similarity_min: Annotated[
            float | None,
            Field(
                ge=0,
                le=1,
                description="Least median phase similarity; omit for the top quantile.",
            ),
        ] = None,
        quantile: Annotated[
            float,
            Field(
                gt=0,
                lt=1,
                description="Keep pixels whose medians are in this top quantile "
                "of the cube.",
            ),
        ] = 0.95,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Find stable places to put the InSAR reference point, in one call.

        For every pixel the server takes the median and standard deviation, over
        the whole stack, of temporal coherence and phase similarity (water
        excluded). It keeps pixels whose medians are in the cube's top 5% (or above
        coherence_min / similarity_min), then scores a circle of radius_m around
        each (the share of viable pixels × the mean score) and checks how much the
        displacement inside the circle scatters. It returns up to n spaced
        candidates with their stats, velocity and a reason, plus the thresholds
        used and the stack's distribution. To use the best one, call
        set_reference_point with the recommended candidate's lon, lat and
        radius_m. Coherence is not stability: mention the candidate's velocity and
        what is on the ground (a dam or building can be coherent and moving), and
        offer the other candidates. The first call on a cube reads the whole stack
        (tens of seconds); later calls take seconds.
        """
        params = {
            "radius_m": radius_m,
            "n": n,
            "min_separation_m": min_separation_m,
            "use_masks": str(use_masks).lower(),
            "coherence_min": coherence_min,
            "similarity_min": similarity_min,
            "quantile": quantile,
            "dataset": dataset,
        }
        try:
            r = await api._client.get(
                "/reference_candidates",
                params={k: v for k, v in params.items() if v is not None},
                timeout=max(api._client.timeout.read or 0, 300.0),
            )
        except httpx.TransportError as e:
            raise BowserError(
                f"Cannot reach the Bowser server at {api.base_url} "
                f"({type(e).__name__})."
            ) from e
        if r.status_code >= 400:
            detail = _detail(r)
            if r.status_code == 404 and detail == "Not Found":
                raise BowserError("This Bowser server has no reference finder.")
            raise BowserError(detail)
        res = r.json()
        keys = (
            "rank",
            "lon",
            "lat",
            "radius_m",
            "temporal_coherence_median",
            "phase_similarity_median",
            "viable_fraction",
            "displacement_scatter_m",
            "velocity",
            "reason",
        )
        return {
            "recommended": res.get("recommended"),
            "candidates": [
                {k: c.get(k) for k in keys if k in c}
                for c in res.get("candidates") or []
            ],
            "thresholds": res.get("thresholds"),
            "distribution": res.get("distribution"),
            "note": "Use set_reference_point with the recommended candidate's lon, "
            "lat and radius_m; say its velocity and what is on the ground there.",
        }

    # --- tools: places (no page needed) -----------------------------------------

    @tool(open_world=True, status="Looking up the place")
    async def geocode(
        query: Annotated[
            str,
            Field(
                min_length=1,
                max_length=200,
                description="Place name or address, e.g. 'Arkabutla Dam, "
                "Mississippi' or '1600 Pennsylvania Ave, Washington DC'.",
            ),
        ],
        limit: Annotated[
            int, Field(ge=1, le=10, description="Most candidates to return.")
        ] = 5,
    ) -> dict[str, Any]:
        """Find a place name or address: candidates with lon/lat and a bounding box.

        Best first, each with `name`, `lon`, `lat`, `bbox` [west, south, east,
        north] and `kind`. From OpenStreetMap's Nominatim (credit it when you
        quote a result). Needs no open page; to move the map there use go_to.
        """
        res = await api.get("/geocode", q=query, limit=limit)
        return {
            **res,
            "note": "Coordinates are WGS84 lon/lat; bbox is [west, south, east, "
            "north]." + ("" if res.get("results") else " Nothing was found."),
        }

    # --- tools: what is on the ground (context and infrastructure) -------------------

    async def drawn(
        result_id: str, name: str, color: str | None, show: bool, n: int = 1
    ) -> dict:
        """Draw a kept result on the page when asked and a page is connected."""
        if not show:
            return {"on_map": False, "note": "show_on_map was false."}
        if not n:
            return {"on_map": False, "note": "Nothing found, so nothing drawn."}
        try:
            res = await api.page(
                "draw_highlight",
                {
                    k: v
                    for k, v in (
                        ("result_id", result_id),
                        ("name", name),
                        ("color", color),
                    )
                    if v is not None
                },
            )
        except BowserError as e:
            return {
                "on_map": False,
                "note": f"Not drawn: {e} Without a connected page, describe the "
                "result instead.",
            }
        return {
            "on_map": True,
            "layer": res.get("name") or name,
            "note": "Drawn as a highlight layer (Overlays › Layers); "
            "clear_highlights removes it.",
        }

    async def infra_query(body: dict[str, Any], kinds_given: bool) -> dict:
        """Ask POST /infrastructure, without buildings if they make it too large.

        Only when the kinds were the default; the answer says so.
        """
        try:
            return await api.post("/infrastructure", body)
        except BowserError as e:
            if kinds_given or "too large for buildings" not in str(e):
                raise
            body = {**body, "kinds": [k for k in body["kinds"] if k != "buildings"]}
            res = await api.post("/infrastructure", body)
            res["note"] = (
                "Buildings were left out: the area is too large for them (their box "
                "must be at most 60 km²); ask for a smaller area. " + res["note"]
            )
            return res

    def infra_answer(res: dict, drawn_note: dict) -> dict:
        return {
            "where": res["where"],
            "area_m2": res["area_m2"],
            "kinds": res["kinds"],
            "summary": res["summary"],
            "text": res["text"],
            "result_id": res["result_id"],
            "map": drawn_note,
            "attribution": res["attribution"],
            "note": res["note"] + " " + EXPOSURE_NOTE,
        }

    @page_tool(read_only=True, status="Listing the context layers")
    async def list_context_layers() -> dict[str, Any]:
        """List the context layers of Overlays › Services, and which are on.

        Each with its id (for add_context_layer / remove_context_layer), label,
        what it shows and its source: roads and railways, admin boundaries,
        buildings (3D), land cover, geology, soils and GNSS stations. Also lists
        the highlight layers the tools drew (clear_highlights removes them).
        """
        return await on_page("list_context_layers")

    @page_tool(status="Adding the context layer")
    async def add_context_layer(
        id: ContextLayerId,  # noqa: A002  (the layer's id, as the model sees it)
        opacity: Annotated[
            float | None,
            Field(ge=0, le=1, description="0-1; omit for the toggle's default."),
        ] = None,
        year: Annotated[
            int | None,
            Field(
                ge=2017,
                le=2025,
                description="Land cover only: the year (default the latest).",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Turn on a context layer of Overlays › Services, as its toggle does.

        Roads (with railways), boundaries, buildings (from zoom 13; tilt the map
        for heights), land cover (a year), geology, soils (loaded for the view:
        zoom in first) or GNSS stations (found in the view). Already on: only
        the opacity changes. Returns the layer and the page's message.
        """
        return await on_page("add_context_layer", id=id, opacity=opacity, year=year)

    @page_tool(status="Removing the context layer")
    async def remove_context_layer(
        id: ContextLayerId,  # noqa: A002  (the layer's id, as the model sees it)
    ) -> dict[str, Any]:
        """Turn off a context layer of Overlays › Services, as its toggle does."""
        return await on_page("remove_context_layer", id=id)

    @tool(open_world=True, status="Looking up OpenStreetMap")
    async def infrastructure_at(
        lon: Lon,
        lat: Lat,
        radius_m: Annotated[
            float,
            Field(gt=0, le=5000, description="Radius of the circle (m)."),
        ] = 500.0,
        kinds: Kinds = None,
        show_on_map: ShowOnMap = True,
    ) -> dict[str, Any]:
        """Find the infrastructure within a radius of a point (OpenStreetMap).

        Per kind (roads, buildings, rail, bridges, pipelines, dams, levees): the
        count, the length inside by class, building count, footprint and types,
        and the named features. Draws them on the page as a highlight layer
        when a page is connected (show_on_map). Being near moving ground says
        nothing about the condition of any feature.
        """
        body = {
            "point": [lon, lat],
            "radius_m": radius_m,
            "kinds": list(kinds or KIND_NAMES),
        }
        res = await infra_query(body, kinds is not None)
        note = await drawn(
            res["result_id"],
            f"Infrastructure within {radius_m:g} m",
            None,
            show_on_map,
            res["n_features"],
        )
        return infra_answer(res, note)

    @tool(open_world=True, status="Looking up OpenStreetMap")
    async def infrastructure_in_area(
        geometry: AreaGeometry = None,
        bbox: AreaBbox = None,
        area: AreaName = None,
        zone: ZoneId = None,
        kinds: Kinds = None,
        show_on_map: ShowOnMap = True,
        list_limit: Annotated[
            int, Field(ge=0, le=50, description="Named features listed per kind.")
        ] = 10,
    ) -> dict[str, Any]:
        """Find the infrastructure in an area (OpenStreetMap), and draw it.

        Give one area: a GeoJSON polygon, a bbox, the name of a shape drawn on
        the page or of a chart area (area; see get_areas), or a deformation zone
        (zone: "Z1" from deformation_zones). Per kind: count, length inside by
        class (lines are clipped to the area), building count, footprint and
        types, named features. Buildings need a small area (box up to 60 km²).
        Draws them when a page is connected (show_on_map). Never say a feature
        is damaged or at risk from this.
        """
        given = [
            k
            for k, v in (
                ("geometry", geometry),
                ("bbox", bbox),
                ("area", area),
                ("zone", zone),
            )
            if v is not None
        ]
        if len(given) != 1:
            raise BowserError("Give one of geometry, bbox, area or zone.")
        body: dict[str, Any] = {
            "kinds": list(kinds or KIND_NAMES),
            "list_limit": list_limit,
        }
        label = "Infrastructure in the area"
        if area is not None:
            found = await on_page("get_areas", name=area)
            body["geometry"] = found["geometry"]
            label = f"Infrastructure in {found.get('name') or area}"
        elif zone is not None:
            body["zone"] = zone
            label = f"Infrastructure in zone {zone}"
        elif bbox is not None:
            body["bbox"] = bbox
        else:
            body["geometry"] = geometry
        res = await infra_query(body, kinds is not None)
        note = await drawn(
            res["result_id"], label, None, show_on_map, res["n_features"]
        )
        return infra_answer(res, note)

    @page_tool(open_world=True, status="Drawing the infrastructure")
    async def highlight_infrastructure(
        kinds: Annotated[
            list[InfraKind],
            Field(min_length=1, description="What to draw, e.g. ['roads']."),
        ],
        geometry: AreaGeometry = None,
        bbox: AreaBbox = None,
        area: AreaName = None,
        zone: ZoneId = None,
        color: Annotated[
            str | None,
            Field(
                pattern=r"^#[0-9A-Fa-f]{6}$",
                description="Line and fill colour, #rrggbb; omit for orange.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Draw the infrastructure of an area on the page, in a highlight layer.

        The area as for infrastructure_in_area (one of geometry, bbox, area or
        zone). The layer is named for what it shows and listed in Overlays ›
        Layers; clear_highlights removes it (or every highlight). Returns how
        many features were drawn, per kind.
        """
        given = [v for v in (geometry, bbox, area, zone) if v is not None]
        if len(given) != 1:
            raise BowserError("Give one of geometry, bbox, area or zone.")
        return await on_page(
            "highlight_infrastructure",
            kinds=kinds,
            geometry=geometry,
            bbox=bbox,
            area=area,
            zone=zone,
            color=color,
        )

    @page_tool(status="Clearing the highlights")
    async def clear_highlights(
        name: Annotated[
            str | None,
            Field(
                max_length=120,
                description="One highlight layer's name; omit to remove them all.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Remove the highlight layers the tools drew (all, or one by name)."""
        return await on_page("clear_highlights", name=name)

    @page_tool(read_only=True, status="Reading the drawn areas")
    async def get_areas(
        name: Annotated[
            str | None,
            Field(
                max_length=120,
                description="A shape's or chart area's name; omit to list them.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """List the shapes drawn on the page and the chart's areas, or get one.

        Without name: their names and kinds. With name: that one's GeoJSON
        geometry (lon/lat), to pass to the area tools.
        """
        return await on_page("get_areas", name=name)

    @tool(status="Finding moving zones")
    async def deformation_zones(
        threshold_mm_yr: Annotated[
            float,
            Field(
                gt=0,
                description="Rate |mm/yr| a zone's cells must reach; check the "
                "layer's spread first (layer_statistics on velocity).",
            ),
        ],
        min_area_m2: Annotated[
            float, Field(ge=0, description="Leave out zones smaller than this (m²).")
        ] = 0.0,
        bbox: AreaBbox = None,
        sign: Annotated[
            Literal["both", "negative", "positive"],
            Field(
                description="negative: away from the satellite (subsidence on most "
                "passes); positive: towards it; both."
            ),
        ] = "both",
        layer: Annotated[
            str | None,
            Field(
                description="Rate layer; omit for velocity, or a straight-line rate "
                "fitted to displacement when the cube has no velocity."
            ),
        ] = None,
        coherence_min: Annotated[
            float | None,
            Field(
                ge=0,
                le=1,
                description="Leave out cells whose median temporal coherence is "
                "below this (e.g. 0.5).",
            ),
        ] = None,
        max_zones: Annotated[
            int, Field(ge=1, le=200, description="The largest zones kept.")
        ] = 20,
        include_geometry: Annotated[
            bool,
            Field(
                description="Return each zone's polygon (long); ids are enough "
                "for the area tools."
            ),
        ] = False,
        show_on_map: ShowOnMap = True,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Find the connected areas where the cube's rate passes a threshold.

        From the cube's velocity layer, or a rate fitted to its displacement
        (`source` says which). Each zone: id (Z1 = largest), direction
        (negative = away from the satellite), area, mean, median and peak rate
        (mm/yr), centroid and box. Pass a zone id to infrastructure_in_area or
        highlight_infrastructure. Draws the zones when a page is connected.
        Rates are relative to the producer's reference; a noisy or incoherent
        area can form zones too, so use coherence_min and look at the series.
        """
        res = await api.get(
            "/deformation_zones",
            threshold_mm_yr=threshold_mm_yr,
            min_area_m2=min_area_m2,
            bbox=",".join(f"{v:g}" for v in bbox) if bbox else None,
            sign=sign,
            layer=layer,
            coherence_min=coherence_min,
            max_zones=max_zones,
            dataset=dataset,
        )
        zones_out = []
        for f in res["zones"]["features"]:
            z = dict(f["properties"])
            if include_geometry:
                z["geometry"] = f["geometry"]
            zones_out.append(z)
        note = await drawn(
            res["result_id"],
            f"Zones |rate| >= {threshold_mm_yr:g} {res['unit']}",
            None,
            show_on_map,
            len(zones_out),
        )
        biggest = zones_out[0] if zones_out else None
        return {
            "source": res["source"],
            "threshold": threshold_mm_yr,
            "unit": res["unit"],
            "sign": sign,
            "n_zones": res["n_zones"],
            "n_found": res["n_found"],
            "truncated": res["truncated"],
            "total_area_m2": res["total_area_m2"],
            "cell_m": res["cell_m"],
            "quality_mask": res["quality_mask"],
            "zones": zones_out,
            "zones_id": res["result_id"],
            "map": note,
            "summary": (
                f"{res['n_zones']} zone(s) with |rate| >= {threshold_mm_yr:g} "
                f"{res['unit']}, {res['total_area_m2'] / 1e6:.2f} km² in all"
                + (
                    f"; largest {biggest['zone']}: {biggest['area_km2']} km², mean "
                    f"{biggest['mean_rate']} {res['unit']}"
                    if biggest
                    else ""
                )
            ),
            "note": "Rates are relative to the producer's reference point. Zone "
            "edges follow the grid (cells of about cell_m). A zone is a screening "
            "result: check its time series, coherence and what is on the ground. "
            + EXPOSURE_NOTE,
        }

    async def _quality_at(all_layers: dict, lon: float, lat: float, dataset):
        """Read the cube's median temporal coherence and phase similarity at a point."""
        found: dict[str, Any] = {}
        for name in ("temporal_coherence", "phase_similarity"):
            for cand in (f"median_{name}", f"average_{name}", name):
                info = all_layers.get(cand)
                if info is None:
                    continue
                try:
                    vals = await api.get(
                        "/point",
                        dataset_name=cand,
                        lon=lon,
                        lat=lat,
                        dataset=dataset,
                    )
                except BowserError:
                    break
                arr = [v for v in vals if v is not None and math.isfinite(v)]
                if arr:
                    found[name] = {
                        "value": round(float(sorted(arr)[len(arr) // 2]), 3),
                        "layer": cand,
                        "how": "median over the dates"
                        if len(vals) > 1
                        else "as stored",
                    }
                break
        if not found:
            return {
                "factor": "quality",
                "status": "no_data",
                "finding": "The cube has no coherence or phase similarity at this "
                "point (no such layer, or nodata).",
                "caution": "Blank or masked does not mean stable.",
            }
        coh = (found.get("temporal_coherence") or {}).get("value")
        sim = (found.get("phase_similarity") or {}).get("value")
        low = (coh is not None and coh < 0.5) or (sim is not None and sim < 0.5)
        parts = [
            f"{k.replace('_', ' ')} {v['value']} ({v['layer']}, {v['how']})"
            for k, v in found.items()
        ]
        return {
            "factor": "quality",
            "status": "flagged" if low else "clear",
            "finding": "Cube quality here: " + "; ".join(parts) + ".",
            "caution": "Low coherence or phase similarity: the series is noisy and "
            "unwrapping errors are more likely; do not read small trends."
            if low
            else None,
            **found,
        }

    @tool(open_world=True, status="Reading the ground at the point")
    async def site_context(
        lon: Lon,
        lat: Lat,
        radius_m: Annotated[
            float,
            Field(gt=0, le=2000, description="Radius for nearby infrastructure (m)."),
        ] = 300.0,
        dataset: Dataset = None,
    ) -> dict[str, Any]:
        """Say what is on the ground at a point: call it before reading a time series.

        Land cover, geology (sediment or bedrock), mapped wetlands, soil (peat,
        expansive clay, fill), terrain slope and how much of a downslope motion
        the radar sees, nearby infrastructure, and the cube's quality there
        (median temporal coherence and phase similarity). Each factor says what
        it means for the interpretation; a service that cannot be reached says
        "could not be looked up", which is not the same as nothing there.
        Context suggests explanations; it does not prove them.
        """
        all_layers = await layers(dataset)
        info = next(iter(all_layers.values()), {})
        check_point(info, lon, lat)
        try:
            ground = await api.get("/site_context", lon=lon, lat=lat)
            factors = ground["factors"]
        except BowserError as e:
            factors = [
                {
                    "factor": "ground",
                    "status": "unavailable",
                    "finding": f"Could not be looked up ({e}).",
                    "caution": None,
                }
            ]
        los = None
        for i in all_layers.values():
            m = i.get("los_metadata") or {}
            if m.get("los_enu_ground_to_sat"):
                los = m["los_enu_ground_to_sat"]
                break
        kind = _measurement_summary(all_layers).get("kind", "unknown")
        for f in factors:
            if f.get("factor") == "terrain" and f.get("slope_deg") is not None:
                f.update(_downslope_in_los(f, los, kind))
        factors.append(await _quality_at(all_layers, lon, lat, dataset))
        try:
            infra = await api.post(
                "/infrastructure",
                {
                    "point": [lon, lat],
                    "radius_m": radius_m,
                    "kinds": list(KIND_NAMES),
                    "list_limit": 3,
                },
            )
            factors.append(
                {
                    "factor": "infrastructure",
                    "status": "clear",
                    "finding": f"Within {radius_m:g} m: {infra['text']}.",
                    "caution": None,
                    "summary": infra["summary"],
                    "source": infra["attribution"],
                }
            )
        except BowserError as e:
            factors.append(
                {
                    "factor": "infrastructure",
                    "status": "unavailable",
                    "finding": f"Could not be looked up ({e}).",
                    "caution": None,
                }
            )
        flagged = [f["factor"] for f in factors if f["status"] == "flagged"]
        missing = [
            f["factor"] for f in factors if f["status"] in ("unavailable", "off")
        ]
        text = f"Flagged: {', '.join(flagged) or 'nothing'}"
        if missing:
            text += f"; could not be looked up: {', '.join(missing)}"
        return {
            "point": [lon, lat],
            "factors": factors,
            "summary": text,
            "note": "Say which factors could explain the signal and how sure you "
            "are; name what could not be looked up. Context suggests explanations, "
            "it does not prove them.",
        }

    # --- tools: the page's map -------------------------------------------------------

    @page_tool(read_only=True, status="Reading the view")
    async def get_view() -> dict[str, Any]:
        """Return where the page's map is looking.

        Center [lon, lat], zoom (MapLibre's scale: 0 = the whole world, ~10 a
        city, ~15 streets), bearing, pitch, bounds [west, south, east, north],
        the map in use (maplibre or leaflet), split screen (on, left and right
        layers) and 3D terrain (on, exaggeration). Call it first when unsure
        where the user is looking.
        """
        return await on_page("get_view")

    @page_tool(quiet=True, status="Moving the map")
    async def fly_to(
        lon: Lon,
        lat: Lat,
        zoom: Annotated[
            float | None,
            Field(
                ge=0,
                le=22,
                description="Zoom (0 = world, ~10 = a city, ~15 = streets); omit "
                "to keep the current zoom.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Move the page's map to coordinates (lon, lat), keeping the zoom unless given.

        For a place name or address use go_to; for an area use fit_bounds.
        Returns the new view.
        """
        return await on_page("fly_to", lon=lon, lat=lat, zoom=zoom)

    @page_tool(quiet=True, status="Moving the map")
    async def fit_bounds(
        west: Annotated[float, Field(ge=-180, le=180, description="West longitude.")],
        south: Annotated[float, Field(ge=-90, le=90, description="South latitude.")],
        east: Annotated[float, Field(ge=-180, le=180, description="East longitude.")],
        north: Annotated[float, Field(ge=-90, le=90, description="North latitude.")],
        padding: Annotated[
            int, Field(ge=0, le=400, description="Margin around the box, pixels.")
        ] = 40,
    ) -> dict[str, Any]:
        """Fit the page's map to a box (west < east, south < north).

        Returns the new view.
        """
        if west >= east or south >= north:
            raise BowserError("Give west < east and south < north.")
        return await on_page(
            "fit_bounds",
            west=west,
            south=south,
            east=east,
            north=north,
            padding=padding,
        )

    @page_tool(quiet=True, status="Moving the map")
    async def pan(
        direction: Annotated[
            Literal["north", "south", "east", "west"],
            Field(description="Which way to move the view."),
        ],
        fraction: Annotated[
            float,
            Field(
                gt=0,
                le=2,
                description="How far, as a fraction of the view's height (north, "
                "south) or width (east, west); 0.5 = half a screen.",
            ),
        ] = 0.5,
        distance_m: Annotated[
            float | None,
            Field(
                gt=0,
                le=5_000_000,
                description="How far in metres on the ground; replaces fraction.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Move the page's map view north, south, east or west, keeping the zoom.

        By a fraction of the view (default half) or a distance in metres.
        Returns the new view.
        """
        return await on_page(
            "pan", direction=direction, fraction=fraction, distance_m=distance_m
        )

    @page_tool(quiet=True, status="Zooming the map")
    async def zoom(
        level: Annotated[
            float | None,
            Field(ge=0, le=22, description="Zoom to this level (0 = world)."),
        ] = None,
        delta: Annotated[
            float | None,
            Field(
                ge=-10,
                le=10,
                description="Zoom in (positive) or out (negative) by this much; "
                "1 doubles the scale.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Zoom the page's map to a level, or in or out by a step (give one of them).

        The center stays. Returns the new view.
        """
        if (level is None) == (delta is None):
            raise BowserError("Give level or delta, not both.")
        return await on_page("zoom", level=level, delta=delta)

    @page_tool(quiet=True, status="Going to the place")
    async def go_to(
        query: Annotated[
            str,
            Field(
                min_length=1,
                max_length=200,
                description="Place name or address, e.g. 'Arkabutla Dam, Mississippi'.",
            ),
        ],
        zoom: Annotated[
            float | None,
            Field(
                ge=0,
                le=22,
                description="Zoom to use at the place; omit to fit the place's "
                "extent.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Move the page's map to a place name or address.

        Geocodes the query (OpenStreetMap), then fits the best match's extent, or
        flies to its point at `zoom`. Returns the place found and the new view;
        check it is the place the user meant (geocode lists the candidates).
        """
        return await on_page("go_to", query=query, zoom=zoom)

    @page_tool(status="Setting the terrain")
    async def set_terrain(
        on: Annotated[bool, Field(description="3D terrain on or off.")],
        exaggeration: Annotated[
            float | None,
            Field(
                description="Vertical exaggeration, 1-10 (clamped; the page "
                "reports the value used). Omit to keep it."
            ),
        ] = None,
        pitch: Annotated[
            float | None,
            Field(
                ge=0,
                le=85,
                description="Camera tilt in degrees so the relief shows; omit "
                "for the page's default (60 when terrain comes on flat).",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Turn 3D terrain on or off and set its vertical exaggeration (MapLibre map).

        The same as the terrain button's popover, which also remembers the
        setting. The Leaflet map has no 3D terrain and says so.
        """
        return await on_page(
            "set_terrain", on=on, exaggeration=exaggeration, pitch=pitch
        )

    @page_tool(status="Setting the split screen")
    async def set_split_screen(
        on: Annotated[bool, Field(description="Split screen on or off.")],
        left_layer: Annotated[
            str | None,
            Field(
                description="Layer on the left (the main layer), a name from "
                "list_layers; omit to keep it."
            ),
        ] = None,
        right_layer: Annotated[
            str | None,
            Field(description="Layer on the right side; omit to keep it."),
        ] = None,
    ) -> dict[str, Any]:
        """Compare two layers side by side: split screen and each side's layer.

        Left is the main layer (as switch_layer sets it), right the split
        screen's layer. Layer names are checked, with close matches suggested.
        Returns both sides with their colormaps and ranges.
        """
        given = [n for n in (left_layer, right_layer) if n]
        if given:
            known = await layers(None)
            bad = [n for n in given if n not in known]
            if bad:
                raise BowserError(_unknown_layers(bad, list(known)))
        return await on_page(
            "set_split_screen", on=on, left_layer=left_layer, right_layer=right_layer
        )

    # --- tools: the page's points, reference and layer ------------------------------

    @page_tool(status="Adding the point")
    async def add_point(
        lon: Lon,
        lat: Lat,
        name: Annotated[
            str | None,
            Field(max_length=40, description='Short label, e.g. "Dam crest".'),
        ] = None,
    ) -> dict[str, Any]:
        """Add a time-series point to the page's map and chart (the chart opens).

        Points read with the data tools are added already.
        """
        return await on_page("add_point", lon=lon, lat=lat, name=name)

    @page_tool(read_only=True, status="Reading the reference")
    async def get_reference() -> dict[str, Any]:
        """Return the page's reference: point, circle sampling and reference date.

        The reference point [lon, lat], whether re-referencing is on, whether
        "Sample around ref marker" is on with its radius (m), the cube's own
        reference point, and the reference date of the current layer.
        """
        return await on_page("get_reference")

    @page_tool(status="Setting the reference point")
    async def set_reference_point(
        lon: Lon,
        lat: Lat,
        radius_m: Annotated[
            float | None,
            Field(
                ge=0,
                le=5000,
                description="Use the median within this radius (m) around the "
                "point ('Sample around ref marker'); 0 turns that off and uses "
                "the one pixel; omit to keep the page's setting.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Move the page's reference point; map and chart become relative to it.

        To change the reference, use this. Choose stable ground (bedrock, an old
        building, a GNSS station), not the feature studied; to choose a good one,
        use find_reference_candidates, then this tool with its lon/lat and
        radius_m. Returns the new reference and whether the chart was
        re-referenced.
        """
        return await on_page("set_reference_point", lon=lon, lat=lat, radius_m=radius_m)

    @page_tool(status="Resetting the reference")
    async def reset_reference() -> dict[str, Any]:
        """Move the page's reference point back to the cube's own (reference_lonlat).

        Says so when the cube names no reference point.
        """
        return await on_page("reset_reference")

    @page_tool(status="Setting the reference date")
    async def set_reference_date(
        date: Annotated[
            str | None,
            Field(
                description="Date, YYYY-MM-DD; the nearest date of the layer is used."
            ),
        ] = None,
        reset: Annotated[
            bool, Field(description="Go back to the producer's reference date.")
        ] = False,
    ) -> dict[str, Any]:
        """Make the page's displacement relative to a date of the current layer.

        Values on that date become 0.

        Give the date, or reset=true for the producer's reference date.
        """
        return await on_page("set_reference_date", date=date, reset=reset or None)

    @page_tool(status="Switching the layer")
    async def switch_layer(layer: Layer) -> dict[str, Any]:
        """Show another layer on the page's map (the left side in split screen)."""
        return await on_page("switch_layer", layer=layer)

    @page_tool(status="Opening the chart")
    async def open_chart() -> dict[str, Any]:
        """Open the page's time-series chart with its points and areas."""
        return await on_page("open_chart")

    @page_tool(mcp=False, status="Adding the overlay")
    async def add_overlay(
        path: Annotated[str, Field(description="Path of the GeoTIFF on the server.")],
        name: Annotated[
            str | None, Field(description="Name in the layer list.")
        ] = None,
    ) -> dict[str, Any]:
        """Add a GeoTIFF on the server's disk to the map as an overlay.

        Full server only, and only where the page may open files on the server.
        """
        return await on_page("add_overlay", path=path, name=name)

    # --- tools: the page's masks ------------------------------------------------------

    @page_tool(read_only=True, status="Reading the masks")
    async def get_masks(
        layer_ranges: Annotated[
            bool,
            Field(
                description="Also list the layers usable as masks with their value "
                "range and percentiles, to choose thresholds."
            ),
        ] = True,
    ) -> dict[str, Any]:
        """Return the page's masks and the layers that can mask.

        Each layer mask (layer, threshold, mode), the custom mask and whether
        recommended_mask is on.

        Mode min keeps pixels >= threshold, mode max keeps pixels <= threshold.
        Masks apply to the map (both sides of a split screen), the chart and,
        by default, the data tools.
        """
        return await on_page("get_masks", layer_ranges=layer_ranges)

    @page_tool(status="Setting the masks")
    async def set_masks(
        masks: Annotated[
            list[LayerMask],
            Field(
                max_length=12,
                description="Masks as {dataset: layer name, threshold, mode}. "
                "mode min keeps pixels >= threshold (e.g. temporal_coherence 0.7 "
                "keeps coherence >= 0.7); mode max keeps pixels <= threshold "
                "(e.g. 'residual 0' keeps residual <= 0: mode max, threshold 0).",
            ),
        ],
        replace: Annotated[
            bool,
            Field(
                description="Replace the page's layer masks (true) or add to them "
                "(false; a mask on the same layer is updated)."
            ),
        ] = True,
    ) -> dict[str, Any]:
        """Set the page's layer masks, as the Masking panel does.

        Pixels that fail a mask are hidden.

        "Coherence above 0.7" is {temporal_coherence, 0.7, min}; "residual 0" or
        "below 0.5" is mode max. Say in your answer how you read the user's
        words. Layer names are checked against the cube, with close matches
        suggested. recommended_mask is a mask like any other (on: threshold 0.5,
        mode min); set_masks with replace keeps it only if listed, so use
        set_recommended_mask to keep or change it alone. Returns what was applied.
        """
        known = await layers(None)
        bad = [m.dataset for m in masks if m.dataset not in known]
        if bad:
            raise BowserError(_unknown_layers(bad, list(known)))
        return await on_page(
            "set_masks", masks=[m.model_dump() for m in masks], replace=replace
        )

    @page_tool(status="Clearing the masks")
    async def clear_masks(
        keep_recommended: Annotated[
            bool, Field(description="Keep recommended_mask on if it is.")
        ] = False,
    ) -> dict[str, Any]:
        """Remove the page's layer masks (all, or all but recommended_mask)."""
        return await on_page("clear_masks", keep_recommended=keep_recommended)

    @page_tool(status="Setting the recommended mask")
    async def set_recommended_mask(
        on: Annotated[bool, Field(description="Use the cube's recommended_mask.")],
    ) -> dict[str, Any]:
        """Turn the cube's recommended_mask on or off (keeps the usable pixels)."""
        return await on_page("set_recommended_mask", on=on)

    # --- tools: the page's display ----------------------------------------------------

    @page_tool(read_only=True, status="Reading the display settings")
    async def get_display(side: Side = "left") -> dict[str, Any]:
        """Return how the page draws a layer.

        The layer, colormap, vmin/vmax (with unit), opacity, rewrap, split
        screen and the available colormaps.
        """
        return await on_page("get_display", side=side)

    @page_tool(status="Setting the colormap")
    async def set_colormap(
        name: Annotated[
            str, Field(description="Colormap name, from get_display's list.")
        ],
        reverse: Annotated[
            bool | None, Field(description="Reverse it; omit to keep as is.")
        ] = None,
        side: Side = "left",
    ) -> dict[str, Any]:
        """Change the colormap of the page's layer. Unknown names get close matches."""
        return await on_page("set_colormap", name=name, reverse=reverse, side=side)

    @page_tool(status="Setting the color range")
    async def set_color_range(
        vmin: Annotated[float | None, Field(description="Lower end.")] = None,
        vmax: Annotated[float | None, Field(description="Upper end.")] = None,
        unit: Annotated[
            Literal["m", "cm", "mm", "in"] | None,
            Field(
                description="Unit of vmin/vmax when the layer is in metres (or "
                "m/yr); omit for the layer's own unit."
            ),
        ] = None,
        preset: Annotated[
            Literal["2-98%", "1sigma", "2sigma", "full", "symmetric"] | None,
            Field(
                description="One of the histogram's buttons instead of vmin/vmax: "
                "2-98% (2nd-98th percentile), 1sigma (16th-84th percentile, the "
                "±1σ button), 2sigma (2.3rd-97.7th, ±2σ), full (min to max), "
                "symmetric (the ±0 button: centred on 0, ±max(|vmin|, |vmax|))."
            ),
        ] = None,
        side: Side = "left",
    ) -> dict[str, Any]:
        """Set the colour range of the page's layer: vmin/vmax, or a preset.

        For 'one sigma' or 'two sigma', use the preset; 'symmetric' means
        centred on 0. Percentiles are of the layer at the date shown. Returns
        the vmin/vmax applied, in the layer's unit.
        """
        if preset is None and vmin is None and vmax is None:
            raise BowserError("Give vmin and/or vmax, or a preset.")
        return await on_page(
            "set_color_range", vmin=vmin, vmax=vmax, unit=unit, preset=preset, side=side
        )

    @page_tool(status="Setting the opacity")
    async def set_opacity(
        opacity: Annotated[
            float, Field(ge=0, le=1, description="0 = invisible, 1 = opaque.")
        ],
        side: Side = "left",
    ) -> dict[str, Any]:
        """Set the opacity of the page's data layer."""
        return await on_page("set_opacity", opacity=opacity, side=side)

    # --- tools: every other control ---------------------------------------------------

    @page_tool(read_only=True, status="Listing the page commands")
    async def list_commands(
        query: Annotated[
            str | None,
            Field(
                max_length=100,
                description="Words to filter by (e.g. 'draw', 'basemap', 'chart').",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """List the page's toolbar and panel commands.

        Each with id, label, description, arguments and, for a toggle,
        whether it is on.

        For a toolbar or panel option not covered by a specific tool (draw
        tools, identify, measure, basemap, grid, chart options, time playback,
        theme, panel tabs...), call list_commands then run_command.
        """
        return await on_page("list_commands", query=query)

    @page_tool(status="Running the page command")
    async def run_command(
        id: Annotated[  # noqa: A002  (the command's id, as the model sees it)
            str, Field(max_length=80, description="Command id from list_commands.")
        ],
        args: Annotated[
            dict[str, Any] | None,
            Field(
                description="The command's arguments; toggles take {on: true} or "
                "{on: false}."
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Run one of the page's commands (see list_commands); returns its new state.

        Commands marked destructive (they delete work, such as clearing all
        points) need the user's go-ahead: ask first.
        """
        return await on_page("run_command", id=id, args=args)

    # --- tools: the user's files: GNSS series, rasters to COG (bowser.file_tools) ---
    register_file_tools(tool, api)
    # --- tools: the page's time-series chart (bowser.chart_tools) ---------------------
    register_chart_tools(page_tool, on_page)

    return specs


def _filename(r: httpx.Response, layer: str, time_index: int | None) -> str:
    disposition = r.headers.get("content-disposition", "")
    if "filename=" in disposition:
        name = disposition.split("filename=")[-1].strip().strip('"')
        if name and "/" not in name and "\\" not in name:
            return name
    return f"{layer}" + ("" if time_index is None else f"_{time_index}") + ".tif"


def _unknown_layers(names: list[str], known: list[str]) -> str:
    """Say which layer names are unknown, with the closest known names."""
    import difflib  # noqa: PLC0415

    def key(s: str) -> str:
        return "".join(c for c in s.lower() if c.isalnum())

    keyed = {key(k): k for k in known}
    parts = []
    for name in names:
        close = difflib.get_close_matches(key(name), list(keyed), n=3, cutoff=0.5)
        # Word order differs ("time_series_residual_inversion"): compare sorted words.
        words = sorted(name.lower().replace("-", "_").replace(" ", "_").split("_"))
        for k in known:
            kw = sorted(k.lower().split("_"))
            if (
                key(k) not in close
                and difflib.SequenceMatcher(None, "".join(words), "".join(kw)).ratio()
                > 0.75
            ):
                close.append(key(k))
        hint = ", ".join(keyed[c] for c in close)
        parts.append(f"{name!r}" + (f" (did you mean {hint}?)" if hint else ""))
    return "No layer " + "; ".join(parts) + f". Layers: {', '.join(sorted(known))}."


#: The page tools ``bowser mcp`` sends through the page channel.
PAGE_COMMANDS = frozenset(
    {
        "get_view",
        "fly_to",
        "fit_bounds",
        "pan",
        "zoom",
        "go_to",
        "set_terrain",
        "set_split_screen",
        "add_point",
        "get_reference",
        "set_reference_point",
        "reset_reference",
        "set_reference_date",
        "switch_layer",
        "open_chart",
        "get_masks",
        "set_masks",
        "clear_masks",
        "set_recommended_mask",
        "get_display",
        "set_colormap",
        "set_color_range",
        "set_opacity",
        "list_commands",
        "run_command",
        "list_context_layers",
        "add_context_layer",
        "remove_context_layer",
        "highlight_infrastructure",
        "clear_highlights",
        "get_areas",
        # Not a tool: how the data tools draw what they found (show_on_map).
        "draw_highlight",
    }
)
PAGE_COMMANDS |= CHART_COMMANDS

INSTRUCTIONS += "\n" + CHART_INSTRUCTIONS


def _describe(fn) -> str:
    """Return a function's docstring as one tool description (dedented)."""
    return inspect.cleandoc(fn.__doc__ or "")
