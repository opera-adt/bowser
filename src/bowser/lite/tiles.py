"""Web Mercator tiles of a cube variable, rendered with numpy instead of titiler/GDAL.

The steps follow what the full server's ``/md/tiles`` does with titiler and
rio-tiler, so the two produce the same pixels:

1. Nearest-neighbour warp: the centre of each output pixel is transformed to the
   cube's CRS (with GDAL's approximate transformer, :mod:`.warp`) and the source
   pixel containing it is taken (GDAL ``nearest``).
2. The variable is masked like ``bowser.main._build_masked_md_dataarray``
   (``mask_variable`` and ``layer_masks``), on the window the tile reads.
3. The tile algorithm (``shift``, ``rewrap``, ``phase``, ``amplitude``) runs on
   the masked array, as in ``bowser.titiler``.
4. ``rescale`` maps values linearly to 0-255 (rio-tiler's ``linear_rescale``),
   a colormap lookup table colours them, and masked pixels get alpha 0.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
import xarray as xr
from fastapi import HTTPException

from ..constants import TILE_SIZE
from . import colormaps, geo, warp
from .cube import Cube, spatial_ref_attrs
from .meta import non_spatial_dim
from .png import encode_rgba
from .sampling import apply_layer_masks, parse_layer_masks

logger = logging.getLogger("bowser")

#: rioxarray's default nodata per dtype, used for pixels the warp leaves empty.
_DEFAULT_NODATA: dict[str, Any] = {
    "uint8": 255,
    "uint16": 65535,
    "int16": -32768,
    "uint32": 4294967295,
    "int32": -2147483648,
    "uint64": 18446744073709551615,
    "int64": -9223372036854775808,
    "int8": -128,
}


class TileOutsideBoundsError(Exception):
    """The requested tile does not overlap the cube (HTTP 404, as rio-tiler)."""


@dataclass
class TileQuery:
    """What one tile request asks for (the MD tiler's query parameters)."""

    variable: str
    time_idx: int | None = None
    mask_variable: str | None = None
    mask_min_value: float = 0.1
    layer_masks: str | None = None
    ref_time_idx: int | None = None
    rescale: list[tuple[float, float]] = field(default_factory=list)
    colormap_name: str | None = None
    algorithm: str | None = None
    algorithm_params: dict = field(default_factory=dict)


# --- algorithms (bowser.titiler) -------------------------------------------------


def _shift(
    arr: np.ma.MaskedArray, shift: float | None = 0, nan_to_zero: bool = True, **_: Any
) -> np.ma.MaskedArray:
    value = np.nan_to_num(shift or 0) if nan_to_zero else shift
    return arr - value


def _rewrap(
    arr: np.ma.MaskedArray,
    scale_factor: float = 1.0,
    shift: float = 0.0,
    wrap_range: float = 2 * np.pi,
    **_: Any,
) -> np.ma.MaskedArray:
    data = arr
    if np.iscomplexobj(data):
        real = np.angle(data)
        mask = np.logical_or(
            getattr(data, "mask", False), np.logical_or(np.isnan(real), real == 0)
        )
        data = np.ma.MaskedArray(real, mask=mask)
    half = wrap_range / 2
    return np.ma.mod(half + scale_factor * (data - shift), wrap_range) - half


def _complex(
    func: Callable[[np.ndarray], np.ndarray],
) -> Callable[..., np.ma.MaskedArray]:
    def run(arr: np.ma.MaskedArray, **_: Any) -> np.ma.MaskedArray:
        data = func(arr.data)
        return np.ma.MaskedArray(data, mask=np.logical_or(np.isnan(data), data == 0))

    return run


ALGORITHMS: dict[str, Callable[..., np.ma.MaskedArray]] = {
    "shift": _shift,
    "rewrap": _rewrap,
    "phase": _complex(np.angle),
    "amplitude": _complex(np.abs),
}
#: Parameter names and types each algorithm accepts
#: (its pydantic fields in bowser.titiler).
_PARAM_TYPES: dict[str, dict[str, type]] = {
    "shift": {"shift": float, "nan_to_zero": bool},
    "rewrap": {"scale_factor": float, "shift": float, "wrap_range": float},
    "phase": {},
    "amplitude": {},
}


def parse_algorithm(name: str | None, params: str | None) -> tuple[str | None, dict]:
    """Validate ``algorithm`` / ``algorithm_params``.

    HTTP 422 for unknown names or bad JSON.
    """
    if name is None:
        return None, {}
    if name not in ALGORITHMS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"bowser-lite supports the algorithms {sorted(ALGORITHMS)}, "
                f"not {name!r}"
            ),
        )
    try:
        raw = json.loads(params) if params else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=422, detail=f"algorithm_params is not JSON: {exc}"
        ) from exc
    types = _PARAM_TYPES[name]
    out: dict = {}
    for key, value in raw.items():
        if key in types:
            out[key] = None if value is None else types[key](value)
    return name, out


