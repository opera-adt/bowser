"""Read native GeoTIFF chart samples with explicit, aligned layer masks."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import rasterio
import xarray as xr
from pyproj import CRS, Transformer
from rasterio.transform import rowcol
from rasterio.windows import Window

from .polygon import (
    MAX_PIXEL_EPOCHS,
    MAX_WINDOW_PIXELS,
    NativeGrid,
    PolygonMask,
    _linear,
    _values,
)
from .polygon_masks import raster_masks
from .reference import select_circle


def available_masks(
    group: Any, groups: dict, masks: list[dict]
) -> tuple[list[PolygonMask], list[str]]:
    """Validate specs; disclose unavailable layers/axes as chart warnings.

    Match the map's unavailable-layer compatibility, without claiming that an
    omitted mask was applied. Valid masks still use the strict shared reader.
    """
    if not isinstance(masks, list) or len(masks) > 10:
        raise ValueError("Chart masks must be a list of at most ten masks")
    specs = [PolygonMask.model_validate(m) for m in masks]
    usable, notes = [], []
    labels = list(map(str, group.x_values))
    for spec in specs:
        other = groups.get(spec.dataset)
        if other is None or not other.file_list:
            reason = "layer unavailable"
        elif len(other.file_list) == 1:
            reason = None
        elif (
            len(other.file_list) != len(group.file_list)
            or list(map(str, other.x_values)) != labels
        ):
            reason = "dates do not match this layer"
        else:
            reason = None
        if reason:
            notes.append(f"Chart mask {spec.dataset!r} not applied: {reason}.")
        else:
            usable.append(spec)
    return usable, notes


class ChartBudgetError(ValueError):
    """Indicate a native read that exceeds the bounded chart allocation."""


class OutsideRasterError(ValueError):
    """Indicate a selection without native source pixel centers."""


class CogSampler:
    """Sample real-valued band-one stacks without resampling or date inference."""

    def __init__(self, group: Any, groups: dict, layer_masks: list[dict]) -> None:
        """Validate configured mask labels and open source grid metadata."""
        self.group = group
        self.paths = group.file_list
        if not self.paths:
            raise ValueError("The selected layer has no raster files")
        self.labels = list(map(str, group.x_values))
        with rasterio.open(self.paths[0]) as source:
            self.grid = NativeGrid(
                source.crs, source.transform, source.width, source.height
            )
        if self.grid.crs is None:
            raise ValueError("Chart sampling requires a source CRS")
        self.transformer = Transformer.from_crs(4326, self.grid.crs, always_xy=True)

        specs, self.warnings = available_masks(group, groups, layer_masks)
        self.masks = raster_masks(groups, specs, self.labels, self.grid)

    def _xy(self, lon: float, lat: float) -> tuple[float, float]:
        if not (
            np.isfinite(lon)
            and -180 <= lon <= 180
            and np.isfinite(lat)
            and -90 <= lat <= 90
        ):
            raise ValueError(
                "Chart coordinates must be finite WGS84 longitude/latitude"
            )
        x, y = self.transformer.transform(lon, lat)
        if not np.isfinite([x, y]).all():
            raise ValueError("Chart coordinates cannot be projected to the source grid")
        return x, y

    def _budget(self, window: Window, count: int) -> None:
        pixels = int(window.width * window.height)
        if (
            pixels > MAX_WINDOW_PIXELS
            or pixels * self.masks.work(count) > MAX_PIXEL_EPOCHS
        ):
            raise ChartBudgetError(
                "Chart selection exceeds the native pixel-epoch budget; "
                "reduce the radius"
            )

    def _read(
        self, path: str, window: Window, nodata: float | None, *, mask: bool = False
    ) -> np.ndarray:
        with rasterio.open(path) as source:
            actual = NativeGrid(
                source.crs, source.transform, source.width, source.height
            )
            if actual != self.grid:
                raise ValueError(
                    "Chart data and masks must share the exact native grid and CRS"
                )
            if mask and source.count != 1:
                raise ValueError("Chart masks must be single-band scalar rasters")
            _linear(source.dtypes[0], None)
            values = _values(source.read(1, window=window, masked=True))
        if nodata is not None:
            values = np.where(values == nodata, np.nan, values)
        return values

    def _frame(self, index: int, window: Window) -> np.ndarray:
        values = self._read(self.paths[index], window, self.group.nodata)
        rows, cols = window.toslices()
        return self.masks.apply(index, rows, cols, values)

    def point(self, lon: float, lat: float, index: int | None = None) -> np.ndarray:
        """Read one containing pixel, for all dates or one resolved source date."""
        x, y = self._xy(lon, lat)
        row, col = rowcol(self.grid.transform, x, y)
        if not (0 <= row < self.grid.height and 0 <= col < self.grid.width):
            raise OutsideRasterError("Point is outside the source raster")
        indices = (
            range(len(self.paths))
            if index is None
            else [max(0, min(index, len(self.paths) - 1))]
        )
        window = Window(col, row, 1, 1)
        self._budget(window, len(indices))
        # Read a static mask once before the concurrent data reads. The shared
        # reader caches one window; workers only reuse that immutable array.
        rows, cols = window.toslices()
        keep = [self.masks.valid(i, rows, cols, (1, 1))[0, 0] for i in indices]
        with ThreadPoolExecutor(max_workers=3) as executor:
            values = list(
                executor.map(
                    lambda i: self._read(self.paths[i], window, self.group.nodata)[
                        0, 0
                    ],
                    indices,
                )
            )
        return np.where(keep, values, np.nan)

    def buffer(self, lon: float, lat: float, radius: float) -> np.ndarray:
        """Read each date's native pixel centers inside a metric circle."""
        if not np.isfinite(radius) or radius <= 0:
            raise ValueError("Chart buffer radius must be finite and positive")
        crs = CRS.from_user_input(self.grid.crs)
        cx, cy = self._xy(lon, lat)
        metric = crs.is_projected and all(
            axis.unit_conversion_factor == 1 for axis in crs.axis_info[:2]
        )
        if metric:
            bounds_x, bounds_y = [cx - radius, cx + radius], [cy - radius, cy + radius]
        else:
            # A local azimuthal equidistant CRS measures distance from this
            # centre in meters, including geographic grids or projected feet.
            local = CRS.from_proj4(
                f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m"
            )
            tr = Transformer.from_crs(local, crs, always_xy=True)
            angles = np.linspace(0, 2 * np.pi, 361)
            bounds_x, bounds_y = tr.transform(
                radius * np.cos(angles), radius * np.sin(angles), errcheck=True
            )
        inverse = ~self.grid.transform
        corners = [
            inverse * (xx, yy)
            for xx in (min(bounds_x), max(bounds_x))
            for yy in (min(bounds_y), max(bounds_y))
        ]
        c0 = max(0, int(np.floor(min(c[0] for c in corners))))
        c1 = min(self.grid.width, int(np.ceil(max(c[0] for c in corners))))
        r0 = max(0, int(np.floor(min(c[1] for c in corners))))
        r1 = min(self.grid.height, int(np.ceil(max(c[1] for c in corners))))
        if c1 <= c0 or r1 <= r0:
            raise OutsideRasterError("Buffer is outside the source raster")
        window = Window(c0, r0, c1 - c0, r1 - r0)
        self._budget(window, len(self.paths))
        rows, cols = np.meshgrid(
            np.arange(r0, r1) + 0.5, np.arange(c0, c1) + 0.5, indexing="ij"
        )
        xx, yy = self.grid.transform * (cols, rows)
        if metric and self.grid.transform.b == self.grid.transform.d == 0:
            # Share upstream's circle predicate on rectilinear meter grids.
            # Broadcast zeros are a coordinate-only view, not a source read.
            coords = xr.DataArray(
                np.broadcast_to(0.0, xx.shape),
                dims=("y", "x"),
                coords={"x": xx[0], "y": yy[:, 0]},
            )
            circle = select_circle(coords, cx, cy, radius)
            assert circle is not None
            inside = circle.inside
            # select_circle can trim boundary rows/columns; use its selected
            # coordinates to trim the raster window identically.
            cols = np.flatnonzero(abs(xx[0] - cx) <= radius)
            rows = np.flatnonzero(abs(yy[:, 0] - cy) <= radius)
            window = (
                Window(c0 + cols[0], r0 + rows[0], len(cols), len(rows))
                if rows.size and cols.size
                else window
            )
        else:
            # select_circle requires separable x/y axes. Rotated grids need
            # their complete affine; non-meter grids need metric distances.
            if not metric:
                xx, yy = Transformer.from_crs(crs, local, always_xy=True).transform(
                    xx, yy
                )
                cx, cy = 0.0, 0.0
            inside = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius**2
        if not inside.any():
            raise OutsideRasterError("No native pixel centers lie inside the buffer")
        return np.stack(
            [self._frame(i, window)[inside] for i in range(len(self.paths))]
        )


