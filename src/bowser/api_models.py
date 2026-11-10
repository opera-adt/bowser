"""Documentation for Bowser's HTTP API: tags, route text and response models.

Shared by the full server (``bowser.main``) and the GDAL-free lite server
(``bowser.lite.main``), so the two describe the same routes the same way. Only
pydantic and the standard library are imported here, so lite can use it.

The response models describe the JSON the endpoints already return. They are
used for the OpenAPI schema only: an endpoint that returns a ``Response`` object
bypasses ``response_model`` validation in FastAPI, and endpoints that return a
plain dict list their model under ``responses`` rather than ``response_model``,
so no field is ever dropped, renamed or coerced. Models with fixed shapes forbid
extra keys; ``tests/test_api_schema.py`` validates real responses against them.
"""

from __future__ import annotations

import json
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, RootModel

# --- tags -----------------------------------------------------------------------

DATA = "Data"
SERIES = "Time series"
STATS = "Statistics"
TILES = "Tiles"
COG_TILES = "COG tiles"
EXPORT = "Export"
CONFIG = "Config"
FILES = "Files"
CONTEXT = "Context"
ASSISTANT = "Assistant"

#: ``FastAPI.openapi_tags``: the order and description of the groups in /api.html.
API_TAGS: list[dict[str, Any]] = [
    {"name": CONFIG, "description": "What the server serves and can do."},
    {
        "name": DATA,
        "description": "The cube's layers, their dates and the dataset catalog.",
    },
    {
        "name": SERIES,
        "description": "Time series at a point, several points or a circle.",
    },
    {
        "name": STATS,
        "description": "Value ranges, histograms, polygon statistics and profiles.",
    },
    {"name": TILES, "description": "Map tiles, TileJSON and colorbars."},
    {
        "name": COG_TILES,
        "description": "TiTiler endpoints for GeoTIFF stacks (COG mode, full only).",
    },
    {"name": EXPORT, "description": "Download a layer as a GeoTIFF (full only)."},
    {
        "name": FILES,
        "description": "Upload masks and raster overlays; tiles for the overlays "
        "(full only).",
    },
    {
        "name": CONTEXT,
        "description": "Proxies for outside data: UNR GNSS stations and WMS layers.",
    },
    {
        "name": ASSISTANT,
        "description": "The page's Assistant: a chat with the user's own AI "
        "provider that answers with Bowser's data tools. Off unless "
        "`BOWSER_ASSISTANT` is set.",
    },
]

#: The ``dataset`` query parameter on routes that read it in middleware only.
DATASET_QUERY: dict[str, Any] = {
    "name": "dataset",
    "in": "query",
    "required": False,
    "description": "Catalog dataset id (see /catalog). Omit when the server was "
    "started on a single cube.",
    "schema": {"anyOf": [{"type": "string"}, {"type": "null"}], "title": "Dataset"},
}
_DATASET_EXTRA = {"openapi_extra": {"parameters": [DATASET_QUERY]}}

_LAYER_MASKS = [{"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"}]

