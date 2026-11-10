"""Geometry without GDAL: CRS lookup, bounds, reprojection and Web Mercator tiles.

Each function mirrors what the full server gets from rioxarray, rasterio or
rio-tiler, so both servers report the same bounds and zoom levels for a cube:

- :func:`resolve_crs` follows ``bowser.geozarr.resolve_crs`` (GeoZarr ``proj:``
  attrs, then the CF ``spatial_ref`` variable).
- :func:`grid_resolution` / :func:`grid_bounds` follow ``DataArray.rio.resolution``
  and ``.rio.bounds`` (the cached ``GeoTransform`` wins unless ``recalc``).
- :func:`transform_bounds` is PROJ's densified bounds transform, as rasterio's.
- :func:`suggested_warp_output` follows GDAL's ``GDALSuggestedWarpOutput2``
  (``rasterio.warp.calculate_default_transform``).
- :func:`dataset_zoom_range` follows rio-tiler's ``minzoom`` / ``maxzoom``.
"""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Any

import numpy as np
from pyproj import CRS, Transformer

from ..constants import TILE_SIZE

#: Half the Web Mercator world width (metres).
WEB_MERCATOR_HALF_M = 20037508.342789244
#: Web Mercator pixel size at zoom 0 for ``TILE_SIZE``-pixel tiles (metres).
_ZOOM0_CELL_M = 2 * WEB_MERCATOR_HALF_M / TILE_SIZE
#: The zoom range of the WebMercatorQuad tile matrix set.
TMS_MINZOOM, TMS_MAXZOOM = 0, 24

WEB_MERCATOR = CRS.from_epsg(3857)
WGS84 = CRS.from_epsg(4326)

Bounds = tuple[float, float, float, float]


def resolve_crs(attrs: dict, spatial_ref_attrs: dict | None) -> CRS:
    """Return the cube's CRS from GeoZarr ``proj:`` attrs or its ``spatial_ref``.

    Parameters
    ----------
    attrs : dict
        Dataset attributes (``proj:code`` / ``proj:wkt2``).
    spatial_ref_attrs : dict or None
        Attributes of the ``spatial_ref`` variable, if there is one
        (``crs_wkt``, or rioxarray's ``spatial_ref``).

    Raises
    ------
    ValueError
        If neither source names a CRS.

    """
    if code := attrs.get("proj:code"):
        return CRS.from_user_input(code)
    if wkt2 := attrs.get("proj:wkt2"):
        return CRS.from_wkt(wkt2)
    if spatial_ref_attrs is not None:
        wkt = spatial_ref_attrs.get("crs_wkt") or spatial_ref_attrs.get("spatial_ref")
        if wkt:
            return CRS.from_wkt(wkt)
    raise ValueError(
        "No CRS found on dataset. Expected GeoZarr 'proj:code'/'proj:wkt2' "
        "root attrs or a CF 'spatial_ref' variable with 'crs_wkt'."
    )


@lru_cache(maxsize=64)
def _transformer(src_wkt: str, dst_wkt: str) -> Transformer:
    return Transformer.from_crs(
        CRS.from_wkt(src_wkt), CRS.from_wkt(dst_wkt), always_xy=True
    )


def transformer(src: CRS, dst: CRS) -> Transformer:
    """Return a cached ``always_xy`` transformer between two CRSs."""
    return _transformer(src.to_wkt(), dst.to_wkt())


def _geo_transform(spatial_ref_attrs: dict | None) -> tuple[float, ...] | None:
    """Return the GDAL ``GeoTransform`` cached on ``spatial_ref``, if any.

    Read as rioxarray reads it.
    """
    gt = (spatial_ref_attrs or {}).get("GeoTransform")
    if gt is None:
        return None
    values = np.array(str(gt).split(), dtype=float)
    return tuple(values.tolist()) if values.size == 6 else None


