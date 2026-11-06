"""Known-truth native polygon summaries, bounded reads, and invalid inputs."""

from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
import rioxarray  # noqa: F401
import xarray as xr
from affine import Affine
from pydantic import ValidationError

from bowser import polygon
from bowser.polygon import PolygonRequest, summarize_rasters, summarize_xarray


def rectangle(west=10.01, south=45.01, east=10.07, north=45.07):
    return [[west, south], [east, south], [east, north], [west, north], [west, south]]


def geometry(holes=False):
    rings = [rectangle()]
    if holes:
        rings.append(rectangle(10.03, 45.03, 10.05, 45.05))
    return {"type": "Polygon", "coordinates": rings}


@pytest.fixture
def source():
    values = np.stack([np.arange(64).reshape(8, 8) + i * 10 for i in range(3)]).astype(
        "float32"
    )
    values[:, 1, 1] = np.nan
    values[1, 2, 2] = np.nan
    values[:, 5, 5] = 0
    return xr.DataArray(
        values,
        dims=("date", "y", "x"),
        coords={
            "date": [0, 1, 2],
            "x": 10.005 + 0.01 * np.arange(8),
            "y": 45.075 - 0.01 * np.arange(8),
        },
        attrs={"units": "meters"},
    ).rio.write_crs(4326)


def group_from(source, directory):
    files = []
    for index in range(source.sizes["date"]):
        path = directory / f"displacement_{index}.tif"
        source.isel(date=index).rio.write_nodata(np.nan).rio.to_raster(path)
        files.append(str(path))
    return SimpleNamespace(file_list=files, nodata=None, x_values=["a", "b", "c"])


@pytest.mark.parametrize("storage", ["md", "cog"])
@pytest.mark.parametrize("support", ["common", "per_date"])
@pytest.mark.parametrize("holes", [False, True])
def test_truth_support_holes_zero_and_statistics(
    source, tmp_path, storage, support, holes
):
    request = PolygonRequest(
        variable="displacement",
        geometry=geometry(holes),
        support=support,
        percentiles=[90, 10, 10],
    )
    before = source.copy(deep=True)
    if storage == "md":
        result = summarize_xarray(source, request, ["a", "b", "c"])
    else:
        result = summarize_rasters(group_from(source, tmp_path), request)
    selected = np.zeros((8, 8), bool)
    selected[1:7, 1:7] = True
    if holes:
        selected[3:5, 3:5] = False
    frames = source.values[:, selected]
    common = np.isfinite(frames).all(axis=0)
    assert result["polygon_pixels"] == selected.sum()
    assert result["common_pixels"] == common.sum()
    assert result["valid_per_date"] == np.isfinite(frames).sum(axis=1).tolist()
    for i, row in enumerate(result["statistics"]):
        values = (
            frames[i, common]
            if support == "common"
            else frames[i, np.isfinite(frames[i])]
        )
        assert row["count"] == len(values)
        assert row["minimum"] == 0  # source-valid zero participates in statistics
        for key, function in (
            ("mean", np.mean),
            ("median", np.median),
            ("spatial_std", np.std),
            ("maximum", np.max),
        ):
            assert row[key] == pytest.approx(function(values.astype(float)), rel=1e-12)
        assert row["percentiles"] == {
            f"{p:g}": pytest.approx(np.percentile(values, p)) for p in (10, 90)
        }
    assert result["reference"] == "stored"
    assert result["optional_masks_applied"] is False
    assert result["component_compatibility"] == "unverified"
    assert result["labels"] == ["a", "b", "c"]
    assert result["units"] == "meters"
    xr.testing.assert_identical(source, before)