#: ``description`` and ``examples`` of the parameters both servers take, for
#: ``Query(..., **PARAMS[name])`` (or ``Path``/``Body``). The examples are points
#: in the synthetic test cube (tests/regression/cube.py).
PARAMS: dict[str, dict[str, Any]] = {
    "dataset": {
        "description": DATASET_QUERY["description"],
        "examples": ["regression"],
    },
    "dataset_name": {
        "description": "Layer name, a key of GET /datasets.",
        "examples": ["displacement"],
    },
    "lon": {"description": "WGS84 longitude.", "examples": [-117.67462]},
    "lat": {"description": "WGS84 latitude.", "examples": [33.95859]},
    "ref_lon": {
        "description": "WGS84 longitude of the reference point; give with ref_lat "
        "to subtract the reference's values.",
        "examples": [-117.67984],
    },
    "ref_lat": {
        "description": "WGS84 latitude of the reference point.",
        "examples": [33.96289],
    },
    "time_idx": {
        "description": "Index along the layer's time axis; read only this step.",
        "examples": [0],
    },
    "time_index": {
        "description": "Index along the layer's time axis (clamped to the last).",
        "examples": [0],
    },
    "nbins": {"description": "Number of histogram bins.", "examples": [100]},
    "points": {
        "description": "Points as {id, lon, lat} with optional name and color.",
        "examples": [[{"id": "p1", "lon": -117.67462, "lat": 33.95859}]],
    },
    "calculate_trends": {
        "description": "Add a linear trend to each point.",
        "examples": [True],
    },
    "layer_masks": {
        "description": "Masks as {dataset, threshold, mode}: mode min keeps "
        "pixels >= threshold, max keeps pixels <= threshold.",
        "examples": [_LAYER_MASKS],
    },
    "layer_masks_json": {
        "description": "JSON list of {dataset, threshold, mode} masks: mode min "
        "keeps pixels >= threshold, max keeps pixels <= threshold.",
        "examples": [json.dumps(_LAYER_MASKS)],
    },
    "ref_buffer_m": {
        "description": "Radius (m) of the median around the reference point; "
        "0 uses one pixel.",
        "examples": [0.0],
    },
    "buffer_m": {"description": "Radius of the circle (m).", "examples": [500.0]},
    "n_samples_buffer": {
        "description": "How many pixel series to return besides the median.",
        "examples": [10],
    },
    "coords": {
        "description": "The line's vertices as [lon, lat] pairs (at least two).",
        "examples": [[[-117.67984, 33.96289], [-117.66939, 33.95429]]],
    },
    "n_samples_profile": {
        "description": "Evenly spaced points along the line (when "
        "sampling_interval is 0).",
        "examples": [200],
    },
    "radius": {
        "description": "Half-width (m) of the strip around the line; 0 samples "
        "the line only.",
        "examples": [0.0],
    },
    "n_random": {
        "description": "Extra sample lines inside the strip.",
        "examples": [5],
    },
    "sampling_interval": {
        "description": "Bin length (m) along the line. When > 0, each bin is the "
        "median of the pixels within half a bin along the line and within radius "
        "across it; 0 uses n_samples points instead.",
        "examples": [0.0],
    },
    "cmap_name": {"description": "Colormap name.", "examples": ["rdbu_r"]},
    "station": {"description": "Four-character UNR station id.", "examples": ["P056"]},
    "west": {"description": "West edge, WGS84 longitude.", "examples": [-118.0]},
    "south": {"description": "South edge, WGS84 latitude.", "examples": [33.5]},
    "east": {"description": "East edge, WGS84 longitude.", "examples": [-117.0]},
    "north": {"description": "North edge, WGS84 latitude.", "examples": [34.5]},
    "wms_url": {
        "description": "WMS base URL, without request parameters.",
        "examples": ["https://example.com/wms"],
    },
    "variable": {
        "description": "Layer name, a key of GET /datasets.",
        "examples": ["displacement"],
    },
    "mask_variable": {
        "description": "Layer to mask with: keeps pixels > mask_min_value.",
        "examples": ["recommended_mask"],
    },
    "mask_min_value": {
        "description": "Threshold for mask_variable.",
        "examples": [0.1],
    },
    "export_mask_min_value": {
        "description": "Threshold for mask_variable (default 0.1), or for a "
        "GeoTIFF stack's own mask files.",
        "examples": [0.1],
    },
    "custom_mask_path": {
        "description": "Server path of a mask from POST /upload_mask; keeps "
        "pixels where the mask is > 0. Ignored by bowser-lite.",
        "examples": ["/tmp/bowser_masks/mask_0123abcd.tif"],
    },
    "rescale": {
        "description": "Colour scale range as min,max.",
        "examples": ["-0.01,0.01"],
    },
    "colormap_name": {"description": "Colormap name.", "examples": ["rdbu_r"]},
    "algorithm": {
        "description": "Pixel algorithm: shift, rewrap, phase or amplitude.",
        "examples": ["shift"],
    },
    "algorithm_params": {
        "description": "JSON parameters of the algorithm.",
        "examples": ['{"shift": 0.001}'],
    },
    "tilesize": {"description": "Tile size in pixels.", "examples": [256]},
    "ref_time_idx": {
        "description": "Show the time step relative to this one: the value at "
        "time_idx minus the value at ref_time_idx, per pixel.",
        "examples": [0],
    },
}

