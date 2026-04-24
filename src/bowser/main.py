import base64
import hashlib
import hmac
import json
import logging
import os
import time
import warnings
from pathlib import Path
from typing import Annotated, Any, Callable, Optional

import matplotlib
import numpy as np
import rasterio
import xarray as xr
from fastapi import (
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response as StarletteResponse
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates
from starlette_cramjam.middleware import CompressionMiddleware

from .config import settings
from .state import BowserState, DatasetRegistry
from .utils import (
    calculate_trend,
    desensitize_mpl_case,
    generate_colorbar,
    register_custom_colormaps,
)

# Register custom colormaps in rio_tiler BEFORE titiler.core.dependencies is
# imported.  titiler captures cmap.list() into a Literal type annotation at
# import time, so reversed variants (cfastie_r, etc.) must be in the registry
# before that happens.
register_custom_colormaps()

from rio_tiler.io.xarray import XarrayReader  # noqa: E402
from titiler.core.algorithm import algorithms as default_algorithms  # noqa: E402
from titiler.core.dependencies import DefaultDependency  # noqa: E402
from titiler.core.errors import (  # noqa: E402
    DEFAULT_STATUS_CODES,
    add_exception_handlers,
)
from titiler.core.factory import TilerFactory  # noqa: E402

from .readers import CustomReader  # noqa: E402
from .titiler import Amplitude, JSONResponse, Phase, Rewrap, Shift  # noqa: E402

logger = logging.getLogger("bowser")
warnings.filterwarnings(
    "ignore", category=RuntimeWarning, message="invalid value encountered in cast"
)

t0 = time.time()

# Set up matplotlib backend for thread safety BEFORE any matplotlib imports

matplotlib.use("Agg")

# Set up logging
h = logging.StreamHandler()
h.setLevel(settings.LOG_LEVEL)
h.setFormatter(
    logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%dT:%H:%M:%S",
    )
)
logger.addHandler(h)

template_dir = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=template_dir)
desensitize_mpl_case()

app = FastAPI(
    title="Bowser",
    openapi_url="/api",
    docs_url="/api.html",
)


def _load_htpasswd(path: str) -> dict[str, str]:
    """Parse an htpasswd file into {username: hashed_password}."""
    users: dict[str, str] = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(":", 1)
        if len(parts) == 2:
            users[parts[0]] = parts[1]
    return users


def _check_password(stored: str, provided: str) -> bool:
    """Verify a plaintext password against an htpasswd entry (SHA1 or bcrypt)."""
    if stored.startswith("{SHA}"):
        digest = base64.b64encode(hashlib.sha1(provided.encode()).digest()).decode()
        return hmac.compare_digest(stored[5:], digest)
    try:
        import bcrypt  # optional — only needed for bcrypt hashes

        return bcrypt.checkpw(provided.encode(), stored.encode())
    except ImportError:
        pass
    # apr1/md5 not implemented — tell user to use SHA or bcrypt
    return False


class BasicAuthMiddleware(BaseHTTPMiddleware):
    """HTTP Basic Auth gate — only active when BOWSER_HTPASSWD_FILE is set."""

    def __init__(self, app, htpasswd_file: str) -> None:
        """Initialise with the path to an htpasswd file."""
        super().__init__(app)
        self.htpasswd_file = Path(htpasswd_file)

    def _users(self) -> dict[str, str]:
        return (
            _load_htpasswd(str(self.htpasswd_file))
            if self.htpasswd_file.exists()
            else {}
        )

    async def dispatch(self, request: Request, call_next: Any) -> StarletteResponse:
        """Enforce HTTP Basic Auth before delegating to downstream handlers."""
        users = self._users()
        if not users:
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                decoded = base64.b64decode(auth[6:]).decode("utf-8", errors="replace")
                username, _, password = decoded.partition(":")
                stored = users.get(username)
                if stored and _check_password(stored, password):
                    return await call_next(request)
            except Exception:
                pass

        return StarletteResponse(
            content="Unauthorized",
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="Bowser"'},
        )


if settings.BOWSER_HTPASSWD_FILE:
    app.add_middleware(BasicAuthMiddleware, htpasswd_file=settings.BOWSER_HTPASSWD_FILE)
    logger.info(f"Basic auth enabled from {settings.BOWSER_HTPASSWD_FILE}")


state = BowserState.load(settings)
# Multi-dataset registry (empty unless BOWSER_CATALOG_FILE is set). Every MD
# endpoint that accepts a ``dataset`` query param routes through this; when
# ``dataset`` is omitted, callers fall back to the single ``state`` above so
# the existing single-dataset CLI flow keeps working unchanged.
registry = DatasetRegistry.from_settings(settings)
print(
    f"Data loading complete in {time.time() - t0:.1f} sec. "
    f"Mode: {state.mode}, catalog entries: {len(registry.ids())}"
)


def _resolve_state(dataset: str | None) -> BowserState:
    """Return the BowserState to serve a request from.

    - ``dataset=None`` → the default single-dataset ``state`` (legacy flow).
      In catalog-only mode (``state`` is a stub with no data), callers that
      try to use the returned state will fail loudly on attribute access —
      which is what we want: an endpoint that forgot to honour ``?dataset=``
      must not silently serve wrong data from the default.
    - ``dataset=<id>`` → the registry-loaded state for that catalog entry.

    Raises ``HTTPException(404)`` when ``dataset`` is given but not in the
    catalog.
    """
    if dataset is None:
        return state
    try:
        return registry.get(dataset)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


def TargetState(dataset: str | None = Query(None)) -> BowserState:
    """FastAPI dependency: route a request to its catalog-chosen ``BowserState``.

    Every MD endpoint that reads ``target.dataset`` / ``target.raster_groups``
    should take this as ``target: BowserState = Depends(TargetState)``.
    Requests without ``?dataset=`` get the module-level default state (legacy
    single-dataset flow). Requests with ``?dataset=X`` get the registry-loaded
    state for that catalog entry (or 404 on unknown id).
    """
    return _resolve_state(dataset)


_SPATIAL_DIMS = ("x", "y")


def _non_spatial_dim(da: xr.DataArray) -> str | None:
    """Return the single non-spatial dim of a DataArray, or None if purely 2-D."""
    non = [d for d in da.dims if d not in _SPATIAL_DIMS]
    if not non:
        return None
    assert len(non) == 1, f"{da.name!r}: expected 0 or 1 non-spatial dim, got {non}"
    return str(non[0])


