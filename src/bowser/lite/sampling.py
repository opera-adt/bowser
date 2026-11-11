"""Reading values out of a cube: masked points, windows, buffers and line samples.

The full server masks a whole variable (``da.where(mask)``) and then picks the
pixels it needs; with dask that stays lazy. Without dask the same expression would
read every chunk, so lite picks the pixels first and masks only those. Because
``where`` is element-wise on one grid, the values are the same.
"""

from __future__ import annotations

import json
import logging
import warnings
from contextlib import contextmanager
from typing import Callable, Iterator

import numpy as np
import xarray as xr
from fastapi import HTTPException

from .cube import Cube
from .meta import non_spatial_dim

logger = logging.getLogger("bowser")

Selector = Callable[[xr.DataArray], xr.DataArray]


def require_var(ds: xr.Dataset, name: str) -> xr.DataArray:
    """``ds[name]``, or HTTP 404 "Variable <name> not found"."""
    if name not in ds.data_vars:
        raise HTTPException(status_code=404, detail=f"Variable {name} not found")
    return ds[name]


def parse_layer_masks(layer_masks: str | list | None) -> list[dict]:
    """Layer masks from a request: a JSON string (tiles) or a list (POST bodies)."""
    if not layer_masks:
        return []
    if isinstance(layer_masks, str):
        try:
            return list(json.loads(layer_masks))
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse layer_masks JSON: {e}")
            return []
    return list(layer_masks)


def _mask_frame(mask_da: xr.DataArray, time_idx: int | None) -> xr.DataArray:
    """Return a mask layer at ``time_idx`` (clamped), or at the first step if None."""
    mdim = non_spatial_dim(mask_da)
    if mdim is None:
        return mask_da
    idx = min(time_idx, mask_da.sizes[mdim] - 1) if time_idx is not None else 0
    return mask_da.isel({mdim: idx})


def apply_layer_masks(
    values: xr.DataArray,
    ds: xr.Dataset,
    layer_masks: list[dict],
    time_idx: int | None,
    select: Selector,
) -> xr.DataArray:
    """Mask already-selected ``values`` by each ``{dataset, threshold, mode}`` layer.

    ``select`` picks from a mask layer the same pixels ``values`` came from.
    ``min`` keeps pixels >= threshold, ``max`` keeps pixels <= threshold, as
    ``bowser.main._apply_layer_masks_md``.
    """
    for m in layer_masks:
        var = m.get("dataset")
        threshold = float(m.get("threshold", 0.5))
        if not var or var not in ds.data_vars:
            continue
        mask = select(_mask_frame(ds[var], time_idx))
        keep = mask <= threshold if m.get("mode", "min") == "max" else mask >= threshold
        values = values.where(keep)
    return values


def nearest_indices(ds: xr.Dataset, dim: str, labels) -> np.ndarray:
    """Positions of the nearest coordinate along ``dim``.

    Exactly as ``.sel(method='nearest')``.
    """
    return ds.indexes[dim].get_indexer(
        np.atleast_1d(np.asarray(labels, dtype=float)), method="nearest"
    )


def point_values(
    cube: Cube,
    name: str,
    lon: float,
    lat: float,
    layer_masks: list[dict] | None = None,
    time_idx: int | None = None,
) -> np.ndarray:
    """Values at the pixel nearest ``(lon, lat)``.

    The whole series, or one step with ``time_idx``.
    """
    ds = cube.dataset
    da = require_var(ds, name)
    if time_idx is not None:
        dim = non_spatial_dim(da)
        if dim is not None:
            da = da.isel({dim: max(0, min(time_idx, da.sizes[dim] - 1))})
    x, y = cube.transformer_from_lonlat.transform(lon, lat)

    def select(a: xr.DataArray) -> xr.DataArray:
        return a.sel(x=x, y=y, method="nearest").load()

    values = apply_layer_masks(select(da), ds, layer_masks or [], time_idx, select)
    return np.atleast_1d(values.values)


def point_xy(cube: Cube, lon: float, lat: float) -> tuple[float, float] | None:
    """Return a point's coordinates in the cube's CRS, or None if not finite."""
    try:
        x, y = cube.transformer_from_lonlat.transform(lon, lat)
    except (ValueError, TypeError):
        return None
    if np.isfinite(x) and np.isfinite(y):
        return float(x), float(y)
    return None