_LITE_501 = (
    "Not available in bowser-lite, which answers HTTP 501 with a `detail` "
    "message; run the full server (`bowser run`). On the full server: "
)

#: summary, description and tags of every documented route, by ``METHOD path``.
ROUTES: dict[str, dict[str, Any]] = {
    "GET /config": {
        "summary": "Server configuration",
        "description": "Page title, whether to show the OPERA logo, and whether "
        "GeoTIFF export is available (false on bowser-lite). The title is the "
        "catalog entry's name when `dataset` is given, here or in the Referer. "
        "`assistant` says whether the Assistant tab is on, its providers and "
        "those with a key.",
        "tags": [CONFIG],
    },
    "GET /mode": {
        "summary": "Data mode",
        "description": "`md` for a GeoZarr cube, `cog` for a stack of GeoTIFFs "
        "(full server only).",
        "tags": [CONFIG],
    },
    "GET /datasets": {
        "summary": "Layers of the dataset",
        "description": "One entry per layer (variable with x and y dimensions): "
        "dates (`x_values`), bounds, reference point, viewing geometry, units and "
        "a short explanation. Start here to learn the layer names that other "
        "endpoints take as `dataset_name` or `variable`.",
        "tags": [DATA],
    },
    "GET /variables": {
        "summary": "Variables of the cube",
        "description": "Dimensions, shape, dtype and attributes of every "
        "variable with x and y dimensions. Empty in COG mode.",
        "tags": [DATA],
    },
    "GET /datasets/{dataset_name}/time_bounds": {
        "summary": "First and last date of a layer",
        "description": "First and last label of the layer's time (or pair) axis "
        "and the number of steps. 400 for a layer without one.",
        "tags": [DATA],
    },
    "GET /catalog": {
        "summary": "Dataset catalog",
        "description": "Catalog entries (from `BOWSER_CATALOG_FILE`, then any "
        "opened at runtime) and whether `POST /catalog/open` is enabled. Pass an "
        "entry's `id` as `?dataset=` to other endpoints.",
        "tags": [DATA],
    },
    "POST /catalog/scan": {
        "summary": "Find cubes under a folder",
        "description": "List the GeoZarr stores under a server folder, to open "
        'with `POST /catalog/open`. Body: `{"dir": "<folder>"}`. 403 unless '
        "`BOWSER_ALLOW_OPEN` is set.",
        "tags": [DATA],
    },
    "POST /catalog/open": {
        "summary": "Open a cube",
        "description": "Open a GeoZarr store by path or URL and add it to the "
        'catalog until the server restarts. Body: `{"uri": "<path or URL>"}`. '
        "Returns the new catalog id. 403 unless `BOWSER_ALLOW_OPEN` is set.",
        "tags": [DATA],
    },
    "GET /point": {
        "summary": "Values at a point",
        "description": "The layer's values at the pixel nearest a lon/lat: the "
        "full series, or one value with `time_idx`. Values are as stored (no "
        "reference subtraction); NaN is returned as null.",
        "tags": [SERIES],
        **_DATASET_EXTRA,
    },
    "GET /chart_point": {
        "summary": "Chart series at a point",
        "description": "The point's series as Chart.js `{x, y}` pairs, minus the "
        "series at the reference point when `ref_lon` and `ref_lat` are given. "
        "No-data dates are left out.",
        "tags": [SERIES],
        **_DATASET_EXTRA,
    },
    "POST /multi_point": {
        "summary": "Series at several points",
        "description": "Series for several points in one call, re-referenced to "
        "a reference point (or the median within `ref_buffer_m` of it), with "
        "optional layer masks and a linear trend per point.",
        "tags": [SERIES],
        **_DATASET_EXTRA,
    },
    "GET /trend_analysis/{dataset_name}": {
        "summary": "Linear trend at a point",
        "description": "Least-squares linear fit to the point's series (minus the "
        "reference point's, when given): slope per day, R², and the rate in mm/yr "
        "with its standard error. Assumes the layer is in metres.",
        "tags": [SERIES],
        **_DATASET_EXTRA,
    },
    "POST /buffer_timeseries": {
        "summary": "Series within a circle",
        "description": "Median series of all pixels within `buffer_m` of a point, "
        "plus up to `n_samples` randomly chosen pixel series (fixed seed), "
        "re-referenced and masked like `/multi_point`.",
        "tags": [SERIES],
        **_DATASET_EXTRA,
    },
    "GET /dataset_range/{dataset_name}": {
        "summary": "Value range of a layer",
        "description": "Minimum, maximum and the 2/98 and 5/95 percentiles of the "
        "layer's first time step, for colour scales and mask sliders.",
        "tags": [STATS],
    },
    "GET /histogram/{dataset_name}": {
        "summary": "Histogram of one time step",
        "description": "Histogram and percentiles of the valid pixels of one time "
        "step. A histogram stored in the cube (`bowser_histogram` attribute) is "
        "returned as is when present.",
        "tags": [STATS],
    },
    "POST /polygon_timeseries": {
        "summary": "Statistics inside a polygon",
        "description": "Per-date statistics (count, mean, median, spread, "
        "percentiles) of the stored pixels inside a WGS84 GeoJSON Polygon or "
        "MultiPolygon, on the native grid. No reference or mask is applied. See "
        "docs/polygon-statistics.md.",
        "tags": [STATS],
    },
    "POST /profile": {
        "summary": "Values along a line",
        "description": "Values of one time step along a polyline. With "
        "`sampling_interval` > 0, binned medians across a `radius`-wide strip; "
        "otherwise `n_samples` evenly spaced points (a plain list when "
        "`radius` is 0).",
        "tags": [STATS],
        **_DATASET_EXTRA,
    },
    "GET /colorbar/{cmap_name}": {
        "summary": "Colorbar image",
        "description": "A horizontal gradient of a colormap. The full server sends "
        "a matplotlib WEBP, bowser-lite a PNG.",
        "tags": [TILES],
    },
    "GET /md/{tileMatrixSetId}/tilejson.json": {
        "summary": "TileJSON for a layer",
        "description": "TileJSON 3.0 for a GeoZarr layer: the tile URL template "
        "(with the given query parameters), lon/lat bounds and zoom range.",
        "tags": [TILES],
    },
    "GET /md/tiles/{tileMatrixSetId}/{z}/{x}/{y}": {
        "summary": "Map tile",
        "description": "One rendered map tile of a GeoZarr layer. bowser-lite "
        "serves WebMercatorQuad PNG tiles only.",
        "tags": [TILES],
    },
    "POST /upload_mask": {
        "summary": "Upload a mask GeoTIFF",
        "description": "Store a GeoTIFF mask on the server and return its path, "
        "to pass as `custom_mask_path` to tiles and exports. Uploads are "
        "deleted after `BOWSER_UPLOAD_RETENTION_H` hours.",
        "tags": [FILES],
    },
    "POST /upload_raster": {
        "summary": "Upload a raster overlay",
        "description": "Store a GeoTIFF overlay and return its path, band count "
        "and per-band statistics. Its tiles are served by the `/overlay` tiler "
        "with `url=<path>`.",
        "tags": [FILES],
    },
    "GET /export/geotiff": {
        "summary": "Export a layer as GeoTIFF",
        "description": "One time step of a layer as a GeoTIFF at native "
        "resolution, with the same masks as the map (masked pixels are NaN), "
        "optionally re-referenced to `ref_lon`/`ref_lat`. Provenance is written "
        "to the file's tags; see docs/geotiff-export-provenance.md.",
        "tags": [EXPORT],
    },
    "GET /gnss/stations": {
        "summary": "GNSS stations in a box",
        "description": "UNR GNSS stations inside a lon/lat box, nearest the "
        "centre first, with MIDAS velocities (North America fixed, mm/yr).",
        "tags": [CONTEXT],
    },
    "GET /gnss/series/{station}": {
        "summary": "GNSS station series",
        "description": "A UNR station's daily east, north and up positions in mm "
        "from the first day (North America fixed), with equipment and earthquake "
        "steps and the monument description.",
        "tags": [CONTEXT],
    },
    "GET /wms_capabilities": {
        "summary": "Layers of a WMS",
        "description": "Fetch a WMS GetCapabilities on the server (browsers are "
        "usually blocked by CORS) and return its named layers.",
        "tags": [CONTEXT],
    },
    "GET /assistant/status": {
        "summary": "Assistant providers",
        "description": "Whether the Assistant is on, whether the page may save "
        "keys here, and each provider with its default model, whether it has a "
        "key (and where it comes from: `saved` or `environment`) and the key's "
        "last four characters. Never the key itself.",
        "tags": [ASSISTANT],
    },
    "PUT /assistant/key": {
        "summary": "Save a provider's key",
        "description": "Check an API key with its provider and keep it on this "
        "computer (system keychain, or a file only this user can read). "
        'Body: `{"provider": "anthropic", "key": "..."}`. 403 unless '
        "`BOWSER_ASSISTANT_PAGE_KEYS` is set and the request comes from this "
        "computer; 401 when the provider rejects the key.",
        "tags": [ASSISTANT],
    },
    "DELETE /assistant/key": {
        "summary": "Remove a provider's key",
        "description": "Forget the key saved for `provider` (same conditions as "
        "PUT).",
        "tags": [ASSISTANT],
    },
    "POST /assistant/chat": {
        "summary": "Chat with the Assistant",
        "description": "Send the conversation to the chosen provider with the "
        "saved or server key and stream the reply as server-sent events: `text` "
        "deltas, each `message` of the conversation, `tool_call` and "
        "`tool_result` for the data tools the server runs itself, `page_tools` "
        "for the tools the page runs (it then sends the results back in a new "
        "request), `error` and `done`. 403 when the Assistant is off.",
        "tags": [ASSISTANT],
    },
}