def _dim_labels(da: xr.DataArray, dim: str) -> list[str]:
    """Render a non-spatial dim's coord values as display labels.

    Order of preference:
    1. A sibling ``pair_label_<slug>`` string coord on the same dim (written by
       the geozarr converter).
    2. Datetime64 dim coord → ``YYYY-MM-DD`` strings.
    3. Matching ``reference_date_*`` / ``secondary_date_*`` date coords on the
       same dim → ``YYYY-MM-DD_YYYY-MM-DD`` pair strings.
    4. Fallback: ``str()`` of each value.
    """
    for c in da.coords:
        if str(c).startswith("pair_label_") and da[c].dims == (dim,):
            return [str(v) for v in da[c].values]

    import pandas as pd  # noqa: PLC0415

    vals = da.coords[dim].values
    if np.issubdtype(vals.dtype, np.datetime64):
        return pd.to_datetime(vals).strftime("%Y-%m-%d").tolist()

    ref = [
        c
        for c in da.coords
        if str(c).startswith("reference_date_") and da[c].dims == (dim,)
    ]
    sec = [
        c
        for c in da.coords
        if str(c).startswith("secondary_date_") and da[c].dims == (dim,)
    ]
    if ref and sec:
        r = pd.to_datetime(da[ref[0]].values)
        s = pd.to_datetime(da[sec[0]].values)
        return [
            f"{a.strftime('%Y-%m-%d')}_{b.strftime('%Y-%m-%d')}" for a, b in zip(r, s)
        ]

    return [str(v) for v in vals]


def _reference_date(labels: list[str], dim: str) -> str | None:
    """Return a shared reference date if all pair labels share the same ref."""
    if not dim.startswith("pair_") or not labels:
        return None
    refs = {lbl.split("_")[0] for lbl in labels if "_" in lbl}
    return refs.pop() if len(refs) == 1 else None


def _los_metadata_from_attrs(attrs: dict) -> dict | None:
    """Pull LOS metadata from xarray/zarr attrs, returning a JSON-serializable dict.

    Recognizes both the legacy schema (scalar ``incidence_angle_deg`` + flat
    ``{east, north, up}`` ENU) and the per-swath schema with
    ``{near, center, far}`` sub-dicts for incidence and ENU.
    """
    heading = attrs.get("heading_angle_deg")
    incidence = attrs.get("incidence_angle_deg")
    if heading is None or incidence is None:
        return None

    def _enu_dict(d: Any) -> dict | None:
        if isinstance(d, dict) and {"east", "north", "up"}.issubset(d):
            return {
                "east": float(d["east"]),
                "north": float(d["north"]),
                "up": float(d["up"]),
            }
        return None

    # Incidence can be a scalar or a {near, center, far} dict.
    if isinstance(incidence, dict) and "center" in incidence:
        inc_center = float(incidence["center"])
        inc_near = float(incidence["near"]) if "near" in incidence else None
        inc_far = float(incidence["far"]) if "far" in incidence else None
    else:
        inc_center = float(incidence)
        inc_near = inc_far = None

    result: dict = {
        "heading_deg": float(heading),
        "incidence_deg": inc_center,
    }
    if inc_near is not None:
        result["incidence_deg_near"] = inc_near
    if inc_far is not None:
        result["incidence_deg_far"] = inc_far

    los = attrs.get("los_enu_ground_to_satellite") or attrs.get("los_enu_ground_to_sat")
    if isinstance(los, dict):
        if "center" in los:
            center = _enu_dict(los.get("center"))
            near = _enu_dict(los.get("near"))
            far = _enu_dict(los.get("far"))
            if center is not None:
                result["los_enu_ground_to_sat"] = center
            if near is not None:
                result["los_enu_ground_to_sat_near"] = near
            if far is not None:
                result["los_enu_ground_to_sat_far"] = far
        else:
            flat = _enu_dict(los)
            if flat is not None:
                result["los_enu_ground_to_sat"] = flat
    return result


def create_xarray_dataset_info(ds: xr.Dataset) -> dict:
    """Create dataset info structure from Xarray Dataset."""
    bounds = ds.rio.bounds()
    if ds.rio.crs != rasterio.crs.CRS.from_epsg(4326):
        mdim_vars = [v for v in ds.data_vars.values() if v.ndim >= 2]
        da = mdim_vars[0][..., ::10, ::10]
        if da.ndim == 3:
            da = da[0]
        latlon_bounds = da.rio.reproject("epsg:4326", subsample=10).rio.bounds()
    else:
        latlon_bounds = bounds
    logger.info(
        f"latlon_bounds: {latlon_bounds}, bounds: {bounds}, ds.rio.crs: {ds.rio.crs}"
    )

    los_metadata = _los_metadata_from_attrs(dict(ds.attrs))
    dataset_info = {}
    skip_spatial_reference = not settings.BOWSER_USE_SPATIAL_REFERENCE_DISP
    for var_name, var in ds.data_vars.items():
        if not {"x", "y"}.issubset(set(var.dims)):
            continue
        use_moving_reference = (
            (
                "displacement" in str(var_name).lower()
                and "short_wave" not in str(var_name).lower()
            )
            or "velocity" in str(var_name).lower()
        ) and not skip_spatial_reference
        available_mask_vars = [
            v
            for v in ["temporal_coherence", "phase_similarity", "recommended_mask"]
            if v in ds.data_vars
        ]
        dim = _non_spatial_dim(var)
        labels = _dim_labels(var, dim) if dim is not None else []
        n = len(labels) if dim is not None else 1
        attrs = dict(var.attrs)
        dataset_info[var_name] = {
            "name": var_name,
            "file_list": (
                [f"variable:{var_name}:{dim}:{i}" for i in range(n)]
                if dim is not None
                else [f"variable:{var_name}"]
            ),
            "mask_file_list": [],
            "mask_min_value": 0.1,
            "nodata": None,
            "uses_spatial_ref": use_moving_reference,
            "algorithm": "shift" if use_moving_reference else None,
            "bounds": list(bounds),
            "latlon_bounds": list(latlon_bounds),
            "x_values": labels,
            "reference_date": _reference_date(labels, dim) if dim else None,
            "available_mask_vars": available_mask_vars,
            "label": attrs.get("long_name", var_name),
            "unit": attrs.get("units", ""),
            "los_metadata": los_metadata,
        }

    return dataset_info


def create_rastergroup_dataset_info(raster_groups: dict) -> dict:
    """Create dataset info structure from RasterGroups."""
    dataset_info = {}
    for name, rg in raster_groups.items():
        dataset_info[name] = {
            "name": rg.name,
            "file_list": [str(f) for f in rg.file_list],
            "mask_file_list": [str(f) for f in rg.mask_file_list],
            "mask_min_value": rg.mask_min_value,
            "nodata": rg.nodata,
            "uses_spatial_ref": rg.uses_spatial_ref,
            "algorithm": rg.algorithm,
            "bounds": list(rg.bounds),
            "latlon_bounds": list(rg.latlon_bounds),
            "x_values": rg.x_values,
            "reference_date": rg.reference_date,
            "los_metadata": (
                rg.los_metadata.model_dump() if rg.los_metadata is not None else None
            ),
        }
    return dataset_info


@app.get("/datasets")
async def datasets(dataset: str | None = Query(None)):
    """Return the JSON describing all data variables for the chosen dataset.

    When ``dataset`` is given, routes through the catalog-loaded store for
    that id; otherwise returns info for the single dataset loaded via
    ``--stack-file`` or the RasterGroup config in COG mode.
    """
    target = _resolve_state(dataset)
    if target.mode == "md":
        return create_xarray_dataset_info(target.dataset)
    else:  # cog mode
        return create_rastergroup_dataset_info(target.raster_groups)


@app.get("/mode")
async def get_mode():
    """Return the current data mode (md or cog) for frontend routing."""
    return {"mode": state.mode}


