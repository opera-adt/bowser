"""Absolute display thresholds preserve signs, valid zeros and source support."""

import numpy as np
import pytest
import xarray as xr

from bowser.mask_alignment import mask_condition, parse_layer_masks
from bowser.polygon import PolygonMask


@pytest.mark.parametrize("mode", ["abs_min", "abs_max"])
@pytest.mark.parametrize("threshold", [0, 2, 5])
def test_absolute_modes_are_explicit_and_accepted(mode, threshold):
    raw = {"dataset": "signed_factor", "mode": mode, "threshold": threshold}
    assert parse_layer_masks([raw]) == [raw]
    assert PolygonMask.model_validate(raw).mode == mode


@pytest.mark.parametrize("operator", ["|value| >=", "|value| <="])
@pytest.mark.parametrize("threshold", [0, 5])
def test_absolute_thresholds_compare_both_signs_and_keep_zero(operator, threshold):
    original = xr.DataArray(
        [-9999, -10, -5, -2, 0, 2, 5, 10, np.nan, np.inf, -np.inf],
        dims="x",
        attrs={"_FillValue": -9999},
    )
    before = original.copy(deep=True)
    expected = np.isfinite(original.values) & (original.values != -9999)
    magnitudes = np.abs(original.values)
    expected &= (
        magnitudes >= threshold if operator.endswith(">=") else magnitudes <= threshold
    )
    np.testing.assert_array_equal(
        mask_condition(original, threshold, operator), expected
    )
    xr.testing.assert_identical(original, before)


def test_absolute_integer_minimum_does_not_overflow():
    mask = xr.DataArray(np.array([-32768, -5, 0, 5], dtype="int16"), dims="x")
    np.testing.assert_array_equal(
        mask_condition(mask, 5, "|value| <="), [False, True, True, True]
    )
    np.testing.assert_array_equal(
        mask_condition(mask, 5, "|value| >="), [True, True, False, True]
    )


@pytest.mark.parametrize("mode", ["abs_min", "abs_max"])
@pytest.mark.parametrize("threshold", [-1, np.nan, np.inf])
def test_invalid_absolute_thresholds_are_rejected(mode, threshold):
    with pytest.raises(ValueError):
        parse_layer_masks([{"dataset": "factor", "mode": mode, "threshold": threshold}])
    with pytest.raises(ValueError):
        PolygonMask.model_validate(
            {"dataset": "factor", "mode": mode, "threshold": threshold}
        )


@pytest.mark.parametrize("mode", ["abs_min", "abs_max"])
def test_tool_masks_accept_and_validate_absolute_modes(mode):
    from bowser.tools import LayerMask

    assert LayerMask(dataset="factor", mode=mode, threshold=5).mode == mode
    with pytest.raises(ValueError):
        LayerMask(dataset="factor", mode=mode, threshold=-1)