#: Routes that bowser-lite answers with 501 (they need GDAL).
LITE_501 = (
    "POST /upload_mask",
    "POST /upload_raster",
    "GET /export/geotiff",
    "POST /polygon_timeseries",
)


def route_doc(key: str, *, lite_stub: bool = False) -> dict[str, Any]:
    """Return the decorator keyword arguments documenting route ``key``.

    ``key`` is ``"METHOD /path"``. With ``lite_stub``, the description says that
    bowser-lite answers 501.
    """
    doc = dict(ROUTES[key])
    if lite_stub:
        doc["description"] = _LITE_501 + doc["description"]
        doc.pop("openapi_extra", None)
    return doc


def describe_tiler_routes(router: Any) -> None:
    """Give a TiTiler router's TileJSON and tile routes the text in ``ROUTES``.

    Only the OpenAPI summary and description change. ``router`` is the factory's
    own router, whose paths have no prefix.
    """
    tile = "/tiles/{tileMatrixSetId}/{z}/{x}/{y}"
    for route in router.routes:
        path = getattr(route, "path", "")
        if path == "/{tileMatrixSetId}/tilejson.json":
            doc = ROUTES["GET /md/{tileMatrixSetId}/tilejson.json"]
        elif path in (tile, tile + ".{format}"):
            doc = ROUTES["GET /md/tiles/{tileMatrixSetId}/{z}/{x}/{y}"]
        else:
            continue
        route.summary = doc["summary"]
        route.description = doc["description"]


