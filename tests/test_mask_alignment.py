"""Validate dynamic mask support without resampling or eager raster reads."""

import numpy as np
import pytest
import xarray as xr

from bowser.mask_alignment import align_mask, mask_condition, parse_layer_masks


def arrays(axis="time"):
    labels = (
        np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
        if axis == "time"
        else ["a_b", "b_c", "a_c"]
    )
    data = xr.DataArray(
        np.arange(12).reshape(3, 2, 2),
        dims=(axis, "y", "x"),
        coords={axis: labels, "x": [5, 15], "y": [15, 5]},
    )
    mask = xr.ones_like(data, dtype="float32")
    mask.values[:, 0, 0] = [1, 0, 1]
    return data, mask


@pytest.mark.parametrize("axis", ["time", "pair"])
@pytest.mark.parametrize("transpose", [False, True])
def test_each_explicit_date_or_pair_uses_its_own_support(axis, transpose):
    data, mask = arrays(axis)
    if transpose:
        mask = mask.transpose("x", axis, "y")
    original = data.copy(deep=True)
    adjusted = data.where(mask_condition(align_mask(data, mask), 0.5, ">="))
    np.testing.assert_allclose(adjusted.isel(y=0, x=0), [0, np.nan, 8], equal_nan=True)
    xr.testing.assert_identical(data, original)
    assert adjusted.dims == data.dims


def test_static_mask_broadcasts_but_one_element_dynamic_axis_is_not_static():
    data, mask = arrays()
    static = mask.isel(time=0, drop=True)
    assert align_mask(data, static).dims == ("y", "x")
    with pytest.raises(ValueError, match="Dynamic mask"):
        align_mask(data, mask.isel(time=slice(0, 1)))
    with pytest.raises(ValueError, match="Dynamic mask"):
        align_mask(data.isel(time=0, drop=True), mask)


@pytest.mark.parametrize(
    "change",
    [
        "shifted",
        "reversed",
        "short",
        "different_axis",
        "unlabeled",
        "spatial",
        "missing_spatial",
        "extra_axis",
        "complex",
    ],
)
def test_incompatible_axes_are_rejected_instead_of_aligned_by_xarray(change):
    data, mask = arrays()
    if change == "shifted":
        mask = mask.assign_coords(time=mask.time + np.timedelta64(1, "D"))
    if change == "reversed":
        mask = mask.isel(time=slice(None, None, -1))
    if change == "short":
        mask = mask.isel(time=slice(0, 2))
    if change == "different_axis":
        mask = mask.rename(time="quality_time")
    if change == "unlabeled":
        mask = mask.drop_vars("time")
    if change == "spatial":
        mask = mask.assign_coords(x=mask.x + 1)
    if change == "missing_spatial":
        mask = mask.drop_vars("x")
    if change == "extra_axis":
        mask = mask.expand_dims(band=[1])
    if change == "complex":
        mask = mask.astype("complex64")
    with pytest.raises(ValueError):
        align_mask(data, mask)


@pytest.mark.parametrize(
    "operator,expected",
    [
        (">=", [False, False, False, True, True, True]),
        ("<=", [False, False, False, True, False, False]),
        (">", [False, False, False, False, True, True]),
    ],
)
def test_mask_nodata_nonfinite_equality_and_legitimate_zero(operator, expected):
    mask = xr.DataArray(
        [-9999, np.nan, np.inf, 0, 0.5, 1], dims="x", attrs={"_FillValue": -9999}
    )
    np.testing.assert_array_equal(mask_condition(mask, 0, operator), expected)


@pytest.mark.parametrize(
    "raw",
    [
        "{broken",
        {},
        [3],
        [{"dataset": ""}],
        [{"dataset": "q", "threshold": None}],
        [{"dataset": "q", "threshold": np.inf}],
        [{"dataset": "q", "mode": "invalid"}],
    ],
)
def test_invalid_requests_cannot_disappear(raw):
    with pytest.raises(ValueError):
        parse_layer_masks(raw)


def test_defaults_native_thresholds_and_input_immutability():
    raw = [{"dataset": "q"}]
    assert parse_layer_masks(raw) == [{"dataset": "q", "threshold": 0.5, "mode": "min"}]
    assert raw == [{"dataset": "q"}]
    assert (
        parse_layer_masks('[{"dataset":"q","threshold":-2,"mode":"max"}]')[0][
            "threshold"
        ]
        == -2
    )
    assert parse_layer_masks(None) == []


def test_selected_slice_does_not_read_other_mask_or_data_dates():
    import dask.array as da
    from dask import delayed

    calls = []

    def frame(kind, index):
        calls.append((kind, index))
        return np.full((2, 2), index if kind == "data" else 1, dtype="float32")

    data, mask = arrays()
    data.data = da.stack(
        [
            da.from_delayed(delayed(frame)("data", i), shape=(2, 2), dtype="float32")
            for i in range(3)
        ]
    )
    mask.data = da.stack(
        [
            da.from_delayed(delayed(frame)("mask", i), shape=(2, 2), dtype="float32")
            for i in range(3)
        ]
    )
    adjusted = data.where(mask_condition(align_mask(data, mask), 0.5, ">="))
    assert calls == []
    np.testing.assert_array_equal(
        adjusted.isel(time=1, x=0, y=0).compute(scheduler="synchronous"), 1
    )
    assert sorted(calls) == [("data", 1), ("mask", 1)]


def test_mask_validation_does_not_read_raster_values_on_failure():
    import dask.array as da
    from dask import delayed

    def forbidden():
        raise AssertionError("Raster was read before axis validation")

    data, mask = arrays()
    mask.data = da.from_delayed(delayed(forbidden)(), shape=(3, 2, 2), dtype="float32")
    with pytest.raises(ValueError, match="Dynamic mask"):
        align_mask(data, mask.rename(time="ministack"))
