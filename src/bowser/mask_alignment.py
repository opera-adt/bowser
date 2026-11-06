"""Validate GeoZarr mask coordinates without loading raster values."""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import xarray as xr


def parse_layer_masks(raw: str | list | None) -> list[dict[str, Any]]:
    """Validate explicit layer names, native thresholds and comparison modes."""
    if raw is None:
        return []
    masks = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(masks, list):
        raise ValueError("layer_masks must be a JSON list")
    result = []
    for mask in masks:
        if not isinstance(mask, dict):
            raise ValueError("Each layer mask must be an object")
        name = mask.get("dataset")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Each layer mask requires a dataset name")
        try:
            threshold = float(mask.get("threshold", 0.5))
        except (TypeError, ValueError) as exc:
            raise ValueError("Mask thresholds must be finite numbers") from exc
        mode = mask.get("mode", "min")
        if not np.isfinite(threshold) or mode not in ("min", "max"):
            raise ValueError("Masks require finite thresholds and min/max mode")
        result.append({"dataset": name, "threshold": threshold, "mode": mode})
    return result


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
                "Mask spatial coordinates must match the selected grid exactly"
            )
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


def mask_condition(mask: xr.DataArray, threshold: float, operator: str) -> xr.DataArray:
    """Compare finite, non-nodata mask values in native units, preserving zeros."""
    if not np.isfinite(threshold):
        raise ValueError("Mask thresholds must be finite")
    if operator not in (">", ">=", "<="):
        raise ValueError("Unsupported mask comparison")
    valid = np.isfinite(mask)
    for key in ("_FillValue", "missing_value", "fill_value", "nodata"):
        if key in mask.attrs and mask.attrs[key] is not None:
            for value in np.atleast_1d(mask.attrs[key]):
                valid = valid & (mask != value)
    comparison = (
        mask > threshold
        if operator == ">"
        else mask >= threshold
        if operator == ">="
        else mask <= threshold
    )
    return valid & comparison
