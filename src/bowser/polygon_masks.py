"""Explicit, bounded native-grid quality masks for polygon statistics.

Rasterio is imported only for GeoTIFF readers. GeoZarr readers are shared with
bowser-lite and do not require GDAL. No mask resampling or date inference occurs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

import numpy as np
from pyproj import CRS

from .mask_alignment import _axis, _crs, align_mask, mask_condition
from .polygon import STORED_WARNING, NativeGrid, _linear, _values

if TYPE_CHECKING:
    import xarray as xr

    from .polygon import PolygonRequest

Reader = Callable[[int, slice, slice], np.ndarray]

#: Values of a dynamic mask read at once (whole time chunks when they fit): about
#: 32 MB as float64 per mask, and a request has at most ten masks.
_READ_BLOCK = 4_000_000
MASKED_WARNING = "Explicit quality masks applied; stored spatial reference retained."


@dataclass
class PolygonMasks:
    """Read mask windows and retain finite source pixels meeting every test."""

    readers: list[Reader] = field(default_factory=list)
    records: list[dict] = field(default_factory=list)

    def valid(
        self, index: int, rows: slice, cols: slice, shape: tuple[int, ...]
    ) -> np.ndarray:
        """Return the finite native mask support without changing source values."""
        keep = np.ones(shape, dtype=bool)
        for read, record in zip(self.readers, self.records):
            mask = read(index, rows, cols)
            if mask.shape != shape:
                raise ValueError("Mask window must match the native data window")
            keep &= mask_condition(mask, record["threshold"], record["operator"])
        return keep

    def apply(
        self, index: int, rows: slice, cols: slice, values: np.ndarray
    ) -> np.ndarray:
        """Combine masks with intrinsic source validity; do not alter values."""
        if not self.readers:
            return values
        keep = np.isfinite(values) & self.valid(index, rows, cols, values.shape)
        return np.where(keep, values, np.nan)

    def work(self, count: int) -> int:
        """Return the frames read for ``count`` data frames and these masks.

        A mask that follows the data's axis costs one frame per data frame; a
        static mask is read once, so it costs one frame.
        """
        dynamic = sum(r["temporal_support"] == "matching_axis" for r in self.records)
        return count * (1 + dynamic) + (len(self.records) - dynamic)

    def finish(self, result: dict) -> dict:
        """Report the masks actually applied without claiming connectivity."""
        if self.records:
            result["optional_masks_applied"] = True
            result["masks"] = self.records
            # By its text, not its place: the list's order is _result's business.
            result["warnings"] = [
                MASKED_WARNING if w == STORED_WARNING else w for w in result["warnings"]
            ]
        return result


def xarray_masks(
    source: xr.DataArray,
    dataset: xr.Dataset | None,
    request: PolygonRequest,
    crs: Any,
) -> PolygonMasks:
    """Prepare static or exact-axis GeoZarr masks on canonical native grids."""
    masks = PolygonMasks()
    if not request.layer_masks:
        return masks
    if dataset is None:
        raise ValueError("Requested masks require an explicit mask source context")
    if crs is None:
        raise ValueError("A source CRS is required")
    _axis(source)
    source = source.sortby("x").sortby("y", ascending=False)
    for spec in request.layer_masks:
        if spec.dataset not in dataset.data_vars:
            raise ValueError(f"Unknown mask layer: {spec.dataset}")
        mask = dataset[spec.dataset]
        if not {"x", "y"}.issubset(mask.dims) or not {"x", "y"}.issubset(mask.coords):
            raise ValueError("Mask requires explicit native x/y pixel centers")
        _linear(mask.dtype, None)
        dim = _axis(mask)
        mask = mask.sortby("x").sortby("y", ascending=False)
        mask = align_mask(source, mask)
        if _crs(mask, crs) != CRS.from_user_input(crs):
            raise ValueError("Masks must share the exact native data grid and CRS")

        stored = dataset[spec.dataset].encoding.get("preferred_chunks", {})
        kept: dict[str, Any] = {"key": None, "values": None}

        def read(index, rows, cols, mask=mask, dim=dim, stored=stored, kept=kept):
            window = (rows.start, rows.stop, cols.start, cols.stop)
            part = mask.isel(y=rows, x=cols)
            if dim is None:
                # A static mask is the same at every date: read its window once.
                if kept["key"] != window:
                    values = _values(part.transpose("y", "x").values, mask.attrs)
                    kept.update(key=window, values=values)
                return kept["values"]
            # A mask along the data's axis: whole time chunks at a time, since
            # reading one date decodes every date stored in its chunks.
            pixels = max(1, (rows.stop - rows.start) * (cols.stop - cols.start))
            chunk = max(1, min(int(stored.get(dim) or 1), _READ_BLOCK // pixels))
            start = index - index % chunk
            if kept["key"] != (window, start):
                block = part.isel({dim: slice(start, start + chunk)})
                values = _values(block.transpose(dim, "y", "x").values, mask.attrs)
                kept.update(key=(window, start), values=values)
            return kept["values"][index - start]

        masks.readers.append(read)
        masks.records.append(
            {
                "dataset": spec.dataset,
                "threshold": spec.threshold,
                "operator": ">=" if spec.mode == "min" else "<=",
                "temporal_support": "matching_axis" if dim else "static",
            }
        )
    return masks


def raster_masks(
    groups: dict | None,
    request: PolygonRequest,
    labels: list[str],
    grid: NativeGrid,
) -> PolygonMasks:
    """Prepare same-grid, single-band GeoTIFF masks without temporal clamping."""
    import rasterio  # noqa: PLC0415
    from rasterio.windows import Window  # noqa: PLC0415

    masks = PolygonMasks()
    if not request.layer_masks:
        return masks
    if groups is None:
        raise ValueError("Requested masks require an explicit mask source context")
    for spec in request.layer_masks:
        if spec.mode != "min":
            raise ValueError("GeoTIFF polygon masks currently support only min")
        if spec.dataset not in groups:
            raise ValueError(f"Unknown mask layer: {spec.dataset}")
        group = groups[spec.dataset]
        paths = list(group.file_list)
        if not paths or len(paths) not in (1, len(labels)):
            raise ValueError("Masks must be static or have one file per data slice")
        if len(paths) > 1 and list(map(str, group.x_values)) != labels:
            raise ValueError("Dynamic mask labels must match the selected axis exactly")

        kept: dict[str, Any] = {"key": None, "values": None}

        def read(index, rows, cols, paths=paths, group=group, kept=kept):
            # One file for every date: read its window once.
            window = (rows.start, rows.stop, cols.start, cols.stop)
            if len(paths) == 1 and kept["key"] == window:
                return kept["values"]
            with rasterio.open(paths[0 if len(paths) == 1 else index]) as mask:
                if (
                    NativeGrid(mask.crs, mask.transform, mask.width, mask.height)
                    != grid
                ):
                    raise ValueError(
                        "Masks must share the exact native data grid and CRS"
                    )
                if mask.count != 1:
                    raise ValueError("Masks must be single-band scalar rasters")
                _linear(mask.dtypes[0], None)
                values = _values(
                    mask.read(1, window=Window.from_slices(rows, cols), masked=True)
                )
                if group.nodata is not None:
                    values = np.where(values == group.nodata, np.nan, values)
                if len(paths) == 1:
                    kept.update(key=window, values=values)
                return values

        masks.readers.append(read)
        masks.records.append(
            {
                "dataset": spec.dataset,
                "threshold": spec.threshold,
                "operator": ">",
                "temporal_support": "matching_axis" if len(paths) > 1 else "static",
            }
        )
    return masks
