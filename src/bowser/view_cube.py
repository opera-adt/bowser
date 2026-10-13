"""View cubes: a display copy of a GeoZarr cube on the Web Mercator tile grid.

The analysis cube stays on its native (e.g. UTM) grid. The view cube resamples it,
nearest neighbour so every value is a value of the source, onto the global
EPSG:3857 pixel grid at one zoom level (the *native zoom*: the coarsest zoom whose
pixels are no larger on the ground than the source pixels). The array is padded
out to whole tiles, so at the native zoom every map tile is exactly one
``(1, 256, 256)`` chunk and a server can answer tile and point requests with array
slicing alone: no GDAL, no pyproj, no reprojection at request time.

See ``docs/view-cube-spec.md`` for the format.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xarray as xr
from pyproj import CRS, Transformer

TILE = 256
# Web Mercator: half the extent of the square world, in metres.
ORIGIN = math.pi * 6378137.0
VIEW_CUBE_VERSION = "1"


def mercator_res(zoom: int) -> float:
    """Pixel size (metres in EPSG:3857) at ``zoom`` for 256-px tiles."""
    return 2 * ORIGIN / (TILE * 2**zoom)


def native_zoom(source_res_m: float, lat: float) -> int:
    """Return the coarsest zoom whose ground pixel is no larger than ``source_res_m``.

    A Web Mercator pixel of size r covers r * cos(lat) metres on the ground.
    """
    ground_at_z0 = 2 * ORIGIN * math.cos(math.radians(lat)) / TILE
    return max(0, math.ceil(math.log2(ground_at_z0 / source_res_m) - 1e-9))


@dataclass(frozen=True)
class ViewGrid:
    """The view-cube grid: whole tiles of the global grid at ``zoom``."""

    zoom: int
    tile_col0: int  # global tile column of the first chunk column
    tile_row0: int  # global tile row of the first chunk row (rows count from the north)
    ntile_x: int
    ntile_y: int

    @property
    def res(self) -> float:
        """Pixel size (EPSG:3857 metres)."""
        return mercator_res(self.zoom)

    @property
    def shape(self) -> tuple[int, int]:
        """(rows, cols) in pixels."""
        return self.ntile_y * TILE, self.ntile_x * TILE

    @property
    def x0(self) -> float:
        """West edge (EPSG:3857 metres)."""
        return -ORIGIN + self.tile_col0 * TILE * self.res

    @property
    def y0(self) -> float:
        """North edge (EPSG:3857 metres)."""
        return ORIGIN - self.tile_row0 * TILE * self.res

    def x(self) -> np.ndarray:
        """Pixel-centre x coordinates."""
        return self.x0 + (np.arange(self.shape[1]) + 0.5) * self.res

    def y(self) -> np.ndarray:
        """Pixel-centre y coordinates."""
        return self.y0 - (np.arange(self.shape[0]) + 0.5) * self.res

    def transform(self) -> list[float]:
        """Affine transform, GDAL order, of the north-west corner."""
        return [self.res, 0.0, self.x0, 0.0, -self.res, self.y0]


def view_grid(bounds_3857: tuple[float, float, float, float], zoom: int) -> ViewGrid:
    """Return the whole-tile grid at ``zoom`` covering (west, south, east, north)."""
    west, south, east, north = bounds_3857
    span = TILE * mercator_res(zoom)
    c0 = math.floor((west + ORIGIN) / span)
    c1 = math.ceil((east + ORIGIN) / span)
    r0 = math.floor((ORIGIN - north) / span)
    r1 = math.ceil((ORIGIN - south) / span)
    return ViewGrid(zoom, c0, r0, max(1, c1 - c0), max(1, r1 - r0))


def _source_crs(ds: xr.Dataset) -> CRS:
    if "proj:code" in ds.attrs:
        return CRS.from_user_input(ds.attrs["proj:code"])
    if "spatial_ref" in ds and "crs_wkt" in ds["spatial_ref"].attrs:
        return CRS.from_wkt(ds["spatial_ref"].attrs["crs_wkt"])
    raise ValueError(
        "source cube has no CRS (no 'proj:code' attr or spatial_ref/crs_wkt)"
    )


def _source_index(
    ds: xr.Dataset, grid: ViewGrid, crs: CRS
) -> tuple[np.ndarray, np.ndarray]:
    """Return the source row/col containing each view-pixel centre (-1 = outside)."""
    xs, ys = ds["x"].values, ds["y"].values
    dx, dy = float(xs[1] - xs[0]), float(ys[1] - ys[0])
    left, top = float(xs[0]) - dx / 2, float(ys[0]) - dy / 2
    gx, gy = np.meshgrid(grid.x(), grid.y())
    e, n = Transformer.from_crs(3857, crs, always_xy=True).transform(gx, gy)
    col = np.floor((e - left) / dx).astype(np.int64)
    row = np.floor((n - top) / dy).astype(np.int64)
    outside = (col < 0) | (col >= xs.size) | (row < 0) | (row >= ys.size)
    col[outside] = -1
    row[outside] = -1
    return row, col


def _bounds_3857(ds: xr.Dataset, crs: CRS) -> tuple[float, float, float, float]:
    """Return the source footprint in EPSG:3857 from its densified edges.

    UTM edges curve in Mercator, so the corners alone are not enough.
    """
    xs, ys = ds["x"].values, ds["y"].values
    dx, dy = float(xs[1] - xs[0]), float(ys[1] - ys[0])
    left, right = float(xs[0]) - dx / 2, float(xs[-1]) + dx / 2
    top, bottom = float(ys[0]) - dy / 2, float(ys[-1]) + dy / 2
    t = np.linspace(0, 1, 101)
    ex = np.concatenate(
        [
            left + (right - left) * t,
            np.full_like(t, right),
            right - (right - left) * t,
            np.full_like(t, left),
        ]
    )
    ny = np.concatenate(
        [
            np.full_like(t, top),
            top + (bottom - top) * t,
            np.full_like(t, bottom),
            bottom - (bottom - top) * t,
        ]
    )
    mx, my = Transformer.from_crs(crs, 3857, always_xy=True).transform(ex, ny)
    return float(mx.min()), float(my.min()), float(mx.max()), float(my.max())


def _lonlat_to_view_rowcol(lon: float, lat: float, grid: ViewGrid) -> tuple[int, int]:
    x, y = Transformer.from_crs(4326, 3857, always_xy=True).transform(lon, lat)
    return int(math.floor((grid.y0 - y) / grid.res)), int(
        math.floor((x - grid.x0) / grid.res)
    )


def make_view_cube(
    source: str | Path, output: str | Path, zoom: int | None = None
) -> Path:
    """Write the view cube of ``source`` to ``output`` (a new Zarr store).

    Every (y, x) variable is resampled nearest-neighbour onto the view grid; NaN
    outside the source footprint and in the tile padding. Other variables (e.g.
    ``reference_time``) and all root attributes are copied. ``reference_row`` /
    ``reference_col`` are recomputed for the new grid from ``reference_lonlat``.
    """
    output = Path(output)
    if output.exists():
        raise FileExistsError(f"{output} exists; remove it first")
    src = xr.open_zarr(source, consolidated=None)
    crs = _source_crs(src)

    xs, ys = src["x"].values, src["y"].values
    source_res = abs(float(xs[1] - xs[0]))
    if not crs.is_projected:
        raise ValueError("source CRS must be projected (metres)")
    lon_c, lat_c = Transformer.from_crs(crs, 4326, always_xy=True).transform(
        float(xs.mean()), float(ys.mean())
    )
    z = native_zoom(source_res, lat_c) if zoom is None else zoom
    grid = view_grid(_bounds_3857(src, crs), z)
    row, col = _source_index(src, grid, crs)
    valid = row >= 0
    r, c = np.where(valid, row, 0), np.where(valid, col, 0)

    out = xr.Dataset(coords={"y": ("y", grid.y()), "x": ("x", grid.x())})
    for name, var in src.data_vars.items():
        if name == "spatial_ref":
            continue
        if var.dims[-2:] != ("y", "x"):
            out[name] = var.load()
            continue
        lead = var.dims[:-2]
        dtype = (
            var.dtype if np.issubdtype(var.dtype, np.floating) else np.dtype(np.float32)
        )
        lead_shape = tuple(src.sizes[d] for d in lead)
        res = np.empty(lead_shape + grid.shape, dtype=dtype)
        # One 2-D slice at a time keeps memory to a slice, whatever the stack length.
        for idx in np.ndindex(*lead_shape):
            res[idx] = var[idx].values[r, c]
            res[idx][~valid] = np.nan
        attrs = {k: v for k, v in var.attrs.items() if k != "grid_mapping"}
        attrs["grid_mapping"] = "spatial_ref"
        out[name] = (lead + ("y", "x"), res, attrs)
    for d in src.coords:
        if d not in ("x", "y") and d in src.dims:
            out = out.assign_coords({d: src[d].values})

    merc = CRS.from_epsg(3857)
    out["spatial_ref"] = xr.DataArray(
        0, attrs={**merc.to_cf(), "spatial_ref": merc.to_wkt()}
    )
    attrs = dict(src.attrs)
    attrs.update(
        {
            "proj:code": "EPSG:3857",
            "spatial:dimensions": ["y", "x"],
            "spatial:transform_type": "affine",
            "spatial:transform": grid.transform(),
            "spatial:shape": list(grid.shape),
            "spatial:bbox": [
                grid.x0,
                grid.y0 - grid.shape[0] * grid.res,
                grid.x0 + grid.shape[1] * grid.res,
                grid.y0,
            ],
            "spatial:registration": "pixel",
            "view:version": VIEW_CUBE_VERSION,
            "view:zoom": grid.zoom,
            "view:tile_origin": [grid.tile_col0, grid.tile_row0],
            "view:tile_count": [grid.ntile_x, grid.ntile_y],
            "view:source_cube": Path(str(source)).name,
            "view:source_res_m": source_res,
        }
    )
    if "reference_lonlat" in attrs:
        lonlat = attrs["reference_lonlat"]
        lon, lat = json.loads(lonlat) if isinstance(lonlat, str) else lonlat
        rr, cc = _lonlat_to_view_rowcol(lon, lat, grid)
        attrs["reference_row"], attrs["reference_col"] = rr, cc
    out.attrs = attrs

    encoding = {}
    for name, var in out.data_vars.items():
        if name == "spatial_ref":
            continue
        if var.dims[-2:] == ("y", "x"):
            chunks = (1,) * (var.ndim - 2) + (TILE, TILE)
            encoding[name] = {"chunks": chunks}
    out.to_zarr(output, mode="w-", encoding=encoding, consolidated=True, zarr_format=3)
    return output
