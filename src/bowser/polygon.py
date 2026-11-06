"""Summarize stored scalar rasters on native pixel centers inside a polygon."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

import numpy as np
import rasterio
import xarray as xr
from affine import Affine
from pydantic import BaseModel, ConfigDict, Field, field_validator
from rasterio.errors import WindowError
from rasterio.features import geometry_mask, geometry_window
from rasterio.warp import transform_geom
from rasterio.windows import Window
from rasterio.windows import transform as window_transform
from shapely.geometry import shape

MAX_VERTICES = 10_000
MAX_WINDOW_PIXELS = 2_000_000
MAX_PIXEL_EPOCHS = 50_000_000
_ANGULAR_UNITS = {"degree", "degrees", "deg", "radian", "radians", "rad"}


class PolygonRequest(BaseModel):
    """Request stored-value summaries, without implicit viewer transformations."""

    model_config = ConfigDict(extra="forbid")
    variable: str = Field(min_length=1)
    geometry: dict[str, Any]
    support: Literal["common", "per_date"] = "common"
    percentiles: list[float] = Field(
        default_factory=lambda: [10, 90], min_length=1, max_length=20
    )

    @field_validator("percentiles")
    @classmethod
    def _percentiles(cls, values: list[float]) -> list[float]:
        if not all(np.isfinite(p) and 0 <= p <= 100 for p in values):
            raise ValueError("Percentiles must be finite and within [0, 100]")
        return sorted(set(values))

    @field_validator("geometry")
    @classmethod
    def _geometry(cls, geometry: dict[str, Any]) -> dict[str, Any]:
        kind = geometry.get("type")
        if kind not in ("Polygon", "MultiPolygon"):
            raise ValueError("Supply a GeoJSON Polygon or MultiPolygon geometry")
        polygons = (
            [geometry.get("coordinates")]
            if kind == "Polygon"
            else geometry.get("coordinates")
        )
        if not isinstance(polygons, list) or not polygons:
            raise ValueError("Polygon coordinates are required")
        vertices = 0
        for polygon in polygons:
            if not isinstance(polygon, list) or not polygon:
                raise ValueError("Each polygon requires an exterior ring")
            for ring in polygon:
                if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
                    raise ValueError(
                        "Polygon rings must be closed with at least four positions"
                    )
                vertices += len(ring)
                if vertices > MAX_VERTICES:
                    raise ValueError("Polygon exceeds the 10000-vertex limit")
                for point in ring:
                    if (
                        not isinstance(point, list)
                        or len(point) != 2
                        or any(
                            isinstance(p, bool) or not isinstance(p, (int, float))
                            for p in point
                        )
                        or not np.isfinite(point).all()
                        or not -180 <= point[0] <= 180
                        or not -90 <= point[1] <= 90
                    ):
                        raise ValueError(
                            "Use finite 2-D WGS84 longitude/latitude coordinates"
                        )
        geom = shape(geometry)
        if geom.is_empty or not geom.is_valid:
            raise ValueError("Polygon must be nonempty and topologically valid")
        if geom.bounds[2] - geom.bounds[0] > 180:
            raise ValueError("Antimeridian-spanning polygons are not supported")
        # Ignore foreign GeoJSON members, not geometry holes or separate parts.
        return {"type": kind, "coordinates": geometry["coordinates"]}


@dataclass(frozen=True)
class NativeGrid:
    """Describe the unchanged level-zero raster grid."""

    crs: Any
    transform: Affine
    width: int
    height: int


def _selection(
    grid: NativeGrid, geometry: dict, count: int
) -> tuple[Window, np.ndarray, bool]:
    if grid.crs is None:
        raise ValueError("A source CRS is required")
    native = transform_geom("EPSG:4326", grid.crs, geometry)
    projected = shape(native)
    if (
        projected.is_empty
        or not projected.is_valid
        or not np.isfinite(projected.bounds).all()
    ):
        raise ValueError("Polygon is not valid in the source CRS")
    try:
        full = geometry_window(grid, [native], boundless=True)
        window = full.intersection(Window(0, 0, grid.width, grid.height))
    except WindowError as exc:
        raise ValueError("Polygon does not intersect the source grid") from exc
    pixels = int(window.width * window.height)
    if count < 1 or pixels > MAX_WINDOW_PIXELS or pixels * count > MAX_PIXEL_EPOCHS:
        raise ValueError("Polygon exceeds the bounded native pixel-epoch budget")
    inside = geometry_mask(
        [native],
        out_shape=(int(window.height), int(window.width)),
        transform=window_transform(window, grid.transform),
        invert=True,
        all_touched=False,
    )
    if not inside.any():
        raise ValueError("No native pixel centers lie inside the polygon")
    return window, inside, full != window


def _linear(dtype: Any, units: str | None) -> None:
    if not (
        np.issubdtype(np.dtype(dtype), np.number)
        or np.issubdtype(np.dtype(dtype), np.bool_)
    ):
        raise ValueError("Select a real-valued numeric scalar raster")
    if units is not None and not isinstance(units, str):
        raise ValueError("Source units must be a string or absent")
    if np.issubdtype(np.dtype(dtype), np.complexfloating):
        raise ValueError("Complex rasters require an explicit scalar conversion first")
    if units and units.strip().lower() in _ANGULAR_UNITS:
        raise ValueError(
            "Linear polygon statistics are not appropriate for angular fields"
        )


def _values(array: Any, attrs: dict | None = None) -> np.ndarray:
    values = np.asarray(np.ma.filled(np.ma.asarray(array).astype(float), np.nan))
    # Only undecoded attribute sentinels are compared numerically. Encoded raw
    # fill values may already have been decoded/scaled into physical units.
    for key in ("_FillValue", "missing_value"):
        for missing in np.atleast_1d((attrs or {}).get(key, [])):
            try:
                sentinel = float(missing)
            except (ValueError, TypeError) as exc:
                raise ValueError("Missing-value metadata must be numeric") from exc
            if np.isfinite(sentinel):
                values = np.where(values == sentinel, np.nan, values)
    return np.where(np.isfinite(values), values, np.nan)


def _summaries(
    load: Callable[[int], np.ndarray],
    count: int,
    pixels: int,
    support: str,
    percentiles: list[float],
) -> tuple[list[dict], list[int], int]:
    common = np.ones(pixels, dtype=bool)
    counts = []
    for index in range(count):
        valid = np.isfinite(load(index))
        common &= valid
        counts.append(int(valid.sum()))
    statistics = []
    for index in range(count):
        frame = load(index)
        valid = np.isfinite(frame)
        if support == "common":
            valid &= common
        values = frame[valid]
        statistics.append(
            {
                "count": int(values.size),
                "mean": float(np.mean(values)) if values.size else None,
                "median": float(np.median(values)) if values.size else None,
                "spatial_std": float(np.std(values)) if values.size else None,
                "minimum": float(np.min(values)) if values.size else None,
                "maximum": float(np.max(values)) if values.size else None,
                "percentiles": {
                    (str(int(p)) if float(p).is_integer() else str(p)): float(
                        np.percentile(values, p, method="linear")
                    )
                    if values.size
                    else None
                    for p in percentiles
                },
            }
        )
    return statistics, counts, int(common.sum())


def summarize_xarray(
    source: xr.DataArray,
    request: PolygonRequest,
    labels: list[str],
) -> dict:
    """Summarize a level-zero GeoZarr variable using bounded spatial reads."""
    if not {"x", "y"}.issubset(source.dims):
        raise ValueError("Source requires x/y spatial dimensions")
    if any(axis not in source.coords for axis in ("x", "y")):
        raise ValueError("Source requires explicit x/y pixel-center coordinates")
    extra = [d for d in source.dims if d not in ("x", "y")]
    if len(extra) > 1:
        raise ValueError("Source supports at most one non-spatial axis")
    for axis in (source.x.values, source.y.values):
        delta = np.diff(axis)
        if (
            len(delta) < 1
            or not np.isfinite(axis).all()
            or delta[0] == 0
            or not np.allclose(delta, delta[0], rtol=1e-7, atol=1e-8)
        ):
            raise ValueError("Source requires regular finite x/y pixel centers")
    units = source.attrs.get("units") or None
    _linear(source.dtype, units)
    dim = extra[0] if extra else None
    count = source.sizes[dim] if dim else 1
    grid = NativeGrid(
        source.rio.crs,
        source.rio.transform(recalc=True),
        source.sizes["x"],
        source.sizes["y"],
    )
    if grid.transform.b != 0 or grid.transform.d != 0:
        raise ValueError("GeoZarr statistics require a rectilinear x/y grid")
    window, inside, clipped = _selection(grid, request.geometry, count)
    subset = source.isel(
        y=slice(int(window.row_off), int(window.row_off + window.height)),
        x=slice(int(window.col_off), int(window.col_off + window.width)),
    )

    def load(index: int) -> np.ndarray:
        frame = subset.isel({dim: index}) if dim else subset
        return _values(frame.transpose("y", "x").values, source.attrs)[inside]

    return _result(load, count, inside, clipped, grid, labels, units, request)


def summarize_rasters(group: Any, request: PolygonRequest) -> dict:
    """Summarize identical-grid, identical-unit GeoTIFFs with windowed reads."""
    if not group.file_list:
        raise ValueError("No rasters in the selected layer")
    with rasterio.open(group.file_list[0]) as first:
        grid = NativeGrid(first.crs, first.transform, first.width, first.height)
    window, inside, clipped = _selection(grid, request.geometry, len(group.file_list))
    units: list[str | None] = []

    def load(index: int) -> np.ndarray:
        with rasterio.open(group.file_list[index]) as src:
            if src.count != 1:
                raise ValueError("Select a single-band scalar raster group")
            if NativeGrid(src.crs, src.transform, src.width, src.height) != grid:
                raise ValueError("All rasters must share the exact native grid and CRS")
            unit = (
                src.units[0]
                or src.tags(1).get("units")
                or src.tags().get("units")
                or None
            )
            _linear(src.dtypes[0], unit)
            if units and unit != units[0]:
                raise ValueError(
                    "All rasters must have identical units, including unknown units"
                )
            if not units:
                units.append(unit)
            values = _values(src.read(1, window=window, masked=True))
            if group.nodata is not None:
                values = np.where(values == group.nodata, np.nan, values)
            return values[inside]

    return _result(
        load,
        len(group.file_list),
        inside,
        clipped,
        grid,
        [str(v) for v in group.x_values],
        None,
        request,
        units,
    )


def _result(
    load: Callable[[int], np.ndarray],
    count: int,
    inside: np.ndarray,
    clipped: bool,
    grid: NativeGrid,
    labels: list[str],
    units: str | None,
    request: PolygonRequest,
    raster_units: list | None = None,
) -> dict:
    if len(labels) != count:
        raise ValueError("Labels must match the source axis length")
    statistics, valid_counts, common = _summaries(
        load,
        count,
        int(inside.sum()),
        request.support,
        request.percentiles,
    )
    if raster_units:
        units = raster_units[0]
    warnings = [
        (
            "Stored values: interactive referencing and optional quality masks "
            "are not applied."
        ),
        (
            "Connected-component compatibility is unverified; disconnected offsets "
            "may be ambiguous."
        ),
        (
            "Spatial percentiles and spread are not measurement uncertainty "
            "or proof of ground motion."
        ),
    ]
    if request.support == "per_date":
        warnings.append(
            "Pixel membership changes with date and can change the apparent history."
        )
    if clipped:
        warnings.append(
            "Polygon extends beyond the source grid; "
            "statistics cover on-grid centers only."
        )
    if units is None:
        warnings.append(
            "Source units are unknown; no units or motion interpretation were inferred."
        )
    if not any(row["count"] for row in statistics):
        warnings.append(
            "No pixels satisfy the requested support; no values were fabricated."
        )
    return {
        "variable": request.variable,
        "labels": labels,
        "units": units,
        "geometry": request.geometry,
        "support": request.support,
        "polygon_pixels": int(inside.sum()),
        "valid_per_date": valid_counts,
        "common_pixels": common,
        "statistics": statistics,
        "reference": "stored",
        "optional_masks_applied": False,
        "component_compatibility": "unverified",
        "warnings": warnings,
        "grid": {
            "crs": str(grid.crs),
            "transform": list(grid.transform)[:6],
            "shape": [grid.height, grid.width],
        },
        "calculation": (
            "Unweighted Float64 native-pixel statistics; linear percentiles; "
            "population spatial standard deviation."
        ),
        "selection": (
            "Level-zero pixel centers; polygon holes excluded; "
            "no interpolation, filtering, inversion or new processing."
        ),
    }