def grid_resolution(
    x: np.ndarray,
    y: np.ndarray,
    spatial_ref_attrs: dict | None = None,
    recalc: bool = False,
) -> tuple[float, float]:
    """Signed ``(res_x, res_y)`` of a grid, as ``DataArray.rio.resolution(recalc)``."""
    gt = _geo_transform(spatial_ref_attrs)
    if gt is not None and (not recalc or x.size == 1 or y.size == 1):
        return gt[1], gt[5]
    if x.size == 1 or y.size == 1:
        raise ValueError(
            "Only 1 dimensional array found. Cannot calculate the resolution."
        )
    return (float(x[-1]) - float(x[0])) / (x.size - 1), (float(y[-1]) - float(y[0])) / (
        y.size - 1
    )


def grid_bounds(
    x: np.ndarray,
    y: np.ndarray,
    spatial_ref_attrs: dict | None = None,
    recalc: bool = False,
) -> Bounds:
    """``(left, bottom, right, top)`` of the pixel edges, as ``.rio.bounds()``."""
    res_x, res_y = grid_resolution(x, y, spatial_ref_attrs, recalc)
    left = float(x[0]) - res_x / 2.0
    right = float(x[-1]) + res_x / 2.0
    top = float(y[0]) - res_y / 2.0
    bottom = float(y[-1]) + res_y / 2.0
    # rioxarray's _order_bounds
    minx, maxx = (right, left) if res_x < 0 else (left, right)
    top_, bottom_ = (top, bottom) if res_y < 0 else (bottom, top)
    return minx, bottom_, maxx, top_


def transform_bounds(
    src: CRS, dst: CRS, bounds: Bounds, densify_pts: int = 21
) -> Bounds:
    """Reproject a bounding box, densifying its edges (as ``transform_bounds``)."""
    if src == dst:
        return tuple(float(v) for v in bounds)  # type: ignore[return-value]
    out = transformer(src, dst).transform_bounds(*bounds, densify_pts=densify_pts)
    return tuple(float(v) for v in out)  # type: ignore[return-value]


def suggested_warp_output(
    src: CRS, dst: CRS, width: int, height: int, bounds: Bounds
) -> tuple[tuple[float, float, float, float, float, float], int, int]:
    """Output grid GDAL would pick to warp a ``width`` x ``height`` raster to ``dst``.

    Returns ``(affine, width, height)`` with the affine as ``(a, b, c, d, e, f)``
    (rasterio order). Samples points along each edge of the source, takes the
    extent of the transformed points and a square pixel whose size keeps the
    source's pixel count along the diagonal, as GDAL's ``GDALSuggestedWarpOutput2``.
    """
    left, bottom, right, top = bounds
    res_x = (right - left) / width
    res_y = (bottom - top) / height
    # GDAL takes one step per ~50 source pixels along the shorter side, 20 to 100 steps.
    n_steps = min(max(int(min(width, height) / 50 + 0.5), 20), 100)
    steps = np.arange(n_steps + 1) * (1.0 / n_steps)
    steps[-1] = 1.0
    n = steps.size
    # GDAL's sample order: top, bottom, left, right edge per step, in pixel space.
    px = np.stack(
        [steps * width, steps * width, np.zeros(n), np.full(n, float(width))], 1
    ).ravel()
    py = np.stack(
        [np.zeros(n), np.full(n, float(height)), steps * height, steps * height], 1
    ).ravel()
    gx = left + px * res_x
    gy = top + py * res_y
    if src != dst:
        gx, gy = transformer(src, dst).transform(gx, gy)
        gx, gy = np.asarray(gx, dtype=float), np.asarray(gy, dtype=float)
    ok = np.isfinite(gx) & np.isfinite(gy)
    if not ok.any():
        raise ValueError("Could not transform any of the source edges")
    minx, maxx = float(gx[ok].min()), float(gx[ok].max())
    miny, maxy = float(gy[ok].min()), float(gy[ok].max())
    if ok[0] and ok[-1]:
        dx, dy = gx[-1] - gx[0], gy[-1] - gy[0]
    else:
        dx = dy = 0.0
    if dx == 0.0 or dy == 0.0:
        dx, dy = maxx - minx, maxy - miny
    pixel = math.hypot(dx, dy) / math.hypot(width, height)
    out_w = int((maxx - minx) / pixel + 0.5)
    out_h = int((maxy - miny) / pixel + 0.5)
    return (pixel, 0.0, minx, 0.0, -pixel, maxy), out_w, out_h