@app.get("/config")
async def get_config():
    """Return app configuration for the frontend."""
    return {"title": settings.BOWSER_TITLE}


@app.get("/catalog")
async def get_catalog():
    """Return the registered dataset catalog as JSON for the picker UI.

    Entries come from the TOML file at ``BOWSER_CATALOG_FILE`` (if set) —
    each with ``{id, name, uri, bbox, description}``. Returns an empty list
    when no catalog is configured or the file is missing.
    """
    from .catalog import load_catalog  # noqa: PLC0415

    if not settings.BOWSER_CATALOG_FILE:
        return {"datasets": []}
    entries = load_catalog(settings.BOWSER_CATALOG_FILE)
    return {"datasets": [e.to_dict() for e in entries]}


@app.get("/variables")
async def get_variables(dataset: str | None = Query(None)):
    """Get available variables (only for MD mode).

    When ``dataset`` is given, resolves to that catalog entry's store;
    otherwise returns the single dataset loaded via ``--stack-file``.
    """
    target = _resolve_state(dataset)
    if target.mode != "md":
        return {"variables": {}}

    variables = {}
    for var_name, var in target.dataset.data_vars.items():
        if "x" in var.dims and "y" in var.dims:
            variables[var_name] = {
                "dimensions": list(var.dims),
                "shape": list(var.shape),
                "dtype": str(var.dtype),
                "attrs": dict(var.attrs),
            }
    return {"variables": variables}


def _scale_threshold(threshold: float, vmin: float, vmax: float) -> float:
    """Map a 0–1 normalised threshold to the actual [vmin, vmax] data range."""
    if np.isfinite(vmin) and np.isfinite(vmax) and vmax > vmin:
        return vmin + threshold * (vmax - vmin)
    return threshold


# Cache dataset-level min/max so nanmin/nanmax aren't recomputed on every tile request.
_MD_VAR_RANGE_CACHE: dict[str, tuple[float, float]] = {}


def _md_var_range(var: str) -> tuple[float, float]:
    """Return (nanmin, nanmax) for an MD dataset variable, cached after first call."""
    if var not in _MD_VAR_RANGE_CACHE:
        arr = state.dataset[var].values
        _MD_VAR_RANGE_CACHE[var] = (float(np.nanmin(arr)), float(np.nanmax(arr)))
    return _MD_VAR_RANGE_CACHE[var]


def _apply_layer_masks_md(
    da: "xr.DataArray",
    layer_masks: list[dict],
    time_idx: int | None = None,
    source_ds: "xr.Dataset | None" = None,
) -> "xr.DataArray":
    """Apply a list of layer mask dicts to a DataArray (MD mode).

    Each dict has keys: dataset (str), threshold (float), mode ('min'|'max').
    threshold is an absolute value in the mask layer's data units.
    'min' keeps pixels >= threshold; 'max' keeps pixels <= threshold.

    ``source_ds`` is the Dataset to look up mask variables in. Tile-rendering
    callers MUST pass the same pyramid-level Dataset that ``da`` came from —
    otherwise ``da.where(mask_da)`` outer-aligns two grids with different
    cell sizes, producing a coord array that ``rioxarray.rio.bounds()`` can't
    interpret as monotonic and the request 500s with NoDataInBounds. Defaults
    to ``state.dataset`` (level 0) for the non-tile callers that already
    operate at full resolution.
    """
    ds = source_ds if source_ds is not None else state.dataset
    for m in layer_masks:
        var = m.get("dataset")
        threshold = float(m.get("threshold", 0.5))
        mode = m.get("mode", "min")
        if not var or var not in ds.data_vars:
            continue
        mask_da = ds[var]
        if time_idx is not None:
            mdim = _non_spatial_dim(mask_da)
            if mdim is not None:
                mask_da = mask_da.isel({mdim: time_idx})
        if mode == "max":
            da = da.where(mask_da <= threshold)
        else:
            da = da.where(mask_da >= threshold)
    return da


async def _get_ref_median(
    dataset_name: str,
    lon: float,
    lat: float,
    buffer_m: float = 0.0,
    layer_masks: list[dict] | None = None,
) -> np.ndarray:
    """Return reference time series.

    Buffer median when ``buffer_m > 0`` (MD mode), else a single pixel.
    """
    layer_masks = layer_masks or []
    if buffer_m <= 0 or state.mode != "md":
        return await _get_point_values(dataset_name, lon, lat, layer_masks)

    if dataset_name not in state.dataset.data_vars:
        raise HTTPException(
            status_code=404, detail=f"Variable {dataset_name} not found"
        )

    from pyproj import Transformer as _T  # noqa: PLC0415, N814

    da = state.dataset[dataset_name]
    da = _apply_layer_masks_md(da, layer_masks)

    tr = _T.from_crs(4326, state.dataset.rio.crs, always_xy=True)
    cx, cy = tr.transform(lon, lat)
    res_x = float(abs(da.x[1] - da.x[0])) if da.x.size > 1 else 1.0
    res_y = float(abs(da.y[1] - da.y[0])) if da.y.size > 1 else 1.0

    x_slice = da.x.sel(x=slice(cx - buffer_m - res_x, cx + buffer_m + res_x))
    y_slice = da.y.sel(y=slice(cy + buffer_m + res_y, cy - buffer_m - res_y))
    if x_slice.size == 0 or y_slice.size == 0:
        return await _get_point_values(dataset_name, lon, lat, layer_masks)

    window = da.sel(x=x_slice, y=y_slice)
    xx, yy = np.meshgrid(x_slice.values, y_slice.values)
    in_circle = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) <= buffer_m

    arr = window.values  # (time, ny, nx)
    arr_masked = np.where(in_circle[np.newaxis, :, :], arr, np.nan)
    flat = arr_masked.reshape(arr.shape[0], -1)  # (time, n_pixels)

    return np.nanmedian(flat, axis=1)  # (time,)


async def _get_point_values(
    dataset_name: str,
    lon: float,
    lat: float,
    layer_masks: list[dict] | None = None,
) -> np.ndarray:
    """Get point values for a dataset at lon/lat, with optional MD-mode masking."""
    if state.mode == "md":
        if dataset_name not in state.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = state.dataset[dataset_name]
        da = _apply_layer_masks_md(da, layer_masks or [])
        x, y = state.transformer_from_lonlat.transform(lon, lat)
        point_data = da.sel(x=x, y=y, method="nearest")
        return np.atleast_1d(point_data.values)
    else:  # cog mode
        if dataset_name not in state.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        return np.atleast_1d(
            state.raster_groups[dataset_name]._reader.read_lonlat(lon, lat)
        )


@app.get(
    "/point",
    response_class=JSONResponse,
    responses={200: {"description": "Return the list of values for a point"}},
)
async def point(
    dataset_name: str,
    lon: Annotated[float, Query(..., title="Longitude", ge=-180, le=180)],
    lat: Annotated[float, Query(..., title="Latitude", ge=-90, le=90)],
):
    """Fetch list of time series values for a point."""
    values = await _get_point_values(dataset_name, lon, lat)
    return JSONResponse(values.tolist())


