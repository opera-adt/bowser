"""Select the pixels of a spatial reference and compute the value it subtracts.

A reference is a point (one pixel) or a circle (the pixels whose centres lie
within ``buffer_m`` of it). The page's point and time-series endpoints and the
GeoTIFF export all go through :func:`select_reference` and
:func:`reference_median`, so an exported raster is referenced exactly like the
map and its charts.
"""

from __future__ import annotations

import warnings
from typing import Any, Literal, NamedTuple

import numpy as np
import xarray as xr
from pyproj import CRS, Transformer

PointMethod = Literal["nearest", "containing"]


class ReferencePixels(NamedTuple):
    """Pixels a reference selects.

    Attributes
    ----------
    values : numpy.ndarray
        Data of the window around the reference, shape ``(..., ny, nx)``: the
        leading (e.g. time) dimensions of the source in their order, then y, x.
    inside : numpy.ndarray
        Boolean ``(ny, nx)``: True for the window pixels the reference selects.

    """

    values: np.ndarray
    inside: np.ndarray


def select_point(
    da: xr.DataArray, cx: float, cy: float, method: PointMethod = "nearest"
) -> ReferencePixels:
    """Select the one pixel at ``(cx, cy)`` (in the CRS of ``da``).

    ``"nearest"`` takes the nearest x and y coordinate, as the GeoZarr reader
    does. ``"containing"`` takes the raster pixel containing the position, as
    rasterio does for GeoTIFFs; they differ only on pixel boundaries.

    Raises
    ------
    ValueError
        For ``"containing"`` when the position is outside the raster.

    """
    if method == "containing":
        # Imported here: bowser-lite reuses this module and runs without rasterio.
        from rasterio.transform import rowcol  # noqa: PLC0415

        row, col = rowcol(da.rio.transform(), cx, cy)
        if not (0 <= row < da.sizes["y"] and 0 <= col < da.sizes["x"]):
            raise ValueError("Reference position is outside the source raster")
        pixel = da.isel(y=[row], x=[col])
    else:
        pixel = da.sel(x=[cx], y=[cy], method="nearest")
    values = np.asarray(pixel.transpose(..., "y", "x").values)
    return ReferencePixels(values, np.ones((1, 1), dtype=bool))


def select_circle(
    da: xr.DataArray,
    cx: float,
    cy: float,
    radius: float,
    *,
    margin_window: bool = False,
    sqrt_distance: bool = False,
) -> ReferencePixels | None:
    """Select the pixels whose centre lies within ``radius`` of ``(cx, cy)``.

    Only the window around the circle is read, so a reference patch does not
    load a whole native-resolution cube.

    Parameters
    ----------
    da : xarray.DataArray
        ``(..., y, x)`` raster with pixel-centre coordinates.
    cx, cy : float
        Circle centre in the CRS of ``da``.
    radius : float
        Radius in the units of the x/y coordinates.
    margin_window : bool
        The viewer's window: label slices one pixel wider than the circle,
        written for ascending x and descending y. Returns ``None`` when that
        window misses the grid, so the caller can fall back or report it.
        Otherwise the window is the rows/columns within ``radius`` of the
        centre, for either axis direction.
    sqrt_distance : bool
        Test ``sqrt(dx² + dy²) <= radius`` (the viewer) instead of
        ``dx² + dy² <= radius²`` (the export). Equal in exact arithmetic; the
        two can differ by rounding for a pixel centre exactly on the rim.

    """
    if margin_window:
        res_x = float(abs(da.x[1] - da.x[0])) if da.x.size > 1 else 1.0
        res_y = float(abs(da.y[1] - da.y[0])) if da.y.size > 1 else 1.0
        x_slice = da.x.sel(x=slice(cx - radius - res_x, cx + radius + res_x))
        y_slice = da.y.sel(y=slice(cy + radius + res_y, cy - radius - res_y))
        if x_slice.size == 0 or y_slice.size == 0:
            return None
        window = da.sel(x=x_slice, y=y_slice)
    else:
        cols = np.flatnonzero(np.abs(da.x.values - cx) <= radius)
        rows = np.flatnonzero(np.abs(da.y.values - cy) <= radius)
        window = da.isel(x=cols, y=rows)
    window = window.transpose(..., "y", "x")
    if sqrt_distance:
        xx, yy = np.meshgrid(window.x.values, window.y.values)
        inside = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) <= radius
    else:
        inside = (window.y.values[:, None] - cy) ** 2 + (
            window.x.values[None, :] - cx
        ) ** 2 <= radius**2
    return ReferencePixels(np.asarray(window.values), inside)


