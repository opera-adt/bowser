"""Validate native mask alignment and signed/absolute display thresholds."""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import xarray as xr
from pyproj import CRS
from pyproj.exceptions import CRSError

MASK_MODES = ("min", "max", "abs_min", "abs_max")


def validate_mask_threshold(mode: str, threshold: float) -> None:
    """Require known modes and finite, nonnegative absolute thresholds."""
    if mode not in MASK_MODES or not np.isfinite(threshold):
        raise ValueError(
            "Masks require a finite threshold and min/max/abs_min/abs_max mode"
        )
    if mode.startswith("abs_") and threshold < 0:
        raise ValueError("Absolute mask thresholds must be nonnegative")


def mask_operator(mode: str, *, inclusive_min: bool = True) -> str:
    """Describe comparisons without changing legacy COG strict-min semantics."""
    if mode not in MASK_MODES:
        raise ValueError("Unknown mask mode")
    return {
        "min": ">=" if inclusive_min else ">",
        "max": "<=",
        "abs_min": "|value| >=",
        "abs_max": "|value| <=",
    }[mode]


def _comparison(values: Any, threshold: float, operator: str) -> Any:
    if not np.isfinite(threshold):
        raise ValueError("Mask thresholds must be finite")
    if operator.startswith("|value|"):
        if threshold < 0:
            raise ValueError("Absolute mask thresholds must be nonnegative")
        # Promote before abs: signed integer minima otherwise wrap around.
        values = np.abs(values.astype("float64"))
        operator = operator.removeprefix("|value| ")
    if operator == ">":
        return values > threshold
    if operator == ">=":
        return values >= threshold
    if operator == "<=":
        return values <= threshold
    raise ValueError("Unsupported mask comparison")


def numpy_mask_condition(
    values: np.ndarray, threshold: float, operator: str
) -> np.ndarray:
    """Compare native numeric masks without reviving masked/nonfinite samples."""
    raw = np.ma.getdata(values)
    valid = ~np.ma.getmaskarray(values) & np.isfinite(raw)
    return valid & _comparison(raw, threshold, operator)


def parse_layer_masks(raw: str | list | None) -> list[dict[str, Any]]:
    """Validate explicit layer names, native thresholds and comparison modes."""
    if raw is None or raw == "":
        return []
    masks = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(masks, list):
        raise ValueError("layer_masks must be a JSON list")
    from .polygon import PolygonMask  # noqa: PLC0415

    return [PolygonMask.model_validate(mask).model_dump() for mask in masks]


def _axis(array: xr.DataArray) -> str | None:
    other = [dim for dim in array.dims if dim not in ("x", "y")]
    if len(other) > 1:
        raise ValueError("Masked layers require at most one non-spatial axis")
    return str(other[0]) if other else None


def align_mask(data: xr.DataArray, mask: xr.DataArray) -> xr.DataArray:
    """Require shared spatial coordinates and an explicit matching dynamic axis.

    Validate complete arrays before selecting a date or spatial window. A 2-D
    mask broadcasts over the data record. A dynamic mask requires the same
    non-spatial dimension and coordinates; unrelated axes are not mapped.
    Raster values remain lazy and input arrays are never modified.
    """
    if mask.dtype.kind not in "biuf":
        raise ValueError("Masks must contain real numeric or Boolean values")
    for dim in ("x", "y"):
        if any(
            dim not in array.dims or dim not in array.coords for array in (data, mask)
        ):
            raise ValueError("Masks require explicit x/y coordinates")
        if any(
            array[dim].dims != (dim,) for array in (data, mask)
        ) or not np.array_equal(data[dim].values, mask[dim].values):
            raise ValueError(
                "Mask spatial coordinates must match the selected grid and CRS exactly"
            )
    source_crs = _crs(data, 4326)
    if _crs(mask, source_crs) != source_crs:
        raise ValueError("Masks must share the exact native data grid and CRS")
    axis, mask_axis = _axis(data), _axis(mask)
    if mask_axis is not None and (
        axis is None
        or mask_axis != axis
        or axis not in data.coords
        or mask_axis not in mask.coords
        or not np.array_equal(data[axis].values, mask[mask_axis].values)
    ):
        raise ValueError(
            "Dynamic mask axis and coordinates must match the selected layer "
            "exactly; use a static summary for a static layer"
        )
    return mask


def mask_condition(mask: Any, threshold: float, operator: str) -> Any:
    """Compare finite, non-nodata mask values in native units, preserving zeros."""
    valid = np.isfinite(mask)
    attrs = getattr(mask, "attrs", {})
    for key in ("_FillValue", "missing_value", "fill_value", "nodata"):
        if key in attrs and attrs[key] is not None:
            for value in np.atleast_1d(attrs[key]):
                valid = valid & (mask != value)
    return valid & _comparison(mask, threshold, operator)


def _crs(array: Any, fallback: Any) -> CRS:
    declared = array.encoding.get("grid_mapping") or array.attrs.get("grid_mapping")
    mapping = declared or "spatial_ref"
    if not isinstance(mapping, str):
        raise ValueError("Mask CRS coordinate name must be a string")
    if declared and mapping not in array.coords:
        raise ValueError("Mask declares a missing CRS coordinate")
    try:
        if mapping in array.coords:
            attrs = array[mapping].attrs
            if wkt := attrs.get("crs_wkt") or attrs.get("spatial_ref"):
                return CRS.from_user_input(wkt)
            if attrs.get("grid_mapping_name"):
                return CRS.from_cf(attrs)
        # Variables without a separate declaration inherit their opened cube's CRS.
        return CRS.from_user_input(fallback)
    except CRSError as exc:
        raise ValueError("Mask has invalid CRS metadata") from exc


def compatibility(ds: xr.Dataset, source: xr.DataArray) -> dict[str, str | None]:
    """Describe selectable masks using coordinate metadata, never raster values."""
    result: dict[str, str | None] = {}
    for name, mask in ds.data_vars.items():
        if not {"x", "y"}.issubset(mask.dims):
            continue
        try:
            align_mask(source, mask)
            result[str(name)] = None
        except (ValueError, TypeError) as exc:
            result[str(name)] = str(exc)
    return result
