import json
import logging
import os
import time
import warnings
from pathlib import Path
from typing import Annotated, Any, Callable, Optional

# Register custom colormaps in rio_tiler BEFORE titiler.core.dependencies is
# imported.  titiler captures cmap.list() into a Literal type annotation at
# import time, so reversed variants (cfastie_r, etc.) must be in the registry
# before that happens.
from .utils import calculate_trend, desensitize_mpl_case, generate_colorbar, register_custom_colormaps
register_custom_colormaps()

import matplotlib
import numpy as np
import rasterio
import xarray as xr
from fastapi import Body, FastAPI, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pyproj import CRS, Transformer
from rio_tiler.io.xarray import XarrayReader
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates
from starlette_cramjam.middleware import CompressionMiddleware
from titiler.core.algorithm import algorithms as default_algorithms
from titiler.core.dependencies import DefaultDependency
from titiler.core.errors import DEFAULT_STATUS_CODES, add_exception_handlers
from titiler.core.factory import TilerFactory

from .config import settings
from .readers import CustomReader
from .titiler import Amplitude, JSONResponse, Phase, RasterGroup, Rewrap, Shift

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


def load_data_sources():
    """Load data sources and determine which mode to use (MD or COG)."""
    # Check for xarray stack file first (MD mode)
    if settings.BOWSER_STACK_DATA_FILE:
        stack_file = os.environ["BOWSER_STACK_DATA_FILE"]
        logger.info(f"Loading xarray dataset from {stack_file} (MD mode)")
        ds = (
            xr.open_zarr(stack_file)
            if stack_file.endswith(".zarr")
            else xr.open_dataset(stack_file)
        )
        crs = CRS.from_wkt(ds.spatial_ref.crs_wkt)
        # Collapse spatial_ref to scalar if it has a time dimension so that
        # 2D variables (no time dim) still inherit the CRS coordinate.
        if "time" in ds.spatial_ref.dims:
            ds = ds.assign_coords(spatial_ref=ds.spatial_ref.isel(time=0).drop_vars("time"))
        ds.rio.write_crs(crs, inplace=True)
        transformer = Transformer.from_crs(4326, ds.rio.crs, always_xy=True)
        return "md", ds, None, transformer

    # Check for RasterGroup JSON config (COG mode)
    elif Path(settings.BOWSER_DATASET_CONFIG_FILE).exists():
        logger.info(
            f"Loading RasterGroups from {settings.BOWSER_DATASET_CONFIG_FILE} (COG)"
        )
        data_js_list = json.loads(Path(settings.BOWSER_DATASET_CONFIG_FILE).read_text())
        raster_groups = {}
        for d in data_js_list:
            rg = RasterGroup.model_validate(d)
            raster_groups[rg.name] = rg
        logger.info(
            (
                f"Found {len(raster_groups)} RasterGroup configs:"
                " {list(raster_groups.keys())}"
            )
        )
        return "cog", None, raster_groups, None

    else:
        raise ValueError(
            "No data files specified - need either stack file or JSON config"
        )


# Global data sources - load once at startup
DATA_MODE, XARRAY_DATASET, RASTER_GROUPS, transformer_from_lonlat = load_data_sources()
print(f"Data loading complete in {time.time() - t0:.1f} sec. Mode: {DATA_MODE}")


