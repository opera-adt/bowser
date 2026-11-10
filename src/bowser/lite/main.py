"""bowser-lite's FastAPI app: the web UI's API for GeoZarr cubes, without GDAL.

Serves the requests the UI makes of ``bowser.main:app`` in MD mode, with the same
parameters and response shapes, using only numpy, xarray, zarr and pyproj.
Settings are read at import, as the full server: ``BOWSER_STACK_DATA_FILE`` (one
cube) and/or ``BOWSER_CATALOG_FILE`` (``?dataset=<id>`` routing),
``BOWSER_ALLOW_OPEN``, ``BOWSER_REMEMBER_OPENED``.

Not in lite (HTTP 501): GeoTIFF uploads (``/upload_raster``, ``/upload_mask``),
``/export/geotiff``, COG mode and the ``/cog`` and ``/overlay`` tilers.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import time
import warnings
from contextvars import ContextVar
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Optional
from urllib.parse import parse_qs, urlencode, urlparse

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import FileResponse, JSONResponse, RedirectResponse
from starlette.staticfiles import StaticFiles

from ..catalog import CatalogEntry, load_catalog, save_catalog
from ..config import settings
from ..utils import calculate_trend
from . import colormaps, geo, meta, sampling, tiles
from .auth import BasicAuthMiddleware
from .cube import Cube, Registry, load_default, open_cube
from .png import encode_rgba
from .profile import Line, binned_profile, point_profile

logger = logging.getLogger("bowser")
warnings.filterwarnings(
    "ignore", category=RuntimeWarning, message="invalid value encountered in cast"
)
warnings.filterwarnings(
    "ignore", category=RuntimeWarning, message="invalid value encountered in divide"
)

t0 = time.time()
_handler = logging.StreamHandler()
_handler.setLevel(settings.LOG_LEVEL)
_handler.setFormatter(
    logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%dT:%H:%M:%S",
    )
)
logger.addHandler(_handler)

app = FastAPI(title="Bowser (lite)", openapi_url="/api", docs_url="/api.html")
if settings.BOWSER_HTPASSWD_FILE:
    app.add_middleware(BasicAuthMiddleware, htpasswd_file=settings.BOWSER_HTPASSWD_FILE)

NOT_IN_LITE = (
    "{what} needs the full Bowser server (GDAL); "
    "bowser-lite serves GeoZarr cubes only. "
    "Run `bowser run` instead of the lite server for this."
)


class NanJSONResponse(JSONResponse):
    """JSON with NaN and infinities written as ``null`` (titiler's ``JSONResponse``)."""

    def render(self, content: Any) -> bytes:
        """Serialise compactly, NaN -> null."""
        import json  # noqa: PLC0415

        return json.dumps(
            _nan_to_none(content),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode()


def _nan_to_none(v: Any) -> Any:
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _nan_to_none(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_nan_to_none(x) for x in v]
    return v


# --- which cube a request reads -----------------------------------------------------

_default_cube: Cube | None = load_default(settings)
registry = Registry.from_settings(settings)
_request_cube: ContextVar[Cube | None] = ContextVar(
    "bowser_lite_request_cube", default=None
)
print(
    f"Data loading complete in {time.time() - t0:.1f} sec. "
    f"Mode: md (lite), catalog entries: {len(registry.ids())}"
)


@app.middleware("http")
async def _route_dataset(request: Request, call_next):
    """Serve this request from the catalog entry named by ``?dataset=``."""
    name = request.query_params.get("dataset")
    token = None
    if name and registry.ids():
        if name not in registry.ids():
            return JSONResponse(
                {"detail": f"unknown dataset id {name!r}"}, status_code=404
            )
        token = _request_cube.set(registry.get(name))
    try:
        return await call_next(request)
    finally:
        if token is not None:
            _request_cube.reset(token)


def resolve(dataset: str | None = None) -> Cube:
    """Return the cube to serve from.

    That is ``?dataset=<id>`` (404 if unknown), else the request's or default one.
    """
    if dataset is not None:
        try:
            return registry.get(dataset)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
    cube = _request_cube.get() or _default_cube
    if cube is None:
        raise HTTPException(
            status_code=400,
            detail="No dataset selected: add ?dataset=<id> (see /catalog).",
        )
    return cube


# --- metadata -----------------------------------------------------------------------


@app.get("/datasets")
def datasets(dataset: str | None = Query(None)):
    """Return the UI's description of every variable of the chosen cube."""
    return meta.dataset_info(
        resolve(dataset), settings.BOWSER_USE_SPATIAL_REFERENCE_DISP
    )


@app.get("/mode")
def get_mode():
    """Lite serves GeoZarr (MD) cubes only."""
    return {"mode": "md"}


@app.get("/config")
def get_config(request: Request, dataset: str | None = Query(None)):
    """Page title, logo flag, and what this server can do.

    The title is the catalog entry's name, from ``?dataset=`` or the Referer.
    ``geotiff_export`` is False: exports need the full server (``bowser run``),
    so the page turns its GeoTIFF button off instead of failing with a 501.
    """
    if dataset is None and (ref := request.headers.get("referer")):
        values = parse_qs(urlparse(ref).query).get("dataset")
        dataset = values[0] if values else None
    entry = registry.catalog.get(dataset) if dataset else None
    return {
        "title": entry.name if entry is not None else settings.BOWSER_TITLE,
        "opera_logo": settings.BOWSER_OPERA_LOGO,
        "geotiff_export": False,
    }


@app.get("/catalog")
def get_catalog():
    """Catalog entries and whether opening is allowed.

    The file's entries come first, then any opened at runtime.
    """
    entries = (
        load_catalog(settings.BOWSER_CATALOG_FILE)
        if settings.BOWSER_CATALOG_FILE
        else []
    )
    listed = {e.id for e in entries}
    entries += [e for e in registry.catalog.values() if e.id not in listed]
    return {
        "datasets": [e.to_dict() for e in entries],
        "allow_open": settings.BOWSER_ALLOW_OPEN,
    }


def _opened_id(name: str, uri: str) -> str:
    """Return a catalog id for a store opened at runtime: its name and a URI hash."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "cube"
    return f"{slug}-{hashlib.sha1(uri.encode()).hexdigest()[:8]}"


@app.post("/catalog/scan")
def scan_folder(body: dict = Body(...)):
    """GeoZarr cubes under a folder (only with ``BOWSER_ALLOW_OPEN``)."""
    from ..scan import find_cubes  # noqa: PLC0415

    if not settings.BOWSER_ALLOW_OPEN:
        raise HTTPException(
            status_code=403,
            detail="Searching folders from the page is off on this server.",
        )
    folder = str(body.get("dir") or "").strip()
    if not folder:
        raise HTTPException(status_code=400, detail="Give a folder to search.")
    try:
        return find_cubes(folder)
    except NotADirectoryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/catalog/open")
def open_dataset(body: dict = Body(...)):
    """Open a GeoZarr store by path or URL and add it to the catalog.

    Returns ``{id, name}``.
    """
    if not settings.BOWSER_ALLOW_OPEN:
        raise HTTPException(
            status_code=403,
            detail="Opening data from the page is off on this server "
            "(set BOWSER_ALLOW_OPEN=true, or run `bowser run` locally).",
        )
    uri = str(body.get("uri") or "").strip()
    if not uri:
        raise HTTPException(
            status_code=400, detail="Give a path or URL to a .zarr store."
        )
    if "://" not in uri:
        path = Path(uri).expanduser()
        if not path.exists():
            raise HTTPException(
                status_code=400, detail=f"No such file or folder: {path}"
            )
        uri = str(path.resolve())
    try:
        cube = open_cube(uri)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not open {uri} as a GeoZarr cube: {exc}"
        ) from exc
    name = str(
        cube.dataset.attrs.get("title")
        or Path(uri.rstrip("/")).name.removesuffix(".zarr")
    )
    try:
        bounds = cube.lonlat_bounds()
    except Exception:  # noqa: BLE001
        bounds = (0.0, 0.0, 0.0, 0.0)  # the picker can't place it on its map
    left, bottom, right, top = bounds
    entry = CatalogEntry(
        id=_opened_id(name, uri),
        name=name,
        uri=uri,
        bbox=(float(left), float(bottom), float(right), float(top)),
    )
    registry.register(entry, cube)
    if settings.BOWSER_REMEMBER_OPENED and settings.BOWSER_CATALOG_FILE:
        kept = [
            e for e in load_catalog(settings.BOWSER_CATALOG_FILE) if e.id != entry.id
        ]
        save_catalog([*kept, entry], settings.BOWSER_CATALOG_FILE)
    return {"id": entry.id, "name": entry.name}


@app.get("/variables")
def get_variables(dataset: str | None = Query(None)):
    """Dimensions, shape, dtype and attrs of every variable with x and y dims."""
    ds = resolve(dataset).dataset
    return {
        "variables": {
            name: {
                "dimensions": list(var.dims),
                "shape": list(var.shape),
                "dtype": str(var.dtype),
                "attrs": dict(var.attrs),
            }
            for name, var in ds.data_vars.items()
            if "x" in var.dims and "y" in var.dims
        }
    }


@app.get("/datasets/{dataset_name}/time_bounds")
def get_time_bounds(dataset_name: str, dataset: str | None = Query(None)):
    """First and last label and the number of time steps."""
    labels = meta.labels_for(
        sampling.require_var(resolve(dataset).dataset, dataset_name)
    )
    if not labels:
        raise HTTPException(status_code=400, detail=f"{dataset_name} has no time dim")
    return NanJSONResponse(
        {"start_time": labels[0], "end_time": labels[-1], "num_time_steps": len(labels)}
    )


# --- values -------------------------------------------------------------------------

Lon = Annotated[float, Query(..., title="Longitude", ge=-180, le=180)]
Lat = Annotated[float, Query(..., title="Latitude", ge=-90, le=90)]
OptLon = Annotated[float | None, Query(title="Reference longitude", ge=-180, le=180)]
OptLat = Annotated[float | None, Query(title="Reference latitude", ge=-90, le=90)]


def _chart_data(x_values: list, values: np.ndarray) -> list[dict]:
    return [
        {"x": x, "y": float(y)}
        for x, y in zip(x_values, np.atleast_1d(values).tolist())
        if not np.isnan(y)
    ]


@app.get("/point", response_class=NanJSONResponse)
def point(
    dataset_name: str,
    lon: Lon,
    lat: Lat,
    time_idx: Annotated[
        int | None, Query(title="Time index — read only this step")
    ] = None,
):
    """Values at a point: the full series, or one value with ``time_idx``."""
    return NanJSONResponse(
        sampling.point_values(
            resolve(), dataset_name, lon, lat, time_idx=time_idx
        ).tolist()
    )


@app.get("/chart_point", response_class=NanJSONResponse)
def chart_point(
    dataset_name: str,
    lon: Lon,
    lat: Lat,
    ref_lon: OptLon = None,
    ref_lat: OptLat = None,
):
    """Chart.js series at a point, minus the reference point's when given."""
    cube = resolve()
    x_values = meta.labels_for(sampling.require_var(cube.dataset, dataset_name))
    values = sampling.point_values(cube, dataset_name, lon, lat)
    if ref_lon is not None and ref_lat is not None:
        values = values - sampling.point_values(cube, dataset_name, ref_lon, ref_lat)
    return NanJSONResponse(
        {"datasets": [{"data": _chart_data(x_values, values)}], "labels": x_values}
    )


def _trend(values: np.ndarray, x_values: list) -> dict:
    t = calculate_trend(values, x_values)  # type: ignore[arg-type]
    return {
        "slope": t["slope"],
        "intercept": t["intercept"],
        "rSquared": t["r_squared"],
        "mmPerYear": t["mm_per_year"],
        "stdMmPerYear": t["std_mm_per_year"],
    }


@app.post("/multi_point", response_class=NanJSONResponse)
def multi_point(
    points: list[dict[str, Any]] = Body(
        ..., description="List of points with id, lat, lon"
    ),
    dataset_name: str = Body(..., description="Dataset name"),
    ref_lon: Optional[float] = Body(None),
    ref_lat: Optional[float] = Body(None),
    calculate_trends: bool = Body(False),
    layer_masks: list[dict] = Body([]),
    ref_buffer_m: float = Body(0.0),
):
    """Series (and optional trends) for several points, re-referenced and masked."""
    cube = resolve()
    x_values = meta.labels_for(sampling.require_var(cube.dataset, dataset_name))
    ref = None
    if ref_lon is not None and ref_lat is not None:
        ref = sampling.ref_values(
            cube, dataset_name, ref_lon, ref_lat, ref_buffer_m, layer_masks
        )
    results = []
    for p in points:
        point_id, lat, lon = p.get("id"), p.get("lat"), p.get("lon")
        color = p.get("color", "#1f77b4")
        if not point_id or lat is None or lon is None:
            continue
        try:
            values = sampling.point_values(
                cube, dataset_name, float(lon), float(lat), layer_masks
            )
            if ref is not None:
                values = values - ref
            data = _chart_data(x_values, values)
            xy = sampling.point_xy(cube, float(lon), float(lat))
            results.append(
                {
                    "pointId": point_id,
                    "label": p.get("name", f"Point {point_id}"),
                    "data": data,
                    "borderColor": color,
                    "backgroundColor": color + "20",
                    "trend": _trend(values, x_values)
                    if calculate_trends and len(data) > 1
                    else None,
                    "x": xy[0] if xy else None,
                    "y": xy[1] if xy else None,
                }
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"Error processing point {point_id}: {e}")
    return NanJSONResponse({"labels": x_values, "datasets": results})


@app.get("/trend_analysis/{dataset_name}", response_class=NanJSONResponse)
def trend_analysis(
    dataset_name: str,
    lon: Lon,
    lat: Lat,
    ref_lon: OptLon = None,
    ref_lat: OptLat = None,
):
    """Linear trend (mm/yr) at a point."""
    cube = resolve()
    x_values = meta.labels_for(sampling.require_var(cube.dataset, dataset_name))
    values = sampling.point_values(cube, dataset_name, lon, lat)
    if ref_lon is not None and ref_lat is not None:
        values = values - sampling.point_values(cube, dataset_name, ref_lon, ref_lat)
    return NanJSONResponse(calculate_trend(values, x_values))  # type: ignore[arg-type]


def _first_step(cube: Cube, name: str, time_index: int = 0) -> np.ndarray:
    da = sampling.require_var(cube.dataset, name)
    dim = meta.non_spatial_dim(da)
    return (
        (da.isel({dim: time_index}) if dim is not None else da)
        .values.ravel()
        .astype(float)
    )


@app.get("/dataset_range/{dataset_name}", response_class=NanJSONResponse)
def get_dataset_range(dataset_name: str, dataset: str | None = Query(None)):
    """min/max and 2/98, 5/95 percentiles of the first time step."""
    arr = _first_step(resolve(dataset), dataset_name)
    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        raise HTTPException(status_code=204, detail="No valid data")
    p = np.percentile(valid, [2, 98, 5, 95])
    return NanJSONResponse(
        {
            "min": float(valid.min()),
            "max": float(valid.max()),
            "p2": float(p[0]),
            "p98": float(p[1]),
            "p5": float(p[2]),
            "p95": float(p[3]),
        }
    )


@app.get("/histogram/{dataset_name}", response_class=NanJSONResponse)
def get_histogram(
    dataset_name: str,
    time_index: Annotated[int, Query(ge=0)] = 0,
    nbins: Annotated[int, Query(ge=4, le=256)] = 100,
    dataset: str | None = Query(None),
):
    """Histogram and percentiles of one time step.

    Uses the stored ``bowser_histogram`` when present.
    """
    cube = resolve(dataset)
    da = sampling.require_var(cube.dataset, dataset_name)
    dim = meta.non_spatial_dim(da)
    if dim is not None:
        time_index = min(time_index, da.sizes[dim] - 1)
    cached = da.attrs.get("bowser_histogram")
    if isinstance(cached, list) and cached:
        idx = time_index if dim is not None else 0
        if 0 <= idx < len(cached):
            entry = cached[idx]
            if isinstance(entry, dict) and "bins" in entry and "counts" in entry:
                return NanJSONResponse(entry)
    arr = _first_step(cube, dataset_name, time_index)
    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        return NanJSONResponse(
            dict.fromkeys(("min", "max", "p2", "p98", "p16", "p84", "p23", "p977"), 0.0)
            | {"bins": [], "counts": []}
        )
    counts, edges = np.histogram(valid, bins=nbins)
    names = ("p2", "p98", "p16", "p84", "p23", "p977")
    pct = np.percentile(valid, [2, 98, 16, 84, 2.275, 97.725])
    return NanJSONResponse(
        {
            "bins": edges.tolist(),
            "counts": counts.tolist(),
            "min": float(valid.min()),
            "max": float(valid.max()),
        }
        | {k: float(v) for k, v in zip(names, pct)}
    )


@app.post("/buffer_timeseries", response_class=NanJSONResponse)
def buffer_timeseries(
    lon: float = Body(...),
    lat: float = Body(...),
    dataset_name: str = Body(...),
    buffer_m: float = Body(500.0),
    n_samples: int = Body(10),
    ref_lon: Optional[float] = Body(None),
    ref_lat: Optional[float] = Body(None),
    layer_masks: list[dict] = Body([]),
    ref_buffer_m: float = Body(0.0),
):
    """Median and a few random pixel series within a circle around a point."""
    cube = resolve()
    x_values = meta.labels_for(sampling.require_var(cube.dataset, dataset_name))
    found = sampling.buffer_window(cube, dataset_name, lon, lat, buffer_m, layer_masks)
    if found is None:
        raise HTTPException(status_code=404, detail="Buffer outside dataset extent")
    flat = sampling.buffer_pixels(*found)
    if ref_lon is not None and ref_lat is not None:
        flat = (
            flat
            - sampling.ref_values(
                cube, dataset_name, ref_lon, ref_lat, ref_buffer_m, layer_masks
            )[:, np.newaxis]
        )
    flat = flat[:, ~np.all(np.isnan(flat), axis=0)]
    if flat.shape[1] == 0:
        raise HTTPException(status_code=404, detail="No valid pixels in buffer")
    with sampling.quiet():
        median_ts = np.nanmedian(flat, axis=1).tolist()
    rng = np.random.default_rng(42)
    idx = rng.choice(flat.shape[1], size=min(n_samples, flat.shape[1]), replace=False)
    samples = flat[:, idx].T.tolist()
    return NanJSONResponse(
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


@app.post("/profile", response_class=NanJSONResponse)
def extract_profile(
    coords: list[list[float]] = Body(..., description="List of [lon, lat] pairs"),
    dataset_name: str = Body(...),
    time_index: int = Body(0),
    n_samples: int = Body(200),
    radius: float = Body(0.0),
    n_random: int = Body(5),
    sampling_interval: float = Body(0.0),
):
    """Values along a polyline.

    Binned medians when ``sampling_interval > 0``, else evenly spaced points.
    """
    if len(coords) < 2:
        raise HTTPException(status_code=422, detail="Need at least 2 coordinate pairs")
    time_index = max(0, time_index)
    line = Line(coords)
    if line.total == 0:
        raise HTTPException(status_code=422, detail="Zero-length line")
    cube = resolve()
    if sampling_interval > 0:

        def read_many(lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
            try:
                return sampling.values_at(cube, dataset_name, time_index, lons, lats)
            except Exception:  # noqa: BLE001
                return np.full(lons.shape, np.nan)

        return NanJSONResponse(
            binned_profile(line, read_many, sampling_interval, radius, n_random)
        )

    def read_one(lon: float, lat: float) -> float | None:
        return sampling.value_at(cube, dataset_name, time_index, lon, lat)

    return NanJSONResponse(point_profile(line, read_one, n_samples, radius, n_random))


# --- images -------------------------------------------------------------------------


@lru_cache(maxsize=256)
def _colorbar_png(name: str) -> bytes:
    return encode_rgba(colormaps.colorbar_rgba(name))


@app.get("/colorbar/{cmap_name}")
def get_colorbar(cmap_name: str):
    """Return a PNG gradient of a colormap (the full server sends a matplotlib WEBP)."""
    try:
        return Response(
            content=_colorbar_png(cmap_name.lower()), media_type="image/png"
        )
    except KeyError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def _tile_query(
    variable: str,
    time_idx: int | None,
    mask_variable: str | None,
    mask_min_value: float,
    layer_masks: str | None,
    rescale: list[str] | None,
    colormap_name: str | None,
    algorithm: str | None,
    algorithm_params: str | None,
) -> tiles.TileQuery:
    if colormap_name is not None and colormap_name.lower() not in colormaps.names():
        raise HTTPException(
            status_code=422, detail=f"Unknown colormap_name {colormap_name!r}"
        )
    algo, params = tiles.parse_algorithm(algorithm, algorithm_params)
    return tiles.TileQuery(
        variable=variable,
        time_idx=time_idx,
        mask_variable=mask_variable,
        mask_min_value=mask_min_value,
        layer_masks=layer_masks,
        rescale=tiles.parse_rescale(rescale),
        colormap_name=colormap_name,
        algorithm=algo,
        algorithm_params=params,
    )


def _check_tms(tms: str) -> None:
    if tms != "WebMercatorQuad":
        raise HTTPException(
            status_code=422,
            detail=f"bowser-lite serves WebMercatorQuad tiles only, not {tms!r}",
        )


# TiTiler 2 leaves these out of the tile URL's query (tilesize is re-added
# last); tile_scale has no meaning there and is passed through unchanged.
_TILEJSON_DROP = {
    "tilematrixsetid",
    "tile_format",
    "tilesize",
    "minzoom",
    "maxzoom",
}


@app.get("/md/{tileMatrixSetId}/tilejson.json", response_class=NanJSONResponse)
def tilejson(
    request: Request,
    tileMatrixSetId: str,
    variable: str = Query(...),
    dataset: str | None = Query(None),
    time_idx: int | None = Query(None),
    mask_variable: str | None = Query(None),
    mask_min_value: float = Query(0.1),
    layer_masks: str | None = Query(None),
    custom_mask_path: str | None = Query(None),  # noqa: ARG001 — accepted, ignored (GeoTIFF)
    rescale: list[str] | None = Query(None),
    colormap_name: str | None = Query(None),
    algorithm: str | None = Query(None),
    algorithm_params: str | None = Query(None),
    tile_format: str | None = Query(None),
    tilesize: Annotated[int | None, Query(gt=0)] = None,
    minzoom: int | None = Query(None),
    maxzoom: int | None = Query(None),
):
    """TileJSON for the MD tiler: tile URL template, lon/lat bounds and zoom range."""
    _check_tms(tileMatrixSetId)
    cube = resolve(dataset)
    q = _tile_query(
        variable,
        time_idx,
        mask_variable,
        mask_min_value,
        layer_masks,
        rescale,
        colormap_name,
        algorithm,
        algorithm_params,
    )
    da, _ = tiles.tile_source(cube.dataset, q)
    bounds = cube.bounds(da)
    min_z, max_z = geo.dataset_zoom_range(
        cube.crs, da.sizes["x"], da.sizes["y"], bounds
    )
    min_z = minzoom if minzoom is not None else min_z
    max_z = maxzoom if maxzoom is not None else max_z
    # Mirror the full server's TiTiler 2: no @Nx path suffix, and the tile size
    # in the query, 512 unless the client asked for another.
    url = f"{request.base_url}md/tiles/{tileMatrixSetId}/{{z}}/{{x}}/{{y}}"
    if tile_format:
        url += f".{tile_format}"
    qs = [
        (k, v)
        for k, v in request.query_params.multi_items()
        if k.lower() not in _TILEJSON_DROP
    ]
    qs.append(("tilesize", str(tilesize if tilesize is not None else 512)))
    url += f"?{urlencode(qs)}"
    ll = geo.transform_bounds(cube.crs, geo.WGS84, bounds)
    return NanJSONResponse(
        {
            "tilejson": "3.0.0",
            "version": "1.0.0",
            "scheme": "xyz",
            "tiles": [url],
            "minzoom": min_z,
            "maxzoom": max_z,
            "bounds": list(ll),
            "center": [(ll[0] + ll[2]) / 2, (ll[1] + ll[3]) / 2, min_z],
        }
    )


def _tile(
    tileMatrixSetId: str,
    z: int,
    x: int,
    y: int,
    scale: int,
    fmt: str | None,
    variable: str,
    dataset: str | None,
    time_idx: int | None,
    mask_variable: str | None,
    mask_min_value: float,
    layer_masks: str | None,
    custom_mask_path: str | None,
    rescale: list[str] | None,
    colormap_name: str | None,
    algorithm: str | None,
    algorithm_params: str | None,
    tilesize: int | None,
) -> Response:
    _check_tms(tileMatrixSetId)
    if fmt not in (None, "png"):
        raise HTTPException(
            status_code=501, detail=f"bowser-lite renders PNG tiles only, not {fmt!r}"
        )
    if not 1 <= scale <= 3:
        raise HTTPException(status_code=422, detail="scale must be 1, 2 or 3")
    if custom_mask_path:
        logger.warning(
            "custom_mask_path is ignored by bowser-lite (GeoTIFF masks need GDAL)"
        )
    cube = resolve(dataset)
    q = _tile_query(
        variable,
        time_idx,
        mask_variable,
        mask_min_value,
        layer_masks,
        rescale,
        colormap_name,
        algorithm,
        algorithm_params,
    )
    try:
        size = tilesize if tilesize is not None else 256 * scale
        content = tiles.render_tile(cube, q, x, y, z, tilesize=size)
    except tiles.TileOutsideBoundsError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return Response(content, media_type="image/png")


_TILE_QUERY = {
    "variable": Query(..., description="Variable name"),
    "dataset": Query(None, description="Catalog dataset id"),
    "time_idx": Query(None, description="Time index"),
    "mask_variable": Query(None, description="Mask variable"),
    "mask_min_value": Query(0.1, description="Mask minimum value"),
    "layer_masks": Query(
        None, description="JSON list of {dataset,threshold,mode} mask dicts"
    ),
    "custom_mask_path": Query(None, description="Ignored by lite (GeoTIFF)"),
    "rescale": Query(None, description="min,max"),
    "colormap_name": Query(None, description="Colormap name"),
    "algorithm": Query(None, description="shift, rewrap, phase or amplitude"),
    "algorithm_params": Query(None, description="JSON algorithm parameters"),
}


def _make_tile_route(path: str) -> None:
    """Register one of the four titiler-style tile paths.

    They differ in having @scale and .format or not.
    """

    def tile(
        tileMatrixSetId: str,
        z: int,
        x: int,
        y: int,
        variable: str = _TILE_QUERY["variable"],
        dataset: Optional[str] = _TILE_QUERY["dataset"],
        time_idx: Optional[int] = _TILE_QUERY["time_idx"],
        mask_variable: Optional[str] = _TILE_QUERY["mask_variable"],
        mask_min_value: float = _TILE_QUERY["mask_min_value"],
        layer_masks: Optional[str] = _TILE_QUERY["layer_masks"],
        custom_mask_path: Optional[str] = _TILE_QUERY["custom_mask_path"],
        rescale: Optional[list[str]] = _TILE_QUERY["rescale"],
        colormap_name: Optional[str] = _TILE_QUERY["colormap_name"],
        algorithm: Optional[str] = _TILE_QUERY["algorithm"],
        algorithm_params: Optional[str] = _TILE_QUERY["algorithm_params"],
        scale: int = 1,
        format: Optional[str] = None,  # noqa: A002 — titiler's parameter name
        tilesize: Optional[int] = Query(None, gt=0),
    ) -> Response:
        return _tile(
            tileMatrixSetId, z, x, y, scale, format, variable, dataset, time_idx,
            mask_variable, mask_min_value, layer_masks, custom_mask_path, rescale,
            colormap_name, algorithm, algorithm_params, tilesize,
        )  # fmt: skip

    app.add_api_route(path, tile, methods=["GET"], response_class=Response, name="tile")


for _path in (
    "/md/tiles/{tileMatrixSetId}/{z:int}/{x:int}/{y:int}",
    "/md/tiles/{tileMatrixSetId}/{z:int}/{x:int}/{y:int}.{format}",
    "/md/tiles/{tileMatrixSetId}/{z:int}/{x:int}/{y:int}@{scale:int}x",
    "/md/tiles/{tileMatrixSetId}/{z:int}/{x:int}/{y:int}@{scale:int}x.{format}",
):
    _make_tile_route(_path)


# --- not in lite --------------------------------------------------------------------


def _not_in_lite(what: str) -> JSONResponse:
    return JSONResponse({"detail": NOT_IN_LITE.format(what=what)}, status_code=501)


@app.post("/upload_mask")
def upload_mask():
    """501: GeoTIFF masks need GDAL."""
    return _not_in_lite("Uploading a GeoTIFF mask")


@app.post("/upload_raster")
def upload_raster():
    """501: GeoTIFF overlays need GDAL."""
    return _not_in_lite("Adding a GeoTIFF overlay")


@app.get("/export/geotiff")
def export_geotiff():
    """501: writing GeoTIFFs needs GDAL."""
    return _not_in_lite("Exporting a GeoTIFF")


@app.post("/polygon_timeseries")
def polygon_timeseries():
    """501: native polygon statistics currently require the full server."""
    return _not_in_lite("Native polygon statistics")


@app.api_route("/cog/{path:path}", methods=["GET", "POST"], include_in_schema=False)
def cog_tiler(path: str):  # noqa: ARG001
    """501: COG mode needs GDAL."""
    return _not_in_lite("COG mode (GeoTIFF stacks)")


@app.api_route("/overlay/{path:path}", methods=["GET", "POST"], include_in_schema=False)
def overlay_tiler(path: str):  # noqa: ARG001
    """501: GeoTIFF overlays need GDAL."""
    return _not_in_lite("The GeoTIFF overlay tiler")


# --- proxies (no CORS on the remote side) ---------------------------------------------


@app.get("/gnss/stations")
def gnss_stations(
    west: float = Query(...),
    south: float = Query(...),
    east: float = Query(...),
    north: float = Query(...),
):
    """UNR GNSS stations in a lon/lat box, nearest the centre first.

    Velocities are MIDAS, NA fixed, in mm/yr.
    """
    from .. import gnss  # noqa: PLC0415

    try:
        rows = gnss.midas_rows()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Could not read UNR's station list: {exc}"
        ) from exc
    return {
        "source": gnss.MIDAS_URL,
        "stations": gnss.stations_in(rows, west, south, east, north),
    }


@app.get("/gnss/series/{station}")
def gnss_series(station: str):
    """Return a UNR station's daily east, north, up (mm since day one), NA fixed."""
    import urllib.error  # noqa: PLC0415

    from .. import gnss  # noqa: PLC0415

    try:
        return gnss.station_series(station)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except urllib.error.HTTPError as exc:
        status = 404 if exc.code == 404 else 502
        raise HTTPException(
            status_code=status,
            detail=f"UNR has no NA-fixed series for {station.upper()}",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Could not read UNR's series: {exc}"
        ) from exc


@app.get("/wms_capabilities", response_class=NanJSONResponse)
def wms_capabilities(url: str = Query(..., description="WMS base URL")):
    """Return the named layers (``[{name, title}]``) in a WMS's GetCapabilities."""
    from .wms import named_layers  # noqa: PLC0415

    return NanJSONResponse({"layers": named_layers(url)})


# --- the page -----------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _server_error(request: Request, exc: Exception):  # noqa: ARG001
    return JSONResponse({"detail": str(exc)}, status_code=500)


_PACKAGE = Path(__file__).resolve().parents[1]
static_path = _PACKAGE / "static"
dist_path = _PACKAGE / "dist"
if static_path.exists():
    app.mount("/static", StaticFiles(directory=static_path), name="static")

    @app.get("/picker", include_in_schema=False)
    def picker_redirect():
        """Friendly alias for /static/picker.html."""
        return RedirectResponse("/static/picker.html")


@app.get("/", include_in_schema=False)
def root(request: Request):
    """Return the app page, or the picker in catalog mode without ``?dataset=``."""
    if settings.BOWSER_CATALOG_FILE and not request.query_params.get("dataset"):
        return RedirectResponse("/picker")
    return FileResponse(dist_path / "index.html")


if dist_path.exists():
    app.mount("/", StaticFiles(directory=dist_path, html=True))
else:
    logger.warning(f"Frontend bundle not found at {dist_path} — serving API only.")
print(f"Setup complete: time to load datasets: {time.time() - t0:.1f} sec.")