# --- response models ------------------------------------------------------------


class _Fixed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ErrorDetail(_Fixed):
    """An error, as FastAPI sends it."""

    detail: str


class AssistantFlag(_Fixed):
    """The Assistant's switch in ``GET /config``."""

    enabled: bool = Field(description="Whether the Assistant tab is on.")
    providers: list[str] = Field(description="Ids of the providers it offers.")
    configured: list[str] = Field(
        description="Ids of the providers with a key, saved or from the server."
    )


class ConfigInfo(_Fixed):
    """``GET /config``."""

    title: str = Field(description="Page title; empty for the default.")
    opera_logo: bool
    geotiff_export: bool = Field(
        description="Whether GET /export/geotiff works on this server."
    )
    polygon_stats: bool = Field(
        description="Whether POST /polygon_timeseries works on this server."
    )
    assistant: AssistantFlag


class AssistantProvider(_Fixed):
    """One provider in ``GET /assistant/status``."""

    id: str
    label: str
    wire: Literal["anthropic", "openai", "gemini", "responses"]
    model: str = Field(description="Default model.")
    models: list[str] = Field(description="Models offered in the picker.")
    needs_key: bool
    local: bool = Field(description="A model server on this computer (no key).")
    auth: Literal["api_key", "none", "sign_in"]
    available: bool = Field(description="False for a provider coming later.")
    note: str
    key_url: str
    configured: bool = Field(description="Has a key (or needs none).")
    source: Optional[Literal["saved", "environment"]] = None
    hint: Optional[str] = Field(None, description="The key's last characters.")
    store: Optional[Literal["keyring", "file"]] = None


