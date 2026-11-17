"""Bounded configured/uploaded polygon masks, using the existing map conventions."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from .polygon import NativeGrid
    from .polygon_masks import PolygonMasks


def attach_mask(
    masks: PolygonMasks,
    paths: list[str],
    grid: NativeGrid,
    threshold: float,
    operator: str,
    *,
    primary: bool,
) -> None:
    """Read one destination window; warp masks only, never measurements."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import Window

    kept: dict[str, Any] = {"key": None, "values": None}

    def read(index: int, rows: slice, cols: slice) -> np.ndarray:
        path = paths[0 if len(paths) == 1 else index]
        key = (path, rows.start, rows.stop, cols.start, cols.stop)
        if kept["key"] != key:
            window = Window(
                cols.start, rows.start, cols.stop - cols.start, rows.stop - rows.start
            )
            try:
                with rasterio.open(path) as src:
                    if (
                        src.count != 1
                        or src.crs is None
                        or np.dtype(src.dtypes[0]).kind not in "biuf"
                    ):
                        raise ValueError(
                            "Polygon masks need a single real-valued band and a CRS"
                        )
                    if (src.crs, src.transform, src.width, src.height) == (
                        grid.crs,
                        grid.transform,
                        grid.width,
                        grid.height,
                    ):
                        values = (
                            src.read(1, window=window, masked=True)
                            .astype(float)
                            .filled(np.nan)
                        )
                    else:
                        # Outside coverage is nodata, never a valid zero.
                        with WarpedVRT(
                            src,
                            crs=grid.crs,
                            transform=grid.transform,
                            width=grid.width,
                            height=grid.height,
                            resampling=Resampling.nearest,
                            dtype="float64",
                            nodata=np.nan,
                        ) as vrt:
                            values = vrt.read(1, window=window, masked=True).filled(
                                np.nan
                            )
            except (OSError, rasterio.errors.RasterioError) as exc:
                raise ValueError(
                    "Could not read the requested polygon mask; no unmasked fallback"
                ) from exc
            if primary:
                values = np.where(values == 0, np.nan, values)
            kept.update(key=key, values=values)
        return np.asarray(kept["values"])

    masks.readers.append(read)
    masks.records.append(
        {
            "dataset": "configured mask" if primary else "uploaded mask",
            "threshold": threshold,
            "operator": operator,
            "temporal_support": "static" if len(paths) == 1 else "matching_axis",
        }
    )