@app.get(
    "/chart_point",
    response_class=JSONResponse,
    responses={200: {"description": "Return the Chart.js-formatted data for a point"}},
)
async def chart_point(
    dataset_name: str,
    lon: Annotated[float, Query(..., title="Longitude", ge=-180, le=180)],
    lat: Annotated[float, Query(..., title="Latitude", ge=-90, le=90)],
    ref_lon: Annotated[
        float | None, Query(..., title="Reference longitude", ge=-180, le=180)
    ] = None,
    ref_lat: Annotated[
        float | None, Query(..., title="Reference latitude", ge=-90, le=90)
    ] = None,
):
    """Fetch the Chart.js time series values for a point (relative to a reference)."""
    # Get time values based on data mode
    if state.mode == "md":
        if dataset_name not in state.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = state.dataset[dataset_name]
        dim = _non_spatial_dim(da)
        x_values = _dim_labels(da, dim) if dim is not None else []
    else:  # cog mode
        if dataset_name not in state.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = state.raster_groups[dataset_name]
        x_values = rg.x_values

    def values_to_chart_data(values):
        """Convert values to chart data."""
        return [
            {"x": x, "y": float(y)}
            for x, y in zip(x_values, np.atleast_1d(values).tolist())
            if not np.isnan(y)
        ]

    # Get values at the point
    values = await _get_point_values(dataset_name, lon, lat)

    # Apply reference subtraction if provided
    if ref_lon is not None and ref_lat is not None:
        ref_values = await _get_point_values(dataset_name, ref_lon, ref_lat)
        values = values - ref_values

    dataset_item = values_to_chart_data(values.tolist())

    return JSONResponse({"datasets": [{"data": dataset_item}], "labels": x_values})


@app.post(
    "/multi_point",
    response_class=JSONResponse,
    responses={200: {"description": "Return time series data for multiple points"}},
)
async def multi_point(
    points: list[dict[str, Any]] = Body(
        ..., description="List of points with id, lat, lon"
    ),
    dataset_name: str = Body(..., description="Dataset name"),
    ref_lon: Optional[float] = Body(None, description="Reference longitude"),
    ref_lat: Optional[float] = Body(None, description="Reference latitude"),
    calculate_trends: bool = Body(
        False, description="Whether to calculate trend analysis"
    ),
    layer_masks: list[dict] = Body(
        [], description="List of {dataset, threshold, mode} mask dicts"
    ),
    ref_buffer_m: float = Body(
        0.0, description="Buffer radius (m) for median re-referencing; 0 = single pixel"
    ),
):
    """Fetch time series data for multiple points efficiently."""
    # Get time values based on data mode
    if state.mode == "md":
        if dataset_name not in state.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = state.dataset[dataset_name]
        dim = _non_spatial_dim(da)
        x_values = _dim_labels(da, dim) if dim is not None else []
    else:  # cog mode
        if dataset_name not in state.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = state.raster_groups[dataset_name]
        x_values = rg.x_values

    # Get reference values if provided (use buffer median when ref_buffer_m > 0)
    ref_values = None
    if ref_lon is not None and ref_lat is not None:
        ref_values = await _get_ref_median(
            dataset_name,
            ref_lon,
            ref_lat,
            ref_buffer_m,
            layer_masks,
        )

    # Process each point
    results = []
    for point_info in points:
        point_id = point_info.get("id")
        lat = point_info.get("lat")
        lon = point_info.get("lon")
        color = point_info.get("color", "#1f77b4")
        name = point_info.get("name", f"Point {point_id}")

        if not all([point_id, lat is not None, lon is not None]):
            continue

        try:
            # Get values at the point
            values = await _get_point_values(
                dataset_name,
                float(lon),  # type: ignore[arg-type]
                float(lat),  # type: ignore[arg-type]
                layer_masks,
            )

            # Apply reference subtraction if provided
            if ref_values is not None:
                values = values - ref_values

            # Convert to chart data format
            chart_data = [
                {"x": x, "y": float(y)}
                for x, y in zip(x_values, np.atleast_1d(values).tolist())
                if not np.isnan(y)
            ]

            # Calculate trend if requested
            trend_data = None
            if calculate_trends and len(chart_data) > 1:
                trend_result = calculate_trend(values, x_values)  # type: ignore[arg-type]
                # Convert to frontend format
                trend_data = {
                    "slope": trend_result["slope"],
                    "intercept": trend_result["intercept"],
                    "rSquared": trend_result["r_squared"],
                    "mmPerYear": trend_result["mm_per_year"],
                }

            results.append(
                {
                    "pointId": point_id,
                    "label": name,
                    "data": chart_data,
                    "borderColor": color,
                    "backgroundColor": color + "20",
                    "trend": trend_data,
                }
            )

        except Exception as e:
            logger.error(f"Error processing point {point_id}: {e}")
            continue

    return JSONResponse(
        {
            "labels": x_values,
            "datasets": results,
        }
    )


@app.get(
    "/trend_analysis/{dataset_name}",
    response_class=JSONResponse,
    responses={200: {"description": "Return trend analysis for a point"}},
)
async def trend_analysis(
    dataset_name: str,
    lon: Annotated[float, Query(title="Longitude", ge=-180, le=180)],
    lat: Annotated[float, Query(title="Latitude", ge=-90, le=90)],
    ref_lon: Annotated[
        float | None, Query(title="Reference longitude", ge=-180, le=180)
    ] = None,
    ref_lat: Annotated[
        float | None, Query(title="Reference latitude", ge=-90, le=90)
    ] = None,
):
    """Calculate trend analysis (mm/year rate) for a single point."""
    # Get time values based on data mode
    if state.mode == "md":
        if dataset_name not in state.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = state.dataset[dataset_name]
        dim = _non_spatial_dim(da)
        x_values = _dim_labels(da, dim) if dim is not None else []
    else:  # cog mode
        if dataset_name not in state.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = state.raster_groups[dataset_name]
        x_values = rg.x_values

    # Get values at the point
    values = await _get_point_values(dataset_name, lon, lat)

    # Apply reference subtraction if provided
    if ref_lon is not None and ref_lat is not None:
        ref_values = await _get_point_values(dataset_name, ref_lon, ref_lat)
        values = values - ref_values

    # Calculate trend
    trend_data = calculate_trend(values, x_values)  # type: ignore[arg-type]

    return JSONResponse(trend_data)


@app.get("/datasets/{dataset_name}/time_bounds")
async def get_time_bounds(
    dataset_name: str,
    target: BowserState = Depends(TargetState),
):
    """Get time bounds for a dataset to help with trend calculations."""
    if target.mode == "md":
        if dataset_name not in target.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = target.dataset[dataset_name]
        dim = _non_spatial_dim(da)
        labels = _dim_labels(da, dim) if dim is not None else []
    else:  # cog mode
        if dataset_name not in target.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        labels = [str(v) for v in target.raster_groups[dataset_name].x_values]

    if not labels:
        raise HTTPException(status_code=400, detail=f"{dataset_name} has no time dim")

    return JSONResponse(
        {
            "start_time": labels[0],
            "end_time": labels[-1],
            "num_time_steps": len(labels),
        }
    )