def create_xarray_dataset_info(ds: xr.Dataset) -> dict:
    """Create dataset info structure from Xarray Dataset."""
    # Get bounds from the dataset
    bounds = ds.rio.bounds()
    if ds.rio.crs != rasterio.crs.CRS.from_epsg(4326):
        mdim_vars = [v for v in ds.data_vars.values() if v.ndim >= 2]
        # Get just one layer to reproject, and subsample for quick reprojecting
        da = mdim_vars[0][..., ::10, ::10]
        if da.ndim == 3:
            da = da[0]
        latlon_bounds = da.rio.reproject("epsg:4326", subsample=10).rio.bounds()
    else:
        latlon_bounds = bounds
    logger.info(
        f"latlon_bounds: {latlon_bounds}, bounds: {bounds}, ds.rio.crs: {ds.rio.crs}"
    )

    # Get time values formatted for frontend
    time_values = ds.time.dt.strftime("%Y-%m-%d").values.tolist()

    # Create info for each variable that has spatial dimensions
    dataset_info = {}

    skip_spatial_reference = os.getenv("BOWSER_SPATIAL_REFERENCE_DISP") == "NO"
    for var_name, var in ds.data_vars.items():
        if "x" in var.dims and "y" in var.dims:
            use_moving_reference = (
                ("displacement" in str(var_name).lower() and "short_wave" not in str(var_name).lower())
                or "velocity" in str(var_name).lower()
            ) and not skip_spatial_reference
            available_mask_vars = [
                v for v in ["temporal_coherence", "phase_similarity", "recommended_mask"]
                if v in ds.data_vars
            ]
            has_time = "time" in var.dims
            attrs = dict(var.attrs)
            dataset_info[var_name] = {
                "name": var_name,
                "file_list": (
                    [f"variable:{var_name}:time:{i}" for i in range(len(ds.time))]
                    if has_time
                    else [f"variable:{var_name}"]
                ),
                "mask_file_list": [],
                "mask_min_value": 0.1,
                "nodata": None,
                "uses_spatial_ref": use_moving_reference,
                "algorithm": "shift" if use_moving_reference else None,
                "bounds": list(bounds),
                "latlon_bounds": list(latlon_bounds),
                "x_values": time_values if has_time else [],
                "available_mask_vars": available_mask_vars,
                "label": attrs.get("long_name", var_name),
                "unit": attrs.get("units", ""),
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
        }
    return dataset_info


@app.get("/datasets")
async def datasets():
    """Return the JSON describing all available datasets."""
    if DATA_MODE == "md":
        return create_xarray_dataset_info(XARRAY_DATASET)
    else:  # cog mode
        return create_rastergroup_dataset_info(RASTER_GROUPS)


@app.get("/mode")
async def get_mode():
    """Return the current data mode (md or cog) for frontend routing."""
    return {"mode": DATA_MODE}


@app.get("/config")
async def get_config():
    """Return app configuration for the frontend."""
    return {"title": settings.BOWSER_TITLE}


@app.get("/variables")
async def get_variables():
    """Get available variables (only for MD mode)."""
    if DATA_MODE != "md":
        return {"variables": {}}

    variables = {}
    for var_name, var in XARRAY_DATASET.data_vars.items():
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
        arr = XARRAY_DATASET[var].values
        _MD_VAR_RANGE_CACHE[var] = (float(np.nanmin(arr)), float(np.nanmax(arr)))
    return _MD_VAR_RANGE_CACHE[var]


