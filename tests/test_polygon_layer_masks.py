"""Explicit polygon masks preserve native values and report actual support."""

import hashlib
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rioxarray  # noqa: F401
import xarray as xr
from pyproj import CRS

from bowser.lite.polygon import summarize_cube
from bowser.polygon import PolygonRequest, summarize_rasters, summarize_xarray


@pytest.fixture
def inputs(tmp_path):
    dates = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    values = np.arange(48, dtype="float32").reshape(3, 4, 4)
    values[:, 0, 0] = 0
    values[1, 1, 1] = np.nan
    quality = np.ones_like(values)
    quality[:, 0, 1] = 0.5
    quality[1, 2, 2] = 0
    quality[:, 3, 2] = np.nan
    quality[:, 3, 3] = -9999
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "quality": (("time", "y", "x"), quality, {"missing_value": -9999}),
            "static_quality": (("y", "x"), quality[0], {"missing_value": -9999}),
        },
        coords={
            "time": dates,
            "x": 10.005 + np.arange(4) * 0.01,
            "y": 45.035 - np.arange(4) * 0.01,
        },
    ).rio.write_crs(4326)
    groups = {}
    for name in ds.data_vars:
        da = ds[name]
        frames = [da.isel(time=i) for i in range(3)] if "time" in da.dims else [da]
        paths = []
        for i, frame in enumerate(frames):
            date = str(dates[i])[:10].replace("-", "") if len(frames) > 1 else "static"
            path = tmp_path / f"{name}_{date}.tif"
            frame.rio.write_nodata(
                -9999 if name != "displacement" else np.nan
            ).rio.to_raster(path)
            paths.append(str(path))
        groups[name] = SimpleNamespace(
            file_list=paths,
            nodata=None,
            x_values=[str(d)[:10] for d in dates] if len(paths) > 1 else ["static"],
        )
    body = {
        "variable": "displacement",
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [10, 45],
                    [10.04, 45],
                    [10.04, 45.04],
                    [10, 45.04],
                    [10, 45],
                ]
            ],
        },
    }
    return ds, groups, body


def run(storage, ds, groups, body, **kwargs):
    request = PolygonRequest(**body)
    labels = [str(d)[:10] for d in ds.time.values]
    if storage == "cog":
        return summarize_rasters(
            groups["displacement"], request, mask_groups=groups, **kwargs
        )
    if storage == "lite":
        return summarize_cube(
            ds.displacement,
            CRS.from_epsg(4326),
            request,
            labels,
            mask_dataset=ds,
            **kwargs,
        )
    return summarize_xarray(ds.displacement, request, labels, mask_dataset=ds, **kwargs)


@pytest.mark.parametrize("storage", ["md", "lite", "cog"])
@pytest.mark.parametrize("support", ["common", "per_date"])
@pytest.mark.parametrize("mask_name", ["quality", "static_quality"])
def test_known_truth_masks_counts_zeros_and_unchanged_data(
    inputs, storage, support, mask_name
):
    ds, groups, body = inputs
    before = ds.copy(deep=True)
    hashes = {
        p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
        for group in groups.values()
        for p in group.file_list
    }
    result = run(
        storage,
        ds,
        groups,
        {
            **body,
            "support": support,
            "layer_masks": [
                {"dataset": mask_name, "threshold": 0.5, "mode": "min"},
            ],
        },
    )
    quality = ds[mask_name].values
    keep = np.isfinite(quality) & (quality != -9999)
    keep &= quality > 0.5 if storage == "cog" else quality >= 0.5
    want = np.where(keep, ds.displacement.values, np.nan)
    valid = np.isfinite(want)
    assert result["valid_per_date"] == valid.sum(axis=(1, 2)).tolist()
    assert result["common_pixels"] == valid.all(axis=0).sum()
    assert result["optional_masks_applied"] is True
    assert result["reference"] == "stored"
    assert result["masks"][0]["operator"] == (">" if storage == "cog" else ">=")
    for i, row in enumerate(result["statistics"]):
        selected = valid.all(axis=0) if support == "common" else valid[i]
        values = want[i][selected].astype(float)
        assert row["count"] == values.size
        assert row["minimum"] == 0  # valid displacement zero is retained
        for name, fn in [
            ("mean", np.mean),
            ("median", np.median),
            ("spatial_std", np.std),
        ]:
            assert row[name] == pytest.approx(fn(values), rel=1e-12)
        assert row["percentiles"] == {
            str(p): pytest.approx(np.percentile(values, p)) for p in (10, 90)
        }
    xr.testing.assert_identical(ds, before)
    assert hashes == {
        p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in hashes
    }