def parse_rescale(values: list[str] | None) -> list[tuple[float, float]]:
    """``rescale=min,max`` query values as float pairs (titiler's parsing)."""
    out = []
    for r in values or []:
        parsed = tuple(
            float(v)
            for v in r.replace(" ", "").replace("[", "").replace("]", "").split(",")
        )
        if len(parsed) != 2:
            raise HTTPException(
                status_code=422, detail=f"Invalid rescale values: {values}"
            )
        out.append(parsed)
    return out  # type: ignore[return-value]


# --- source pixels ---------------------------------------------------------------


def _clamp(i: int, n: int) -> int:
    return max(0, min(i, n - 1))


def minus_reference_step(
    da: xr.DataArray, full: xr.DataArray, dim: str, ref_time_idx: int
) -> xr.DataArray:
    """Return ``da`` minus ``full`` at step ``ref_time_idx`` (clamped), per pixel.

    As ``bowser.main._minus_reference_step``: NaN where either is NaN, with
    ``da``'s attributes, encoding and coordinates kept.
    """
    ref = full.isel({dim: _clamp(ref_time_idx, full.sizes[dim])}, drop=True)
    with xr.set_options(keep_attrs=True):
        out = da - ref
    out.encoding = dict(da.encoding)
    return out


def tile_source(
    ds: xr.Dataset, q: TileQuery
) -> tuple[xr.DataArray, Callable[[xr.DataArray, Any], xr.DataArray]]:
    """Return the lazy variable for a tile and a function that masks any window of it.

    Mirrors ``bowser.main._build_masked_md_dataarray``: select ``time_idx``
    (clamped), subtract the step at ``ref_time_idx`` when given, keep pixels
    where ``mask_variable > mask_min_value``, then apply the layer masks from the
    same pyramid level.
    """
    if q.variable not in ds.variables:
        raise HTTPException(status_code=404, detail=f"Variable {q.variable} not found")
    da = ds[q.variable]
    mask_da = None
    if q.mask_variable is not None:
        if q.mask_variable not in ds.variables:
            raise HTTPException(
                status_code=404, detail=f"Mask variable {q.mask_variable} not found"
            )
        mask_da = ds[q.mask_variable]
    if q.time_idx is not None:
        dim = non_spatial_dim(da)
        if dim is not None:
            full = da
            da = da.isel({dim: _clamp(q.time_idx, da.sizes[dim])})
            if q.ref_time_idx is not None:
                da = minus_reference_step(da, full, dim, q.ref_time_idx)
        if mask_da is not None and (mdim := non_spatial_dim(mask_da)) is not None:
            mask_da = mask_da.isel({mdim: _clamp(q.time_idx, mask_da.sizes[mdim])})
    layer_masks = parse_layer_masks(q.layer_masks)

    def masked(
        window: xr.DataArray, select: Callable[[xr.DataArray], xr.DataArray]
    ) -> xr.DataArray:
        if mask_da is not None:
            window = window.where(select(mask_da) > q.mask_min_value)
        return apply_layer_masks(window, ds, layer_masks, q.time_idx, select)

    return da, masked


def _dst_nodata(da: xr.DataArray) -> Any:
    """Return the value the warp writes where it has no source pixel (as rioxarray)."""
    if np.issubdtype(da.dtype, np.floating) or np.issubdtype(
        da.dtype, np.complexfloating
    ):
        nodata = np.nan
    else:
        nodata = None
    attrs = da.attrs
    explicit = attrs.get(
        "_FillValue",
        attrs.get("missing_value", attrs.get("fill_value", attrs.get("nodata"))),
    )
    if da.encoding.get("_FillValue") is None and explicit is not None:
        return explicit
    if nodata is None:
        nodata = _DEFAULT_NODATA.get(da.dtype.name)
    return nodata


