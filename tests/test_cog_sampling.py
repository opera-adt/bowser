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
    original = rasterio.open

    def record(path, *args, **kwargs):
        calls.append(str(path))
        return original(path, *args, **kwargs)

    monkeypatch.setattr(rasterio, "open", record)
    assert sampler.point(*position(transform), index=2).tolist() == [0]
    assert sorted(calls) == sorted(
        [
            groups["data"].file_list[2],
            groups["quality"].file_list[2],
        ]
    )


@pytest.mark.parametrize(
    "change", ["short", "reversed", "empty", "static_data_dynamic_mask"]
)
def test_axes_not_guessed(inputs, change):
    groups, transform = inputs
    if change == "short":
        groups["quality"].file_list = groups["quality"].file_list[:2]
    if change == "reversed":
        groups["quality"].x_values = ["c", "b", "a"]
    if change == "empty":
        groups["quality"].file_list = []
    if change == "static_data_dynamic_mask":
        groups["data"].file_list = groups["data"].file_list[:1]
        groups["data"].x_values = ["a"]
    sampler = CogSampler(groups["data"], groups, [{"dataset": "quality"}])
    assert len(sampler.warnings) == 1
    assert "not applied" in sampler.warnings[0]
    assert sampler.masks.records == []
    np.testing.assert_equal(
        sampler.point(*position(transform)), np.zeros(len(groups["data"].file_list))
    )


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


def test_geographic_circle_uses_meter_distances(inputs):
    groups, _ = inputs
    transform = from_origin(3, 45.0005, 0.0001, 0.0001)
    for path in groups["data"].file_list:
        with rasterio.open(path, "r+") as src:
            src.crs = "EPSG:4326"
            src.transform = transform
    lon, lat = transform * (2.5, 2.5)
    sampler = CogSampler(groups["data"], groups, [])
    # East/west neighbors are ~7.9 m away; north/south ~11.1 m.
    np.testing.assert_array_equal(sampler.buffer(lon, lat, 9)[0], [11, 0, 13])


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


def test_static_mask_window_is_opened_once(inputs, monkeypatch):
    groups, transform = inputs
    groups["quality"].file_list = groups["quality"].file_list[:1]
    sampler = CogSampler(groups["data"], groups, [{"dataset": "quality"}])
    calls = []
    original = rasterio.open

    def record(path, *args, **kwargs):
        calls.append(str(path))
        return original(path, *args, **kwargs)

    monkeypatch.setattr(rasterio, "open", record)
    sampler.buffer(*position(transform), 11)
    assert calls.count(groups["quality"].file_list[0]) == 1
    assert len(calls) == 4


def test_unmasked_point_reads_three_dates_concurrently(inputs, monkeypatch):
    from threading import Barrier

    groups, transform = inputs
    sampler = CogSampler(groups["data"], groups, [])
    barrier = Barrier(3, timeout=5)
    original = sampler._read

    def wait_for_other_readers(*args, **kwargs):
        barrier.wait()
        return original(*args, **kwargs)

    monkeypatch.setattr(sampler, "_read", wait_for_other_readers)
    np.testing.assert_equal(sampler.point(*position(transform)), [0, 0, 0])


def test_geographic_circle_counts_match_geodesic_truth(inputs):
    groups, _ = inputs
    transform = from_origin(-118.4, 33.8, 0.0001, 0.0001)
    for path in groups["data"].file_list:
        with rasterio.open(path, "r+") as src:
            src.crs = "EPSG:4326"
            src.transform = transform
    lon, lat = transform * (2.5, 2.5)
    rows, cols = np.meshgrid(np.arange(5) + 0.5, np.arange(5) + 0.5, indexing="ij")
    xx, yy = transform * (cols, rows)
    from pyproj import Geod

    distance = Geod(ellps="WGS84").inv(
        np.full_like(xx, lon), np.full_like(yy, lat), xx, yy
    )[2]
    inside = distance <= 16
    with rasterio.open(groups["data"].file_list[0]) as src:
        expected = src.read(1)[inside]
    sampler = CogSampler(groups["data"], groups, [])
    np.testing.assert_array_equal(sampler.buffer(lon, lat, 16)[0], expected)


def test_native_buffer_limit_prevents_oversized_ui_requests(tmp_path):
    path = tmp_path / "large.tif"
    # Sparse metadata-only GeoTIFF; no multi-million-pixel array is allocated.
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=3000,
        height=3000,
        count=1,
        dtype="float32",
        crs=32631,
        transform=from_origin(500000, 15000, 5, 5),
        tiled=True,
        sparse_ok=True,
    ):
        pass
    group = SimpleNamespace(
        file_list=[str(path)] * 300, x_values=list(range(300)), nodata=None
    )
    limit = cog_sampling.buffer_limit(group)
    assert 0 < limit < 5000
    sampler = CogSampler(group, {}, [])
    lon, lat = Transformer.from_crs(32631, 4326, always_xy=True).transform(507500, 7500)
    # Independently check the conservative square bound for ten dynamic masks.
    pixels = (int(np.ceil(2 * limit / 5)) + 2) ** 2
    assert pixels * 300 * 11 <= cog_sampling.MAX_PIXEL_EPOCHS
    with pytest.raises(ValueError, match="budget"):
        sampler.buffer(lon, lat, 5000)
