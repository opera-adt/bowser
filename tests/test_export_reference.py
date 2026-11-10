"""Exercise GeoTIFF reference subtraction using only tiny synthetic rasters."""

import json
import os
import subprocess
import sys

import numpy as np
import pytest
import rasterio
import rioxarray  # noqa: F401
import xarray as xr
from pyproj import Transformer

from bowser.reference import reference_offset


@pytest.fixture(scope="module")
def exports(tmp_path_factory):
    work = tmp_path_factory.mktemp("reference-export")
    x = 500000 + 10 * (np.arange(5) + 0.5)
    y = 50 - 10 * (np.arange(5) + 0.5)
    field = np.arange(25, dtype="float32").reshape(5, 5) - 12
    field[0, 0] = np.nan
    field[2, 2] = 25  # distinguish the reference pixel from its neighborhood median
    stack = np.stack([field * 0, field, field + 5])
    quality = np.ones((5, 5), dtype="float32")
    quality[2, 2] = 0  # display masking must not silently change the reference
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), stack, {"units": "meters"}),
            "velocity": (("y", "x"), field, {"units": "meters / year"}),
            "quality": (("y", "x"), quality, {"units": "unitless"}),
        },
        coords={
            "time": np.array(
                ["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]"
            ),
            "x": x,
            "y": y,
        },
    ).rio.write_crs(32631)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    for name in ds.data_vars:
        da = ds[name]
        for idx in range(3 if "time" in da.dims else 1):
            slice_ = da.isel(time=idx) if "time" in da.dims else da
            slice_.rio.write_nodata(np.nan).rio.to_raster(work / f"{name}_{idx}.tif")
    tr = Transformer.from_crs(32631, 4326, always_xy=True)
    lon, lat = tr.transform(x[2], y[2])
    nodata_lon, nodata_lat = tr.transform(x[0], y[0])
    ref = {"ref_lon": lon, "ref_lat": lat}
    requests = {
        "point": {**ref},
        "buffer": {**ref, "ref_buffer_m": 11},
        "zero": {**ref, "time_idx": 0},
        "stored": {},
        "static": {**ref, "variable": "velocity"},
        "masked": {
            **ref,
            "layer_masks": json.dumps(
                [{"dataset": "quality", "threshold": 0.5, "mode": "min"}]
            ),
        },
        "nodata": {"ref_lon": nodata_lon, "ref_lat": nodata_lat},
        "outside": {"ref_lon": 0, "ref_lat": 0},
        "missing_lat": {"ref_lon": lon},
        "missing_lon": {"ref_lat": lat},
        "radius_only": {"ref_buffer_m": 11},
        "negative_radius": {**ref, "ref_buffer_m": -1},
        "bad_lat": {**ref, "ref_lat": 91},
        "bad_lon": {**ref, "ref_lon": "nan"},
        "quality_reference": {**ref, "variable": "quality"},
    }
    (work / "requests.json").write_text(json.dumps(requests))
    script = r"""
import json
from pathlib import Path
from fastapi.testclient import TestClient
from bowser import main
from bowser.state import BowserState
from bowser.titiler import RasterGroup

work = Path.cwd()
groups = {}
for name, count in (("displacement", 3), ("velocity", 1), ("quality", 1)):
    groups[name] = RasterGroup(
        name=name,
        file_list=[str(work / f"{name}_{i}.tif") for i in range(count)],
        uses_spatial_ref=name != "quality",
        algorithm="shift" if name != "quality" else None,
    )
cog = BowserState(mode="cog", raster_groups=groups)
original_resolve = main._resolve_state
def resolve(dataset=None):
    return cog if dataset == "cog" else original_resolve(dataset)
main._resolve_state = resolve
client = TestClient(main.app)
result = {}
for mode in ("md", "cog"):
    for name, params in json.loads((work / "requests.json").read_text()).items():
        response = client.get("/export/geotiff", params={
            "variable": "displacement", "time_idx": 2,
            **({"dataset": "cog"} if mode == "cog" else {}), **params,
        })
        key = f"{mode}_{name}"
        result[key] = {"status": response.status_code}
        if response.status_code == 200:
            (work / f"{key}.tif").write_bytes(response.content)
        else:
            result[key]["detail"] = response.json()
(work / "result.json").write_text(json.dumps(result))
"""
    env = {
        **os.environ,
        "BOWSER_STACK_DATA_FILE": str(work / "cube.zarr"),
        "BOWSER_CATALOG_FILE": "",
        "BOWSER_USE_SPATIAL_REFERENCE_DISP": "true",
    }
    run = subprocess.run(
        [sys.executable, "-c", script],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert run.returncode == 0, run.stdout[-2000:] + run.stderr[-4000:]
    return work, ds, json.loads((work / "result.json").read_text())


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_point_reference_changes_exported_pixels(exports, mode):
    work, ds, results = exports
    assert results[f"{mode}_point"]["status"] == 200
    with rasterio.open(work / f"{mode}_point.tif") as src:
        np.testing.assert_allclose(
            src.read(1), ds.displacement.isel(time=2) - 30, equal_nan=True
        )
        assert src.read(1)[2, 2] == 0  # valid zero, not nodata


@pytest.mark.parametrize("mode", ["md", "cog"])
@pytest.mark.parametrize(
    "case,offset",
    [("buffer", 6), ("static", 25), ("zero", 0), ("stored", 0), ("masked", 30)],
)
def test_reference_variants_and_metadata(exports, mode, case, offset):
    work, ds, results = exports
    assert results[f"{mode}_{case}"]["status"] == 200
    expected = (
        ds.velocity.values.copy()
        if case == "static"
        else ds.displacement.isel(time=0 if case == "zero" else 2).values.copy()
    )
    expected -= offset
    if case == "masked":
        expected[2, 2] = np.nan
    with rasterio.open(work / f"{mode}_{case}.tif") as src:
        np.testing.assert_allclose(src.read(1), expected, equal_nan=True)
        assert src.crs.to_epsg() == 32631
        assert src.shape == (5, 5)
        assert src.transform == ds.rio.transform()
        assert np.isnan(src.nodata)
        assert src.tags()["units"] == (
            "meters / year" if case == "static" else "meters"
        )
        if case != "stored":
            assert float(src.tags()["BOWSER_REFERENCE_VALUE"]) == offset
            assert int(src.tags()["BOWSER_REFERENCE_VALID_PIXELS"]) == (
                5 if case == "buffer" else 1
            )
        else:
            assert "BOWSER_REFERENCE_VALUE" not in src.tags()


@pytest.mark.parametrize("mode", ["md", "cog"])
@pytest.mark.parametrize(
    "case",
    [
        "nodata",
        "outside",
        "missing_lat",
        "missing_lon",
        "radius_only",
        "negative_radius",
        "bad_lat",
        "bad_lon",
        "quality_reference",
    ],
)
def test_invalid_reference_is_not_silently_ignored(exports, mode, case):
    _, _, results = exports
    assert results[f"{mode}_{case}"]["status"] == 422, results[f"{mode}_{case}"]


@pytest.mark.parametrize("transpose", [False, True])
@pytest.mark.parametrize("reverse_y", [False, True])
def test_reference_support_and_source_immutability(transpose, reverse_y):
    da = (
        xr.DataArray(
            [[-9999, 0, 2], [3, 12, 5], [6, 7, 8]],
            dims=("y", "x"),
            coords={"x": [500005, 500015, 500025], "y": [25, 15, 5]},
            attrs={"units": "radians"},
        )
        .rio.write_crs(32631)
        .rio.write_nodata(-9999)
    )
    if reverse_y:
        da = da.isel(y=slice(None, None, -1))
    if transpose:
        da = da.transpose("x", "y")
    original = da.copy(deep=True)
    lon, lat = Transformer.from_crs(32631, 4326, always_xy=True).transform(500015, 15)
    offset, tags = reference_offset(da, lon, lat, 16)
    assert offset == 5.5  # exclude the finite nodata sentinel, retain valid zero
    assert tags["BOWSER_REFERENCE_VALID_PIXELS"] == "8"
    xr.testing.assert_identical(da, original)


def test_geographic_point_is_supported_but_meter_buffer_is_not():
    da = xr.DataArray(
        [[1, 0], [3, 4]], dims=("y", "x"), coords={"x": [3, 3.01], "y": [0.01, 0]}
    ).rio.write_crs(4326)
    assert reference_offset(da, 3.01, 0.01)[0] == 0
    with pytest.raises(ValueError, match="projected CRS in meters"):
        reference_offset(da, 3.01, 0.01, 10)


@pytest.mark.parametrize("radius", [np.nan, np.inf, -1])
def test_invalid_radius(radius):
    da = xr.DataArray(
        [[1]], dims=("y", "x"), coords={"x": [3], "y": [0]}
    ).rio.write_crs(4326)
    with pytest.raises(ValueError, match="radius"):
        reference_offset(da, 3, 0, radius)


def test_point_sampling_matches_each_native_reader_at_pixel_boundaries():
    da = xr.DataArray(
        [[1, 2], [3, 4]],
        dims=("y", "x"),
        coords={"x": [3, 4], "y": [1, 0]},
    ).rio.write_crs(4326)
    # xarray's nearest-coordinate tie break differs from rasterio's containing
    # pixel at a boundary. Match each reader, rather than silently shifting the
    # chosen reference by one row.
    expected = float(da.sel(x=3.5, y=0.5, method="nearest"))
    assert reference_offset(da, 3.5, 0.5)[0] == expected
    assert reference_offset(da, 3.5, 0.5, point_method="containing")[0] == 4
