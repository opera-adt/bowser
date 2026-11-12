"""Polygon statistics without GDAL: the pixels of ``POST /polygon_timeseries``.

The full server (``bowser.polygon``) reprojects the polygon with rasterio,
checks it with shapely and burns it with GDAL (``all_touched=False``). Here the
same three steps use pyproj and numpy; the request model, the statistics and
the response are the full server's own code.

A pixel is selected when its centre is inside the polygon (even-odd over all
rings, so holes are excluded). :func:`rasterize` follows GDAL's scanline fill
(``GDALdllImageFilledPolygon``), so both servers select the same pixels.

A centre exactly on an edge (a tie) is decided by GDAL's rule with the rounding
of GDAL built for Linux x86-64. The arithmetic here is plain IEEE double
operations in numpy, one at a time, so the answer for given vertices is the
same on every platform. GDAL's own answer for a tie is not: its arm64 builds
(macOS) round the pixel coordinates differently (fused multiply-add), so there
the full server can differ from lite, in tie pixels only.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import xarray as xr
from pyproj import CRS, Transformer

from .. import polygon as _full
from ..polygon import MAX_PIXEL_EPOCHS, MAX_WINDOW_PIXELS, NativeGrid
from ..polygon_masks import xarray_masks

#: Segment pairs tested per block by :func:`is_valid` (bounds its memory).
_PAIR_BLOCK = 2_000_000
#: Scanline-edge pairs tested per block by :func:`rasterize`.
_SCAN_BLOCK = 4_000_000
#: Values read from the cube per block (time steps x window pixels).
_READ_BLOCK = 16_000_000

Rings = list[list[np.ndarray]]


def rings_of(geometry: dict[str, Any]) -> Rings:
    """Return ``[[exterior, hole, ...], ...]`` as ``(n, 2)`` float arrays."""
    polygons = (
        [geometry["coordinates"]]
        if geometry["type"] == "Polygon"
        else geometry["coordinates"]
    )
    return [[np.asarray(ring, dtype=float) for ring in polygon] for polygon in polygons]


def _cross(o: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Return twice the signed area of the triangles ``o, a, b`` (broadcast)."""
    return (a[..., 0] - o[..., 0]) * (b[..., 1] - o[..., 1]) - (
        a[..., 1] - o[..., 1]
    ) * (b[..., 0] - o[..., 0])


def _area2(ring: np.ndarray) -> float:
    """Return twice the signed area of a closed ring (positive: counter-clockwise)."""
    x, y = ring[:, 0] - ring[0, 0], ring[:, 1] - ring[0, 1]
    return float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]))