@app.get("/colorbar/{cmap_name}")
async def get_colorbar(cmap_name: str):
    """Get a WEBP image of a matplotlib colorbar."""
    try:
        colorbar_bytes = generate_colorbar(cmap_name)
        return Response(content=colorbar_bytes, media_type="image/webp")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get(
    "/dataset_range/{dataset_name}",
    response_class=JSONResponse,
    responses={
        200: {"description": "Return min/max/p2/p98 for a dataset (first time slice)"}
    },
)
async def get_dataset_range(
    dataset_name: str,
    target: BowserState = Depends(TargetState),
):
    """Return the value range of a dataset for use in mask threshold sliders."""
    if target.mode == "md":
        if dataset_name not in target.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = target.dataset[dataset_name]
        dim = _non_spatial_dim(da)
        arr = (
            (da.isel({dim: 0}) if dim is not None else da).values.ravel().astype(float)
        )
    else:
        if dataset_name not in target.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = target.raster_groups[dataset_name]
        with rasterio.open(rg.file_list[0]) as src:
            arr = src.read(1).ravel().astype(float)
            nodata = src.nodata
        if nodata is not None:
            arr = arr[arr != nodata]

    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        raise HTTPException(status_code=204, detail="No valid data")

    return JSONResponse(
        {
            "min": float(valid.min()),
            "max": float(valid.max()),
            "p2": float(np.percentile(valid, 2)),
            "p98": float(np.percentile(valid, 98)),
        }
    )


@app.get(
    "/histogram/{dataset_name}",
    response_class=JSONResponse,
    responses={200: {"description": "Return histogram data for one time slice"}},
)
async def get_histogram(
    dataset_name: str,
    time_index: Annotated[int, Query(ge=0)] = 0,
    nbins: Annotated[int, Query(ge=4, le=256)] = 100,
    target: BowserState = Depends(TargetState),
):
    """Compute a histogram of valid pixel values for one time step of a dataset."""
    if target.mode == "md":
        if dataset_name not in target.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = target.dataset[dataset_name]
        dim = _non_spatial_dim(da)
        if dim is not None:
            time_index = min(time_index, da.sizes[dim] - 1)
            arr = da.isel({dim: time_index}).values.ravel().astype(float)
        else:
            arr = da.values.ravel().astype(float)
    else:
        if dataset_name not in target.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = target.raster_groups[dataset_name]
        time_index = min(time_index, len(rg.file_list) - 1)
        with rasterio.open(rg.file_list[time_index]) as src:
            arr = src.read(1).ravel().astype(float)
            nodata = src.nodata
        if nodata is not None:
            arr = arr[arr != nodata]

    # Previously this also filtered `arr != 0`, but 0 is meaningful for
    # categorical / mask layers (ps_mask, recommended_mask) — excluding it
    # could empty the histogram on a tile with no PS pixels in view. NaN is
    # the correct missing-value sentinel; `isfinite` handles it.
    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        # An empty view returns an empty histogram at 200 rather than 204 —
        # HTTP 204 must have an empty body (RFC 7230), which makes clients
        # that call .json() blow up with "unexpected end of data".
        return JSONResponse(
            {k: 0.0 for k in ("min", "max", "p2", "p98", "p16", "p84", "p23", "p977")}
            | {"bins": [], "counts": []}
        )

    counts, bin_edges = np.histogram(valid, bins=nbins)
    return JSONResponse(
        {
            "bins": bin_edges.tolist(),
            "counts": counts.tolist(),
            "min": float(valid.min()),
            "max": float(valid.max()),
            "p2": float(np.percentile(valid, 2)),
            "p98": float(np.percentile(valid, 98)),
            "p16": float(np.percentile(valid, 16)),
            "p84": float(np.percentile(valid, 84)),
            "p23": float(np.percentile(valid, 2.275)),
            "p977": float(np.percentile(valid, 97.725)),
        }
    )


@app.post(
    "/buffer_timeseries",
    response_class=JSONResponse,
    responses={
        200: {
            "description": "Return median + sampled pixel time series within a buffer"
        }
    },
)
async def buffer_timeseries(
    lon: float = Body(..., description="Center longitude"),
    lat: float = Body(..., description="Center latitude"),
    dataset_name: str = Body(..., description="Dataset name"),
    buffer_m: float = Body(500.0, description="Buffer radius in metres"),
    n_samples: int = Body(10, description="Number of random pixel samples to return"),
    ref_lon: Optional[float] = Body(None),
    ref_lat: Optional[float] = Body(None),
    layer_masks: list[dict] = Body(
        [], description="List of {dataset, threshold, mode} mask dicts"
    ),
    ref_buffer_m: float = Body(
        0.0, description="Buffer radius (m) for median re-referencing; 0 = single pixel"
    ),
):
    """Collect all pixels within a circular buffer, return median + random samples."""
    if state.mode == "md":
        if dataset_name not in state.dataset.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = state.dataset[dataset_name]
        da = _apply_layer_masks_md(da, layer_masks)
        dim = _non_spatial_dim(da)
        x_values: list = _dim_labels(da, dim) if dim is not None else []

        # Project centre to dataset CRS
        from pyproj import Transformer as _T  # noqa: PLC0415, N814

        tr = _T.from_crs(4326, state.dataset.rio.crs, always_xy=True)
        cx, cy = tr.transform(lon, lat)

        res_x = float(abs(da.x[1] - da.x[0])) if da.x.size > 1 else 1.0
        res_y = float(abs(da.y[1] - da.y[0])) if da.y.size > 1 else 1.0

        # Select spatial window
        x_slice = da.x.sel(x=slice(cx - buffer_m - res_x, cx + buffer_m + res_x))
        y_slice = da.y.sel(y=slice(cy + buffer_m + res_y, cy - buffer_m - res_y))
        if x_slice.size == 0 or y_slice.size == 0:
            raise HTTPException(status_code=404, detail="Buffer outside dataset extent")

        window = da.sel(x=x_slice, y=y_slice)
        # Circular mask
        xx, yy = np.meshgrid(x_slice.values, y_slice.values)
        dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        in_circle = dist <= buffer_m  # (ny, nx)

        # Stack time series for valid pixels: shape (time, n_valid)
        arr = window.values  # (time, ny, nx)
        mask2d = in_circle[np.newaxis, :, :]
        arr_masked = np.where(mask2d, arr, np.nan)  # (time, ny, nx)
        flat = arr_masked.reshape(arr.shape[0], -1)  # (time, n_pixels)

        # Reference subtraction (use buffer median when ref_buffer_m > 0)
        if ref_lon is not None and ref_lat is not None:
            ref_vals = await _get_ref_median(
                dataset_name,
                ref_lon,
                ref_lat,
                ref_buffer_m,
                layer_masks,
            )
            flat = flat - ref_vals[:, np.newaxis]

    else:
        if dataset_name not in state.raster_groups:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = state.raster_groups[dataset_name]
        x_values = rg.x_values

        reader0 = rg._reader.readers[0]
        tr_from = reader0._transformer_from_lonlat
        cx, cy = tr_from.transform(lon, lat)
        tf = reader0.transform
        res_x = abs(tf.a)
        res_y = abs(tf.e)

        # Pixel radius
        pr_x = int(np.ceil(buffer_m / res_x))
        pr_y = int(np.ceil(buffer_m / res_y))
        row_c, col_c = reader0._lonlat_to_rowcol(lon, lat)
        r0, r1 = max(0, row_c - pr_y), min(reader0.shape[0], row_c + pr_y + 1)
        c0, c1 = max(0, col_c - pr_x), min(reader0.shape[1], col_c + pr_x + 1)

        rows, cols = np.meshgrid(np.arange(r0, r1), np.arange(c0, c1), indexing="ij")
        xs = tf.c + (cols + 0.5) * tf.a
        ys = tf.f + (rows + 0.5) * tf.e
        dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
        in_circle = (dist <= buffer_m).ravel()

        # Read full stack for window — shape (T, ny, nx) via slicing
        T = len(rg.file_list)
        ny, nx = r1 - r0, c1 - c0
        flat_full = np.full((T, ny * nx), np.nan)
        for t_idx in range(T):
            with rasterio.open(rg.file_list[t_idx]) as src:
                nodata = src.nodata
                patch = src.read(
                    1, window=rasterio.windows.Window(c0, r0, nx, ny)
                ).astype(float)
                if nodata is not None:
                    patch[patch == nodata] = np.nan
                flat_full[t_idx] = patch.ravel()
        flat = flat_full[:, in_circle]

        if ref_lon is not None and ref_lat is not None:
            ref_vals = await _get_point_values(dataset_name, ref_lon, ref_lat)
            flat = flat - ref_vals[:, np.newaxis]

    # Drop columns (pixels) that are all NaN
    valid_cols = ~np.all(np.isnan(flat), axis=0)
    flat = flat[:, valid_cols]
    if flat.shape[1] == 0:
        raise HTTPException(status_code=404, detail="No valid pixels in buffer")

    import warnings as _w  # noqa: PLC0415

    with _w.catch_warnings():
        _w.simplefilter("ignore", RuntimeWarning)
        median_ts = np.nanmedian(flat, axis=1).tolist()

    # Random sample (up to n_samples)
    rng = np.random.default_rng(42)
    n_actual = min(n_samples, flat.shape[1])
    sample_idx = rng.choice(flat.shape[1], size=n_actual, replace=False)
    samples = flat[:, sample_idx].T.tolist()  # list of n_actual time series

    return JSONResponse(
        {
            "labels": x_values,
            "median": [
                {"x": x, "y": float(v)}
                for x, v in zip(x_values, median_ts)
                if not np.isnan(v)
            ],
            "samples": [
                [
                    {"x": x, "y": float(v)}
                    for x, v in zip(x_values, ts)
                    if not np.isnan(v)
                ]
                for ts in samples
            ],
            "n_pixels": int(flat.shape[1]),
        }
    )


