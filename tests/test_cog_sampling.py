"""Exercise native GeoTIFF chart support, geometry and bounded reads."""

from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
from affine import Affine
from pyproj import Transformer
from rasterio.transform import from_origin

from bowser import cog_sampling
from bowser.cog_sampling import CogSampler, OutsideRasterError


@pytest.fixture
def inputs(tmp_path):
    transform = from_origin(500000, 50, 10, 10)
    values = np.arange(25, dtype="float32").reshape(5, 5)
    values[2, 2] = 0
    quality = np.ones_like(values)
    quality[2, 3] = 0.5
    quality[1, 2] = 0
    groups = {}
    for name, field in (("data", values), ("quality", quality)):
        paths = []
        for index in range(3):
            path = tmp_path / f"{name}_{index}.tif"
            with rasterio.open(
                path,
                "w",
                driver="GTiff",
                width=5,
                height=5,
                count=1,
                dtype="float32",
                crs="EPSG:32631",
                transform=transform,
                nodata=-9999,
            ) as dst:
                data = field * (index + 1) if name == "data" else field.copy()
                if name == "quality" and index == 1:
                    data[2, 2] = 0
                dst.write(data, 1)
            paths.append(str(path))
        groups[name] = SimpleNamespace(
            file_list=paths, x_values=["a", "b", "c"], nodata=None
        )
    return groups, transform


def position(transform, row=2, col=2):
    x, y = transform * (col + 0.5, row + 0.5)
    return Transformer.from_crs(32631, 4326, always_xy=True).transform(x, y)


@pytest.mark.parametrize(
    "mode,expected", [("min", [0, np.nan, 0]), ("max", [np.nan, 0, np.nan])]
)
def test_dynamic_masks_and_valid_zero(inputs, mode, expected):
    groups, transform = inputs
    sampler = CogSampler(
        groups["data"], groups, [{"dataset": "quality", "threshold": 0.5, "mode": mode}]
    )
    np.testing.assert_allclose(
        sampler.point(*position(transform)), expected, equal_nan=True
    )


def test_single_slice_reads_only_requested_data_and_mask(inputs, monkeypatch):
    groups, transform = inputs
    sampler = CogSampler(groups["data"], groups, [{"dataset": "quality"}])
    calls = []
    original = sampler._read

    def record(path, window, *args, **kwargs):
        calls.append((path, window.width, window.height))
        return original(path, window, *args, **kwargs)

    monkeypatch.setattr(sampler, "_read", record)
    assert sampler.point(*position(transform), index=2).tolist() == [0]
    assert calls == [
        (groups["data"].file_list[2], 1, 1),
        (groups["quality"].file_list[2], 1, 1),
    ]


@pytest.mark.parametrize(
    "change", ["short", "reversed", "empty", "static_data_dynamic_mask"]
)
def test_axes_not_guessed(inputs, change):
    groups, _ = inputs
    if change == "short":
        groups["quality"].file_list = groups["quality"].file_list[:2]
    if change == "reversed":
        groups["quality"].x_values = ["c", "b", "a"]
    if change == "empty":
        groups["quality"].file_list = []
    if change == "static_data_dynamic_mask":
        groups["data"].file_list = groups["data"].file_list[:1]
        groups["data"].x_values = ["a"]
    with pytest.raises(ValueError):
        CogSampler(groups["data"], groups, [{"dataset": "quality"}])


def test_static_mask_reused_and_all_nodata_stays_missing(inputs):
    groups, transform = inputs
    groups["quality"].file_list = groups["quality"].file_list[:1]
    with rasterio.open(groups["quality"].file_list[0], "r+") as src:
        values = src.read(1)
        values[2, 2] = -9999
        src.write(values, 1)
    sampler = CogSampler(
        groups["data"],
        groups,
        [{"dataset": "quality", "mode": "max", "threshold": 0.5}],
    )
    assert np.isnan(sampler.point(*position(transform))).all()


def test_source_internal_mask_and_configured_sentinel_are_retained(inputs):
    groups, transform = inputs
    with rasterio.open(groups["data"].file_list[0], "r+") as src:
        mask = np.full((5, 5), 255, dtype="uint8")
        mask[2, 2] = 0
        src.write_mask(mask)
    sampler = CogSampler(groups["data"], groups, [])
    assert np.isnan(sampler.point(*position(transform))[0])
    groups["data"].nodata = 0
    assert np.isnan(
        CogSampler(groups["data"], groups, []).point(*position(transform))
    ).all()


