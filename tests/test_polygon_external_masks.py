"""Known native support for external masks without resampling measurements."""

from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
import rioxarray  # noqa: F401
import xarray as xr
from pyproj import CRS
from rasterio.transform import from_origin

from bowser.lite.polygon import summarize_cube
from bowser.polygon import PolygonRequest, summarize_rasters, summarize_xarray


@pytest.fixture
def case(tmp_path):
    raw = np.arange(32, dtype="float32").reshape(2, 4, 4)
    raw[:, 0, 0] = 0
    ds = xr.Dataset(
        {"d": (("time", "y", "x"), raw, {"units": "meters"})},
        coords={
            "time": ["2026-01-01", "2026-01-13"],
            "x": [0.5, 1.5, 2.5, 3.5],
            "y": [3.5, 2.5, 1.5, 0.5],
        },
    ).rio.write_crs(4326)
    paths = []
    for i in range(2):
        p = tmp_path / f"d_{i}.tif"
        ds.d.isel(time=i).rio.to_raster(p)
        paths.append(str(p))
    group = SimpleNamespace(
        file_list=paths,
        x_values=list(ds.time.values),
        nodata=None,
        mask_file_list=[],
        mask_min_value=0,
    )
    body = {
        "variable": "d",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
        },
    }

    def write(values, name="mask", transform=None):
        p = tmp_path / f"{name}.tif"
        with rasterio.open(
            p,
            "w",
            driver="GTiff",
            width=values.shape[1],
            height=values.shape[0],
            count=1,
            dtype="float32",
            crs=4326,
            transform=transform or from_origin(0, 4, 1, 1),
            nodata=-9999,
        ) as f:
            f.write(values.astype("float32"), 1)
        return str(p)

    return ds, group, body, write


def run(storage, case, **updates):
    ds, group, body, _ = case
    request = PolygonRequest(**{**body, **updates})
    if storage == "cog":
        return summarize_rasters(group, request)
    return summarize_xarray(ds.d, request, list(ds.time.values), external_masks=True)


@pytest.mark.parametrize("storage", ["md", "cog"])
def test_uploaded_known_truth_zero_nodata_and_statistics(case, storage):
    ds, _, _, write = case
    mask = np.ones((4, 4))
    mask[0, 1] = 0
    mask[0, 2] = 0.25
    mask[0, 3] = -9999
    path = write(mask)
    out = run(storage, case, custom_mask_path=path)
    keep = (mask > (0 if storage == "md" else 0.5)) & (mask != -9999)
    assert out["optional_masks_applied"]
    assert out["statistics"][0]["count"] == int(keep.sum())
    assert out["statistics"][0]["median"] == np.median(ds.d.values[0][keep])
    assert out["statistics"][0]["minimum"] == 0
    assert out["statistics"][1]["minimum"] == 0
    assert out["masks"][0]["dataset"] == "uploaded mask"
    assert path not in str(out)


@pytest.mark.parametrize("support", ["common", "per_date"])
def test_configured_masks_follow_dates_without_clamping(case, support):
    _, group, _, write = case
    first = np.ones((4, 4))
    first[0, 1] = 0
    last = first.copy()
    last[1, 0] = 0
    group.mask_file_list = [write(first, "m0"), write(last, "m1")]
    out = run("cog", case, primary_mask=True, support=support)
    assert [r["count"] for r in out["statistics"]] == (
        [14, 14] if support == "common" else [15, 14]
    )
    assert out["masks"][0]["temporal_support"] == "matching_axis"
    assert out["statistics"][0]["minimum"] == 0
    assert out["statistics"][1]["minimum"] == 0


@pytest.mark.parametrize("storage", ["md", "cog"])
def test_mask_warp_is_bounded_and_outside_coverage_invalid(case, storage):
    *_, write = case
    # A coarser mask covers only the left half; valid zero data are preserved.
    path = write(np.ones((2, 1)), transform=from_origin(0, 4, 2, 2))
    out = run(storage, case, custom_mask_path=path)
    assert [r["count"] for r in out["statistics"]] == [8, 8]
    assert out["statistics"][0]["mean"] == np.mean(case[0].d.values[0, :, :2])
    assert out["statistics"][1]["mean"] == np.mean(case[0].d.values[1, :, :2])