def _within(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Whether ``p`` is in the bounding box of the segments ``a``-``b``."""
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    return ((p >= lo) & (p <= hi)).all(axis=-1)


def _locate(point: np.ndarray, ring: np.ndarray) -> int:
    """Return 1 if ``point`` is inside the closed ``ring``, 0 on it, -1 outside."""
    a, b = ring[:-1], ring[1:]
    on_edge = (_cross(a, b, point) == 0) & _within(point, a, b)
    if on_edge.any():
        return 0
    x, y = point
    spans = (a[:, 1] > y) != (b[:, 1] > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        at = a[:, 0] + (y - a[:, 1]) * (b[:, 0] - a[:, 0]) / (b[:, 1] - a[:, 1])
    return 1 if np.count_nonzero(spans & (x < at)) % 2 else -1


def _interior_point(ring: np.ndarray, other: np.ndarray) -> np.ndarray | None:
    """Return a point of ``ring`` that is not on ``other``, or None."""
    for p in (*ring[:-1], *((ring[:-1] + ring[1:]) / 2)):
        if _locate(p, other) != 0:
            return p
    return None


def _in_polygon(point: np.ndarray, polygon: list[np.ndarray]) -> bool:
    """Whether ``point`` is strictly inside ``polygon`` (holes excluded)."""
    if _locate(point, polygon[0]) != 1:
        return False
    return all(_locate(point, hole) == -1 for hole in polygon[1:])


def _segments_cross(polygons: Rings) -> bool:
    """Whether any two segments meet where a valid polygon's may not.

    Within one ring, only neighbouring segments may touch (at their shared
    vertex, without folding back). Segments of different rings may touch at
    points but not cross or run along each other, and two rings of one polygon
    may touch at one point only (two would cut its interior in two).
    """
    start, end, ring_id, part_id, index, length = [], [], [], [], [], []
    n_rings = 0
    for part, polygon in enumerate(polygons):
        for ring in polygon:
            m = len(ring) - 1
            start.append(ring[:-1])
            end.append(ring[1:])
            ring_id.append(np.full(m, n_rings))
            part_id.append(np.full(m, part))
            index.append(np.arange(m))
            length.append(np.full(m, m))
            n_rings += 1
    a, b = np.concatenate(start), np.concatenate(end)
    rid, pid, idx, size = (np.concatenate(v) for v in (ring_id, part_id, index, length))
    touches: dict[tuple[int, ...], set[tuple[float, float]]] = {}
    n = len(a)
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    # Only segments whose boxes meet can meet. Sorted by their left end, the
    # ones that can meet segment k in x are a run right after it.
    order = np.argsort(lo[:, 0], kind="stable")
    run_end = np.searchsorted(lo[order, 0], hi[order, 0], side="right")
    counts = run_end - np.arange(1, n + 1)
    ends = np.cumsum(counts)
    k0 = 0
    while k0 < n:
        done = ends[k0 - 1] if k0 else 0
        k1 = max(k0 + 1, int(np.searchsorted(ends, done + _PAIR_BLOCK, side="right")))
        first = np.repeat(np.arange(k0, k1), counts[k0:k1])
        starts = np.repeat(ends[k0:k1] - counts[k0:k1], counts[k0:k1])
        second = first + 1 + np.arange(done, done + first.size) - starts
        k0 = k1
        i, j = order[first], order[second]
        near = (lo[i, 1] <= hi[j, 1]) & (lo[j, 1] <= hi[i, 1])
        i, j = i[near], j[near]
        a1, b1, a2, b2 = a[i], b[i], a[j], b[j]
        o1, o2 = _cross(a1, b1, a2), _cross(a1, b1, b2)
        o3, o4 = _cross(a2, b2, a1), _cross(a2, b2, b1)
        proper = (o1 * o2 < 0) & (o3 * o4 < 0)
        at = [
            ((o1 == 0) & _within(a2, a1, b1), a2),
            ((o2 == 0) & _within(b2, a1, b1), b2),
            ((o3 == 0) & _within(a1, a2, b2), a1),
            ((o4 == 0) & _within(b1, a2, b2), b1),
        ]
        touch = at[0][0] | at[1][0] | at[2][0] | at[3][0]
        collinear = (o1 == 0) & (o2 == 0) & (o3 == 0) & (o4 == 0)
        # Collinear segments overlap along a length when their boxes do.
        low = np.maximum(lo[i], lo[j])
        high = np.minimum(hi[i], hi[j])
        overlap = collinear & (low < high).any(axis=-1)
        same = rid[i] == rid[j]
        gap = np.abs(idx[i] - idx[j])
        neighbours = same & ((gap == 1) | (gap == size[i] - 1))
        bad = np.where(
            neighbours, overlap, np.where(same, proper | touch, proper | overlap)
        )
        if bad.any():
            return True
        for on, points in at:
            for k in np.flatnonzero(on & ~same & (pid[i] == pid[j])):
                pair = tuple(sorted((int(rid[i[k]]), int(rid[j[k]]))))
                seen = touches.setdefault(pair, set())
                seen.add((float(points[k, 0]), float(points[k, 1])))
                if len(seen) > 1:
                    return True
    return False


def is_valid(polygons: Rings) -> bool:
    """Whether the rings form a nonempty, valid polygon or multipolygon.

    The OGC rules shapely's ``is_valid`` applies: rings do not cross or touch
    themselves, holes lie inside their exterior and outside each other, and the
    parts of a multipolygon do not overlap. Rings may touch at a point. One
    rule is not checked: an interior cut in two by a chain of three or more
    rings that touch one another.
    """
    cleaned: Rings = []
    for polygon in polygons:
        rings = []
        for ring in polygon:
            if not np.isfinite(ring).all():
                return False
            keep = np.ones(len(ring), dtype=bool)
            keep[1:] = (np.diff(ring, axis=0) != 0).any(axis=1)
            ring = ring[keep]
            if len(ring) < 4 or _area2(ring) == 0:
                return False
            rings.append(ring)
        cleaned.append(rings)
    if _segments_cross(cleaned):
        return False
    for polygon in cleaned:
        shell, holes = polygon[0], polygon[1:]
        for k, hole in enumerate(holes):
            p = _interior_point(hole, shell)
            if p is None or _locate(p, shell) != 1:
                return False
            for other in holes[:k] + holes[k + 1 :]:
                q = _interior_point(hole, other)
                if q is None or _locate(q, other) == 1:
                    return False
    for k, polygon in enumerate(cleaned):
        for other in cleaned[:k] + cleaned[k + 1 :]:
            p = _interior_point(polygon[0], other[0])
            if p is None or _in_polygon(p, other):
                return False
    return True


class PolygonRequest(_full.PolygonRequest):  # noqa: D101
    # The full server's request (and its description in the API schema), with
    # the topology check done in numpy.
    __doc__ = _full.PolygonRequest.__doc__

    @classmethod
    def _topologically_valid(cls, geometry: dict[str, Any]) -> bool:
        return is_valid(rings_of(geometry))


def rasterize(
    polygons: Rings,
    shape: tuple[int, int],
    origin: tuple[float, float],
    resolution: tuple[float, float],
) -> np.ndarray:
    """Burn polygons on a north-up grid: True where a pixel centre is inside.

    Parameters
    ----------
    polygons : list of list of numpy.ndarray
        Rings in the grid's CRS (:func:`rings_of`); all rings are filled
        together with the even-odd rule.
    shape : tuple of int
        ``(height, width)`` of the grid.
    origin : tuple of float
        ``(x, y)`` of the outer corner of the first pixel.
    resolution : tuple of float
        Signed pixel size ``(res_x, res_y)``.

    Returns
    -------
    numpy.ndarray
        Boolean ``(height, width)``, as ``rasterio.features.geometry_mask(...,
        invert=True, all_touched=False)``: a centre between the rounded
        crossings ``floor(x + 0.5)`` of its row is inside.

    """
    height, width = shape
    out = np.zeros(shape, dtype=bool)
    # GDAL's inverse geotransform, then pixel = origin + coordinate * scale.
    x0, y0 = -origin[0] / resolution[0], -origin[1] / resolution[1]
    sx, sy = 1.0 / resolution[0], 1.0 / resolution[1]
    px1, py1, px2, py2 = [], [], [], []
    for polygon in polygons:
        for ring in polygon:
            # GDAL walks every ring clockwise (in the CRS), which decides the
            # horizontal edges below.
            if _area2(ring) > 0:
                ring = ring[::-1]
            px, py = x0 + ring[:, 0] * sx, y0 + ring[:, 1] * sy
            # Each vertex with the one before it; the first with the last.
            px1.append(np.roll(px, 1))
            py1.append(np.roll(py, 1))
            px2.append(px)
            py2.append(py)
    ax, ay, bx, by = (np.concatenate(v) for v in (px1, py1, px2, py2))
    first = max(int(min(ay.min(), by.min())), 0)
    last = min(int(max(ay.max(), by.max())), height - 1)
    if last < first:
        return out
    # Order each edge by row, so a crossing belongs to rows in [low, high).
    up = ay < by
    lo_y, hi_y = np.where(up, ay, by), np.where(up, by, ay)
    lo_x, hi_x = np.where(up, ax, bx), np.where(up, bx, ax)
    sloped = ay != by
    step = max(1, _SCAN_BLOCK // len(ax))
    for r0 in range(first, last + 1, step):
        rows = np.arange(r0, min(r0 + step, last + 1))
        dy = (rows + 0.5)[:, None]
        hit = sloped & (dy >= lo_y) & (dy < hi_y)
        r, e = np.nonzero(hit)
        at = (dy[r, 0] - lo_y[e]) * (hi_x[e] - lo_x[e]) / (hi_y[e] - lo_y[e]) + lo_x[e]
        col = np.clip(np.floor(at + 0.5), 0, width).astype(np.int64)
        # A centre is inside when an odd number of crossings lie at or before it.
        toggles = np.zeros((len(rows), width + 1), dtype=np.int32)
        np.add.at(toggles, (r, col), 1)
        out[rows] = (np.cumsum(toggles[:, :width], axis=1) & 1).astype(bool)
        # A horizontal edge through a row of centres, drawn right to left, is
        # filled on its own (GDAL keeps these bottom edges, skips the others).
        flat = ~sloped & (dy == ay) & (ax > bx)
        for r, e in zip(*np.nonzero(flat)):
            c0 = int(np.clip(np.floor(bx[e] + 0.5), 0, width))
            c1 = int(np.clip(np.floor(ax[e] + 0.5), 0, width))
            out[rows[r], c0:c1] = True
    return out


def _window(
    polygons: Rings, grid: NativeGrid
) -> tuple[tuple[int, int, int, int], bool] | None:
    """Return the polygon's pixel window on the grid and whether it was clipped.

    ``(col_off, row_off, width, height)``: the bounding box rounded outward, as
    ``rasterio.features.geometry_window``, cut to the grid. None when it misses.
    """
    a, _, c, _, e, f = list(grid.transform)[:6]
    points = np.concatenate([ring for polygon in polygons for ring in polygon])
    left, bottom = points.min(axis=0)
    right, top = points.max(axis=0)
    # Pixel coordinates of the box's corners, with the arithmetic of
    # :func:`rasterize` (plain IEEE operations, the same on every platform).
    cols = [-c / a + x * (1.0 / a) for x in (left, right)]
    rows = [-f / e + y * (1.0 / e) for y in (top, bottom)]
    col_start, row_start = min(cols), min(rows)
    col_off, row_off = math.floor(col_start), math.floor(row_start)
    col_stop = math.ceil(col_start + max(max(cols) - col_start, 0.0))
    row_stop = math.ceil(row_start + max(max(rows) - row_start, 0.0))
    full = (col_off, row_off, col_stop - col_off, row_stop - row_off)
    c0, r0 = max(col_off, 0), max(row_off, 0)
    c1, r1 = min(col_stop, grid.width), min(row_stop, grid.height)
    if c0 >= c1 or r0 >= r1:
        return None
    window = (c0, r0, c1 - c0, r1 - r0)
    return window, full != window


def selection(
    grid: NativeGrid, geometry: dict[str, Any], count: int
) -> tuple[tuple[int, int, int, int], np.ndarray, bool]:
    """Select the grid's pixel centres inside a lon/lat polygon.

    As ``bowser.polygon._selection``: the same window, limits and messages.

    Returns
    -------
    window : tuple of int
        ``(col_off, row_off, width, height)`` holding every selected pixel.
    inside : numpy.ndarray
        Boolean ``(height, width)`` of the window.
    clipped : bool
        Whether the polygon reaches beyond the grid.

    """
    if grid.crs is None:
        raise ValueError("A source CRS is required")
    to_native = Transformer.from_crs(4326, grid.crs, always_xy=True)
    polygons = [
        [np.column_stack(to_native.transform(ring[:, 0], ring[:, 1])) for ring in rings]
        for rings in rings_of(geometry)
    ]
    if not is_valid(polygons):
        raise ValueError("Polygon is not valid in the source CRS")
    found = _window(polygons, grid)
    if found is None:
        raise ValueError("Polygon does not intersect the source grid")
    (col_off, row_off, width, height), clipped = found
    pixels = width * height
    if count < 1 or pixels > MAX_WINDOW_PIXELS or pixels * count > MAX_PIXEL_EPOCHS:
        raise ValueError("Polygon exceeds the bounded native pixel-epoch budget")
    a, _, c, _, e, f = list(grid.transform)[:6]
    inside = rasterize(
        polygons, (height, width), (a * col_off + c, e * row_off + f), (a, e)
    )
    rows = np.flatnonzero(inside.any(axis=1))
    cols = np.flatnonzero(inside.any(axis=0))
    if rows.size == 0:
        raise ValueError("No native pixel centers lie inside the polygon")
    tight = (
        col_off + int(cols[0]),
        row_off + int(rows[0]),
        int(cols[-1] - cols[0]) + 1,
        int(rows[-1] - rows[0]) + 1,
    )
    return tight, inside[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1], clipped


def crs_name(crs: CRS) -> str:
    """``EPSG:<code>`` when the CRS has one, else its WKT (as rasterio prints it)."""
    code = crs.to_epsg()
    return f"EPSG:{code}" if code else crs.to_wkt()


def summarize_cube(
    source: xr.DataArray,
    crs: CRS,
    request: _full.PolygonRequest,
    labels: list[str],
    *,
    mask_dataset: xr.Dataset | None = None,
) -> dict:
    """Summarize a level-zero GeoZarr variable inside the request's polygon.

    The lite counterpart of ``bowser.polygon.summarize_xarray``: same checks,
    statistics and response. Only the polygon's window is read, a block of time
    steps at a time (whole chunks along the time axis when they fit).
    """
    if not {"x", "y"}.issubset(source.dims):
        raise ValueError("Source requires x/y spatial dimensions")
    if any(axis not in source.coords for axis in ("x", "y")):
        raise ValueError("Source requires explicit x/y pixel-center coordinates")
    extra = [d for d in source.dims if d not in ("x", "y")]
    if len(extra) > 1:
        raise ValueError("Source supports at most one non-spatial axis")
    x, y = np.asarray(source.x.values), np.asarray(source.y.values)
    for axis in (x, y):
        delta = np.diff(axis)
        if (
            len(delta) < 1
            or not np.isfinite(axis).all()
            or delta[0] == 0
            or not np.allclose(delta, delta[0], rtol=1e-7, atol=1e-8)
        ):
            raise ValueError("Source requires regular finite x/y pixel centers")
    # The grid as north-up (x increasing, y decreasing), whatever the storage
    # order; a window is mapped back to the stored order when it is read.
    flip_x, flip_y = bool(x[0] > x[-1]), bool(y[0] < y[-1])
    x = x[::-1] if flip_x else x
    y = y[::-1] if flip_y else y
    units = source.attrs.get("units") or None
    _full._linear(source.dtype, units)
    dim = extra[0] if extra else None
    count = source.sizes[dim] if dim else 1
    res_x = (float(x[-1]) - float(x[0])) / (x.size - 1)
    res_y = (float(y[-1]) - float(y[0])) / (y.size - 1)
    grid = NativeGrid(
        crs_name(crs),
        (res_x, 0.0, float(x[0]) - res_x / 2.0, 0.0, res_y, float(y[0]) - res_y / 2.0),
        x.size,
        y.size,
    )
    masks = xarray_masks(source, mask_dataset, request, crs)
    (col_off, row_off, width, height), inside, clipped = selection(
        grid, request.geometry, count * (1 + len(request.layer_masks))
    )
    cols = (
        slice(x.size - col_off - width, x.size - col_off)
        if flip_x
        else slice(col_off, col_off + width)
    )
    rows = (
        slice(y.size - row_off - height, y.size - row_off)
        if flip_y
        else slice(row_off, row_off + height)
    )
    subset = source.isel(y=rows, x=cols)
    order = ([dim] if dim else []) + ["y", "x"]
    chunk = 1
    if dim:
        stored = source.encoding.get("preferred_chunks", {}).get(dim) or 1
        chunk = max(1, min(int(stored), _READ_BLOCK // (width * height)))
    block: dict[str, Any] = {"start": -1, "values": None}

    def load(index: int) -> np.ndarray:
        start = index - index % chunk
        if block["start"] != start:
            part = subset.isel({dim: slice(start, start + chunk)}) if dim else subset
            values = np.asarray(part.transpose(*order).values)
            values = values[..., ::-1, :] if flip_y else values
            values = values[..., ::-1] if flip_x else values
            # Keep the selected pixels only: ``(steps, n_inside)``.
            block.update(start=start, values=values.reshape(-1, height, width))
            block["values"] = block["values"][:, inside]
        # Mask reads use the same canonical north-up window as the polygon.
        # Apply before selecting polygon pixels, retaining the original read block.
        values = _full._values(block["values"][index - start], source.attrs)
        if not masks.readers:
            return values
        keep = masks.valid(
            index,
            slice(row_off, row_off + height),
            slice(col_off, col_off + width),
            (height, width),
        )
        return np.where(keep[inside], values, np.nan)

    return masks.finish(
        _full._result(load, count, inside, clipped, grid, labels, units, request)
    )
