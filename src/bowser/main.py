import json
import logging
import os
import time
import warnings
from pathlib import Path
from typing import Annotated, Callable, Optional

import fsspec
import numpy as np
import rasterio
import xarray as xr
import zarr
from fastapi import FastAPI, HTTPException, Query, Response
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
from titiler.core.middleware import CacheControlMiddleware

from .config import settings
from .readers import CustomReader
from .titiler import Amplitude, JSONResponse, Phase, RasterGroup, Rewrap, Shift
from .utils import desensitize_mpl_case, generate_colorbar

logger = logging.getLogger("bowser")
warnings.filterwarnings(
    "ignore", category=RuntimeWarning, message="invalid value encountered in cast"
)

t0 = time.time()
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
        if stack_file.startswith("s3://"):
            # TODO: Do I need to pass `anon=True` ? or will it get handled by fsspec?
            fs = fsspec.filesystem("s3", asynchronous=True)
            store = zarr.storage.FsspecStore(fs, path=stack_file.lstrip("s3://"))
            ds = xr.open_zarr(store, consolidated=False)
        ds = (
            xr.open_zarr(stack_file, consolidated=False)
            if stack_file.endswith(".zarr")
            else xr.open_dataset(stack_file)
        )
        crs = CRS.from_wkt(ds.spatial_ref.crs_wkt)
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
                "displacement" in str(var_name).lower()
                and "short_wave" not in str(var_name).lower()
                and not skip_spatial_reference
            )
            dataset_info[var_name] = {
                "name": var_name,
                "file_list": [
                    f"variable:{var_name}:time:{i}" for i in range(len(ds.time))
                ],
                "mask_file_list": [],
                "mask_min_value": 0.1,
                "nodata": None,
                "uses_spatial_ref": use_moving_reference,
                "algorithm": "shift" if use_moving_reference else None,
                "bounds": list(bounds),
                "latlon_bounds": list(latlon_bounds),
                "x_values": time_values,
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


async def _get_point_values(dataset_name: str, lon: float, lat: float) -> np.ndarray:
    """Get point values for a dataset at lon/lat."""
    if DATA_MODE == "md":
        if dataset_name not in XARRAY_DATASET.data_vars:
            raise HTTPException(
                status_code=404, detail=f"Variable {dataset_name} not found"
            )
        x, y = transformer_from_lonlat.transform(lon, lat)
        point_data = XARRAY_DATASET[dataset_name].sel(x=x, y=y, method="nearest")
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


@app.get("/colorbar/{cmap_name}")
async def get_colorbar(cmap_name: str):
    """Get a WEBP image of a matplotlib colorbar."""
    try:
        colorbar_bytes = generate_colorbar(cmap_name)
        return Response(content=colorbar_bytes, media_type="image/webp")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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

app.add_middleware(
    CacheControlMiddleware,
    cachecontrol="public, max-age=3600",
    exclude_path={r"/healthz"},
)

# Set up algorithms
algorithms = default_algorithms.register(
    {"phase": Phase, "amplitude": Amplitude, "shift": Shift, "rewrap": Rewrap}
)
PostProcessParams: Callable = algorithms.dependency


# Set up routing based on data mode
# if DATA_MODE == "cog":
# COG mode: use RasterGroup approach
def InputDependency(
    url: Annotated[str, Query(description="Dataset URL")],
    mask: Annotated[str | None, Query(description="Mask URL")] = None,
    mask_min_value: Annotated[float, Query(description="Mask Minimum Value")] = 0.1,
) -> dict:
    """Create dataset path from args."""
    return {
        "data": url,
        "mask": mask,
        "mask_min_value": mask_min_value,
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

    if time_idx is None or "time" not in da.dims:
        if mask_da is not None:
            da = da.where(mask_da > mask_min_value)
        return da
    da = da.sel(time=XARRAY_DATASET.time[time_idx])
    if mask_da is not None:
        mask_da = mask_da.sel(time=XARRAY_DATASET.time[time_idx])
        return da.where(mask_da > mask_min_value)
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
