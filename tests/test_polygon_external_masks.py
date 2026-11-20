"""Known native support for external masks without resampling measurements."""

from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
import rioxarray
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


def _warped(da, path):
    """Warp a mask to the whole grid of ``da``, as the full server's map does."""
    mask = rioxarray.open_rasterio(path, masked=True).squeeze("band", drop=True)
    return mask.rio.reproject_match(da)


def run(storage, case, **updates):
    ds, group, body, _ = case
    request = PolygonRequest(**{**body, **updates})
    if storage == "cog":
        return summarize_rasters(
            group, request, warp=lambda path: _warped(ds.d.isel(time=0), path)
        )
    return summarize_xarray(
        ds.d, request, list(ds.time.values), warp=lambda da, p: _warped(da, p) > 0
    )


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


MAP_SCRIPT = r"""
import json
import sys
import numpy as np
from fastapi.testclient import TestClient
from bowser import main
from bowser.state import BowserState
from bowser.titiler import RasterGroup

inputs = json.loads(open(sys.argv[1]).read())
ds = main.state.dataset
mask = inputs["mask"]
plain = BowserState(mode="cog", raster_groups={"d": RasterGroup(
    name="d", file_list=inputs["files"])})
configured = BowserState(mode="cog", raster_groups={"d": RasterGroup(
    name="d", file_list=inputs["files"], mask_file_list=[mask], mask_min_value=0.5)})


def geotiff_map(state, custom):
    # The GeoTIFF map's masked layer (its configured mask, if any, and ``custom``).
    return lambda i: np.isfinite(main._build_masked_cog_dataarray(
        state, "d", i, None, None, custom, strict_masks=True).values)


cases = {
    # The GeoZarr map: the cached whole-grid warp, kept where > 0.
    "md_uploaded": (main._default_state, {"custom_mask_path": mask},
                    lambda i: main._custom_mask_on(ds.d.isel(time=i), mask).values),
    "cog_uploaded": (plain, {"custom_mask_path": mask}, geotiff_map(plain, mask)),
    "cog_configured": (configured, {"primary_mask": True},
                       geotiff_map(configured, None)),
}
out = {}
for name, (state, fields, keep) in cases.items():
    main._default_state = state
    with TestClient(main.app) as client:
        r = client.post("/polygon_timeseries", json={**inputs["body"], **fields,
                                                     "support": "per_date"})
    out[name] = {"status": r.status_code, "body": r.json(),
                 "keep": [np.asarray(keep(i)).tolist() for i in range(2)]}
print(json.dumps(out))
"""


@pytest.mark.parametrize("storage", ["md", "cog"])
def test_reprojected_masks_keep_the_maps_pixels(tmp_path, storage):
    """Areas keep exactly the pixels the map keeps for a mask on another grid.

    A windowed warp of a geographic mask flips a few edge pixels against the
    map's whole-grid warp once the grid is wider than GDAL's 512-pixel warp
    chunks, so the grid here is wider than that.
    """
    import json
    import os
    import subprocess
    import sys

    from pyproj import Transformer

    n = 560
    x = 230015.0 + 30 * np.arange(n)
    y = 3850015.0 - 30 * np.arange(n)
    values = (1 + np.arange(2 * n * n, dtype="float32")).reshape(2, n, n)
    ds = xr.Dataset(
        {"d": (("time", "y", "x"), values, {"units": "meters"})},
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": x,
            "y": y,
        },
    ).rio.write_crs(32615)
    ds.to_zarr(tmp_path / "cube.zarr", consolidated=False)
    files = []
    for i in range(2):
        files.append(str(tmp_path / f"d_{i}.tif"))
        ds.d.isel(time=i).rio.to_raster(files[-1])
    west, south, east, north = ds.d.isel(time=0).rio.reproject(4326).rio.bounds()
    res = 9.887e-5
    width, height = int((east - west) / res) + 4, int((north - south) / res) + 4
    mask = str(tmp_path / "geographic.tif")
    with rasterio.open(
        mask,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="uint8",
        crs=4326,
        transform=from_origin(west - 2 * res, north + 2 * res, res, res),
    ) as f:
        rng = np.random.default_rng(1)
        f.write(rng.integers(0, 2, (height, width)).astype("uint8"), 1)
    # Rows 0-39, columns 100-219: their window differs from the whole-grid warp.
    rows, cols = slice(0, 40), slice(100, 220)
    to_wgs84 = Transformer.from_crs(32615, 4326, always_xy=True).transform
    x0, x1 = x[cols.start] - 15, x[cols.stop - 1] + 15
    y0, y1 = y[rows.start] + 15, y[rows.stop - 1] - 15
    ring = [to_wgs84(a, b) for a, b in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]
    body = {
        "variable": "d",
        "geometry": {"type": "Polygon", "coordinates": [ring + ring[:1]]},
    }
    (tmp_path / "input.json").write_text(
        json.dumps({"body": body, "mask": mask, "files": files})
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(tmp_path / "cube.zarr"),
        BOWSER_DATASET_CONFIG_FILE=str(tmp_path / "absent.json"),
        BOWSER_REF_WARMUP="0",
        MPLCONFIGDIR=str(tmp_path / "mpl"),
    )
    run = subprocess.run(
        [sys.executable, "-B", "-c", MAP_SCRIPT, str(tmp_path / "input.json")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        timeout=180,
    )
    assert run.returncode == 0, run.stderr[-3000:]
    results = json.loads(run.stdout.strip().splitlines()[-1])
    names = ["md_uploaded"] if storage == "md" else ["cog_uploaded", "cog_configured"]
    for name in names:
        result = results[name]
        assert result["status"] == 200, result
        for i, stats in enumerate(result["body"]["statistics"]):
            keep = np.asarray(result["keep"][i], dtype=bool)[rows, cols]
            kept = values[i, rows, cols][keep]
            assert 0 < kept.size < keep.size
            # Same pixels, same order: the same count, mean and spread exactly.
            assert stats["count"] == kept.size, name
            assert stats["mean"] == float(np.mean(kept.astype(float))), name
            assert stats["spatial_std"] == float(np.std(kept.astype(float))), name
        assert result["body"]["polygon_pixels"] == 40 * 120


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
                             ('missing', {'custom_mask_path': 'missing-mask.tif'}),
                             ('threshold_only', {'mask_min_value': 0})]:
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
        "md_threshold_only",
        "cog_threshold_only",
    ]:
        assert results[name]["status"] == 422, results[name]
    # As on the point/radius charts: a threshold needs primary_mask, and lite
    # refuses every external mask as unsupported rather than invalid.
    assert "primary_mask=true" in results["cog_threshold_only"]["body"]["detail"]
    for name in ["uploaded", "configured", "missing", "threshold_only"]:
        assert results["lite_" + name]["status"] == 501, results["lite_" + name]


def test_mask_fields_are_documented_like_the_chart_options():
    from bowser.api_models import PARAMS

    for name in ("primary_mask", "mask_min_value", "custom_mask_path"):
        field = PolygonRequest.model_fields[name]
        assert field.description == PARAMS[name]["description"]