def buffer_limit(group: Any) -> float:
    """Conservative UI radius for up to ten dynamic masks and all dates.

    The exact clipped-window budget is still checked on every request. Small
    rasters that fit in full need no radius restriction. No pixels are read.
    """
    with rasterio.open(group.file_list[0]) as source:
        count = max(1, len(group.file_list))
        pixels = min(MAX_WINDOW_PIXELS, MAX_PIXEL_EPOCHS // (11 * count))
        if source.width * source.height <= pixels:
            return 5000.0
        crs = CRS.from_user_input(source.crs)
        t = source.transform
        if crs.is_projected:
            factor = min(a.unit_conversion_factor for a in crs.axis_info[:2])
            spacing = float(np.linalg.svd([[t.a, t.b], [t.d, t.e]])[1][-1]) * factor
        else:
            # Bound metric spacing over the geographic raster's latitude span.
            # A small safety margin also covers local ellipsoid variation.
            lat = max(abs(source.bounds.bottom), abs(source.bounds.top))
            geod = crs.get_geod()
            dx = abs(geod.inv(0, lat, abs(t.a), lat)[2])
            dy = abs(geod.inv(0, lat, 0, lat - min(abs(t.e), 1))[2])
            spacing = min(dx, dy) * 0.9 if not (t.b or t.d) else 0.0
        radius = max(0.0, (np.sqrt(pixels) - 4) * spacing / 2)
        return min(5000.0, float(np.floor(radius / 5) * 5))