@app.post(
    "/profile",
    response_class=JSONResponse,
    responses={200: {"description": "Return values along a line profile"}},
)
async def extract_profile(
    coords: list[list[float]] = Body(..., description="List of [lon, lat] pairs"),
    dataset_name: str = Body(..., description="Dataset name"),
    time_index: int = Body(0, description="Time index"),
    n_samples: int = Body(
        200, description="Number of samples along line (used when sampling_interval=0)"
    ),
    radius: float = Body(0.0, description="Buffer radius in metres (0 = single line)"),
    n_random: int = Body(
        5, description="Number of random sample lines within buffer (legacy)"
    ),
    sampling_interval: float = Body(
        0.0,
        description=(
            "Bin spacing in metres along profile (0 = use n_samples). When > 0, "
            "each bin collects all pixels within ±(sampling_interval/2) of the "
            "bin centre along the profile direction and within ±radius "
            "perpendicular, then returns their median."
        ),
    ),
):
    """Sample raster values along a polyline.

    When ``radius`` > 0 and ``sampling_interval`` > 0, the profile is divided
    into non-overlapping bins of width ``sampling_interval``.  Each bin
    collects a dense grid of pixels within that along-track window and within
    ``radius`` perpendicular to the line; the bin value is the nanmedian of
    those pixels.  The centre-line profile uses the same bins sampled only
    along the line centre.

    When ``sampling_interval`` = 0 the legacy behaviour is used: ``n_samples``
    evenly-spaced points with random perpendicular lines.
    """
    from pyproj import Geod  # noqa: PLC0415

    if len(coords) < 2:
        raise HTTPException(status_code=422, detail="Need at least 2 coordinate pairs")
    time_index = max(0, time_index)
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    geod = Geod(ellps="WGS84")

    # Cumulative geodesic distances along segments
    seg_dists: list[float] = [0.0]
    for i in range(1, len(lons)):
        _, _, d = geod.inv(lons[i - 1], lats[i - 1], lons[i], lats[i])
        seg_dists.append(seg_dists[-1] + float(d))
    total_dist = seg_dists[-1]
    if total_dist == 0:
        raise HTTPException(status_code=422, detail="Zero-length line")

    def _read_lonlat(slon: float, slat: float) -> float | None:
        """Read a single value at (slon, slat); return None on failure."""
        try:
            if state.mode == "md":
                if dataset_name not in state.dataset.data_vars:
                    return None
                da = state.dataset[dataset_name]
                dim = _non_spatial_dim(da)
                if dim is not None and time_index < da.sizes[dim]:
                    da = da.isel({dim: time_index})
                x_c, y_c = state.transformer_from_lonlat.transform(slon, slat)
                val = float(da.sel(x=x_c, y=y_c, method="nearest").values)
            else:
                if dataset_name not in state.raster_groups:
                    return None
                rg = state.raster_groups[dataset_name]
                t = min(time_index, len(rg.file_list) - 1)
                val = float(
                    np.atleast_1d(rg._reader.readers[t].read_lonlat(slon, slat))[0]
                )
            return val if np.isfinite(val) else None
        except Exception:
            return None

    def _pos_at_dist(sd: float) -> tuple[float, float, float]:
        """Return (lon, lat, bearing_deg) at distance sd along the polyline."""
        seg_idx = int(
            np.clip(np.searchsorted(seg_dists, sd, side="right") - 1, 0, len(lons) - 2)
        )
        frac = (sd - seg_dists[seg_idx]) / max(
            seg_dists[seg_idx + 1] - seg_dists[seg_idx], 1e-9
        )
        slon = lons[seg_idx] + frac * (lons[seg_idx + 1] - lons[seg_idx])
        slat = lats[seg_idx] + frac * (lats[seg_idx + 1] - lats[seg_idx])
        az, _, _ = geod.inv(
            lons[seg_idx], lats[seg_idx], lons[seg_idx + 1], lats[seg_idx + 1]
        )
        return float(slon), float(slat), float(az)

    # ── Binned-median sampling (new mode) ─────────────────────────────────────
    if sampling_interval > 0:
        half = sampling_interval / 2.0
        bin_centres = np.arange(half, total_dist, sampling_interval)
        if len(bin_centres) == 0:
            bin_centres = np.array([total_dist / 2.0])

        # Along-track step: cap at sampling_interval so we never oversample.
        # 5 steps per bin is enough for a smooth median; minimum 1 m.
        along_step = max(min(sampling_interval / 5.0, sampling_interval), 1.0)

        # Perpendicular: 5 steps across the full width (radius > 0 only).
        # Minimum 1 m; 0 offset (centre line) is always included.
        if radius > 0:
            perp_step = max(radius / 5.0, 1.0)
            perp_offsets_dense = np.arange(-radius, radius + perp_step * 0.5, perp_step)
            # Remove duplicate 0 if it lands on a grid point exactly
            perp_offsets_dense = perp_offsets_dense[np.abs(perp_offsets_dense) > 1e-3]
        else:
            perp_offsets_dense = np.empty(0)

        # Display sample lines (for chart decoration), evenly spaced, max n_random
        n_display = max(1, min(n_random, 5)) if radius > 0 else 0
        perp_offsets_display = (
            np.linspace(-radius, radius, n_display) if n_display > 0 else np.empty(0)
        )

        centre_profile: list[dict] = []
        median_profile: list[dict] = []
        sample_profiles_acc: list[list[dict]] = [[] for _ in range(n_display)]

        for bc in bin_centres:
            along_dists = np.arange(bc - half, bc + half + along_step * 0.5, along_step)
            along_dists = along_dists[(along_dists >= 0) & (along_dists <= total_dist)]

            # Compute centre positions once per along-track step
            positions = [_pos_at_dist(ad) for ad in along_dists]  # (lon, lat, bearing)

            # --- Centre values (no perpendicular offset) ---
            centre_vals = [
                v
                for clon, clat, _ in positions
                if (v := _read_lonlat(clon, clat)) is not None
            ]

            # --- Full 2-D window (centre + perpendicular strip) ---
            all_vals = list(centre_vals)
            if radius > 0:
                for clon, clat, bearing in positions:
                    perp_az = bearing + 90.0
                    for off in perp_offsets_dense:
                        o_lon, o_lat, _ = geod.fwd(clon, clat, perp_az, off)
                        v = _read_lonlat(o_lon, o_lat)
                        if v is not None:
                            all_vals.append(v)

            if centre_vals:
                centre_profile.append(
                    {"dist": float(bc), "value": float(np.nanmedian(centre_vals))}
                )
            if all_vals:
                median_profile.append(
                    {"dist": float(bc), "value": float(np.nanmedian(all_vals))}
                )

            # --- Display sample lines (reuse cached positions) ---
            for k, off in enumerate(perp_offsets_display):
                svals: list[float] = []
                for clon, clat, bearing in positions:
                    if abs(off) < 1e-3:
                        v = _read_lonlat(clon, clat)
                    else:
                        o_lon, o_lat, _ = geod.fwd(clon, clat, bearing + 90.0, off)
                        v = _read_lonlat(o_lon, o_lat)
                    if v is not None:
                        svals.append(v)
                if svals:
                    sample_profiles_acc[k].append(
                        {"dist": float(bc), "value": float(np.nanmedian(svals))}
                    )

        return JSONResponse(
            {
                "centre": centre_profile,
                "median": median_profile,
                "samples": sample_profiles_acc,
                "binned": True,
                "bin_width": float(sampling_interval),
            }
        )

    # ── Legacy mode: evenly-spaced points ─────────────────────────────────────
    sample_dists = np.linspace(0, total_dist, n_samples)

    # Compute sample point positions
    sample_positions: list[tuple[float, float, float, float]] = []
    for sd in sample_dists:
        slon, slat, az = _pos_at_dist(sd)
        sample_positions.append((float(sd), slon, slat, az))

    if radius <= 0:
        results: list[dict] = []
        for sd, slon, slat, _ in sample_positions:
            v = _read_lonlat(slon, slat)
            if v is not None:
                results.append({"dist": sd, "value": v})
        return JSONResponse(results)

    # Legacy buffer: random perpendicular sample lines
    rng = np.random.default_rng(42)
    offsets = rng.uniform(-radius, radius, size=n_random)

    all_lines: list[list[float | None]] = [[] for _ in range(1 + n_random)]
    for i, (sd, slon, slat, bearing) in enumerate(sample_positions):
        all_lines[0].append(_read_lonlat(slon, slat))
        perp_az = bearing + 90.0
        for j, off in enumerate(offsets):
            if off == 0:
                o_lon, o_lat = slon, slat
            else:
                o_lon, o_lat, _ = geod.fwd(slon, slat, perp_az, off)
            all_lines[j + 1].append(_read_lonlat(o_lon, o_lat))

    arr = np.array(
        [[v if v is not None else np.nan for v in line] for line in all_lines]
    )
    median_vals = np.nanmedian(arr, axis=0)

    centre_profile = [
        {"dist": float(sample_positions[i][0]), "value": float(v)}
        for i, v in enumerate(arr[0])
        if np.isfinite(v)
    ]
    median_profile = [
        {"dist": float(sample_positions[i][0]), "value": float(v)}
        for i, v in enumerate(median_vals)
        if np.isfinite(v)
    ]
    sample_profiles = [
        [
            {"dist": float(sample_positions[i][0]), "value": float(arr[j + 1, i])}
            for i in range(len(sample_positions))
            if np.isfinite(arr[j + 1, i])
        ]
        for j in range(n_random)
    ]

    return JSONResponse(
        {
            "centre": centre_profile,
            "median": median_profile,
            "samples": sample_profiles,
        }
    )