def source_pixels(
    cube: Cube,
    tile: tuple[int, int, int],
    tilesize: int,
    grid: tuple[float, float, float, float],
    shape: tuple[int, int],
    pixel_bits: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Source ``(col, row)`` of each tile pixel and whether it has one.

    Picked as GDAL's warp picks them.

    ``grid`` is the source ``(left, top, res_x, res_y)``, ``shape`` its ``(ny, nx)``.
    The source is first clipped to the tile (rioxarray's ``clip_box``); the tile is
    warped in GDAL's chunks, each row through the approximate transformer, and a
    pixel takes the source pixel containing its centre (``nearest``) if that lies
    in its chunk's source window.
    """
    x, y, z = tile
    left, bottom, right, top = geo.tile_bounds(x, y, z)
    step_x, step_y = (right - left) / tilesize, (top - bottom) / tilesize
    src_left, src_top, res_x, res_y = grid
    to_crs = (
        None
        if cube.crs == geo.WEB_MERCATOR
        else geo.transformer(geo.WEB_MERCATOR, cube.crs)
    )
    clip_bounds = (
        (left, bottom, right, top)
        if to_crs is None
        else geo.transform_bounds(
            geo.WEB_MERCATOR, cube.crs, (left, bottom, right, top)
        )
    )
    c0, c1, r0, r1 = warp.clip_window(clip_bounds, grid, shape)

    def to_source(px: np.ndarray, py: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Tile pixel coordinates to pixel coordinates in the clipped source."""
        mx, my = left + px * step_x, top - py * step_y
        if to_crs is not None:
            mx, my = to_crs.transform(mx, my)
        with np.errstate(invalid="ignore"):
            return (np.asarray(mx) - src_left) / res_x - c0, (
                np.asarray(my) - src_top
            ) / res_y - r0

    col = np.zeros((tilesize, tilesize), dtype=np.intp)
    row = np.zeros((tilesize, tilesize), dtype=np.intp)
    inside = np.zeros((tilesize, tilesize), dtype=bool)
    if c1 <= c0 or r1 <= r0:
        return col, row, inside
    for ch in warp.chunks(
        to_source, tilesize, tilesize, (r1 - r0, c1 - c0), pixel_bits, pixel_bits
    ):
        if ch.src_x1 <= ch.src_x0 or ch.src_y1 <= ch.src_y0:
            continue
        sx, sy = warp.approx_rows(
            to_source, ch.width, ch.height, x_off=ch.x_off, y_off=ch.y_off
        )
        with np.errstate(invalid="ignore"):
            # GDAL nearest: the source pixel that contains the (transformed) centre.
            cx = np.floor(sx + 1e-10)
            cy = np.floor(sy + 1e-10)
            ok = (
                np.isfinite(cx)
                & np.isfinite(cy)
                & (cx >= ch.src_x0)
                & (cx < ch.src_x1)
                & (cy >= ch.src_y0)
                & (cy < ch.src_y1)
            )
        block = (
            slice(ch.y_off, ch.y_off + ch.height),
            slice(ch.x_off, ch.x_off + ch.width),
        )
        col[block] = np.where(ok, cx, 0).astype(np.intp) + c0
        row[block] = np.where(ok, cy, 0).astype(np.intp) + r0
        inside[block] = ok
    return col, row, inside


def sample_tile(
    cube: Cube,
    ds: xr.Dataset,
    q: TileQuery,
    x: int,
    y: int,
    z: int,
    tilesize: int = TILE_SIZE,
) -> np.ma.MaskedArray:
    """Return the ``(1, tilesize, tilesize)`` masked source values for one tile."""
    da, masked = tile_source(ds, q)
    if da.ndim != 2:
        raise HTTPException(
            status_code=400,
            detail=f"{q.variable} has more than one band: give time_idx",
        )
    if not geo.tile_intersects(x, y, z, cube.crs, cube.bounds(da)):
        raise TileOutsideBoundsError(f"Tile(x={x}, y={y}, z={z}) is outside bounds")
    xs = np.asarray(da["x"].values, dtype=float)
    ys = np.asarray(da["y"].values, dtype=float)
    # The warp's source affine comes from the coordinates (rioxarray recalc=True).
    res_x = (
        (xs[-1] - xs[0]) / (xs.size - 1)
        if xs.size > 1
        else geo.grid_resolution(xs, ys, spatial_ref_attrs(da))[0]
    )
    res_y = (
        (ys[-1] - ys[0]) / (ys.size - 1)
        if ys.size > 1
        else geo.grid_resolution(xs, ys, spatial_ref_attrs(da))[1]
    )
    left, top = xs[0] - res_x / 2.0, ys[0] - res_y / 2.0

    bits = da.dtype.itemsize * 8 + 1  # data + a nodata validity bit, as GDAL counts it
    col, row, inside = source_pixels(
        cube, (x, y, z), tilesize, (left, top, res_x, res_y), (ys.size, xs.size), bits
    )

    window = da.isel(y=slice(0, 0), x=slice(0, 0))
    r0 = c0 = 0
    if inside.any():
        col_i = col[inside]
        row_i = row[inside]
        r0, r1 = int(row_i.min()), int(row_i.max()) + 1
        c0, c1 = int(col_i.min()), int(col_i.max()) + 1
        win_sel = {"y": slice(r0, r1), "x": slice(c0, c1)}
        window = masked(da.isel(win_sel).load(), lambda a: a.isel(win_sel).load())

    nodata = _dst_nodata(window)
    values = np.asarray(window.values)
    out = np.zeros((tilesize, tilesize), dtype=values.dtype)
    if nodata is not None:
        out[~inside] = nodata
    if inside.any():
        out[inside] = values[row_i - r0, col_i - c0]
    mask = ~inside | _isnull(out)
    if nodata is not None and not _isnan(nodata):
        mask |= out == nodata
    return np.ma.MaskedArray(out[np.newaxis], mask=mask[np.newaxis])


def _isnull(a: np.ndarray) -> np.ndarray:
    if np.issubdtype(a.dtype, np.floating) or np.issubdtype(
        a.dtype, np.complexfloating
    ):
        return np.isnan(a)
    return np.zeros(a.shape, dtype=bool)


def _isnan(v: Any) -> bool:
    try:
        return bool(np.isnan(v))
    except TypeError:
        return False


# --- rendering ---------------------------------------------------------------------


def linear_rescale(
    image: np.ndarray,
    in_range: tuple[float, float],
    out_range: tuple[float, float] = (0, 255),
) -> np.ndarray:
    """As rio-tiler's ``linear_rescale``: clip to ``in_range``, map to ``out_range``."""
    imin, imax = in_range
    omin, omax = out_range
    im = np.clip(image, imin, imax) - imin
    im = im / np.float64(imax - imin)
    return im * (omax - omin) + omin


def rescale(
    arr: np.ma.MaskedArray, in_range: list[tuple[float, float]]
) -> np.ma.MaskedArray:
    """As rio-tiler's ``rescale_image``: per band, masked pixels to 0, cast to uint8."""
    arr = arr.copy()
    if len(in_range) != arr.shape[0]:
        in_range = [in_range[0]] * arr.shape[0]
    mask = np.ma.getmaskarray(arr)
    with np.errstate(invalid="ignore", divide="ignore"):
        for b in range(arr.shape[0]):
            arr.data[b] = np.where(
                ~mask[b], linear_rescale(arr.data[b], in_range[b]), 0
            )
        return arr.astype("uint8")


def _to_uint8(
    arr: np.ma.MaskedArray, stats: tuple[float, float] | None
) -> np.ma.MaskedArray:
    """Stretch data that is not uint8 after rendering over its dtype or valid range."""
    if arr.dtype == np.uint8:
        return arr
    if stats is None:
        info = (
            np.finfo(arr.dtype)
            if np.issubdtype(arr.dtype, np.floating)
            else np.iinfo(arr.dtype)
        )
        stats = (float(info.min), float(info.max))
    return rescale(arr, [stats])


def render_png(
    arr: np.ma.MaskedArray, q: TileQuery, stats: tuple[float, float] | None = None
) -> bytes:
    """Run the algorithm, rescale and colormap; encode as an RGBA PNG."""
    if q.algorithm is not None:
        arr = ALGORITHMS[q.algorithm](arr, **q.algorithm_params)
        arr = np.ma.MaskedArray(arr.data, mask=np.ma.getmaskarray(arr))
    if q.rescale:
        arr = rescale(arr, q.rescale)
    arr = _to_uint8(arr, stats)
    alpha = (~np.ma.getmaskarray(arr)).any(axis=0).astype(np.uint8) * np.uint8(255)
    band = np.asarray(arr.data[0], dtype=np.uint8)
    rgba = np.empty(band.shape + (4,), dtype=np.uint8)
    if q.colormap_name:
        lut = colormaps.get_lut(q.colormap_name)
        rgba[...] = lut[band]
        rgba[..., 3] = np.bitwise_and(rgba[..., 3], alpha)
    else:
        rgba[..., :3] = band[..., np.newaxis]
        rgba[..., 3] = alpha
    return encode_rgba(rgba)


def valid_range(da: xr.DataArray) -> tuple[float, float] | None:
    """``(valid_min, valid_max)`` from a variable's attrs, as rio-tiler passes them."""
    lo, hi = da.attrs.get("valid_min"), da.attrs.get("valid_max")
    return (float(lo), float(hi)) if lo is not None and hi is not None else None


def render_tile(
    cube: Cube, q: TileQuery, x: int, y: int, z: int, tilesize: int = TILE_SIZE
) -> bytes:
    """One PNG tile: pick the pyramid level for ``z``, sample, render."""
    ds = cube.dataset_for_tile_zoom(z)
    arr = sample_tile(cube, ds, q, x, y, z, tilesize)
    return render_png(arr, q, valid_range(ds[q.variable]))
