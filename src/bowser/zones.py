"""Deformation zones: connected areas of a cube that move faster than a threshold.

Shared by the full server and bowser-lite (``GET /deformation_zones``), so both
give the same zones for the same cube. Only numpy and pyproj are needed (lite
has no GDAL, scipy or shapely): the grid is labelled into 4-connected areas
(scipy's ``ndimage.label`` when it is installed, else a breadth-first search
here, which finds the same areas), each area's outline is traced along its pixel
edges and simplified (Ramer-Douglas-Peucker), then projected to lon/lat.

The rate is the cube's 2-D velocity layer when it has one, otherwise a straight
line fitted through the displacement of every pixel; the result says which.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
from pyproj import CRS, Transformer

#: Most grid cells labelled; larger areas are averaged in blocks first.
MAX_CELLS = 1_000_000
#: Most values read for a fitted rate (dates x cells).
MAX_FIT_VALUES = 60_000_000
#: Outlines are simplified to this fraction of a cell.
SIMPLIFY_CELLS = 0.5
#: Most vertices in one ring after simplification (the tolerance grows to fit).
MAX_RING_VERTICES = 1_500
#: Holes smaller than this many cells are left out of the outlines.
MIN_HOLE_CELLS = 4
#: Layer names tried, in order, for a quality mask (``coherence_min``).
COHERENCE_LAYERS = (
    "median_temporal_coherence",
    "average_temporal_coherence",
    "temporal_coherence",
)

Sign = Literal["both", "negative", "positive"]

_METRES = {"m", "meter", "meters", "metre", "metres"}
_METRES_PER_YEAR = {"m/yr", "m/y", "m/year", "m yr-1", "m/a", "meters/year"}


class ZonesError(ValueError):
    """A request that cannot be answered, with a message for the user."""


@dataclass
class Grid:
    """A 2-D rate in mm/yr (or the layer's unit per year) on the cube's grid.

    ``rows`` and ``cols`` are the window of the cube read, ``k`` the size of
    the blocks averaged into one cell.
    """

    values: np.ndarray
    x: np.ndarray
    y: np.ndarray
    source: str
    unit: str
    rows: slice
    cols: slice
    k: int


def rate_factor(unit: str | None, per_year: bool) -> tuple[float, str]:
    """Return the factor and unit of a rate from a layer's unit.

    Metres (a displacement whose rate is fitted, ``per_year`` false) and metres
    per year become mm/yr; anything else is kept, per year.
    """
    u = (unit or "").strip().lower()
    if (u in _METRES and not per_year) or u in _METRES_PER_YEAR:
        return 1000.0, "mm/yr"
    if per_year:
        return 1.0, unit or "unknown unit"
    return 1.0, f"{unit or 'unknown unit'} per year"


def _non_spatial_dim(da: Any) -> str | None:
    others = [d for d in da.dims if d not in ("x", "y")]
    return others[0] if others else None


def _years(coord: Any) -> np.ndarray:
    """Decimal years of a time coordinate (datetime64, or ISO date strings)."""
    vals = np.asarray(coord)
    if np.issubdtype(vals.dtype, np.datetime64):
        days = vals.astype("datetime64[D]").astype("int64").astype(float)
    else:
        days = np.array(
            [np.datetime64(str(v)[:10], "D").astype("int64") for v in vals], float
        )
    return days / 365.25


def _window(
    x: np.ndarray,
    y: np.ndarray,
    to_xy: Transformer,
    bbox: tuple[float, float, float, float] | None,
) -> tuple[slice, slice]:
    """Return the row and column slices of the grid inside ``bbox`` (lon/lat)."""
    if bbox is None:
        return slice(0, len(y)), slice(0, len(x))
    west, south, east, north = bbox
    if not (west < east and south < north):
        raise ZonesError("bbox must be [west, south, east, north].")
    # Compare in lon/lat first: far from its zone a projection gives nonsense.
    to_ll = Transformer.from_crs(to_xy.target_crs, "EPSG:4326", always_xy=True)
    gx = np.concatenate([x, x, np.full(len(y), x[0]), np.full(len(y), x[-1])])
    gy = np.concatenate([np.full(len(x), y[0]), np.full(len(x), y[-1]), y, y])
    glon, glat = (np.asarray(v, dtype=float) for v in to_ll.transform(gx, gy))
    if (
        west > np.nanmax(glon)
        or east < np.nanmin(glon)
        or south > np.nanmax(glat)
        or north < np.nanmin(glat)
    ):
        raise ZonesError("The bbox does not overlap the cube.")
    west, east = max(west, float(np.nanmin(glon))), min(east, float(np.nanmax(glon)))
    south, north = (
        max(south, float(np.nanmin(glat))),
        min(north, float(np.nanmax(glat))),
    )
    t = np.linspace(0.0, 1.0, 21)
    lons = np.concatenate([west + (east - west) * t, np.full(21, east)])
    lons = np.concatenate([lons, east - (east - west) * t, np.full(21, west)])
    lats = np.concatenate([np.full(21, south), south + (north - south) * t])
    lats = np.concatenate([lats, np.full(21, north), north - (north - south) * t])
    xs, ys = (np.asarray(v, dtype=float) for v in to_xy.transform(lons, lats))
    ok = np.isfinite(xs) & np.isfinite(ys)
    if not ok.any():
        raise ZonesError("The bbox does not overlap the cube.")
    xs, ys = xs[ok], ys[ok]
    cols = np.nonzero((x >= xs.min()) & (x <= xs.max()))[0]
    rows = np.nonzero((y >= ys.min()) & (y <= ys.max()))[0]
    if not len(cols) or not len(rows):
        raise ZonesError("The bbox does not overlap the cube.")
    return slice(rows[0], rows[-1] + 1), slice(cols[0], cols[-1] + 1)


def _block_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Mean of ``k`` x ``k`` blocks of the last two axes, NaNs left out."""
    if k == 1:
        return a
    ny, nx = a.shape[-2] // k * k, a.shape[-1] // k * k
    a = a[..., :ny, :nx]
    shape = (*a.shape[:-2], ny // k, k, nx // k, k)
    blocks = a.reshape(shape)
    with np.errstate(invalid="ignore"):
        n = np.isfinite(blocks).sum(axis=(-3, -1))
        s = np.nansum(blocks, axis=(-3, -1))
        return np.where(n > 0, s / np.maximum(n, 1), np.nan)


def _centres(c: np.ndarray, k: int) -> np.ndarray:
    n = len(c) // k * k
    return c[:n].reshape(-1, k).mean(axis=1) if k > 1 else c


def read_rate(
    ds: Any,
    to_xy: Transformer,
    layer: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> Grid:
    """Read the rate for zones from an xarray dataset (level 0 of a cube).

    ``layer`` is a 2-D rate layer (default ``velocity``) or a layer with dates
    (default ``displacement``), whose straight-line rate is fitted per pixel.
    """
    names = list(ds.data_vars)
    if layer is not None and layer not in names:
        raise ZonesError(f"No layer {layer!r}. Layers: {', '.join(sorted(names))}.")
    if layer is None:
        if "velocity" in names and _non_spatial_dim(ds["velocity"]) is None:
            layer = "velocity"
        elif "displacement" in names:
            layer = "displacement"
        else:
            raise ZonesError(
                "The cube has no velocity layer and no displacement to fit a "
                "rate to; give `layer`."
            )
    da = ds[layer]
    if "x" not in da.dims or "y" not in da.dims:
        raise ZonesError(f"{layer!r} is not a map layer (no x/y).")
    x, y = np.asarray(ds["x"].values), np.asarray(ds["y"].values)
    rows, cols = _window(x, y, to_xy, bbox)
    x, y = x[cols], y[rows]
    k = max(1, math.ceil(math.sqrt(len(x) * len(y) / MAX_CELLS)))
    dim = _non_spatial_dim(da)
    factor, unit = rate_factor(
        da.attrs.get("units") or da.attrs.get("unit"), per_year=dim is None
    )
    if dim is None:
        part = da.isel(y=rows, x=cols).transpose("y", "x")
        values = _block_mean(np.asarray(part.values, dtype=float), k) * factor
        source = f"the velocity layer {layer!r}"
    else:
        n_t = da.sizes[dim]
        if n_t < 2:
            raise ZonesError(f"{layer!r} has fewer than two dates to fit a rate.")
        # Cap the values read: sample every k-th pixel (k grows for long series).
        while n_t * (len(y) // k) * (len(x) // k) > MAX_FIT_VALUES:
            k += 1
        part = da.isel(y=rows, x=cols).transpose(dim, "y", "x")
        cube = _block_mean(np.asarray(part.values, dtype=float), k)
        t = _years(ds[dim].values if dim in ds.coords else np.arange(n_t))
        values = fit_rate(cube, t) * factor
        labels = [str(v)[:10] for v in np.asarray(ds[dim].values)[[0, -1]]]
        source = (
            f"a straight line fitted to {layer!r} at each pixel over {n_t} dates "
            f"({labels[0]} to {labels[1]})"
        )
    return Grid(values, _centres(x, k), _centres(y, k), source, unit, rows, cols, k)


def fit_rate(cube: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Least-squares slope per pixel of ``cube`` (time, y, x) against ``t``.

    Dates without data are left out per pixel; fewer than two dates give NaN.
    """
    ok = np.isfinite(cube)
    tt = np.broadcast_to(t[:, None, None], cube.shape)
    n = ok.sum(axis=0)
    z = np.where(ok, cube, 0.0)
    tz = np.where(ok, tt, 0.0)
    st, sz = tz.sum(axis=0), z.sum(axis=0)
    stt, stz = (tz * tz).sum(axis=0), (tz * z).sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        den = n * stt - st * st
        slope = (n * stz - st * sz) / den
    return np.where((n >= 2) & (den > 0), slope, np.nan)


def read_quality(ds: Any, grid: Grid) -> tuple[np.ndarray, str] | None:
    """Return a coherence on the zones grid (same window and blocks), or None."""
    for name in COHERENCE_LAYERS:
        if name not in ds.data_vars:
            continue
        da = ds[name]
        part = da.isel(y=grid.rows, x=grid.cols)
        dim = _non_spatial_dim(da)
        if dim is not None:
            # A coherence per date: the median over at most 30 of its dates.
            step = max(1, math.ceil(da.sizes[dim] / 30))
            part = part.isel({dim: slice(0, None, step)}).transpose(dim, "y", "x")
            with np.errstate(all="ignore"):
                arr = np.nanmedian(np.asarray(part.values, dtype=float), axis=0)
            label = f"the median of {name!r} over its dates"
        else:
            arr = np.asarray(part.transpose("y", "x").values, dtype=float)
            label = name
        return _block_mean(arr, grid.k), label
    return None


# --- connected areas ---------------------------------------------------------------


def label(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Label the 4-connected areas of ``mask``: 1..n, 0 outside.

    Numbered in raster order of their first cell; scipy's labelling when it is
    installed, else a search here (the same labels).
    """
    try:
        from scipy import ndimage  # noqa: PLC0415
    except ImportError:
        return label_numpy(mask)
    labels, n = ndimage.label(mask)
    return labels.astype(np.int32), int(n)


def label_numpy(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Label 4-connected areas without scipy (breadth-first, raster order)."""
    ny, nx = mask.shape
    labels = np.zeros(mask.shape, np.int32)
    flat = mask.ravel()
    lab = labels.ravel()
    n = 0
    for start in np.flatnonzero(flat):
        if lab[start]:
            continue
        n += 1
        lab[start] = n
        queue = deque([int(start)])
        while queue:
            i = queue.popleft()
            r, c = divmod(i, nx)
            for j, inside in (
                (i - nx, r > 0),
                (i + nx, r < ny - 1),
                (i - 1, c > 0),
                (i + 1, c < nx - 1),
            ):
                if inside and flat[j] and not lab[j]:
                    lab[j] = n
                    queue.append(j)
    return labels, n


# --- outlines ------------------------------------------------------------------------

# Directions (row, col) in screen order: east, south, west, north.
_RIGHT = {(0, 1): (1, 0), (1, 0): (0, -1), (0, -1): (-1, 0), (-1, 0): (0, 1)}


def trace_rings(cells: np.ndarray) -> list[np.ndarray]:
    """Trace the closed outlines of a boolean grid along its cell edges.

    Returns rings of corner positions (row, col), corner (r, c) being the top
    left of cell (r, c). Each ring walks with the inside on its right (in screen
    order, rows down); at a corner where two cells touch only diagonally, the
    ring turns to keep them apart (4-connectivity). Only corners where the
    outline turns are kept.
    """
    m = np.pad(cells.astype(bool), 1)
    inner = m[1:-1, 1:-1]
    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add(sel: np.ndarray, start: tuple[int, int], end: tuple[int, int]) -> None:
        for r, c in zip(*np.nonzero(sel)):
            a = (int(r) + start[0], int(c) + start[1])
            b = (int(r) + end[0], int(c) + end[1])
            edges.setdefault(a, []).append(b)

    add(inner & ~m[:-2, 1:-1], (0, 0), (0, 1))  # top: west to east
    add(inner & ~m[1:-1, 2:], (0, 1), (1, 1))  # right: north to south
    add(inner & ~m[2:, 1:-1], (1, 1), (1, 0))  # bottom: east to west
    add(inner & ~m[1:-1, :-2], (1, 0), (0, 0))  # left: south to north
    rings = []
    while edges:
        start = min(edges)
        ring = [start]
        here = start
        nxt = edges[here].pop(0)
        if not edges[here]:
            del edges[here]
        direction = (nxt[0] - here[0], nxt[1] - here[1])
        here = nxt
        while here != start:
            ring.append(here)
            outs = edges[here]
            if len(outs) > 1:
                # Turn right first (hug the cell), then straight, then left.
                order = [
                    _RIGHT[direction],
                    direction,
                    _RIGHT[_RIGHT[_RIGHT[direction]]],
                ]
                outs.sort(key=lambda p: _turn_rank(order, here, p))
            nxt = outs.pop(0)
            if not outs:
                del edges[here]
            direction = (nxt[0] - here[0], nxt[1] - here[1])
            here = nxt
        rings.append(_corners(np.array(ring, dtype=float)))
    return rings


def _turn_rank(
    order: list[tuple[int, int]], here: tuple[int, int], to: tuple[int, int]
) -> int:
    step = (to[0] - here[0], to[1] - here[1])
    return order.index(step) if step in order else 9


def _corners(ring: np.ndarray) -> np.ndarray:
    """Keep the vertices where a closed ring turns."""
    prev = np.roll(ring, 1, axis=0)
    nxt = np.roll(ring, -1, axis=0)
    d1, d2 = ring - prev, nxt - ring
    turn = (d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) != 0
    return ring[turn] if turn.any() else ring


def simplify(ring: np.ndarray, tolerance: float) -> np.ndarray:
    """Ramer-Douglas-Peucker on a closed ring (no repeated last vertex)."""
    n = len(ring)
    if n <= 4 or tolerance <= 0:
        return ring
    # Split at the vertex farthest from the first, then simplify both halves.
    far = int(np.argmax(((ring - ring[0]) ** 2).sum(axis=1)))
    keep = np.zeros(n, bool)
    keep[[0, far]] = True
    closed = np.vstack([ring, ring[:1]])
    stack = [(0, far), (far, n)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = closed[i], closed[j]
        pts = closed[i + 1 : j]
        ab = b - a
        norm = math.hypot(*ab)
        if norm == 0:
            d = np.hypot(*(pts - a).T)
        else:
            d = np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / norm
        k = int(np.argmax(d))
        if d[k] > tolerance:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    out = ring[keep]
    return out if len(out) >= 3 else ring


def _signed_area(ring: np.ndarray) -> float:
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


# --- zones ---------------------------------------------------------------------------


def _pixel_area_m2(
    x: np.ndarray, y: np.ndarray, crs: CRS, rows: np.ndarray
) -> np.ndarray:
    """Area (m²) of the cells in ``rows`` of a regular grid."""
    dx = abs(float(x[1] - x[0])) if len(x) > 1 else 1.0
    dy = abs(float(y[1] - y[0])) if len(y) > 1 else dx
    if crs.is_geographic:
        lat = np.radians(y[rows])
        return (dx * 111_320.0 * np.cos(lat)) * (dy * 110_574.0)
    unit = (crs.axis_info[0].unit_conversion_factor if crs.axis_info else 1.0) or 1.0
    return np.full(len(rows), dx * dy * unit * unit)


def find_zones(
    grid: Grid,
    to_xy: Transformer,
    threshold: float,
    sign: Sign = "both",
    min_area_m2: float = 0.0,
    max_zones: int = 50,
    quality: tuple[np.ndarray, str] | None = None,
    quality_min: float | None = None,
    reference: float | None = None,
) -> dict[str, Any]:
    """Return the zones of ``grid`` where the rate passes ``threshold``.

    Parameters
    ----------
    grid : Grid
        The rate and its cell centres (from :func:`read_rate`).
    to_xy : pyproj.Transformer
        lon/lat to the grid's CRS (``always_xy``).
    threshold : float
        Rate (in ``grid.unit``) that ``|rate|`` must reach.
    sign : {"both", "negative", "positive"}
        Which way: negative (away from the satellite), positive, or both;
        a zone never mixes the two.
    min_area_m2 : float
        Zones smaller than this are left out.
    max_zones : int
        The largest zones kept.
    quality, quality_min : optional
        A 2-D quality grid and the least value a cell must have.
    reference : float, optional
        Rate subtracted first (the rate at a reference point).

    Returns
    -------
    dict
        ``zones`` (a GeoJSON FeatureCollection in lon/lat, largest first, with
        id ``Z1``... and area, mean, median, peak, centroid, bbox), the
        threshold, the source of the rate and the grid's cell size.

    """
    v = grid.values - (reference or 0.0)
    valid = np.isfinite(v)
    if quality is not None and quality_min is not None:
        valid &= np.nan_to_num(quality[0], nan=-np.inf) >= quality_min
    parts = []
    if sign in ("negative", "both"):
        parts.append(("negative", valid & (v <= -threshold)))
    if sign in ("positive", "both"):
        parts.append(("positive", valid & (v >= threshold)))
    crs = to_xy.target_crs
    to_lonlat = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    x, y = grid.x, grid.y
    dx = float(x[1] - x[0]) if len(x) > 1 else 1.0
    dy = float(y[1] - y[0]) if len(y) > 1 else -dx
    cell_area = _pixel_area_m2(x, y, crs, np.arange(len(y)))
    found = []
    n_all = 0
    for which, mask in parts:
        labels, n = label(mask)
        n_all += n
        if not n:
            continue
        idx = labels.ravel()
        counts = np.bincount(idx, minlength=n + 1)
        areas = np.bincount(idx, weights=np.repeat(cell_area, len(x)), minlength=n + 1)
        for k in range(1, n + 1):
            if areas[k] < min_area_m2 or counts[k] == 0:
                continue
            found.append((float(areas[k]), which, k, labels))
    found.sort(key=lambda f: (-f[0], f[1], f[2]))
    kept = found[:max_zones]
    features = []
    for i, (area, which, k, labels) in enumerate(kept):
        rr, cc = np.nonzero(labels == k)
        vals = v[rr, cc]
        peak = float(vals[np.argmax(np.abs(vals))])
        cx, cy = float(x[cc].mean()), float(y[rr].mean())
        clon, clat = to_lonlat.transform(cx, cy)
        r0, r1, c0, c1 = rr.min(), rr.max() + 1, cc.min(), cc.max() + 1
        geometry = _outline(labels[r0:r1, c0:c1] == k, r0, c0, x, y, dx, dy, to_lonlat)
        lons = [p[0] for ring in geometry["coordinates"] for p in ring]
        lats = [p[1] for ring in geometry["coordinates"] for p in ring]
        features.append(
            {
                "type": "Feature",
                "id": f"Z{i + 1}",
                "geometry": geometry,
                "properties": {
                    "zone": f"Z{i + 1}",
                    "direction": which,
                    "area_m2": round(area),
                    "area_km2": round(area / 1e6, 4),
                    "n_cells": int(len(vals)),
                    "mean_rate": round(float(vals.mean()), 2),
                    "median_rate": round(float(np.median(vals)), 2),
                    "peak_rate": round(peak, 2),
                    "centroid": [round(clon, 6), round(clat, 6)],
                    "bbox": [
                        round(min(lons), 6),
                        round(min(lats), 6),
                        round(max(lons), 6),
                        round(max(lats), 6),
                    ],
                },
            }
        )
    lat_mid = float(np.mean(to_lonlat.transform(x.mean(), y.mean())[1]))
    step = (
        abs(dx) * 111_320 * math.cos(math.radians(lat_mid))
        if crs.is_geographic
        else abs(dx)
        * ((crs.axis_info[0].unit_conversion_factor or 1.0) if crs.axis_info else 1.0)
    )
    return {
        "zones": {"type": "FeatureCollection", "features": features},
        "n_zones": len(features),
        "n_found": n_all,
        "truncated": len(found) > len(kept),
        "total_area_m2": round(sum(f[0] for f in kept)),
        "threshold": threshold,
        "sign": sign,
        "unit": grid.unit,
        "source": grid.source,
        "quality_mask": (
            {"layer": quality[1], "min": quality_min}
            if quality is not None and quality_min is not None
            else None
        ),
        "cell_m": round(step, 1),
        "grid_shape": [int(len(y)), int(len(x))],
        "valid_cells": int(valid.sum()),
    }


def _outline(
    cells: np.ndarray,
    r0: int,
    c0: int,
    x: np.ndarray,
    y: np.ndarray,
    dx: float,
    dy: float,
    to_lonlat: Transformer,
) -> dict[str, Any]:
    """Return a zone's GeoJSON Polygon: outer ring and larger holes, in lon/lat."""
    rings = trace_rings(cells)
    sized = sorted(((abs(_signed_area(r)), r) for r in rings), key=lambda t: -t[0])
    out = []
    for j, (area, ring) in enumerate(sized):
        if j > 0 and area < MIN_HOLE_CELLS:
            continue
        tol = SIMPLIFY_CELLS
        simple = simplify(ring, tol)
        while len(simple) > MAX_RING_VERTICES:
            tol *= 2
            simple = simplify(ring, tol)
        # Corner (r, c) of the cells to the grid's CRS, then lon/lat.
        rows = simple[:, 0] + r0
        cols = simple[:, 1] + c0
        gx = x[0] + (cols - 0.5) * dx
        gy = y[0] + (rows - 0.5) * dy
        lon, lat = to_lonlat.transform(gx, gy)
        pts = np.column_stack([lon, lat])
        # GeoJSON: the outer ring counter-clockwise, holes clockwise.
        ccw = _signed_area(pts) > 0
        if (j == 0) != ccw:
            pts = pts[::-1]
        pts = np.round(pts, 6)
        out.append(
            [[float(a), float(b)] for a, b in pts]
            + [[float(pts[0, 0]), float(pts[0, 1])]]
        )
    return {"type": "Polygon", "coordinates": out}


def deformation_zones(
    ds: Any,
    to_xy: Transformer,
    threshold_mm_yr: float,
    *,
    sign: Sign = "both",
    min_area_m2: float = 0.0,
    bbox: tuple[float, float, float, float] | None = None,
    layer: str | None = None,
    coherence_min: float | None = None,
    max_zones: int = 50,
    ref_lonlat: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """Find the deformation zones of a cube (both servers' ``GET /deformation_zones``).

    ``ds`` is the cube's level-0 xarray dataset and ``to_xy`` the transformer
    from lon/lat to its CRS. See :func:`find_zones` for the result.
    """
    if threshold_mm_yr <= 0:
        raise ZonesError("threshold_mm_yr must be above 0.")
    grid = read_rate(ds, to_xy, layer, bbox)
    quality = None
    if coherence_min is not None:
        quality = read_quality(ds, grid)
        if quality is None:
            raise ZonesError(
                "The cube has no coherence layer for coherence_min "
                f"(looked for {', '.join(COHERENCE_LAYERS)})."
            )
    reference = None
    if ref_lonlat is not None:
        rx, ry = to_xy.transform(*ref_lonlat)
        col = int(np.argmin(np.abs(grid.x - rx)))
        row = int(np.argmin(np.abs(grid.y - ry)))
        reference = float(grid.values[row, col])
        if not math.isfinite(reference):
            raise ZonesError("The reference point has no rate (nodata there).")
    out = find_zones(
        grid,
        to_xy,
        threshold_mm_yr,
        sign=sign,
        min_area_m2=min_area_m2,
        max_zones=max_zones,
        quality=quality,
        quality_min=coherence_min,
        reference=reference,
    )
    out["reference"] = None
    if ref_lonlat is not None and reference is not None:
        out["reference"] = {
            "point": list(ref_lonlat),
            "rate_subtracted": round(reference, 3),
        }
    out["bbox"] = list(bbox) if bbox else None
    return out