@pytest.mark.parametrize("kind", ["shift", "crs", "data_grid", "complex", "nonfinite"])
def test_invalid_raster_support_cannot_silently_pass(inputs, kind):
    groups, transform = inputs
    path = (
        groups["data"].file_list[1]
        if kind == "data_grid"
        else groups["quality"].file_list[0]
    )
    if kind == "complex":
        with rasterio.open(path) as src:
            profile = src.profile
        profile["dtype"] = "complex64"
        with rasterio.open(path, "w", **profile) as dst:
            dst.write(np.ones((1, 5, 5), dtype="complex64"))
    else:
        with rasterio.open(path, "r+") as src:
            if kind in ("shift", "data_grid"):
                src.transform = transform * Affine.translation(1, 0)
            if kind == "crs":
                src.crs = "EPSG:3857"
            if kind == "nonfinite":
                values = src.read(1)
                values[2, 2] = np.inf
                src.write(values, 1)
    sampler = CogSampler(groups["data"], groups, [{"dataset": "quality"}])
    if kind == "nonfinite":
        assert np.isnan(sampler.point(*position(transform))[0])
    else:
        with pytest.raises(ValueError):
            sampler.point(*position(transform))


def test_buffer_geometry_metric_units_and_valid_samples(inputs):
    groups, transform = inputs
    sampler = CogSampler(groups["data"], groups, [])
    original = sampler.buffer(*position(transform), 11)
    assert original.shape == (3, 5)
    np.testing.assert_array_equal(original[0], [7, 11, 0, 13, 17])
    for radius in (0, -1, np.nan, np.inf):
        with pytest.raises(ValueError):
            sampler.buffer(*position(transform), radius)
    with pytest.raises(OutsideRasterError):
        sampler.buffer(20, 20, 1)
    with pytest.raises(OutsideRasterError):
        sampler.point(20, 20)


def test_buffer_budget_precedes_pixel_reads(inputs, monkeypatch):
    groups, transform = inputs
    sampler = CogSampler(groups["data"], groups, [{"dataset": "quality"}])
    monkeypatch.setattr(cog_sampling, "MAX_PIXEL_EPOCHS", 1)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Raster values read before budget validation")

    monkeypatch.setattr(sampler, "_read", forbidden)
    with pytest.raises(ValueError, match="budget"):
        sampler.buffer(*position(transform), 11)


@pytest.mark.parametrize(
    "transform",
    [
        Affine(10, 0, 500000, 0, 10, 0),
        Affine.translation(500000, 50) * Affine.rotation(15) * Affine.scale(10, -10),
    ],
)
def test_buffer_uses_native_affine_for_reversed_or_rotated_grids(inputs, transform):
    groups, _ = inputs
    for group in groups.values():
        for path in group.file_list:
            with rasterio.open(path, "r+") as src:
                src.transform = transform
    sampler = CogSampler(groups["data"], groups, [])
    np.testing.assert_array_equal(
        sampler.buffer(*position(transform), 11)[0], [7, 11, 0, 13, 17]
    )


def test_geographic_degrees_are_not_interpreted_as_meters(inputs):
    groups, _ = inputs
    for path in groups["data"].file_list:
        with rasterio.open(path, "r+") as src:
            src.crs = "EPSG:4326"
    sampler = CogSampler(groups["data"], groups, [])
    with pytest.raises(ValueError, match="projected CRS in meters"):
        sampler.buffer(10, 20, 11)


@pytest.mark.parametrize(
    "masks",
    [
        [None],
        [{"dataset": ""}],
        [{"dataset": "quality", "mode": "abs_max"}],
        [{"dataset": "quality", "threshold": None}],
        [{"dataset": "quality", "threshold": np.inf}],
        [{"dataset": "quality"}] * 11,
    ],
)
def test_invalid_mask_specs_are_rejected(inputs, masks):
    groups, _ = inputs
    with pytest.raises(ValueError):
        CogSampler(groups["data"], groups, masks)