class AssistantStatus(_Fixed):
    """``GET /assistant/status``, ``PUT`` and ``DELETE /assistant/key``."""

    enabled: bool
    page_keys: bool = Field(
        description="Whether the page may save keys on this server."
    )
    providers: list[AssistantProvider]
    default_provider: Optional[str] = None
    stored_in: Optional[str] = Field(
        None, description="After PUT: where the key was kept."
    )


class ModeInfo(_Fixed):
    """``GET /mode``."""

    mode: Literal["md", "cog"]


class EnuVector(_Fixed):
    """A unit vector in local east, north, up."""

    east: float
    north: float
    up: float


class LosInfo(_Fixed):
    """Satellite viewing geometry; near/far keys are left out when unknown."""

    heading_deg: float
    incidence_deg: float
    incidence_deg_near: Optional[float] = None
    incidence_deg_far: Optional[float] = None
    los_enu_ground_to_sat: Optional[EnuVector] = None
    los_enu_ground_to_sat_near: Optional[EnuVector] = None
    los_enu_ground_to_sat_far: Optional[EnuVector] = None


class DatasetInfo(_Fixed):
    """One layer of ``GET /datasets``.

    ``available_mask_vars``, ``label``, ``reference_lonlat`` and ``n_time_steps``
    are sent for GeoZarr cubes only, ``file_list`` and ``mask_file_list`` for
    GeoTIFF groups only; ``guidance`` only for layers with both producer text and
    Bowser guidance; ``metadata_notes`` only for some GeoTIFF groups.
    """

    name: str
    file_list: Optional[list[str]] = Field(
        default=None, description="GeoTIFF mode only: one file per time step."
    )
    mask_file_list: Optional[list[str]] = Field(
        default=None, description="GeoTIFF mode only: the matching mask files."
    )
    n_time_steps: Optional[int] = Field(
        default=None,
        description="GeoZarr mode only: steps on the time axis (1 for 2-D).",
    )
    mask_min_value: float
    nodata: Optional[float]
    uses_spatial_ref: bool = Field(
        description="Whether the map re-references this layer to a moving point."
    )
    algorithm: Optional[str]
    bounds: list[float] = Field(description="Bounds in the layer's own CRS.")
    latlon_bounds: list[float] = Field(description="[west, south, east, north].")
    x_values: list[Union[str, int]] = Field(
        description="Labels of the time (or pair) axis; empty for a 2-D layer."
    )
    reference_date: Optional[str]
    los_metadata: Optional[LosInfo]
    available_mask_vars: Optional[list[str]] = None
    label: Optional[str] = None
    reference_lonlat: Optional[list[float]] = None
    description: str
    description_source: Literal["bowser", "source", "unknown"]
    source_description: Optional[str]
    source_flags: list[dict[str, str]]
    unit: str
    unit_status: Literal["provided", "missing", "mixed"]
    guidance: Optional[str] = Field(
        None,
        description="Bowser's general note, sent when the producer's own "
        "description is shown as `description`.",
    )
    metadata_notes: Optional[list[str]] = None


class DatasetsInfo(RootModel[dict[str, DatasetInfo]]):
    """``GET /datasets``: layer name -> description."""