def _apply_layer_masks_md(
    da: "xr.DataArray",
    layer_masks: list[dict],
    time_idx: int | None = None,
) -> "xr.DataArray":
    """Apply a list of layer mask dicts to a DataArray (MD mode).

    Each dict has keys: dataset (str), threshold (float), mode ('min'|'max').
    threshold is an absolute value in the mask layer's data units.
    'min' keeps pixels >= threshold; 'max' keeps pixels <= threshold.
    """
    for m in layer_masks:
        var = m.get("dataset")
        threshold = float(m.get("threshold", 0.5))
        mode = m.get("mode", "min")
        if not var or var not in XARRAY_DATASET.data_vars:
            continue
        mask_da = XARRAY_DATASET[var]
        if time_idx is not None and "time" in mask_da.dims:
            mask_da = mask_da.isel(time=time_idx)
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
    """Return reference time series: buffer median when buffer_m > 0 (MD mode), else single pixel."""
    layer_masks = layer_masks or []
    if buffer_m <= 0 or DATA_MODE != "md":
        return await _get_point_values(dataset_name, lon, lat, layer_masks)

    if dataset_name not in XARRAY_DATASET.data_vars:
        raise HTTPException(status_code=404, detail=f"Variable {dataset_name} not found")

    from pyproj import Transformer as _T  # noqa: PLC0415

    da = XARRAY_DATASET[dataset_name]
    da = _apply_layer_masks_md(da, layer_masks)

    tr = _T.from_crs(4326, XARRAY_DATASET.rio.crs, always_xy=True)
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
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = XARRAY_DATASET[dataset_name]
        da = _apply_layer_masks_md(da, layer_masks or [])
        x, y = transformer_from_lonlat.transform(lon, lat)
        point_data = da.sel(x=x, y=y, method="nearest")
        return np.atleast_1d(point_data.values)
    else:  # cog mode
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        return np.atleast_1d(RASTER_GROUPS[dataset_name]._reader.read_lonlat(lon, lat))


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
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = XARRAY_DATASET[dataset_name]
        x_values = da.time.dt.strftime("%Y-%m-%d").values.tolist()
    else:  # cog mode
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = RASTER_GROUPS[dataset_name]
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
    layer_masks: list[dict] = Body([], description="List of {dataset, threshold, mode} mask dicts"),
    ref_buffer_m: float = Body(0.0, description="Buffer radius (m) for median re-referencing; 0 = single pixel"),
):
    """Fetch time series data for multiple points efficiently."""
    # Get time values based on data mode
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = XARRAY_DATASET[dataset_name]
        x_values = da.time.dt.strftime("%Y-%m-%d").values.tolist()
    else:  # cog mode
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = RASTER_GROUPS[dataset_name]
        x_values = rg.x_values

    # Get reference values if provided (use buffer median when ref_buffer_m > 0)
    ref_values = None
    if ref_lon is not None and ref_lat is not None:
        ref_values = await _get_ref_median(
            dataset_name, ref_lon, ref_lat, ref_buffer_m, layer_masks,
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
                dataset_name, float(lon), float(lat), layer_masks
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
                trend_result = calculate_trend(values, x_values)
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
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = XARRAY_DATASET[dataset_name]
        x_values = da.time.dt.strftime("%Y-%m-%d").values.tolist()
    else:  # cog mode
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = RASTER_GROUPS[dataset_name]
        x_values = rg.x_values

    # Get values at the point
    values = await _get_point_values(dataset_name, lon, lat)

    # Apply reference subtraction if provided
    if ref_lon is not None and ref_lat is not None:
        ref_values = await _get_point_values(dataset_name, ref_lon, ref_lat)
        values = values - ref_values

    # Calculate trend
    trend_data = calculate_trend(values, x_values)

    return JSONResponse(trend_data)


@app.get("/datasets/{dataset_name}/time_bounds")
async def get_time_bounds(dataset_name: str):
    """Get time bounds for a dataset to help with trend calculations."""
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        da = XARRAY_DATASET[dataset_name]
        time_values = da.time.values
        start_time = str(time_values[0])
        end_time = str(time_values[-1])
    else:  # cog mode
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_name} not found"
            )
        rg = RASTER_GROUPS[dataset_name]
        x_values = rg.x_values
        start_time = str(x_values[0])
        end_time = str(x_values[-1])

    return JSONResponse(
        {
            "start_time": start_time,
            "end_time": end_time,
            "num_time_steps": len(time_values) if DATA_MODE == "md" else len(x_values),
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
    responses={200: {"description": "Return min/max/p2/p98 for a dataset (first time slice)"}},
)
async def get_dataset_range(dataset_name: str):
    """Return the value range of a dataset for use in mask threshold sliders."""
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(status_code=404, detail=f"Variable {dataset_name} not found")
        da = XARRAY_DATASET[dataset_name]
        arr = da.isel(time=0).values.ravel().astype(float) if "time" in da.dims else da.values.ravel().astype(float)
    else:
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(status_code=404, detail=f"Dataset {dataset_name} not found")
        rg = RASTER_GROUPS[dataset_name]
        with rasterio.open(rg.file_list[0]) as src:
            arr = src.read(1).ravel().astype(float)
            nodata = src.nodata
        if nodata is not None:
            arr = arr[arr != nodata]

    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        raise HTTPException(status_code=204, detail="No valid data")

    return JSONResponse({
        "min": float(valid.min()),
        "max": float(valid.max()),
        "p2": float(np.percentile(valid, 2)),
        "p98": float(np.percentile(valid, 98)),
    })


@app.get(
    "/histogram/{dataset_name}",
    response_class=JSONResponse,
    responses={200: {"description": "Return histogram data for one time slice"}},
)
async def get_histogram(
    dataset_name: str,
    time_index: Annotated[int, Query(ge=0)] = 0,
    nbins: Annotated[int, Query(ge=4, le=256)] = 100,
):
    """Compute a histogram of valid pixel values for one time step of a dataset."""
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(status_code=404, detail=f"Variable {dataset_name} not found")
        da = XARRAY_DATASET[dataset_name]
        if "time" in da.dims:
            time_index = min(time_index, da.sizes["time"] - 1)
            arr = da.isel(time=time_index).values.ravel().astype(float)
        else:
            arr = da.values.ravel().astype(float)
    else:
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(status_code=404, detail=f"Dataset {dataset_name} not found")
        rg = RASTER_GROUPS[dataset_name]
        time_index = min(time_index, len(rg.file_list) - 1)
        with rasterio.open(rg.file_list[time_index]) as src:
            arr = src.read(1).ravel().astype(float)
            nodata = src.nodata
        if nodata is not None:
            arr = arr[arr != nodata]

    valid = arr[np.isfinite(arr) & (arr != 0)]
    if valid.size == 0:
        raise HTTPException(status_code=204, detail="No valid data")

    counts, bin_edges = np.histogram(valid, bins=nbins)
    return JSONResponse({
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
    })


@app.post(
    "/buffer_timeseries",
    response_class=JSONResponse,
    responses={200: {"description": "Return median + sampled pixel time series within a buffer"}},
)
async def buffer_timeseries(
    lon: float = Body(..., description="Center longitude"),
    lat: float = Body(..., description="Center latitude"),
    dataset_name: str = Body(..., description="Dataset name"),
    buffer_m: float = Body(500.0, description="Buffer radius in metres"),
    n_samples: int = Body(10, description="Number of random pixel samples to return"),
    ref_lon: Optional[float] = Body(None),
    ref_lat: Optional[float] = Body(None),
    layer_masks: list[dict] = Body([], description="List of {dataset, threshold, mode} mask dicts"),
    ref_buffer_m: float = Body(0.0, description="Buffer radius (m) for median re-referencing; 0 = single pixel"),
):
    """Collect all pixels within a circular buffer, return median + random samples."""
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(status_code=404, detail=f"Variable {dataset_name} not found")
        da = XARRAY_DATASET[dataset_name]
        da = _apply_layer_masks_md(da, layer_masks)
        x_values: list = da.time.dt.strftime("%Y-%m-%d").values.tolist()

        # Project centre to dataset CRS
        from pyproj import Transformer as _T  # noqa: PLC0415
        tr = _T.from_crs(4326, XARRAY_DATASET.rio.crs, always_xy=True)
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
                dataset_name, ref_lon, ref_lat, ref_buffer_m, layer_masks,
            )
            flat = flat - ref_vals[:, np.newaxis]

    else:
        if dataset_name not in RASTER_GROUPS:
            raise HTTPException(status_code=404, detail=f"Dataset {dataset_name} not found")
        rg = RASTER_GROUPS[dataset_name]
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

        rows, cols = np.meshgrid(np.arange(r0, r1), np.arange(c0, c1), indexing='ij')
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
                patch = src.read(1, window=rasterio.windows.Window(c0, r0, nx, ny)).astype(float)
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

    median_ts = np.nanmedian(flat, axis=1).tolist()

    # Random sample (up to n_samples)
    rng = np.random.default_rng(42)
    n_actual = min(n_samples, flat.shape[1])
    sample_idx = rng.choice(flat.shape[1], size=n_actual, replace=False)
    samples = flat[:, sample_idx].T.tolist()  # list of n_actual time series

    return JSONResponse({
        "labels": x_values,
        "median": [{"x": x, "y": float(v)} for x, v in zip(x_values, median_ts) if not np.isnan(v)],
        "samples": [
            [{"x": x, "y": float(v)} for x, v in zip(x_values, ts) if not np.isnan(v)]
            for ts in samples
        ],
        "n_pixels": int(flat.shape[1]),
    })


