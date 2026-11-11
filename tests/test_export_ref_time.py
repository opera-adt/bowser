"""GeoTIFF export relative to the reference date chosen in the viewer (ref_time_idx).

The map's tiles show value(t) - value(t_ref) per pixel, and shift them by the
reference's value at t minus its value at t_ref. The export must write the same
numbers, and say so in its provenance tags. The app reads its settings at
import, so it runs in its own interpreter.
"""

import json
import os
import subprocess
import sys

import numpy as np
import pytest
import xarray as xr

rasterio = pytest.importorskip("rasterio")
pytest.importorskip("rioxarray")
pytest.importorskip("titiler.core")
from pyproj import Transformer  # noqa: E402

DATES = ["2026-01-01", "2026-01-13", "2026-01-25"]


@pytest.fixture(scope="module")
def exports(tmp_path_factory):
    work = tmp_path_factory.mktemp("ref-time-export")
    x = 500000 + 10 * (np.arange(5) + 0.5)
    y = 50 - 10 * (np.arange(5) + 0.5)
    field = np.arange(25, dtype="float32").reshape(5, 5) - 12
    field[0, 0] = np.nan
    # Not a shift of each other: the medians of a difference and the difference
    # of medians disagree, so the test pins which one the export uses (the map's).
    stack = np.stack([field * 0, field, field**2 / 4 + 3])
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), stack, {"units": "meters"}),
            "velocity": (("y", "x"), field, {"units": "meters / year"}),
        },
        coords={"time": np.array(DATES, dtype="datetime64[ns]"), "x": x, "y": y},
        attrs={"reference_date": "2026-01-01"},
    ).rio.write_crs(32631)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    ds.displacement.isel(time=2).rio.write_nodata(np.nan).rio.to_raster(
        work / "displacement_2.tif"
    )
    lon, lat = Transformer.from_crs(32631, 4326, always_xy=True).transform(x[2], y[2])
    ref = {"ref_lon": lon, "ref_lat": lat}
    requests = {
        "relative": {"ref_time_idx": 1},
        "relative_point": {**ref, "ref_time_idx": 1},
        "relative_buffer": {**ref, "ref_buffer_m": 11, "ref_time_idx": 1},
        "clamped": {"ref_time_idx": 9},
        "stored": {},
        "negative": {"ref_time_idx": -1},
        "static": {"variable": "velocity", "ref_time_idx": 1},
        "cog": {"dataset": "cog", "ref_time_idx": 1},
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
cog = BowserState(mode="cog", raster_groups={"displacement": RasterGroup(
    name="displacement", file_list=[str(work / "displacement_2.tif")],
    uses_spatial_ref=True, algorithm="shift",
)})
original_resolve = main._resolve_state
main._resolve_state = lambda dataset=None: (
    cog if dataset == "cog" else original_resolve(dataset)
)
client = TestClient(main.app)
result = {}
for name, params in json.loads((work / "requests.json").read_text()).items():
    response = client.get("/export/geotiff", params={
        "variable": "displacement", "time_idx": 2, **params,
    })
    result[name] = {"status": response.status_code}
    if response.status_code == 200:
        (work / f"{name}.tif").write_bytes(response.content)
        result[name]["disposition"] = response.headers["content-disposition"]
    else:
        result[name]["detail"] = response.json()
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
        timeout=120,
    )
    assert run.returncode == 0, run.stdout[-2000:] + run.stderr[-4000:]
    return work, stack, json.loads((work / "result.json").read_text())


def _read(work, name):
    with rasterio.open(work / f"{name}.tif") as src:
        return src.read(1), src.tags()


def test_pixels_are_relative_to_the_chosen_date(exports):
    work, stack, results = exports
    assert results["relative"]["status"] == 200, results["relative"]
    values, tags = _read(work, "relative")
    np.testing.assert_allclose(values, stack[2] - stack[1], equal_nan=True)
    assert tags["BOWSER_EXPORT_REFERENCE_MODE"] == "stored"  # no spatial shift


@pytest.mark.parametrize(
    "case,pixels", [("relative_point", [(2, 2)]), ("relative_buffer", None)]
)
def test_spatial_reference_is_its_change_since_the_chosen_date(exports, case, pixels):
    # The map's shift: the reference's value at t minus its value at t_ref, each
    # a point value or the circle's median on that date.
    work, stack, results = exports
    assert results[case]["status"] == 200, results[case]
    cross = pixels or [(2, 2), (1, 2), (3, 2), (2, 1), (2, 3)]
    at = [np.median([stack[t][p] for p in cross]) for t in (1, 2)]
    values, tags = _read(work, case)
    np.testing.assert_allclose(
        values, (stack[2] - stack[1]) - (at[1] - at[0]), rtol=1e-6, equal_nan=True
    )
    assert float(tags["BOWSER_REFERENCE_VALUE"]) == pytest.approx(at[1] - at[0])
    assert tags["BOWSER_EXPORT_REFERENCE_MODE"] == "interactive"


def test_provenance_records_the_chosen_date(exports):
    work, _, results = exports
    _, tags = _read(work, "relative")
    time = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])["time"]
    assert time["reference_index"] == 1
    assert time["reference_label"] == "2026-01-13"
    assert time["reference_date"] == "2026-01-13"
    assert time["stored_reference_date"] == "2026-01-01"
    assert time["selected_date"] == "2026-01-25"
    assert "value(reference)" in time["reference_operation"]
    assert tags["BOWSER_TIME_REFERENCE_INDEX"] == "1"
    assert tags["BOWSER_TIME_REFERENCE_DATE"] == "2026-01-13"
    assert "displacement_20260113-20260125" in results["relative"]["disposition"]


def test_stored_export_is_unchanged(exports):
    work, stack, results = exports
    values, tags = _read(work, "stored")
    np.testing.assert_allclose(values, stack[2], equal_nan=True)
    time = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])["time"]
    assert time["reference_date"] == "2026-01-01"
    assert "reference_index" not in time
    assert "BOWSER_TIME_REFERENCE_INDEX" not in tags


def test_reference_step_is_clamped_like_the_tiles(exports):
    work, stack, results = exports
    values, tags = _read(work, "clamped")
    np.testing.assert_allclose(values, stack[2] - stack[2], equal_nan=True)
    assert tags["BOWSER_TIME_REFERENCE_INDEX"] == "2"


@pytest.mark.parametrize("case", ["negative", "static", "cog"])
def test_a_reference_date_that_cannot_apply_is_refused(exports, case):
    _, _, results = exports
    assert results[case]["status"] == 422, results[case]