@pytest.mark.parametrize("storage", ["md", "lite"])
@pytest.mark.parametrize("reverse", [False, True])
def test_upper_bound_intersection_and_axis_order(inputs, storage, reverse):
    ds, groups, body = inputs
    if reverse:
        ds = ds.isel(x=slice(None, None, -1), y=slice(None, None, -1)).transpose(
            "x", "time", "y", ...
        )
    result = run(
        storage,
        ds,
        groups,
        {
            **body,
            "layer_masks": [
                {"dataset": "quality", "threshold": 0.5, "mode": "max"},
                {"dataset": "static_quality", "threshold": 0.5, "mode": "min"},
            ],
        },
    )
    assert [r["count"] for r in result["statistics"]] == [1, 1, 1]
    assert [r["median"] for r in result["statistics"]] == [1, 17, 33]
    assert [r["operator"] for r in result["masks"]] == ["<=", ">="]


@pytest.mark.parametrize("storage", ["md", "lite", "cog"])
def test_all_invalid_mask_does_not_return_unmasked_statistics(inputs, storage):
    ds, groups, body = inputs
    result = run(
        storage,
        ds,
        groups,
        {
            **body,
            "layer_masks": [
                {"dataset": "quality", "threshold": 2},
            ],
        },
    )
    assert result["common_pixels"] == 0
    assert all(r["count"] == 0 and r["median"] is None for r in result["statistics"])


@pytest.mark.parametrize("storage", ["md", "lite", "cog"])
def test_unknown_mask_is_an_error(inputs, storage):
    ds, groups, body = inputs
    with pytest.raises(ValueError, match="Unknown mask layer"):
        run(storage, ds, groups, {**body, "layer_masks": [{"dataset": "missing"}]})


@pytest.mark.parametrize("storage", ["md", "lite"])
def test_mismatched_temporal_axis_is_rejected(inputs, storage):
    ds, groups, body = inputs
    ds["wrong_dates"] = ds.quality.rename(time="quality_time").assign_coords(
        quality_time=ds.time.values + np.timedelta64(1, "D")
    )
    with pytest.raises(ValueError, match="Dynamic mask"):
        run(storage, ds, groups, {**body, "layer_masks": [{"dataset": "wrong_dates"}]})


def test_cog_upper_bound_is_rejected_until_map_parity_is_repaired(inputs):
    ds, groups, body = inputs
    with pytest.raises(
        ValueError, match="GeoTIFF polygon masks currently support only min"
    ):
        run(
            "cog",
            ds,
            groups,
            {**body, "layer_masks": [{"dataset": "quality", "mode": "max"}]},
        )


@pytest.mark.parametrize("storage", ["md", "lite", "cog"])
def test_requested_masks_require_a_source_context(inputs, storage):
    ds, groups, body = inputs
    request = PolygonRequest(**body, layer_masks=[{"dataset": "quality"}])
    with pytest.raises(ValueError, match="mask source"):
        if storage == "cog":
            summarize_rasters(groups["displacement"], request)
        elif storage == "lite":
            summarize_cube(
                ds.displacement, CRS.from_epsg(4326), request, ["a", "b", "c"]
            )
        else:
            summarize_xarray(ds.displacement, request, ["a", "b", "c"])


@pytest.mark.parametrize("storage", ["md", "lite"])
def test_mask_grid_mismatch_is_rejected(inputs, storage):
    ds, groups, body = inputs
    ds["shifted"] = ds.static_quality.rename(x="shifted_x")
    with pytest.raises(ValueError, match="native x/y"):
        run(storage, ds, groups, {**body, "layer_masks": [{"dataset": "shifted"}]})