class VariableInfo(_Fixed):
    """One variable of ``GET /variables``."""

    dimensions: list[str]
    shape: list[int]
    dtype: str
    attrs: dict[str, Any]


class VariablesInfo(_Fixed):
    """``GET /variables``."""

    variables: dict[str, VariableInfo]


class TimeBounds(_Fixed):
    """``GET /datasets/{dataset_name}/time_bounds``."""

    start_time: str
    end_time: str
    num_time_steps: int


class CatalogEntryInfo(_Fixed):
    """A catalog entry."""

    id: str
    name: str
    uri: str
    bbox: list[float] = Field(description="[west, south, east, north] in WGS84.")
    description: str


class CatalogInfo(_Fixed):
    """``GET /catalog``."""

    datasets: list[CatalogEntryInfo]
    allow_open: bool


class FoundCube(_Fixed):
    """A store found by ``POST /catalog/scan``."""

    path: str
    name: str
    title: Optional[str]


class ScanResult(_Fixed):
    """``POST /catalog/scan``."""

    cubes: list[FoundCube]
    truncated: bool


class OpenedDataset(_Fixed):
    """``POST /catalog/open``: pass ``id`` as ``?dataset=``."""

    id: str
    name: str


class PointValues(RootModel[list[Optional[float]]]):
    """``GET /point``: one value per time step (null for no data)."""


class ChartXY(_Fixed):
    """A chart point: date label and value."""

    x: Union[str, int]
    y: float


class ChartSeries(_Fixed):
    """A Chart.js dataset."""

    data: list[ChartXY]


class ChartPoint(_Fixed):
    """``GET /chart_point``."""

    datasets: list[ChartSeries]
    labels: list[Union[str, int]]


class PointTrend(_Fixed):
    """A trend in ``POST /multi_point`` (camelCase, for the chart)."""

    slope: float
    intercept: float
    rSquared: float  # noqa: N815
    mmPerYear: float  # noqa: N815
    stdMmPerYear: float  # noqa: N815


class PointSeries(_Fixed):
    """One point of ``POST /multi_point``."""

    pointId: Any  # noqa: N815
    label: str
    data: list[ChartXY]
    borderColor: str  # noqa: N815
    backgroundColor: str  # noqa: N815
    trend: Optional[PointTrend]
    x: Optional[float] = Field(description="Easting in the layer's CRS.")
    y: Optional[float] = Field(description="Northing in the layer's CRS.")


class MultiPointSeries(_Fixed):
    """``POST /multi_point``."""

    labels: list[Union[str, int]]
    datasets: list[PointSeries]


class Trend(_Fixed):
    """``GET /trend_analysis/{dataset_name}``."""

    slope: float = Field(description="Units per day.")
    intercept: float
    r_squared: float
    mm_per_year: float
    std_err: float
    std_mm_per_year: float


class BufferSeries(_Fixed):
    """``POST /buffer_timeseries``."""

    labels: list[Union[str, int]]
    median: list[ChartXY]
    samples: list[list[ChartXY]]
    n_pixels: int = Field(description="Pixels with data within the circle.")


class ValueRange(_Fixed):
    """``GET /dataset_range/{dataset_name}``."""

    min: float
    max: float
    p2: float
    p98: float
    p5: float
    p95: float


class Histogram(BaseModel):
    """``GET /histogram/{dataset_name}``.

    A histogram stored in the cube is passed through and may carry other keys.
    """

    model_config = ConfigDict(extra="allow")
    bins: list[float] = Field(description="Bin edges (one more than counts).")
    counts: list[int]
    min: float
    max: float
    p2: float
    p98: float
    p16: float
    p84: float
    p23: float = Field(description="2.275th percentile (mean - 2 sigma).")
    p977: float = Field(description="97.725th percentile (mean + 2 sigma).")


class ProfileSample(_Fixed):
    """A value at a distance (m) along the line."""

    dist: float
    value: float


class ProfileLines(_Fixed):
    """``POST /profile`` with a radius or bins."""

    centre: list[ProfileSample]
    median: list[ProfileSample]
    samples: list[list[ProfileSample]]
    binned: Optional[bool] = Field(None, description="Sent (true) when binned.")
    bin_width: Optional[float] = Field(None, description="Sent when binned.")