def warp_output_bounds(
    src: CRS, dst: CRS, width: int, height: int, bounds: Bounds
) -> Bounds:
    """``(left, bottom, right, top)`` of :func:`suggested_warp_output`'s grid."""
    (a, _, c, _, e, f), w, h = suggested_warp_output(src, dst, width, height, bounds)
    return c, f + h * e, c + w * a, f


def cell_size(z: int, tilesize: int = TILE_SIZE) -> float:
    """Web Mercator pixel size (metres) at zoom ``z``."""
    return _ZOOM0_CELL_M * TILE_SIZE / tilesize / (1 << z)


def zoom_for_res(res: float, min_z: int = TMS_MINZOOM, max_z: int = TMS_MAXZOOM) -> int:
    """Return the WebMercatorQuad zoom closest to a pixel size.

    Same as morecantile's ``auto`` strategy.
    """
    zoom = min_z
    matrix_res = cell_size(zoom)
    for zoom in range(min_z, max_z + 1):
        matrix_res = cell_size(zoom)
        if res > matrix_res or abs(res - matrix_res) / matrix_res <= 1e-8:
            break
    if zoom > 0 and abs(res - matrix_res) / matrix_res > 1e-8:
        if cell_size(max(zoom - 1, min_z)) / res < res / matrix_res:
            zoom = max(zoom - 1, min_z)
    return zoom


def _max_overview_level(width: int, height: int, minsize: int = TILE_SIZE) -> int:
    level, factor = 0, 1
    while min(width // factor, height // factor) > minsize:
        factor *= 2
        level += 1
    return level


def dataset_zoom_range(
    crs: CRS, width: int, height: int, bounds: Bounds
) -> tuple[int, int]:
    """``(minzoom, maxzoom)`` rio-tiler reports for a raster of this size and bounds."""
    if crs == WEB_MERCATOR:
        res = max(
            abs((bounds[2] - bounds[0]) / width), abs((bounds[3] - bounds[1]) / height)
        )
        w, h = width, height
    else:
        (a, _, _, _, e, _), w, h = suggested_warp_output(
            crs, WEB_MERCATOR, width, height, bounds
        )
        res = max(abs(a), abs(e))
    maxzoom = zoom_for_res(res)
    minzoom = zoom_for_res(res * 2 ** _max_overview_level(w, h, TILE_SIZE))
    return minzoom, maxzoom


def tile_bounds(x: int, y: int, z: int) -> Bounds:
    """Return a WebMercatorQuad tile's ``(left, bottom, right, top)`` in EPSG:3857."""
    size = 2 * WEB_MERCATOR_HALF_M / (1 << z)
    left = -WEB_MERCATOR_HALF_M + x * size
    top = WEB_MERCATOR_HALF_M - y * size
    return left, top - size, left + size, top


def tile_intersects(x: int, y: int, z: int, crs: CRS, bounds: Bounds) -> bool:
    """Whether a tile overlaps a raster's bounds (rio-tiler's ``tile_exists``)."""
    tb = tile_bounds(x, y, z)
    if crs != WEB_MERCATOR:
        try:
            tb = transform_bounds(WEB_MERCATOR, crs, tb)
        except Exception:  # noqa: BLE001
            return True
    if not all(math.isfinite(v) for v in tb):
        return True
    t = _normalize(tb)
    d = _normalize(bounds)
    return t[0] < d[2] and t[2] > d[0] and t[3] > d[1] and t[1] < d[3]


def _normalize(b: Bounds) -> Bounds:
    return min(b[0], b[2]), min(b[1], b[3]), max(b[0], b[2]), max(b[1], b[3])


def tile_pixel_centers(
    x: int, y: int, z: int, tilesize: int = TILE_SIZE
) -> tuple[np.ndarray, np.ndarray]:
    """EPSG:3857 x and y (1-D) of a tile's pixel centres, left-right and top-bottom."""
    left, bottom, right, top = tile_bounds(x, y, z)
    step_x = (right - left) / tilesize
    step_y = (top - bottom) / tilesize
    centers = np.arange(tilesize) + 0.5
    return left + centers * step_x, top - centers * step_y


def json_floats(values: Any) -> list[float]:
    """Plain Python floats for a JSON response."""
    return [float(v) for v in values]