@pytest.mark.parametrize(
    "reverse_x,reverse_y,transpose",
    [(True, False, False), (False, True, False), (True, True, True)],
)
def test_axis_directions_and_dimension_order(source, reverse_x, reverse_y, transpose):
    request = PolygonRequest(variable="field", geometry=geometry(True))
    expected = summarize_xarray(source, request, ["a", "b", "c"])
    if reverse_x:
        source = source.isel(x=slice(None, None, -1))
    if reverse_y:
        source = source.isel(y=slice(None, None, -1))
    if transpose:
        source = source.transpose("x", "date", "y")
    actual = summarize_xarray(source, request, ["a", "b", "c"])
    for actual_row, expected_row in zip(actual["statistics"], expected["statistics"]):
        # Reversing row order changes floating reduction order by a few ULPs.
        # Only std uses a numeric comparison; counts and other values are exact.
        np.testing.assert_allclose(
            actual_row.pop("spatial_std"),
            expected_row.pop("spatial_std"),
            rtol=0,
            atol=1e-12,
        )
        assert actual_row == expected_row


def test_multipolygon_is_union_not_a_filled_bounding_box(source):
    geom = {
        "type": "MultiPolygon",
        "coordinates": [
            [rectangle(10, 45.06, 10.02, 45.08)],
            [rectangle(10.06, 45, 10.08, 45.02)],
        ],
    }
    result = summarize_xarray(
        source, PolygonRequest(variable="field", geometry=geom), ["a", "b", "c"]
    )
    assert result["polygon_pixels"] == 8
    assert result["common_pixels"] == 7


def test_clipping_and_no_data_are_explicit(source):
    geom = {"type": "Polygon", "coordinates": [rectangle(9.99, 44.99, 10.09, 45.09)]}
    request = PolygonRequest(variable="field", geometry=geom)
    source = source * np.nan
    result = summarize_xarray(source, request, ["a", "b", "c"])
    assert result["polygon_pixels"] == 64
    assert result["common_pixels"] == 0
    assert result["statistics"][0]["mean"] is None
    assert result["statistics"][0]["percentiles"] == {"10": None, "90": None}
    assert any("beyond" in warning for warning in result["warnings"])
    assert any("No pixels" in warning for warning in result["warnings"])


@pytest.mark.parametrize("storage", ["md", "cog"])
def test_budget_before_reading_pixels(source, tmp_path, monkeypatch, storage):
    monkeypatch.setattr(polygon, "MAX_WINDOW_PIXELS", 1)
    request = PolygonRequest(variable="field", geometry=geometry())
    with pytest.raises(ValueError, match="budget"):
        if storage == "md":
            summarize_xarray(source, request, ["a", "b", "c"])
        else:
            summarize_rasters(group_from(source, tmp_path), request)