def test_cog_mismatched_dates_are_not_clamped(inputs):
    ds, groups, body = inputs
    groups["quality"].x_values = ["wrong", "dates", "here"]
    with pytest.raises(ValueError, match="Dynamic mask labels"):
        run("cog", ds, groups, {**body, "layer_masks": [{"dataset": "quality"}]})


@pytest.mark.parametrize("storage", ["md", "lite"])
def test_budget_includes_mask_work_before_reading(inputs, storage, monkeypatch):
    import dask.array as da
    from dask import delayed

    from bowser import polygon
    from bowser.lite import polygon as lite_polygon

    ds, groups, body = inputs

    def unreadable():
        raise AssertionError("A rejected oversized request must not read arrays")

    ds["displacement"].data = da.from_delayed(delayed(unreadable)(), (3, 4, 4), float)
    monkeypatch.setattr(polygon, "MAX_PIXEL_EPOCHS", 50)
    monkeypatch.setattr(lite_polygon, "MAX_PIXEL_EPOCHS", 50)
    with pytest.raises(ValueError, match="budget"):
        run(storage, ds, groups, {**body, "layer_masks": [{"dataset": "quality"}]})


@pytest.mark.parametrize("bad_context", ["shifted", "crs", "cf_crs", "missing_mapping"])
def test_external_mask_context_must_match_native_grid_and_crs(inputs, bad_context):
    ds, _, body = inputs
    masks = ds[["quality"]].copy(deep=True)
    if bad_context == "shifted":
        masks = masks.assign_coords(x=masks.x + 0.005)
    elif bad_context == "crs":
        masks = masks.rio.write_crs(3857)
    elif bad_context == "cf_crs":
        cf = CRS.from_epsg(32611).to_cf()
        cf.pop("crs_wkt")
        masks.spatial_ref.attrs = cf
    else:
        masks.quality.encoding["grid_mapping"] = "absent_crs"
    request = PolygonRequest(**body, layer_masks=[{"dataset": "quality"}])
    with pytest.raises(ValueError, match="grid and CRS|missing CRS coordinate"):
        summarize_xarray(ds.displacement, request, ["a", "b", "c"], mask_dataset=masks)


@pytest.mark.parametrize("mode", ["min", "max"])
def test_dynamic_mask_cannot_be_applied_to_a_static_summary(inputs, mode):
    ds, _, body = inputs
    request = PolygonRequest(**body, layer_masks=[{"dataset": "quality", "mode": mode}])
    with pytest.raises(ValueError, match="Dynamic mask"):
        summarize_xarray(
            ds.displacement.isel(time=0), request, ["static"], mask_dataset=ds
        )


@pytest.mark.parametrize("case", ["grid", "multiband", "short"])
def test_cog_bad_mask_support_is_rejected(inputs, case, tmp_path):
    import rasterio
    from affine import Affine

    ds, groups, body = inputs
    group = groups["quality"]
    if case == "short":
        group.file_list = group.file_list[:2]
    else:
        with rasterio.open(group.file_list[0]) as src:
            meta, values = src.profile, src.read(1)
        if case == "grid":
            meta["transform"] *= Affine.translation(1, 0)
        else:
            meta["count"] = 2
        path = tmp_path / "invalid_quality.tif"
        with rasterio.open(path, "w", **meta) as dst:
            for band in range(1, meta["count"] + 1):
                dst.write(values, band)
        group.file_list = [str(path)]
    with pytest.raises(ValueError, match="grid and CRS|single-band|one file per"):
        run("cog", ds, groups, {**body, "layer_masks": [{"dataset": "quality"}]})


def test_mask_parameters_reject_nonfinite_thresholds_and_excessive_work(inputs):
    from pydantic import ValidationError

    _, _, body = inputs
    for threshold in [np.nan, np.inf, -np.inf]:
        with pytest.raises(ValidationError):
            PolygonRequest(
                **body, layer_masks=[{"dataset": "quality", "threshold": threshold}]
            )
    with pytest.raises(ValidationError):
        PolygonRequest(**body, layer_masks=[{"dataset": "quality"}] * 11)
