"""Uploaded GeoZarr masks use native point/windows and bounded reads."""

import numpy as np
import pytest
import rasterio
import rioxarray  # noqa: F401
import xarray as xr
from rasterio.transform import from_origin

from bowser import chart_masking


@pytest.fixture
def native(tmp_path):
    source = xr.DataArray(
        np.zeros((3, 12, 12)),
        dims=("time", "y", "x"),
        coords={"x": 500005 + 10 * np.arange(12), "y": 115 - 10 * np.arange(12)},
    ).rio.write_crs(32631)
    path = tmp_path / "mask.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=12,
        height=12,
        count=1,
        dtype="float32",
        crs=32631,
        transform=from_origin(500000, 120, 10, 10),
        nodata=-9999,
    ) as dst:
        dst.write(np.ones((1, 12, 12), dtype="float32"))
    return source, path


@pytest.mark.parametrize("radius,width", [(None, 1), (11, 5)])
def test_only_requested_mask_window_is_read(native, monkeypatch, radius, width):
    source, path = native
    calls = []
    original = chart_masking.read_native_mask

    def record(path, grid, window):
        calls.append(window)
        return original(path, grid, window)

    monkeypatch.setattr(chart_masking, "read_native_mask", record)
    keep = chart_masking.custom_keep(source, path, 500065, 55, radius)
    assert keep.shape == (width, width) and keep.all()
    assert len(calls) == 1 and calls[0].width == calls[0].height == width


@pytest.mark.parametrize(
    "value,valid", [(0, False), (0.25, True), (-9999, False), (np.inf, False)]
)
def test_md_uploaded_mask_preserves_its_positive_value_rule(native, value, valid):
    source, path = native
    with rasterio.open(path, "r+") as dst:
        values = dst.read(1)
        values[6, 6] = value
        dst.write(values, 1)
    assert chart_masking.custom_keep(source, path, 500065, 55).item() == valid


def test_window_budget_is_checked_before_mask_pixel_reads(native, monkeypatch):
    source, path = native
    monkeypatch.setattr(chart_masking, "MAX_WINDOW_PIXELS", 1)

    def forbidden(*_args):
        raise AssertionError("Mask read before budget check")

    monkeypatch.setattr(chart_masking, "read_native_mask", forbidden)
    with pytest.raises(ValueError, match="budget"):
        chart_masking.custom_keep(source, path, 500065, 55, 11)