# Upload directory for custom masks
_UPLOAD_DIR = Path(os.environ.get("BOWSER_UPLOAD_DIR", "/tmp/bowser_masks"))
_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.post(
    "/upload_mask",
    response_class=JSONResponse,
    responses={
        200: {"description": "Upload a GeoTIFF mask file and return its server path"}
    },
)
async def upload_mask(file: UploadFile):
    """Accept a GeoTIFF mask upload and store it for use in masking."""
    import uuid  # noqa: PLC0415

    dest = _UPLOAD_DIR / f"mask_{uuid.uuid4().hex}.tif"
    dest.write_bytes(await file.read())
    return JSONResponse({"path": str(dest)})


# Set up CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    CompressionMiddleware,
    minimum_size=0,
    exclude_mediatype={
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/jp2",
        "image/webp",
    },
    compression_level=6,
)

# Set up algorithms
algorithms = default_algorithms.register(
    {"phase": Phase, "amplitude": Amplitude, "shift": Shift, "rewrap": Rewrap}
)
PostProcessParams: Callable = algorithms.dependency


# Ordered lists of RasterGroup names to search for each mask type in COG mode.
_COG_COHERENCE_NAMES = [
    "Temporal coherence",
    "Average temporal coherence",
    "(Pseudo) correlation",
]
_COG_SIMILARITY_NAMES = ["Phase cosine similarity", "Phase cosine similarity (full)"]


def _cog_mask_file(group_names: list[str], time_idx: int) -> str | None:
    """Return the file path for the first matching RasterGroup at time_idx."""
    for name in group_names:
        if name in state.raster_groups:
            fl = state.raster_groups[name].file_list
            if fl:
                return fl[min(time_idx, len(fl) - 1)]
    return None