def select_reference(
    da: xr.DataArray,
    cx: float,
    cy: float,
    buffer_m: float = 0.0,
    *,
    point_method: PointMethod = "nearest",
    margin_window: bool = False,
    sqrt_distance: bool = False,
) -> ReferencePixels | None:
    """Select a reference: a circle when ``buffer_m > 0``, else one pixel.

    See :func:`select_point` and :func:`select_circle` for the parameters.
    """
    if buffer_m > 0:
        return select_circle(
            da,
            cx,
            cy,
            buffer_m,
            margin_window=margin_window,
            sqrt_distance=sqrt_distance,
        )
    return select_point(da, cx, cy, point_method)


def pool(values: np.ndarray, inside: np.ndarray) -> np.ndarray:
    """Return ``(N, n_window)``: the first axis of ``values``, then its pixels.

    Pixels not ``inside`` become NaN. The first axis is the series (time) axis
    of a ``(N, ny, nx)`` window; a 2-D ``(ny, nx)`` window (a layer without a
    time axis) is one step, ``N = 1``.
    """
    if values.ndim == inside.ndim:
        values = values[np.newaxis]
    return np.where(inside, values, np.nan).reshape(values.shape[0], -1)


def reference_median(pooled: np.ndarray) -> np.ndarray:
    """Median of the non-NaN pixels for each row of a :func:`pool` array.

    A row with no valid pixel gives NaN.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(pooled, axis=1)


class SourceGrid(NamedTuple):
    """Georeferencing of a reference source, as its ``.rio`` accessor gives it.

    Attributes
    ----------
    crs : Any
        The source's CRS (anything pyproj reads), or None.
    bounds : tuple of float
        ``(left, bottom, right, top)`` of the pixel edges.
    nodata : float or None
        The value marking missing pixels in the decoded data.

    """

    crs: Any
    bounds: tuple[float, float, float, float]
    nodata: Any


def reference_offset(
    source: xr.DataArray,
    lon: float,
    lat: float,
    buffer_m: float = 0.0,
    *,
    point_method: PointMethod = "nearest",
    grid: SourceGrid | None = None,
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
    grid : SourceGrid, optional
        CRS, bounds and nodata of ``source``. Read from its ``.rio`` accessor
        when omitted; bowser-lite, which has no rioxarray, passes them.

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
    if grid is None:
        grid = SourceGrid(source.rio.crs, source.rio.bounds(), source.rio.nodata)
    if grid.crs is None:
        raise ValueError("Reference export requires a source CRS")
    if np.issubdtype(source.dtype, np.complexfloating):
        raise ValueError("Reference export requires real-valued data")
    crs = CRS.from_user_input(grid.crs)
    cx, cy = Transformer.from_crs(4326, crs, always_xy=True).transform(lon, lat)
    left, bottom, right, top = grid.bounds
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
        method = "circular_median"
    else:
        method = f"{point_method}_pixel"
    # The exact window (either axis direction) and the squared-distance test.
    selected = select_reference(source, cx, cy, buffer_m, point_method=point_method)
    assert selected is not None  # only the viewer's margin window can miss
    values = np.asarray(selected.values, dtype=float)
    valid = selected.inside & np.isfinite(values)
    nodata = grid.nodata
    if nodata is not None and np.isfinite(nodata):
        valid &= values != nodata
    n_valid = int(np.count_nonzero(valid))
    if n_valid == 0:
        raise ValueError(
            "Reference contains no valid source pixels; select another reference"
        )
    offset = float(reference_median(pool(values[np.newaxis], valid))[0])
    return offset, {
        "BOWSER_REFERENCE_METHOD": method,
        "BOWSER_REFERENCE_LONGITUDE": str(lon),
        "BOWSER_REFERENCE_LATITUDE": str(lat),
        "BOWSER_REFERENCE_BUFFER_METERS": str(buffer_m),
        "BOWSER_REFERENCE_VALUE": str(offset),
        "BOWSER_REFERENCE_VALID_PIXELS": str(n_valid),
        "BOWSER_REFERENCE_OPERATION": "exported_value = stored_value - reference_value",
        "BOWSER_REFERENCE_SUPPORT": "valid source pixels before optional display masks",
    }
