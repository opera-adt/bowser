"""Read native GeoTIFF chart samples with explicit, aligned layer masks."""

from __future__ import annotations

from typing import Any

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.transform import rowcol
from rasterio.windows import Window

from .polygon import MAX_PIXEL_EPOCHS, MAX_WINDOW_PIXELS, NativeGrid, _linear, _values


def _mask_specs(masks: list[dict]) -> list[dict]:
    """Validate existing signed chart-mask fields without importing GeoZarr IO."""
    if not isinstance(masks, list) or len(masks) > 10:
        raise ValueError("Chart masks must be a list of at most ten masks")
    result = []
    for mask in masks:
        if not isinstance(mask, dict):
            raise ValueError("Each chart mask must be an object")
        name = mask.get("dataset")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Each chart mask requires a dataset name")
        try:
            threshold = float(mask.get("threshold", 0.5))
        except (TypeError, ValueError) as exc:
            raise ValueError("Mask thresholds must be finite numbers") from exc
        mode = mask.get("mode", "min")
        if not np.isfinite(threshold) or mode not in ("min", "max"):
            raise ValueError("Masks require finite thresholds and min/max mode")
        result.append({"dataset": name, "threshold": threshold, "mode": mode})
    return result


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
        self.masks = []
        for mask in _mask_specs(layer_masks):
            if mask["dataset"] not in groups:
                raise ValueError(f"Unknown mask layer: {mask['dataset']}")
            mask_group = groups[mask["dataset"]]
            paths = mask_group.file_list
            if len(paths) not in (1, len(self.paths)):
                raise ValueError("Masks must be static or have one file per data slice")
            if len(paths) > 1 and list(map(str, mask_group.x_values)) != self.labels:
                raise ValueError(
                    "Dynamic mask labels must match the selected layer exactly"
                )
            self.masks.append(
                (paths, mask["threshold"], mask["mode"], mask_group.nodata)
            )
        with rasterio.open(self.paths[0]) as source:
            self.grid = NativeGrid(
                source.crs, source.transform, source.width, source.height
            )
        if self.grid.crs is None:
            raise ValueError("Chart sampling requires a source CRS")
        self.transformer = Transformer.from_crs(4326, self.grid.crs, always_xy=True)

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
            or pixels * count * (1 + len(self.masks)) > MAX_PIXEL_EPOCHS
        ):
            raise ValueError("Chart selection exceeds the native pixel-epoch budget")

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
        keep = np.isfinite(values)
        for paths, threshold, mode, nodata in self.masks:
            mask = self._read(
                paths[0 if len(paths) == 1 else index], window, nodata, mask=True
            )
            comparison = mask <= threshold if mode == "max" else mask > threshold
            keep &= np.isfinite(mask) & comparison
        return np.where(keep, values, np.nan)

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
        return np.array([self._frame(i, window)[0, 0] for i in indices])

    def buffer(self, lon: float, lat: float, radius: float) -> np.ndarray:
        """Read each date's native pixel centers inside a metric circle."""
        if not np.isfinite(radius) or radius <= 0:
            raise ValueError("Chart buffer radius must be finite and positive")
        crs = CRS.from_user_input(self.grid.crs)
        if not crs.is_projected or any(
            axis.unit_conversion_factor != 1 for axis in crs.axis_info[:2]
        ):
            raise ValueError("Chart buffers require a projected CRS in meters")
        cx, cy = self._xy(lon, lat)
        inverse = ~self.grid.transform
        corners = [
            inverse * (xx, yy)
            for xx in (cx - radius, cx + radius)
            for yy in (cy - radius, cy + radius)
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
        inside = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius**2
        if not inside.any():
            raise OutsideRasterError("No native pixel centers lie inside the buffer")
        return np.stack(
            [self._frame(i, window)[inside] for i in range(len(self.paths))]
        )
