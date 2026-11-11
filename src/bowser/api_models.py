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
    "radius_m": {
        "description": "Radius in metres of the circle around each candidate "
        "(the reference circle to use with it); 0 judges single pixels.",
        "examples": [100.0],
    },
    "n_candidates": {"description": "Number of candidates.", "examples": [5]},
    "min_separation_m": {
        "description": "Minimum distance in metres between candidates "
        "(default 3 x radius_m).",
        "examples": [300.0],
    },
    "use_masks": {
        "description": "Also exclude pixels outside the recommended mask on most "
        "dates (water is always excluded).",
        "examples": [False],
    },
    "coherence_min": {
        "description": "Minimum median temporal coherence of a viable pixel "
        "(default: the `quantile` of the cube's medians).",
        "examples": [0.8],
    },
    "similarity_min": {
        "description": "Minimum median phase similarity of a viable pixel "
        "(default: the `quantile` of the cube's medians).",
        "examples": [0.7],
    },
    "quantile": {
        "description": "Quantile of the cube's medians used as the default "
        "thresholds (0.95: the top 5%).",
        "examples": [0.95],
    },
    "k_std": {
        "description": "Weight of the standard deviations in the pixel score "
        "(median - k_std x std).",
        "examples": [1.0],
    },
    "coherence_layer": {
        "description": "Temporal coherence layer.",
        "examples": ["temporal_coherence"],
    },
    "similarity_layer": {
        "description": "Phase similarity layer.",
        "examples": ["phase_similarity"],
    },
    "screen_stride": {
        "description": "Screen with every n-th time chunk of dates, then recheck "
        "the shortlist with every date (default: 1, or more only when the "
        "screening read would exceed 4 billion values per layer).",
        "examples": [1],
    },
    "displacement_layer": {
        "description": "Displacement layer for the scatter check (skipped when "
        "absent).",
        "examples": ["displacement"],
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
        "re-referenced and masked like `/multi_point`. A 2-D layer (no time axis) "
        "is a one-step series without a label, as in `/chart_point`: `labels` and "
        "the series are empty and `n_pixels` counts the circle's valid pixels.",
        "tags": [SERIES],
        **_DATASET_EXTRA,
    },
    "GET /reference_candidates": {
        "summary": "Stable reference-point candidates",
        "description": "Rank places to put the reference point. Per pixel, the "
        "median and standard deviation over the whole stack of temporal coherence "
        "and phase similarity (water excluded; with `use_masks`, pixels outside the "
        "recommended mask on most dates too). A pixel is viable when both medians "
        "reach the thresholds (default: the top 5% of the cube's own medians); its "
        "score is ((med_coh - k std_coh) + (med_sim - k std_sim)) / 2. Each viable "
        "pixel's circle of `radius_m` (the circle 'Sample around ref marker' "
        "averages) is scored by viable fraction x mean score; the best centres at "
        "least `min_separation_m` apart are then ranked after a displacement check "
        "(scatter of each pixel about the circle median through time). Each "
        "candidate has the `lon`, `lat` and `radius_m` to set as the reference; "
        "`recommended` is the first. The per-pixel reductions are cached per cube "
        "and layer, so only the first call reads the whole stack. Coherence is not "
        "stability: check each candidate's velocity and what is on the ground.",
        "tags": [STATS],
    },
    "GET /reference_candidates/status": {
        "summary": "Readiness of the reference finder",
        "description": "Whether the per-pixel statistics that "
        "`GET /reference_candidates` needs (median and std through time of "
        "temporal coherence, phase similarity and the water mask) are ready, being "
        "computed (with progress) or not started. They are computed once per cube "
        "and kept in memory and on disk. Both servers start computing them in the "
        "background once a newly opened cube's server has been idle for a while, "
        "and pause whenever a request is in flight (`BOWSER_REFSTATS_WARMUP`).",
        "tags": [STATS],
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
    "POST /upload_data": {
        "summary": "Upload data to add",
        "description": "Store a raster or vector file to add with `POST /data`: "
        "one file, or a Shapefile's parts (`.shp`, `.dbf`, `.prj`...) together. "
        "Returns the main file's server path. Uploads are swept after "
        "`BOWSER_UPLOAD_RETENTION_H` hours.",
        "tags": [FILES],
    },
    "POST /data": {
        "summary": "Add a raster or vector file",
        "description": "Make a file ready to draw. Body: "
        '`{"path": "<server path>", "name": "<shown name>"}`. A raster is '
        "tiled by `/overlay` from a Cloud-Optimized GeoTIFF (`cog`); a vector "
        "over 20 MB or 50 000 features becomes a PMTiles archive of vector "
        "tiles, a smaller one a GeoJSON (`url`). A file that is not yet in that "
        "form is converted once in the background and cached (keyed by path, size "
        "and mtime); poll `GET /data/{data_id}` while `status` is `converting`. "
        "Allowed for uploads (`POST /upload_data`), for `BOWSER_OVERLAY_FILES`, "
        "and for any path when `BOWSER_ALLOW_OPEN` is set (403 otherwise).",
        "tags": [FILES],
    },
    "GET /files": {
        "summary": "List a server folder",
        "description": "One server folder, for picking files to add with "
        "`POST /data` (Overlays › Load file › Browse): its sub-folders first, then "
        "the files the page can add (GeoTIFF, GeoJSON/JSON, Shapefile `.shp`, "
        "GeoPackage, FlatGeobuf, KML/KMZ, GPX, CSV/TSV/TXT, zipped Shapefile) with "
        "their sizes, sorted by name; not its sub-folders' contents. `dir` "
        "defaults to the folder of the cube being viewed, else the server user's "
        "home. Symlinks are resolved; hidden files are left out unless "
        "`hidden=true`; entries the server's user cannot read are skipped and "
        "counted (`skipped`); at most 1000 entries (`truncated`). 403 unless "
        "`BOWSER_ALLOW_OPEN` is set, as for server paths in `POST /data`; no "
        "folder is off limits beyond what the server's user can read. 400 for a "
        "path that is not a folder.",
        "tags": [FILES],
    },
    "GET /data/{data_id}": {
        "summary": "Added file status",
        "description": "Whether a file added with `POST /data` is still being "
        "converted, ready (a raster with its COG path, bands and bounds; a vector "
        "with the `url` to read it from) or failed (with the reason). 404 for an "
        "unknown id.",
        "tags": [FILES],
    },
    "GET /data/{data_id}.{fmt}": {
        "summary": "Converted vector",
        "description": "A vector converted by `POST /data`: the PMTiles archive "
        "(`fmt=pmtiles`), served in byte ranges for HTTP `Range` requests (206), "
        "or the GeoJSON (`fmt=geojson`). 404 until the conversion is ready.",
        "tags": [FILES],
    },
    "GET /export/geotiff": {
        "summary": "Export a layer as GeoTIFF",
        "description": "One time step of a layer as a GeoTIFF at native "
        "resolution, with the same masks as the map (masked pixels are NaN), "
        "optionally re-referenced to `ref_lon`/`ref_lat` and shown relative to "
        "another date (`ref_time_idx`, GeoZarr only), as on the map. Provenance "
        "is written "
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
        "last four characters. Never the key itself. Ollama is listed only when "
        "it is installed on this computer (started in the background if needed "
        "on the user's own computer), with its installed models.",
        "tags": [ASSISTANT],
    },
    "GET /assistant/models": {
        "summary": "A provider's models",
        "description": "The provider's own list of models, asked for with the "
        "saved or server key (never returned), for the model picker: OpenAI "
        "chat models, OpenRouter models that take tools, Gemini models that "
        "generate content, Anthropic's models, or Ollama's installed models. "
        "Kept for 10 minutes per provider and key; `refresh=true` asks again. "
        "400 without a key, 401 when the provider rejects it, 502 when it "
        "cannot be reached; 403 when the Assistant is off.",
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
    "POST /assistant/signin": {
        "summary": "Sign in to an AI account",
        "description": "Start signing in with one of `sign_in.methods` of GET "
        "/assistant/status. `chatgpt` (OAuth with PKCE): `sign_in_url` is "
        "OpenAI's page for the browser, which comes back to GET /auth/callback. "
        "`claude`: Bowser runs the user's Claude Code, which signs in on "
        "Anthropic's page if it is not signed in yet (Bowser never sees its "
        "credentials). 403 unless `BOWSER_ASSISTANT_PAGE_KEYS` is set and the "
        "request comes from this computer.",
        "tags": [ASSISTANT],
    },
    "DELETE /assistant/signin": {
        "summary": "Sign out of an AI account",
        "description": "OAuth: revoke the refresh token with the provider and "
        "forget the tokens (`note` says when the provider did not confirm). "
        "Agent: stop using it here and kill its processes; the agent itself "
        "stays signed in. Same conditions as POST.",
        "tags": [ASSISTANT],
    },
    "GET /auth/callback": {
        "summary": "OAuth sign-in callback",
        "description": "Where the provider's sign-in page sends the browser "
        "back (`code`, `state`, and for a first sign-in the issued "
        "`client_id`). Accepted only from this computer and for the `state` of "
        "a sign-in Bowser started; answers a small HTML page.",
        "tags": [ASSISTANT],
    },
    "POST /assistant/permission": {
        "summary": "Answer an agent's permission request",
        "description": "Answer a `permission` event of POST /assistant/chat: "
        '`{"conversation", "id", "choice": "allow" | "allow_always" | '
        '"reject"}`. Unanswered requests are declined after the event\'s '
        "`timeout` seconds. 404 when the request is no longer open.",
        "tags": [ASSISTANT],
    },
    "POST /assistant/agent": {
        "summary": "Start a chat's agent",
        "description": "Start the signed-in agent (Claude Code) for "
        "`conversation` now, so the first question does not wait for it: the "
        "first time, Bowser installs the agent's ACP adapter into its cache. "
        "Answers the start's phase (see GET). From this computer only.",
        "tags": [ASSISTANT],
    },
    "GET /assistant/agent": {
        "summary": "How far a chat's agent has started",
        "description": "`phase`: `none`, `installing` (the adapter, first "
        "time only), `starting`, `ready` or `error`; `text` to show, "
        "`elapsed` seconds (to ready, once ready), `error`, and a `note` when "
        "npx stands in for the installed adapter. An idle agent is closed "
        "after 10 minutes.",
        "tags": [ASSISTANT],
    },
    "POST /assistant/stop": {
        "summary": "Stop a chat's agent",
        "description": "Kill the agent process of `conversation` (all of them "
        "without one): Stop and New chat in the page. From this computer only.",
        "tags": [ASSISTANT],
    },
    "POST /assistant/chat": {
        "summary": "Chat with the Assistant",
        "description": "Send the conversation to the chosen provider with the "
        "saved or server key and stream the reply as server-sent events: `text` "
        "deltas, each `message` of the conversation, `tool_call` and "
        "`tool_result` for the data tools the server runs itself, `page_tools` "
        "for the tools the page runs (it then sends the results back in a new "
        "request), `error` and `done`. With a signed-in agent (`provider` "
        "`claude` and a `conversation` id) also `status`, `permission` and "
        "`permission_closed`. 403 when the Assistant is off.",
        "tags": [ASSISTANT],
    },
}

#: Routes that bowser-lite answers with 501 (they need GDAL).
LITE_501 = (
    "POST /upload_mask",
    "POST /upload_raster",
    "POST /upload_data",
    "POST /data",
    "GET /data/{data_id}",
    "GET /data/{data_id}.{fmt}",
    "GET /files",
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


class DataConversion(_Fixed):
    """What a server converts added files to (``POST /data``); all off on lite."""

    cog: bool = Field(description="Rasters are converted to Cloud-Optimized GeoTIFFs.")
    pmtiles: bool = Field(
        description="Large vectors are converted to PMTiles (needs GDAL's driver)."
    )
    pmtiles_min_mb: Optional[float] = Field(
        description="Vector uploads larger than this many MB go to the server to be "
        "tiled; smaller ones are read in the browser. Null when `pmtiles` is off."
    )


class AssistantFlag(_Fixed):
    """The Assistant's switch in ``GET /config``."""

    enabled: bool = Field(description="Whether the Assistant tab is on.")
    providers: list[str] = Field(description="Ids of the providers it offers.")
    configured: list[str] = Field(
        description="Ids of the providers with a key, saved or from the server."
    )
    sign_in: list[str] = Field(
        description="Ids of the sign-in methods this server offers (to this "
        "computer only)."
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
    geotiff_upload: bool = Field(
        description="Whether POST /upload_mask and POST /upload_raster work on "
        "this server."
    )
    # --- added data (POST /data) ---
    data_conversion: DataConversion
    overlay_files: list[str] = Field(
        description="Files the page adds when it opens (`bowser run --overlay`, "
        "BOWSER_OVERLAY_FILES)."
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


class SignInMethod(_Fixed):
    """One way to sign in, in ``GET /assistant/status``."""

    id: str
    label: str = Field(description="The button's text.")
    kind: Literal["oauth", "local_agent"]
    vendor: str
    blurb: str
    state: Literal["signed_out", "pending", "signed_in", "no_plan", "not_installed"]
    account: Optional[str] = Field(None, description="The account's email.")
    plan: Optional[str] = None
    detail: Optional[str] = Field(None, description="Why it is not ready.")
    install_url: Optional[str] = None
    usage_url: Optional[str] = Field(None, description="Where to manage usage.")
    model: str = Field(description="Default model; empty for an agent.")
    models: list[str]


class SignInStatus(_Fixed):
    """The ``sign_in`` part of ``GET /assistant/status``."""

    allowed: bool = Field(
        description="Whether this request may sign in: the server keeps keys "
        "from the page and the request comes from this computer."
    )
    reason: Optional[str] = Field(None, description="Why not, when not.")
    methods: list[SignInMethod]


class AssistantStatus(_Fixed):
    """The Assistant's status.

    Sent by ``GET /assistant/status``, ``PUT`` and ``DELETE /assistant/key``,
    ``POST`` and ``DELETE /assistant/signin``.
    """

    enabled: bool
    page_keys: bool = Field(
        description="Whether the page may save keys on this server."
    )
    providers: list[AssistantProvider]
    default_provider: Optional[str] = None
    stored_in: Optional[str] = Field(
        None, description="After PUT: where the key was kept."
    )
    sign_in: SignInStatus
    sign_in_url: Optional[str] = Field(
        None, description="After POST /assistant/signin: the page to open."
    )
    note: Optional[str] = Field(None, description="After sign-out: a caveat.")


class AssistantAnswered(_Fixed):
    """``POST /assistant/permission``."""

    ok: bool


class AssistantAgent(_Fixed):
    """``POST`` and ``GET /assistant/agent``."""

    phase: Literal["none", "installing", "starting", "ready", "error"]
    text: str
    elapsed: float = Field(description="Seconds since the start (to ready).")
    error: Optional[str] = None
    note: Optional[str] = None


class AssistantStopped(_Fixed):
    """``POST /assistant/stop``."""

    stopped: int = Field(description="How many agent processes were killed.")


class AssistantModel(_Fixed):
    """One model in ``GET /assistant/models``."""

    id: str = Field(description="The model id to send.")
    label: Optional[str] = Field(None, description="The provider's display name.")


class AssistantModels(_Fixed):
    """``GET /assistant/models``."""

    provider: str
    models: list[AssistantModel]
    cached: bool = Field(description="Whether the list came from the cache.")


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


class ReferenceCandidate(_Fixed):
    """One candidate of ``GET /reference_candidates``."""

    rank: int = Field(description="1 is the best.")
    lon: float = Field(description="WGS84 longitude of the pixel centre.")
    lat: float = Field(description="WGS84 latitude of the pixel centre.")
    radius_m: float = Field(description="Reference circle radius to use with it.")
    x: float = Field(description="Easting in the cube's CRS.")
    y: float = Field(description="Northing in the cube's CRS.")
    row: int = Field(description="Pixel row at full resolution.")
    col: int = Field(description="Pixel column at full resolution.")
    temporal_coherence_median: Optional[float]
    temporal_coherence_std: Optional[float]
    phase_similarity_median: Optional[float]
    phase_similarity_std: Optional[float]
    pixel_score: Optional[float] = Field(
        description="((med_coh - k std_coh) + (med_sim - k std_sim)) / 2."
    )
    viable_fraction: Optional[float] = Field(
        description="Share of the circle's pixels that are viable."
    )
    mean_score: Optional[float] = Field(
        description="Mean pixel score of the circle's valid pixels."
    )
    neighbourhood_score: Optional[float] = Field(
        description="viable_fraction x mean_score."
    )
    displacement_scatter_m: Optional[float] = Field(
        description="Median over the circle of std through time of "
        "(pixel - circle median) displacement, in metres; low is good."
    )
    score: Optional[float] = Field(
        description="neighbourhood_score x s0 / (s0 + displacement_scatter_m)."
    )
    velocity: Optional[float] = Field(
        description="The velocity layer at the pixel, in its units."
    )
    reason: str


class CandidateThresholds(_Fixed):
    """Thresholds and weights ``GET /reference_candidates`` used."""

    temporal_coherence_median_min: float
    phase_similarity_median_min: float
    from_quantile: dict[str, bool] = Field(
        description="Per layer: true when the threshold came from `quantile`."
    )
    quantile: float
    k_std: float
    scatter_scale_m: float = Field(description="s0 of the final score.")


class CandidateDistribution(_Fixed):
    """Percentiles of the per-pixel medians over the valid pixels."""

    temporal_coherence_median: dict[str, Optional[float]]
    phase_similarity_median: dict[str, Optional[float]]
    n_valid_pixels: int
    n_viable_pixels: int


class CandidateLayers(_Fixed):
    """The layers ``GET /reference_candidates`` read (null when absent)."""

    temporal_coherence: str
    phase_similarity: str
    displacement: Optional[str]
    velocity: Optional[str]
    water_mask: Optional[str]
    masks: list[str]


class CandidateScreening(_Fixed):
    """The grid the search ran on."""

    level: int = Field(description="Pyramid level screened (0: full resolution).")
    pixel_size_m: float
    full_pixel_size_m: float
    refined: bool = Field(
        description="Whether the shortlist was recomputed at full resolution "
        "with every date (after a coarse level or a date subset)."
    )
    circle_pixels: int = Field(description="Pixels in one circle when screening.")
    date_stride: int = Field(description="Every n-th time chunk was screened.")
    dates_screened: int = Field(description="Dates the screening statistics used.")


class CandidateParameters(_Fixed):
    """The search parameters used."""

    radius_m: float
    min_separation_m: float
    n: int
    use_masks: bool


class ReferenceCandidates(_Fixed):
    """``GET /reference_candidates``."""

    recommended: Optional[ReferenceCandidate] = Field(
        description="The first candidate: set it with its lon, lat and radius_m."
    )
    candidates: list[ReferenceCandidate]
    thresholds: CandidateThresholds
    distribution: CandidateDistribution
    parameters: CandidateParameters
    layers: CandidateLayers
    screening: CandidateScreening
    cached: bool = Field(
        description="True when the per-pixel stack statistics came from the cache."
    )


class StatsLayerStatus(_Fixed):
    """One layer's per-pixel statistics in ``GET /reference_candidates/status``."""

    state: Literal["idle", "running", "ready"]
    progress: float = Field(description="0 to 1.")


class ReferenceCandidatesStatus(_Fixed):
    """``GET /reference_candidates/status``."""

    state: Literal["idle", "running", "ready", "unavailable"] = Field(
        description="ready: a search answers in seconds; running: being "
        "prepared (by the background warm-up or a search); idle: not started; "
        "unavailable: the cube lacks the layers."
    )
    progress: float = Field(description="0 to 1, over the layers.")
    layers: dict[str, StatsLayerStatus]
    detail: Optional[str]
    warm_up: bool = Field(description="Whether this server warms up opened cubes.")


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


class UploadedData(_Fixed):
    """``POST /upload_data``: where the upload is, to pass to ``POST /data``."""

    path: str = Field(description="Server path of the main file.")
    name: str = Field(description="Its name as uploaded.")


class DataStatus(_Fixed):
    """``POST /data`` and ``GET /data/{data_id}``."""

    id: str = Field(description="Conversion id, for GET /data/{data_id}.")
    name: str = Field(description="The file's name.")
    kind: Literal["raster", "vector"]
    format: Literal["cog", "pmtiles", "geojson"] = Field(
        description="What it is drawn from: a COG through /overlay, or a PMTiles "
        "archive or GeoJSON from `url`."
    )
    status: Literal["converting", "ready", "failed"]
    converted: Optional[bool] = Field(
        None, description="False when a raster was already a COG."
    )
    elapsed_s: Optional[float] = Field(
        None, description="Seconds since the conversion started."
    )
    error: Optional[str] = None
    bounds: Optional[list[float]] = Field(
        None, description="WGS84 [west, south, east, north]."
    )
    # A raster, once ready.
    cog: Optional[str] = Field(
        None, description="Server path of the COG; pass as url= to /overlay."
    )
    band_count: Optional[int] = None
    bands: Optional[list[BandStats]] = None
    nodata: Optional[float] = None
    dem: Optional[bool] = Field(
        None,
        description="Whether it looks like an elevation model (one band of "
        "heights); the page then draws it as a hillshade.",
    )
    # A vector.
    url: Optional[str] = Field(
        None, description="Where to read it, once ready: GET /data/{data_id}.{fmt}."
    )
    layers: Optional[list[str]] = Field(None, description="Its non-empty layers.")
    feature_count: Optional[int] = None


class FolderEntry(_Fixed):
    """A sub-folder, or a file ``POST /data`` adds, in ``GET /files``."""

    name: str
    path: str = Field(description="Server path; pass a file's to POST /data.")
    type: Literal["dir", "file"]
    size: Optional[int] = Field(None, description="A file's size in bytes.")
    kind: Optional[Literal["raster", "vector"]] = Field(
        None, description="What a file is added as."
    )


class FolderListing(_Fixed):
    """``GET /files``: one server folder."""

    dir: str = Field(description="The folder, with its symlinks resolved.")
    parent: Optional[str] = Field(description="Its parent; null at the root.")
    entries: list[FolderEntry] = Field(
        description="Sub-folders first, then files, each sorted by name."
    )
    truncated: bool = Field(description="More than 1000 entries: only those sent.")
    skipped: int = Field(description="Entries left out that could not be read.")


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
#: ``GET /data/{data_id}.{fmt}``: the whole file, or the byte range asked for.
DATA_FILE_RESPONSES: dict[int | str, Any] = {
    200: {
        "description": "The PMTiles archive or GeoJSON.",
        "content": {"application/vnd.pmtiles": {}, "application/geo+json": {}},
    },
    206: {"description": "The byte range of the archive asked for with `Range`."},
}

NOT_IN_LITE: dict[int | str, Any] = {
    501: {"model": ErrorDetail, "description": "Needs the full server (GDAL)."}
}