def InputDependency(
    url: Annotated[str, Query(description="Dataset URL")],
    mask: Annotated[str | None, Query(description="Mask URL")] = None,
    mask_min_value: Annotated[float, Query(description="Mask Minimum Value")] = 0.1,
    custom_mask: Annotated[
        str | None, Query(description="Custom mask GeoTIFF path")
    ] = None,
    layer_masks: Annotated[
        str | None,
        Query(description="JSON list of {dataset,threshold,mode} mask dicts"),
    ] = None,
    time_idx: Annotated[
        int, Query(description="Time index for resolving mask files")
    ] = 0,
) -> dict:
    """Create dataset path from args."""
    extra_masks: list[tuple[str, float]] = []
    if custom_mask and Path(custom_mask).exists():
        extra_masks.append((custom_mask, 0.5))

    if layer_masks:
        try:
            masks = json.loads(layer_masks)
            for m in masks:
                dataset = m.get("dataset")
                threshold = float(m.get("threshold", 0.5))
                mode = m.get("mode", "min")
                if not dataset or dataset not in state.raster_groups:
                    continue
                fl = state.raster_groups[dataset].file_list
                if not fl:
                    continue
                f = fl[min(time_idx, len(fl) - 1)]
                # Threshold is now an absolute value — pass it directly.
                # CustomReader extra_masks keeps pixels where value > min_value
                # ('min' mode only).
                if mode == "min":
                    extra_masks.append((f, threshold))
                # 'max' mode not supported for COG tiles (CustomReader has no inversion)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse layer_masks JSON: {e}")

    return {
        "data": url,
        "mask": mask,
        "mask_min_value": mask_min_value,
        "extra_masks": extra_masks,
    }


cog_endpoints = TilerFactory(
    router_prefix="/cog",
    reader=CustomReader,
    path_dependency=InputDependency,
    process_dependency=PostProcessParams,
)
app.include_router(
    cog_endpoints.router, prefix="/cog", tags=["Cloud Optimized GeoTIFF"]
)
logger.info("Configured COG endpoints at /cog/*")


# MD mode: use xarray approach
def XarrayPathDependency(
    request: Request,
    variable: str = Query(..., description="Variable name"),
    dataset: Optional[str] = Query(
        None,
        description=(
            "Catalog dataset id (multi-dataset mode). Omit to use the single "
            "store loaded via --stack-file."
        ),
    ),
    time_idx: Optional[int] = Query(None, description="Time index"),
    mask_variable: Optional[str] = Query(None, description="Mask variable"),
    mask_min_value: float = Query(0.1, description="Mask minimum value"),
    layer_masks: Optional[str] = Query(
        None, description="JSON list of {dataset,threshold,mode} mask dicts"
    ),
    custom_mask_path: Optional[str] = Query(
        None, description="Path to uploaded custom mask GeoTIFF"
    ),
) -> xr.DataArray:
    """Create a DataArray from query parameters.

    Picks the appropriate multiscale pyramid level for tile-bearing routes;
    non-tile routes fall back to the native-resolution level. Routes through
    the catalog registry when ``dataset`` is given — different ``dataset``
    values at the same time serve from independent BowserStates, so two
    clients on two datasets never collide.
    """
    target = _resolve_state(dataset)
    # Path param is only present on tile-bearing routes like
    # /md/tiles/{tms}/{z}/{x}/{y}. Missing elsewhere — fall back to full res.
    try:
        tile_z = int(request.path_params["z"])
    except (KeyError, TypeError, ValueError):
        ds = target.dataset
    else:
        ds = target.dataset_for_tile_zoom(tile_z)
    da = ds[variable]
    skip_recommended_mask = not settings.BOWSER_USE_RECOMMENDED_MASK
    if mask_variable is not None:
        mask_da = ds[mask_variable]
    elif variable == "displacement" and (
        "recommended_mask" in ds.data_vars and not skip_recommended_mask
    ):
        mask_da = ds["recommended_mask"]
    else:
        mask_da = None

    # Resolve the per-variable non-spatial dim (was hardcoded "time")
    if time_idx is not None:
        dim = _non_spatial_dim(da)
        if dim is not None:
            da = da.isel({dim: time_idx})
        if mask_da is not None:
            mdim = _non_spatial_dim(mask_da)
            if mdim is not None:
                mask_da = mask_da.isel({mdim: time_idx})

    # Apply primary mask
    if mask_da is not None:
        da = da.where(mask_da > mask_min_value)

    # Apply layer masks. ``source_ds=ds`` is essential here — ``ds`` is the
    # pyramid-level Dataset selected for ``tile_z``; if we let the helper
    # default to state.dataset (level 0) the mask grid won't match ``da``'s
    # grid at low zoom and rioxarray bounds resolution fails downstream.
    if layer_masks:
        try:
            da = _apply_layer_masks_md(
                da, json.loads(layer_masks), time_idx, source_ds=ds
            )
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse layer_masks JSON: {e}")

    # Custom mask (uploaded GeoTIFF) — reproject to match da
    if custom_mask_path and Path(custom_mask_path).exists():
        try:
            import rioxarray as rxr  # noqa: PLC0415

            custom_da = rxr.open_rasterio(custom_mask_path, masked=True).squeeze(
                "band", drop=True
            )
            custom_da_repr = custom_da.rio.reproject_match(da)
            da = da.where(custom_da_repr > 0)
        except Exception as exc:
            logger.warning(f"Failed to apply custom mask {custom_mask_path}: {exc}")

    return da


md_endpoints = TilerFactory(
    router_prefix="/md",
    reader=XarrayReader,
    path_dependency=XarrayPathDependency,
    reader_dependency=DefaultDependency,
    process_dependency=PostProcessParams,
)
app.include_router(md_endpoints.router, prefix="/md", tags=["Xarray Multi Dimensional"])
logger.info("Configured MD endpoints at /md/*")

# Add exception handlers
add_exception_handlers(app, DEFAULT_STATUS_CODES)

# Mount the dataset picker first so /picker.html resolves before the catch-all
# SPA mount at /. The picker is a standalone page — no React build required —
# that reads /catalog and redirects to /?dataset=<id> on click.
static_path = Path(__file__).parent / "static"
if static_path.exists():
    app.mount("/static", StaticFiles(directory=static_path), name="static")

    @app.get("/picker", include_in_schema=False)
    async def picker_redirect():
        """Friendly alias for /static/picker.html."""
        from starlette.responses import RedirectResponse  # noqa: PLC0415

        return RedirectResponse("/static/picker.html")


# In catalog mode, bare `/` has no `?dataset=` to key off of, so the frontend
# fires `/datasets?` against the stub default state and 500s. Redirect to the
# picker instead; once the user picks a dataset, the SPA mount below serves
# index.html for `/?dataset=<id>`.
dist_path = Path(__file__).parent / "dist"


@app.get("/", include_in_schema=False)
async def root(request: Request):
    """Serve the SPA, or redirect to the picker in catalog mode."""
    from starlette.responses import FileResponse, RedirectResponse  # noqa: PLC0415

    if settings.BOWSER_CATALOG_FILE and not request.query_params.get("dataset"):
        return RedirectResponse("/picker")
    return FileResponse(dist_path / "index.html")


# Serve the SPA as a catch-all under /.
app.mount("/", StaticFiles(directory=dist_path, html=True))
print(f"Setup complete: time to load datasets: {time.time() - t0:.1f} sec.")
logger.info(f"Bowser started in {state.mode.upper()} mode")