@pytest.mark.parametrize("storage", ["md", "cog"])
def test_missing_mask_never_falls_back(case, storage):
    with pytest.raises(ValueError, match="no unmasked fallback"):
        run(storage, case, custom_mask_path="missing-mask.tif")


def test_incomplete_configured_mask_and_lite_reject_explicitly(case):
    ds, group, body, _ = case
    with pytest.raises(ValueError, match="complete configured"):
        run("cog", case, primary_mask=True)
    req = PolygonRequest(**body, custom_mask_path="mask.tif")
    with pytest.raises(ValueError, match="full server"):
        summarize_cube(ds.d, CRS.from_epsg(4326), req, list(ds.time.values))
    with pytest.raises(ValueError, match="full server"):
        summarize_xarray(ds.d, req, list(ds.time.values))


def test_external_masks_through_actual_http_routes(case, tmp_path):
    """Actual full/lite routes confirm support rather than merely accepting fields."""
    import json
    import os
    import subprocess
    import sys

    ds, group, body, write = case
    ds.assign_coords(time=np.asarray(ds.time.values, dtype="datetime64[ns]")).to_zarr(
        tmp_path / "cube.zarr", consolidated=False
    )
    values = np.ones((4, 4))
    values[0, 1] = 0
    values[0, 2] = 0.25
    values[0, 3] = -9999
    path = write(values)
    (tmp_path / "input.json").write_text(
        json.dumps(
            {
                "body": body,
                "mask": path,
                "files": group.file_list,
            }
        )
    )
    script = r"""
import json
from pathlib import Path
from fastapi.testclient import TestClient
from bowser import main
from bowser.state import BowserState
from bowser.titiler import RasterGroup
from bowser.lite.main import app as lite_app
work = Path.cwd()
inputs = json.loads((work / 'input.json').read_text())
original = main._default_state
cog = BowserState(mode='cog', raster_groups={'d': RasterGroup(
    name='d', file_list=inputs['files'], mask_file_list=[inputs['mask']],
    mask_min_value=0,
)})
results = {}
states = [('md', original, main.app), ('cog', cog, main.app),
          ('lite', None, lite_app)]
for name, state, app in states:
    if state is not None:
        main._default_state = state
    with TestClient(app) as client:
        for kind, fields in [('uploaded', {'custom_mask_path': inputs['mask']}),
                             ('configured', dict(primary_mask=True, mask_min_value=0)),
                             ('missing', {'custom_mask_path': 'missing-mask.tif'})]:
            r = client.post('/polygon_timeseries', json={**inputs['body'], **fields})
            results[name + '_' + kind] = {'status': r.status_code, 'body': r.json()}
(work / 'response.json').write_text(json.dumps(results))
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(tmp_path / "cube.zarr"),
        BOWSER_DATASET_CONFIG_FILE=str(tmp_path / "absent.json"),
        BOWSER_REF_WARMUP="0",
        MPLCONFIGDIR=str(tmp_path / "mpl"),
    )
    run = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        timeout=90,
    )
    assert run.returncode == 0, run.stdout[-1000:] + run.stderr[-3000:]
    results = json.loads((tmp_path / "response.json").read_text())
    for name, count in [
        ("md_uploaded", 14),
        ("cog_uploaded", 13),
        ("cog_configured", 14),
    ]:
        result = results[name]
        assert result["status"] == 200, result
        assert result["body"]["optional_masks_applied"] is True
        assert [r["count"] for r in result["body"]["statistics"]] == [count, count]
        assert result["body"]["statistics"][0]["minimum"] == 0
        assert result["body"]["masks"][0]["dataset"] == (
            "configured mask" if name == "cog_configured" else "uploaded mask"
        )
    for name in [
        "md_configured",
        "md_missing",
        "cog_missing",
        "lite_uploaded",
        "lite_configured",
        "lite_missing",
    ]:
        assert results[name]["status"] == 422, results[name]
