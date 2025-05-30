import logging
import pathlib
import time
import warnings
from typing import Annotated, Callable, Optional

import numpy as np
import rasterio
import xarray
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from opera_utils import disp
from pyproj import Transformer
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
from .titiler import Amplitude, JSONResponse, Phase, Rewrap, Shift
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

template_dir = pathlib.Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=template_dir)
desensitize_mpl_case()

app = FastAPI(title="Bowser")


def load_dataset():
    """Load and prepare the Xarray dataset."""
    # nc_files = Path("/Users/staniewi/repos/opera-utils/subsets-nyc-f08622").glob(
    #     "OPERA*.nc"
    # )
    # TODO: settings isn't working with a list of files, bad parsing
    import os

    nc_files = os.environ["BOWSER_NC_DATA_FILES"].split(",")
    # nc_files = settings.BOWSER_NC_DATA_FILES
    print(nc_files)
    dps = disp.DispProductStack.from_file_list(nc_files)
    ds = disp.create_rebased_stack(dps, chunks={"time": 1})

    return ds


# Global dataset - load once at startup
DATASET = load_dataset()
print(f"Dataset loading complete in {time.time() - t0:.1f} sec.")

transformer_from_lonlat = Transformer.from_crs(4326, DATASET.rio.crs, always_xy=True)


# Create dataset info structure compatible with frontend
def create_dataset_info(ds: xarray.Dataset) -> dict:
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
    print(f"latlon_bounds: {latlon_bounds}, bounds: {bounds}, ds.rio.crs: {ds.rio.crs}")

    # Get time values formatted for frontend
    time_values = ds.time.dt.strftime("%Y-%m-%d").values.tolist()

    # Create info for each variable that has spatial dimensions
    dataset_info = {}

    for var_name, var in ds.data_vars.items():
        if "x" in var.dims and "y" in var.dims:
            dataset_info[var_name] = {
                "name": var_name,
                "file_list": [
                    f"variable:{var_name}:time:{i}" for i in range(len(ds.time))
                ],
                "mask_file_list": [],
                "mask_min_value": 0.1,
                "nodata": None,
                "uses_spatial_ref": "displacement" in var_name,
                "algorithm": "shift" if "displacement" in var_name else None,
                "bounds": list(bounds),
                "latlon_bounds": list(latlon_bounds),
                "x_values": time_values,
            }

    return dataset_info


@app.get("/datasets")
async def datasets():
    """Return the JSON describing the dataset variables."""
    return create_dataset_info(DATASET)


# Variables endpoint for compatibility
@app.get("/variables")
async def get_variables():
    """Get available variables in the dataset."""
    variables = {}
    for var_name, var in DATASET.data_vars.items():
        if "x" in var.dims and "y" in var.dims:
            variables[var_name] = {
                "dimensions": list(var.dims),
                "shape": list(var.shape),
                "dtype": str(var.dtype),
                "attrs": dict(var.attrs),
            }
    return {"variables": variables}


async def _get_point_values(variable_name: str, lon: float, lat: float) -> np.ndarray:
    """Get point values for a specific variable at lon/lat."""
    if variable_name not in DATASET.data_vars:
        raise HTTPException(
            status_code=404, detail=f"Variable {variable_name} not found"
        )

    x, y = transformer_from_lonlat.transform(lon, lat)

    # Use xarray's selection with nearest neighbor
    point_data = DATASET[variable_name].sel(x=x, y=y, method="nearest")
    return np.atleast_1d(point_data.values)


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
    if dataset_name not in DATASET.data_vars:
        raise HTTPException(
            status_code=404, detail=f"Variable {dataset_name} not found"
        )

    da = DATASET[dataset_name]

    # Format time values for x-axis
    x_values = da.time.dt.strftime("%Y-%m-%d").values.tolist()

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


# Keep your existing COG endpoints for backward compatibility
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
    reader=CustomReader,
    path_dependency=InputDependency,
    process_dependency=PostProcessParams,
)
app.include_router(
    cog_endpoints.router, prefix="/cog", tags=["Cloud Optimized GeoTIFF"]
)


# Xarray path dependency: rather than passing `?url=https://....`
def XarrayPathDependency(
    variable: str = Query(..., description="Variable name"),
    time_idx: Optional[int] = Query(None, description="Time index"),
    # TODO: make this UI-configurable
    mask_variable: Optional[str] = Query(None, description="Mask variable"),
    mask_min_value: float = Query(0.1, description="Mask minimum value"),
) -> xarray.DataArray:
    """Create a DataArray from query parameters."""
    da = DATASET[variable]
    if mask_variable is not None:
        mask_da = DATASET[mask_variable]
    elif variable == "displacement":
        mask_da = DATASET["recommended_mask"]
    else:
        mask_da = None

    if time_idx is None or "time" not in da.dims:
        if mask_da is not None:
            da = da.where(mask_da > mask_min_value)
        return da
    da = da.sel(time=DATASET.time[time_idx])
    if mask_da is not None:
        mask_da = mask_da.sel(time=DATASET.time[time_idx])
        return da.where(mask_da > mask_min_value)
    return da


# Create Xarray tiler using standard TilerFactory
xarray_endpoints = TilerFactory(
    reader=XarrayReader,
    path_dependency=XarrayPathDependency,
    # Set the reader_dependency to `empty`
    reader_dependency=DefaultDependency,
    process_dependency=PostProcessParams,
)
app.include_router(
    xarray_endpoints.router,
    # prefix="/md",
    tags=["Xarray Multi Dimensional"],
)

# Add exception handlers
add_exception_handlers(app, DEFAULT_STATUS_CODES)

# Serve static files
dist_path = pathlib.Path(__file__).parent / "dist"
app.mount("/", StaticFiles(directory=dist_path, html=True))
print(f"Setup complete: time to load datasets: {time.time() - t0:.1f}")