#: ``POST /profile``: a list without radius or bins, else the lines.
Profile = Union[list[ProfileSample], ProfileLines]


class PolygonRow(_Fixed):
    """Statistics of one date in ``POST /polygon_timeseries``."""

    count: int
    mean: Optional[float]
    median: Optional[float]
    spatial_std: Optional[float]
    minimum: Optional[float]
    maximum: Optional[float]
    percentiles: dict[str, Optional[float]] = Field(
        description='By percentile, e.g. "10", "90" or "2.5".'
    )


class PolygonGrid(_Fixed):
    """The native grid the statistics were computed on."""

    crs: str
    transform: list[float]
    shape: list[int]


class PolygonStatistics(_Fixed):
    """``POST /polygon_timeseries``."""

    variable: str
    labels: list[str]
    units: Optional[str]
    geometry: dict[str, Any]
    support: Literal["common", "per_date"]
    polygon_pixels: int
    valid_per_date: list[int]
    common_pixels: int
    statistics: list[PolygonRow]
    reference: Literal["stored"]
    optional_masks_applied: bool
    component_compatibility: str
    warnings: list[str]
    grid: PolygonGrid
    calculation: str
    selection: str


class UploadedMask(_Fixed):
    """``POST /upload_mask``."""

    path: str = Field(description="Server path; pass as custom_mask_path.")


class BandStats(_Fixed):
    """Statistics of one band of an uploaded raster."""

    name: str
    min: float
    max: float
    p2: float
    p98: float
    p5: float
    p95: float


class UploadedRaster(_Fixed):
    """``POST /upload_raster``."""

    path: str = Field(description="Server path; pass as url= to /overlay.")
    name: str
    band_count: int
    bands: list[BandStats]


class GnssStation(_Fixed):
    """A UNR station with its MIDAS velocity (mm/yr, North America fixed)."""

    id: str
    lon: float
    lat: float
    first: float = Field(description="First epoch, decimal year.")
    last: float = Field(description="Last epoch, decimal year.")
    ve_mm_yr: float
    vn_mm_yr: float
    vu_mm_yr: float
    sigma_vu_mm_yr: float


class GnssStations(_Fixed):
    """``GET /gnss/stations``."""

    source: str
    stations: list[GnssStation]


class GnssStep(_Fixed):
    """An equipment change or a nearby earthquake."""

    date: str
    kind: Literal["equipment", "earthquake"]
    detail: str
    event: Optional[str] = None


class GnssSeries(_Fixed):
    """``GET /gnss/series/{station}``; steps and monument are sent with data."""

    station: str
    frame: str
    station_page: str
    dates: list[str]
    east_mm: list[float]
    north_mm: list[float]
    up_mm: list[float]
    steps: Optional[list[GnssStep]] = None
    monument: Optional[dict[str, Optional[str]]] = None


class WmsLayer(_Fixed):
    """A named WMS layer."""

    name: str
    title: str


class WmsLayers(_Fixed):
    """``GET /wms_capabilities``."""

    layers: list[WmsLayer]


class TileJSON(_Fixed):
    """bowser-lite's TileJSON 3.0 (the fields TiTiler 2.4 sends)."""

    tilejson: str
    band_descriptions: list[list[str]]
    data_type: str
    raster_layers: dict[str, Any]
    version: str
    scheme: str
    tiles: list[str]
    minzoom: int
    maxzoom: int
    bounds: list[float]
    center: list[float]


# --- non-JSON responses -----------------------------------------------------------


def image_response(media_type: str, description: str) -> dict[int | str, Any]:
    """Return a ``responses`` entry for a binary image body."""
    return {
        200: {
            "description": description,
            "content": {media_type: {"schema": {"type": "string", "format": "binary"}}},
        }
    }


#: ``responses`` for the routes bowser-lite answers with 501.
NOT_IN_LITE: dict[int | str, Any] = {
    501: {"model": ErrorDetail, "description": "Needs the full server (GDAL)."}
}
