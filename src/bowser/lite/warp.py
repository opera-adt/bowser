"""Where each tile pixel falls in the source grid, computed the way GDAL's warper does.

GDAL (and so the full server, through rioxarray) does not transform every output
pixel exactly: its approximate transformer transforms the first, middle and last
pixel of each output row, and if a straight line between the ends misses the
middle by at most ``max_error`` source pixels, interpolates the whole row along
that line; otherwise it splits the row in two and repeats (``GDALApproxTransform``,
``max_error=0.125`` in rasterio's ``reproject``). Doing the same here makes lite
pick the same source pixel as GDAL even where the projection bends inside a tile.

GDAL also warps a tile in several blocks when a block's source would be mostly
outside the raster (tiles on the edge of a cube) or too large for its memory
limit; each block interpolates its own rows and reads only its own source window.
:func:`chunks` reproduces that split, and :func:`clip_window` the source subset
rioxarray hands GDAL (``clip_box``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np

#: rasterio's default approximate-transformer tolerance, in source pixels.
MAX_ERROR = 0.125

ToSource = Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]


def approx_rows(
    to_source: ToSource,
    n_cols: int,
    n_rows: int,
    max_error: float = MAX_ERROR,
    x_off: int = 0,
    y_off: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """Source pixel coordinates ``(col, row)`` of each output pixel centre.

    Each has shape ``(n_rows, n_cols)``.

    ``to_source(px, py)`` maps output pixel coordinates (``i + 0.5``) to source
    pixel coordinates exactly; it is called a few times per row, on batches. The
    block starts at output pixel ``(x_off, y_off)``.
    """
    px = x_off + np.arange(n_cols) + 0.5
    out_x = np.full((n_rows, n_cols), np.nan)
    out_y = np.full((n_rows, n_cols), np.nan)
    if n_cols <= 5:
        gx, gy = np.meshgrid(px, y_off + np.arange(n_rows) + 0.5)
        sx, sy = to_source(gx.ravel(), gy.ravel())
        return np.reshape(sx, gx.shape), np.reshape(sy, gy.shape)

    rows = np.arange(n_rows)
    to_block = to_source if y_off == 0 else (lambda gx, gy: to_source(gx, gy + y_off))
    # Each segment: row, first index, count, and the transformed start/middle/end.
    start = np.zeros(n_rows, dtype=np.intp)
    count = np.full(n_rows, n_cols, dtype=np.intp)
    idx = np.stack([start, start + (count - 1) // 2, start + count - 1], axis=1)
    tx, ty = _transform(to_block, px, rows, idx)
    seg = (rows, start, count, tx, ty)
    while seg[0].size:
        seg = _step(to_block, px, seg, out_x, out_y, max_error)
    return out_x, out_y


def _transform(
    to_source: ToSource, px: np.ndarray, rows: np.ndarray, idx: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Exactly transform the pixels ``idx`` (``(n, k)`` column indices) of ``rows``."""
    gx = px[idx]
    gy = np.repeat(rows[:, np.newaxis] + 0.5, idx.shape[1], axis=1)
    sx, sy = to_source(gx.ravel(), gy.ravel())
    return np.reshape(np.asarray(sx, dtype=float), idx.shape), np.reshape(
        np.asarray(sy, dtype=float), idx.shape
    )