def buffer_window(
    cube: Cube,
    name: str,
    lon: float,
    lat: float,
    buffer_m: float,
    layer_masks: list[dict],
) -> tuple[xr.DataArray, np.ndarray] | None:
    """Return the masked pixels within ``buffer_m`` of a point.

    The result is ``(window, in_circle)``.

    ``window`` is the bounding box of the circle (all time steps), ``in_circle``
    the ``(ny, nx)`` boolean disc. None when the box misses the cube.
    """
    ds = cube.dataset
    da = require_var(ds, name)
    cx, cy = cube.transformer_from_lonlat.transform(lon, lat)
    res_x = float(abs(da.x[1] - da.x[0])) if da.x.size > 1 else 1.0
    res_y = float(abs(da.y[1] - da.y[0])) if da.y.size > 1 else 1.0
    x_sel = slice(cx - buffer_m - res_x, cx + buffer_m + res_x)
    y_sel = slice(cy + buffer_m + res_y, cy - buffer_m - res_y)
    x_slice = da.x.sel(x=x_sel)
    y_slice = da.y.sel(y=y_sel)
    if x_slice.size == 0 or y_slice.size == 0:
        return None

    def select(a: xr.DataArray) -> xr.DataArray:
        return a.sel(x=x_sel, y=y_sel).load()

    window = apply_layer_masks(select(da), ds, layer_masks, None, select)
    xx, yy = np.meshgrid(x_slice.values, y_slice.values)
    return window, np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) <= buffer_m


def buffer_pixels(window: xr.DataArray, in_circle: np.ndarray) -> np.ndarray:
    """``(time, n_pixels)`` values of a buffer window, NaN outside the disc.

    A 2-D window (a layer without a time axis) is one step: ``(1, n_pixels)``.
    Mirrors :func:`bowser.reference.pool`, which lite does not import (rasterio).
    """
    arr = window.values
    if arr.ndim == in_circle.ndim:
        arr = arr[np.newaxis]
    return np.where(in_circle, arr, np.nan).reshape(arr.shape[0], -1)


def ref_values(
    cube: Cube,
    name: str,
    lon: float,
    lat: float,
    buffer_m: float = 0.0,
    layer_masks: list[dict] | None = None,
) -> np.ndarray:
    """Return the reference series: buffer median if ``buffer_m > 0``, else a pixel."""
    layer_masks = layer_masks or []
    if buffer_m <= 0:
        return point_values(cube, name, lon, lat, layer_masks)
    found = buffer_window(cube, name, lon, lat, buffer_m, layer_masks)
    if found is None:
        return point_values(cube, name, lon, lat, layer_masks)
    with quiet():
        return np.nanmedian(buffer_pixels(*found), axis=1)


def values_at(
    cube: Cube, name: str, time_index: int, lons: np.ndarray, lats: np.ndarray
) -> np.ndarray:
    """One time step sampled at many lon/lat points (nearest pixel).

    NaN outside the grid.

    The batched read of ``/profile``: one transform, one window read.
    """
    if lons.size == 0:
        return np.array([], dtype=float)
    ds = cube.dataset
    if name not in ds.data_vars:
        return np.full(lons.shape, np.nan)
    da = ds[name]
    dim = non_spatial_dim(da)
    if dim is not None and time_index < da.sizes[dim]:
        da = da.isel({dim: time_index})
    xs, ys = cube.transformer_from_lonlat.transform(lons, lats)
    xs = np.asarray(xs, dtype=float)
    ys = np.asarray(ys, dtype=float)
    ix = nearest_indices(ds, "x", xs)
    iy = nearest_indices(ds, "y", ys)
    xv, yv = da.x.values, da.y.values
    in_bounds = (
        (xs >= xv.min()) & (xs <= xv.max()) & (ys >= yv.min()) & (ys <= yv.max())
    )
    ok = (ix >= 0) & (iy >= 0)
    out = np.full(lons.shape, np.nan)
    if not ok.any():
        return out
    r0, r1 = int(iy[ok].min()), int(iy[ok].max())
    c0, c1 = int(ix[ok].min()), int(ix[ok].max())
    window = da.isel(y=slice(r0, r1 + 1), x=slice(c0, c1 + 1)).values.astype(float)
    if window.ndim != 2:
        return out
    out[ok] = window[iy[ok] - r0, ix[ok] - c0]
    out[~in_bounds] = np.nan
    return out


def value_at(
    cube: Cube, name: str, time_index: int, lon: float, lat: float
) -> float | None:
    """One value at one point (the profile's per-point read); None on NaN or failure."""
    try:
        ds = cube.dataset
        if name not in ds.data_vars:
            return None
        da = ds[name]
        dim = non_spatial_dim(da)
        if dim is not None and time_index < da.sizes[dim]:
            da = da.isel({dim: time_index})
        x, y = cube.transformer_from_lonlat.transform(lon, lat)
        val = float(da.sel(x=x, y=y, method="nearest").values)
        return val if np.isfinite(val) else None
    except Exception:  # noqa: BLE001
        return None


@contextmanager
def quiet() -> Iterator[None]:
    """Silence numpy's all-NaN RuntimeWarnings (e.g. the median of an empty slice)."""
    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore", RuntimeWarning)
        yield