@app.post(
    "/profile",
    response_class=JSONResponse,
    responses={200: {"description": "Return values along a line profile"}},
)
async def extract_profile(
    coords: list[list[float]] = Body(..., description="List of [lon, lat] pairs"),
    dataset_name: str = Body(..., description="Dataset name"),
    time_index: int = Body(0, description="Time index"),
    n_samples: int = Body(200, description="Number of samples along line"),
    radius: float = Body(0.0, description="Buffer radius in metres (0 = single line)"),
    n_random: int = Body(5, description="Number of random sample lines within buffer"),
):
    """Sample raster values along a polyline.

    When ``radius`` > 0, returns median and random sample profiles within the
    buffer; otherwise returns the single centre-line profile.
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

    sample_dists = np.linspace(0, total_dist, n_samples)

    def _read_lonlat(slon: float, slat: float) -> float | None:
        """Read a single value at (slon, slat); return None on failure."""
        try:
            if DATA_MODE == "md":
                if dataset_name not in XARRAY_DATASET.data_vars:
                    return None
                da = XARRAY_DATASET[dataset_name]
                if "time" in da.dims and time_index < da.shape[0]:
                    da = da.isel(time=time_index)
                x_c, y_c = transformer_from_lonlat.transform(slon, slat)
                val = float(da.sel(x=x_c, y=y_c, method="nearest").values)
            else:
                if dataset_name not in RASTER_GROUPS:
                    return None
                rg = RASTER_GROUPS[dataset_name]
                t = min(time_index, len(rg.file_list) - 1)
                val = float(np.atleast_1d(rg._reader.readers[t].read_lonlat(slon, slat))[0])
            return val if np.isfinite(val) else None
        except Exception:
            return None

    # ── Compute sample point positions along the line ──────────────────────────
    # For each distance d along line, compute (slon, slat) and the perpendicular
    # unit vector in lon/lat degrees (approximated from the local bearing).
    sample_positions: list[tuple[float, float, float, float]] = []  # (dist, slon, slat, bearing_deg)
    for sd in sample_dists:
        seg_idx = int(np.clip(np.searchsorted(seg_dists, sd, side="right") - 1, 0, len(lons) - 2))
        frac = (sd - seg_dists[seg_idx]) / max(seg_dists[seg_idx + 1] - seg_dists[seg_idx], 1e-9)
        slon = lons[seg_idx] + frac * (lons[seg_idx + 1] - lons[seg_idx])
        slat = lats[seg_idx] + frac * (lats[seg_idx + 1] - lats[seg_idx])
        # Forward bearing of this segment (degrees)
        az, _, _ = geod.inv(lons[seg_idx], lats[seg_idx], lons[seg_idx + 1], lats[seg_idx + 1])
        sample_positions.append((float(sd), slon, slat, float(az)))

    if radius <= 0:
        # ── Simple centre-line profile ─────────────────────────────────────────
        results: list[dict] = []
        for sd, slon, slat, _ in sample_positions:
            v = _read_lonlat(slon, slat)
            if v is not None:
                results.append({"dist": sd, "value": v})
        return JSONResponse(results)

    # ── Buffer profile: median + random samples ────────────────────────────────
    rng = np.random.default_rng(42)
    # Random perpendicular offsets for sample lines: shape (n_random,)
    offsets = rng.uniform(-radius, radius, size=n_random)

    # centre + random lines → shape (1+n_random, n_samples)
    all_lines: list[list[float | None]] = [[] for _ in range(1 + n_random)]

    for i, (sd, slon, slat, bearing) in enumerate(sample_positions):
        # Centre line
        all_lines[0].append(_read_lonlat(slon, slat))
        # Perpendicular direction = bearing + 90°
        perp_az = bearing + 90.0
        for j, off in enumerate(offsets):
            if off == 0:
                o_lon, o_lat = slon, slat
            else:
                o_lon, o_lat, _ = geod.fwd(slon, slat, perp_az, off)
            all_lines[j + 1].append(_read_lonlat(o_lon, o_lat))

    # Build finite-only arrays for median computation
    arr = np.array([[v if v is not None else np.nan for v in line] for line in all_lines])
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

    return JSONResponse({
        "centre": centre_profile,
        "median": median_profile,
        "samples": sample_profiles,
    })


# Upload directory for custom masks
_UPLOAD_DIR = Path(os.environ.get("BOWSER_UPLOAD_DIR", "/tmp/bowser_masks"))
_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.post(
    "/upload_mask",
    response_class=JSONResponse,
    responses={200: {"description": "Upload a GeoTIFF mask file and return its server path"}},
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


# Set up routing based on data mode
# if DATA_MODE == "cog":
# COG mode: use RasterGroup approach
# Ordered lists of RasterGroup names to search for each mask type in COG mode.
_COG_COHERENCE_NAMES  = ["Temporal coherence", "Average temporal coherence", "(Pseudo) correlation"]
_COG_SIMILARITY_NAMES = ["Phase cosine similarity", "Phase cosine similarity (full)"]


def _cog_mask_file(group_names: list[str], time_idx: int) -> str | None:
    """Return the file path for the first matching RasterGroup at time_idx."""
    for name in group_names:
        if name in RASTER_GROUPS:
            fl = RASTER_GROUPS[name].file_list
            if fl:
                return fl[min(time_idx, len(fl) - 1)]
    return None


def InputDependency(
    url: Annotated[str, Query(description="Dataset URL")],
    mask: Annotated[str | None, Query(description="Mask URL")] = None,
    mask_min_value: Annotated[float, Query(description="Mask Minimum Value")] = 0.1,
    custom_mask: Annotated[str | None, Query(description="Custom mask GeoTIFF path")] = None,
    layer_masks: Annotated[str | None, Query(description="JSON list of {dataset,threshold,mode} mask dicts")] = None,
    time_idx: Annotated[int, Query(description="Time index for resolving mask files")] = 0,
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
                if not dataset or dataset not in RASTER_GROUPS:
                    continue
                fl = RASTER_GROUPS[dataset].file_list
                if not fl:
                    continue
                f = fl[min(time_idx, len(fl) - 1)]
                # Threshold is now an absolute value — pass it directly
                # CustomReader extra_masks keeps pixels where value > min_value ('min' mode only)
                if mode == "min":
                    extra_masks.append((f, threshold))
                # 'max' mode not supported for COG tiles (CustomReader has no inversion)
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"Failed to parse layer_masks: {e}")

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
    variable: str = Query(..., description="Variable name"),
    time_idx: Optional[int] = Query(None, description="Time index"),
    mask_variable: Optional[str] = Query(None, description="Mask variable"),
    mask_min_value: float = Query(0.1, description="Mask minimum value"),
    layer_masks: Optional[str] = Query(None, description="JSON list of {dataset,threshold,mode} mask dicts"),
    custom_mask_path: Optional[str] = Query(None, description="Path to uploaded custom mask GeoTIFF"),
) -> xr.DataArray:
    """Create a DataArray from query parameters."""
    da = XARRAY_DATASET[variable]
    skip_recommended_mask = os.getenv("BOWSER_USE_RECOMMENDED_MASK") == "NO"
    if mask_variable is not None:
        mask_da = XARRAY_DATASET[mask_variable]
    elif variable == "displacement" and (
        "recommended_mask" in XARRAY_DATASET.data_vars and not skip_recommended_mask
    ):
        mask_da = XARRAY_DATASET["recommended_mask"]
    else:
        mask_da = None

    # Resolve time
    if time_idx is not None and "time" in da.dims:
        da = da.sel(time=XARRAY_DATASET.time[time_idx])
        if mask_da is not None:
            mask_da = mask_da.sel(time=XARRAY_DATASET.time[time_idx])

    # Apply primary mask
    if mask_da is not None:
        da = da.where(mask_da > mask_min_value)

    # Apply layer masks
    if layer_masks:
        try:
            da = _apply_layer_masks_md(da, json.loads(layer_masks), time_idx)
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"Failed to apply layer_masks: {e}")

    # Custom mask (uploaded GeoTIFF) — reproject to match da
    if custom_mask_path and Path(custom_mask_path).exists():
        try:
            import rioxarray as rxr  # noqa: PLC0415
            custom_da = rxr.open_rasterio(custom_mask_path, masked=True).squeeze("band", drop=True)
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

# Serve static files
dist_path = Path(__file__).parent / "dist"
app.mount("/", StaticFiles(directory=dist_path, html=True))
print(f"Setup complete: time to load datasets: {time.time() - t0:.1f} sec.")
logger.info(f"Bowser started in {DATA_MODE.upper()} mode")