def test_geotiff_reads_only_the_window(source, tmp_path, monkeypatch):
    group = group_from(source, tmp_path)
    opened = rasterio.open
    reads = []

    class RecordingReader:
        def __init__(self, *args, **kwargs):
            self.source = opened(*args, **kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.source.close()

        def __getattr__(self, name):
            return getattr(self.source, name)

        def read(self, *args, **kwargs):
            reads.append(kwargs.get("window"))
            return self.source.read(*args, **kwargs)

    monkeypatch.setattr(polygon.rasterio, "open", RecordingReader)
    summarize_rasters(
        group,
        PolygonRequest(variable="field", geometry=geometry()),
    )
    assert len(reads) == 6
    assert all(w is not None and w.width < 8 and w.height < 8 for w in reads)


def test_geozarr_evaluates_only_intersecting_chunks(source):
    import dask.array as da
    from dask import delayed

    reads = []

    def read(index, row, col):
        reads.append((index, row, col))
        return source.values[index : index + 1, row : row + 2, col : col + 2]

    stack = da.concatenate(
        [
            da.concatenate(
                [
                    da.concatenate(
                        [
                            da.from_delayed(
                                delayed(read)(i, r, c), (1, 2, 2), "float32"
                            )
                            for c in range(0, 8, 2)
                        ],
                        axis=2,
                    )
                    for r in range(0, 8, 2)
                ],
                axis=1,
            )
            for i in range(3)
        ],
        axis=0,
    )
    lazy = source.copy(data=stack)
    geom = {
        "type": "Polygon",
        "coordinates": [rectangle(10.031, 45.041, 10.039, 45.049)],
    }
    result = summarize_xarray(
        lazy, PolygonRequest(variable="field", geometry=geom), ["a", "b", "c"]
    )
    assert result["polygon_pixels"] == 1
    assert len(reads) == 6
    assert set(reads) == {(i, 2, 2) for i in range(3)}


@pytest.mark.parametrize(
    "units,dtype",
    [("radians", "float32"), ("degrees", "float32"), ("meters", "complex64")],
)
def test_unsupported_linear_mean_fields(source, units, dtype):
    source = source.astype(dtype).assign_attrs(units=units)
    with pytest.raises(ValueError, match="angular|Complex"):
        summarize_xarray(
            source,
            PolygonRequest(variable="field", geometry=geometry()),
            ["a", "b", "c"],
        )


def test_finite_nodata_static_and_unknown_units(source):
    source = source.isel(date=0).copy()
    source.attrs = {"missing_value": -9999}
    source.values[2, 2] = -9999
    result = summarize_xarray(
        source, PolygonRequest(variable="field", geometry=geometry()), ["Stored layer"]
    )
    assert result["valid_per_date"] == [34]
    assert result["units"] is None
    assert result["statistics"][0]["minimum"] == 0
    assert any("units are unknown" in w for w in result["warnings"])


def test_missing_coordinates_cannot_be_inferred_from_array_indices():
    source = xr.DataArray(np.arange(64).reshape(8, 8), dims=("y", "x")).rio.write_crs(
        4326
    )
    geom = {"type": "Polygon", "coordinates": [rectangle(1, 1, 3, 3)]}
    with pytest.raises(ValueError, match="explicit x/y"):
        summarize_xarray(
            source, PolygonRequest(variable="field", geometry=geom), ["Stored layer"]
        )


def test_close_percentiles_retain_distinct_keys(source):
    percentiles = [2.0000001, 2.0000002]
    request = PolygonRequest(
        variable="field", geometry=geometry(), percentiles=percentiles
    )
    result = summarize_xarray(source, request, ["a", "b", "c"])
    assert set(result["statistics"][0]["percentiles"]) == {str(p) for p in percentiles}


@pytest.mark.parametrize("change", ["units", "transform", "crs"])
def test_raster_group_incompatibility_rejected(source, tmp_path, change):
    group = group_from(source, tmp_path)
    with rasterio.open(group.file_list[1], "r+") as src:
        if change == "units":
            src.set_band_unit(1, "centimeters")
        elif change == "transform":
            src.transform = src.transform * Affine.translation(0.1, 0)
        else:
            src.crs = "EPSG:3857"
    with pytest.raises(ValueError, match="units|grid"):
        summarize_rasters(group, PolygonRequest(variable="field", geometry=geometry()))


@pytest.mark.parametrize(
    "updates",
    [
        {"support": "fake"},
        {"percentiles": []},
        {"percentiles": [-1]},
        {"percentiles": [float("nan")]},
        {"percentiles": [101]},
        {"ref_lon": 10},
        {"layer_masks": []},
        {"custom_mask_path": "mask.tif"},
        {"geometry": {"type": "Point", "coordinates": [10, 45]}},
        {"geometry": {"type": "Polygon", "coordinates": []}},
        {"geometry": {"type": "Polygon", "coordinates": [rectangle()[:-1]]}},
        {
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]],
            }
        },
        {"geometry": {"type": "Polygon", "coordinates": [rectangle(-179, 0, 179, 1)]}},
    ],
)
def test_invalid_or_unsupported_requests_are_explicit(updates):
    with pytest.raises(ValidationError):
        PolygonRequest.model_validate(
            {"variable": "field", "geometry": geometry(), **updates}
        )