def _step(
    to_source: ToSource,
    px: np.ndarray,
    seg: tuple,
    out_x: np.ndarray,
    out_y: np.ndarray,
    max_error: float,
) -> tuple:
    """Fill the segments a straight line fits; return the halves of the others."""
    rows, start, count, tx, ty = seg
    mid = start + (count - 1) // 2
    end = start + count - 1
    span = px[end] - px[start]
    with np.errstate(invalid="ignore", divide="ignore"):
        dx = (tx[:, 2] - tx[:, 0]) / span
        dy = (ty[:, 2] - ty[:, 0]) / span
        off = px[mid] - px[start]
        err = np.abs(tx[:, 0] + dx * off - tx[:, 1]) + np.abs(
            ty[:, 0] + dy * off - ty[:, 1]
        )
    small = count <= 5
    fits = ~small & (err <= max_error)
    for i in np.flatnonzero(fits):
        cols = np.arange(start[i], end[i] + 1)
        dist = px[cols] - px[start[i]]
        out_x[rows[i], cols] = tx[i, 0] + dx[i] * dist
        out_y[rows[i], cols] = ty[i, 0] + dy[i] * dist
    for i in np.flatnonzero(small):
        cols = np.arange(start[i], end[i] + 1)
        sx, sy = to_source(px[cols], np.full(cols.size, rows[i] + 0.5))
        out_x[rows[i], cols] = sx
        out_y[rows[i], cols] = sy
    split = ~small & ~fits  # includes NaN errors: split until exact
    if not split.any():
        return (rows[:0], start[:0], count[:0], tx[:0], ty[:0])
    r, s, n, m = rows[split], start[split], count[split], (count[split] - 1) // 2
    # First half: [s, s+m-1]; second half: [s+m, s+n-1] (its start is the old middle).
    need = np.stack([s + m - 1, s + (m - 1) // 2, s + m + (n - m - 1) // 2], axis=1)
    nx, ny = _transform(to_source, px, r, need)
    old_x, old_y = tx[split], ty[split]
    first = (
        r,
        s,
        m,
        np.stack([old_x[:, 0], nx[:, 1], nx[:, 0]], 1),
        np.stack([old_y[:, 0], ny[:, 1], ny[:, 0]], 1),
    )
    second = (
        r,
        s + m,
        n - m,
        np.stack([old_x[:, 1], nx[:, 2], old_x[:, 2]], 1),
        np.stack([old_y[:, 1], ny[:, 2], old_y[:, 2]], 1),
    )
    keep = first[2] > 0
    return tuple(np.concatenate([a[keep], b]) for a, b in zip(first, second))


# --- how GDAL splits a warp into chunks ---------------------------------------------

#: GDAL's default warp memory limit (bytes) and edge sample steps.
WARP_MEMORY_LIMIT = 64 * 1024 * 1024
_EDGE_STEPS = 21


@dataclass(frozen=True)
class Chunk:
    """An output block warped on its own, and the source window it may read."""

    x_off: int
    y_off: int
    width: int
    height: int
    src_x0: int
    src_x1: int
    src_y0: int
    src_y1: int


def clip_window(
    bounds: tuple[float, float, float, float],
    grid: tuple[float, float, float, float],
    shape: tuple[int, int],
    auto_expand: int = 1,
) -> tuple[int, int, int, int]:
    """Source ``(col0, col1, row0, row1)`` that ``clip_box`` keeps for ``bounds``.

    ``grid`` is ``(left, top, res_x, res_y)`` and ``shape`` ``(ny, nx)``. A window one
    pixel wide or less is grown by half a pixel per side, at most twice.
    """
    left, top, res_x, res_y = grid
    ny, nx = shape
    minx, miny, maxx, maxy = bounds
    x_lo, x_hi = (maxx, minx) if res_x < 0 else (minx, maxx)
    y_top, y_bottom = (maxy, miny) if res_y < 0 else (miny, maxy)
    cols = [(x - left) / res_x for x in (x_lo, x_hi)]
    rows = [(y - top) / res_y for y in (y_top, y_bottom)]
    c0, c1 = math.floor(max(min(cols), 0)), math.ceil(max(max(cols), 0))
    r0, r1 = math.floor(max(min(rows), 0)), math.ceil(max(max(rows), 0))
    c1, r1 = min(c1, nx), min(r1, ny)
    c0, r0 = min(c0, c1), min(r0, r1)
    if (c1 - c0 <= 1 or r1 - r0 <= 1) and auto_expand < 3:
        hx, hy = abs(res_x) / 2, abs(res_y) / 2
        return clip_window(
            (minx - hx, miny - hy, maxx + hx, maxy + hy), grid, shape, auto_expand + 1
        )
    return c0, c1, r0, r1


def _source_extent(
    to_source: ToSource, x_off: int, y_off: int, w: int, h: int
) -> tuple[float, float, float, float, bool]:
    """Extent of a block's edges in source pixels.

    Sampled as GDAL's ``ComputeSourceWindow`` does.
    """
    steps = np.arange(_EDGE_STEPS + 1) / _EDGE_STEPS
    steps[-1] = 1.0
    n = steps.size
    px = np.concatenate(
        [
            x_off + steps * w,
            x_off + steps * w,
            np.full(n, float(x_off)),
            np.full(n, float(x_off + w)),
        ]
    )
    py = np.concatenate(
        [
            np.full(n, float(y_off)),
            np.full(n, float(y_off + h)),
            y_off + steps * h,
            y_off + steps * h,
        ]
    )
    sx, sy = to_source(px, py)
    sx, sy = np.asarray(sx, dtype=float), np.asarray(sy, dtype=float)
    ok = np.isfinite(sx) & np.isfinite(sy)
    if not ok.any():
        return math.inf, math.inf, -math.inf, -math.inf, True
    return (
        float(sx[ok].min()),
        float(sy[ok].min()),
        float(sx[ok].max()),
        float(sy[ok].max()),
        not ok.all(),
    )


def chunks(
    to_source: ToSource,
    width: int,
    height: int,
    src_shape: tuple[int, int],
    src_bits: int,
    dst_bits: int,
) -> list[Chunk]:
    """Return the output blocks GDAL warps separately (``CollectChunkList``).

    A block is halved along its longer side while its source window would exceed
    the warp memory limit, or while less than half of the source extent its
    edges map to lies inside the source raster (``SRC_FILL_RATIO_HEURISTICS``).
    """
    src_h, src_w = src_shape
    out: list[Chunk] = []

    def collect(x_off: int, y_off: int, w: int, h: int) -> None:
        minx, miny, maxx, maxy, failed = _source_extent(to_source, x_off, y_off, w, h)
        pad = 10 if failed else 0
        if minx > src_w or maxx < 0 or miny > src_h or maxy < 0:
            x0 = x1 = y0 = y1 = 0
            fill = 0.0
        else:
            x0 = max(0, math.floor(minx) - pad)
            y0 = max(0, math.floor(miny) - pad)
            x1 = min(src_w, math.ceil(maxx) + pad)
            y1 = min(src_h, math.ceil(maxy) + pad)
            raw_w = max(0.0, min(float(src_w - x0), min(maxx, src_w) - max(minx, 0.0)))
            raw_h = max(0.0, min(float(src_h - y0), min(maxy, src_h) - max(miny, 0.0)))
            fill = raw_w * raw_h / max(1.0, (maxx - minx) * (maxy - miny))
        memory = (src_bits * (x1 - x0) * (y1 - y0) + dst_bits * w * h) / 8.0
        too_big = memory > WARP_MEMORY_LIMIT and (w > 2 or h > 2)
        sparse = 0 < fill < 0.5 and (w > 100 or h > 100)
        if too_big or sparse:
            if w > h:
                half = w // 2
                collect(x_off, y_off, half, h)
                collect(x_off + half, y_off, w - half, h)
            else:
                half = h // 2
                collect(x_off, y_off, w, half)
                collect(x_off, y_off + half, w, h - half)
            return
        out.append(Chunk(x_off, y_off, w, h, x0, x1, y0, y1))

    collect(0, 0, width, height)
    return out
