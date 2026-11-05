"""Sample spatial references for native-resolution raster exports."""

from __future__ import annotations

from typing import Literal

import numpy as np
import xarray as xr
from pyproj import CRS, Transformer
from rasterio.transform import rowcol


def reference_offset(
    source: xr.DataArray,
    lon: float,
    lat: float,
    buffer_m: float = 0.0,
    *,
    point_method: Literal["nearest", "containing"] = "nearest",
) -> tuple[float, dict[str, str]]:
    """Sample a point or circular median from an unmasked, 2-D source slice.

    Parameters
    ----------
    source : xarray.DataArray
        Native raster with x/y pixel-center coordinates and a CRS. Source
        nodata is excluded; optional display masks are deliberately not used,
        matching the reference controls' point/buffer time-series requests.
    lon, lat : float
        Requested reference position in WGS84 decimal degrees.
    buffer_m : float
        Circular radius in meters. Zero selects the nearest native pixel.
        A positive radius requires a projected CRS whose axes use meters.
    point_method : {"nearest", "containing"}
        Match the viewer's native point reader: nearest coordinate for GeoZarr,
        containing raster pixel for GeoTIFFs. Only differs at pixel boundaries.

    Returns
    -------
    offset : float
        Value to subtract, in the source layer's units.
    tags : dict[str, str]
        Reference provenance to write into the exported GeoTIFF.

    Raises
    ------
    ValueError
        If the coordinates, grid, CRS, radius, or reference support are invalid.

    """
    if not (np.isfinite(lon) and -180 <= lon <= 180):
        raise ValueError("Reference longitude must be finite and within [-180, 180]")
    if not (np.isfinite(lat) and -90 <= lat <= 90):
        raise ValueError("Reference latitude must be finite and within [-90, 90]")
    if not (np.isfinite(buffer_m) and buffer_m >= 0):
        raise ValueError("Reference buffer radius must be finite and non-negative")
    if source.ndim != 2 or set(source.dims) != {"y", "x"}:
        raise ValueError("Reference export requires a 2-D raster with x/y coordinates")
    if source.rio.crs is None:
        raise ValueError("Reference export requires a source CRS")
    if np.issubdtype(source.dtype, np.complexfloating):
        raise ValueError("Reference export requires real-valued data")
    crs = CRS.from_user_input(source.rio.crs)
    cx, cy = Transformer.from_crs(4326, crs, always_xy=True).transform(lon, lat)
    left, bottom, right, top = source.rio.bounds()
    if not (
        np.isfinite(cx)
        and np.isfinite(cy)
        and left <= cx <= right
        and bottom <= cy <= top
    ):
        raise ValueError("Reference position is outside the source raster")

    if buffer_m > 0:
        if not crs.is_projected or any(
            axis.unit_conversion_factor != 1.0 for axis in crs.axis_info[:2]
        ):
            raise ValueError(
                "Median reference buffers require a projected CRS in meters"
            )
        # Slice before reading values so a reference patch does not load an
        # entire native-resolution GeoZarr. Boolean indices handle either axis
        # direction and do not depend on dimension order.
        cols = np.flatnonzero(np.abs(source.x.values - cx) <= buffer_m)
        rows = np.flatnonzero(np.abs(source.y.values - cy) <= buffer_m)
        patch = source.isel(x=cols, y=rows).transpose("y", "x")
        values = np.asarray(patch.values, dtype=float)
        circle = (patch.y.values[:, None] - cy) ** 2 + (
            patch.x.values[None, :] - cx
        ) ** 2 <= buffer_m**2
        values = values[circle]
        method = "circular_median"
    else:
        if point_method == "containing":
            row, col = rowcol(source.rio.transform(), cx, cy)
            if not (0 <= row < source.sizes["y"] and 0 <= col < source.sizes["x"]):
                raise ValueError("Reference position is outside the source raster")
            pixel = source.isel(y=row, x=col)
        else:
            pixel = source.sel(x=cx, y=cy, method="nearest")
        values = np.atleast_1d(pixel.values).astype(float)
        method = f"{point_method}_pixel"

    valid = np.isfinite(values)
    nodata = source.rio.nodata
    if nodata is not None and np.isfinite(nodata):
        valid &= values != nodata
    values = values[valid]
    if values.size == 0:
        raise ValueError(
            "Reference contains no valid source pixels; select another reference"
        )
    offset = float(np.median(values))
    return offset, {
        "BOWSER_REFERENCE_METHOD": method,
        "BOWSER_REFERENCE_LONGITUDE": str(lon),
        "BOWSER_REFERENCE_LATITUDE": str(lat),
        "BOWSER_REFERENCE_BUFFER_METERS": str(buffer_m),
        "BOWSER_REFERENCE_VALUE": str(offset),
        "BOWSER_REFERENCE_VALID_PIXELS": str(values.size),
        "BOWSER_REFERENCE_OPERATION": "exported_value = stored_value - reference_value",
        "BOWSER_REFERENCE_SUPPORT": "valid source pixels before optional display masks",
    }
