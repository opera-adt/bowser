"""Exercise exported metadata and numeric masks together through the real API."""

import json
import os
import subprocess
import sys

import numpy as np
import pytest
import rioxarray  # noqa: F401
import xarray as xr


@pytest.fixture(scope="module")
def exports(tmp_path_factory):
    work = tmp_path_factory.mktemp("export-provenance")
    values = np.array([[np.nan, 0, 2], [3, 4, 5], [6, 7, 8]], dtype="float32")
    quality = np.array([[0, 0.5, 0.8], [1, 0, 1], [1, 1, 1]], dtype="float32")
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                np.stack([values * 0, values]),
                {"units": "meters", "reference_date": "20260101"},
            ),
            "quality": (("time", "y", "x"), np.stack([quality * 0, quality])),
            "velocity": (("y", "x"), values, {"units": "m/year"}),
        },
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": [500005, 500015, 500025],
            "y": [25, 15, 5],
        },
        attrs={
            "sensor": "Example radar",
            "frame_id": 42,
            "product_type": "Example product",
        },
    ).rio.write_crs(32631)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    for idx, date in enumerate(("20260101", "20260113")):
        ds.displacement.isel(time=idx).rio.write_nodata(np.nan).rio.to_raster(
            work / f"displacement_20260101_{date}.tif"
        )
        ds.quality.isel(time=idx).rio.to_raster(work / f"quality_{date}.tif")
    ds.velocity.rio.write_nodata(np.nan).rio.to_raster(work / "velocity.tif")
    xr.DataArray(quality, dims=("y", "x"), coords={"x": ds.x, "y": ds.y}).rio.write_crs(
        32631
    ).rio.to_raster(work / "custom.tif")
    (work / "broken.tif").write_text("not a raster")
    script = r"""
import inspect
import io
import json
from pathlib import Path
import numpy as np
import rasterio
from fastapi.testclient import TestClient
from bowser import main
from bowser.state import BowserState
from bowser.titiler import RasterGroup

work = Path.cwd()
cog = BowserState(
    mode="cog",
    raster_groups={
        "displacement": RasterGroup(
            name="displacement",
            file_list=[
                str(work / f"displacement_20260101_{d}.tif")
                for d in ("20260101", "20260113")
            ],
        ),
        "quality": RasterGroup(
            name="quality",
            file_list=[
                str(work / f"quality_{d}.tif") for d in ("20260101", "20260113")
            ],
        ),
        "velocity": RasterGroup(
            name="velocity", file_list=[str(work / "velocity.tif")]
        ),
    },
)
md = main._default_state
client = TestClient(main.app)
result = {}
for mode, state in (("md", md), ("cog", cog)):
    main._default_state = state
    cases = {
        "stored": {},
        "static": {"variable": "velocity"},
        "clamped": {"time_idx": 900},
        "negative": {"time_idx": -1},
        "layer": {
            "layer_masks": json.dumps(
                [{"dataset": "quality", "threshold": 0.5, "mode": "min"}]
            )
        },
        "custom": {"custom_mask_path": str(work / "custom.tif")},
        "missing_custom": {"custom_mask_path": str(work / "absent.tif")},
        "broken_custom": {"custom_mask_path": str(work / "broken.tif")},
        "unknown": {"layer_masks": '[{"dataset":"missing"}]'},
        "bad_json": {"layer_masks": "{broken"},
        "not_list": {"layer_masks": "{}"},
        "bad_item": {"layer_masks": "[3]"},
        "bad_mode": {"layer_masks": '[{"dataset":"quality","mode":"fake"}]'},
        "nan": {"layer_masks": '[{"dataset":"quality","threshold":NaN}]'},
        "max": {"layer_masks": '[{"dataset":"quality","mode":"max","threshold":0.5}]'},
    }
    if mode == "md":
        cases["primary"] = {"mask_variable": "quality", "mask_min_value": 0.5}
    else:
        cases["primary"] = {"mask_min_value": 0.5}
    for name, params in cases.items():
        cog.raster_groups["displacement"].mask_file_list = (
            cog.raster_groups["quality"].file_list if name == "primary" else []
        )
        response = client.get(
            "/export/geotiff",
            params={"variable": "displacement", "time_idx": 1, **params},
        )
        case = {"status": response.status_code}
        if response.status_code == 200:
            with rasterio.MemoryFile(response.content) as mem, mem.open() as src:
                case.update(
                    tags=src.tags(),
                    values=np.nan_to_num(src.read(1), nan=-9999).tolist(),
                    valid=(~src.read(1, masked=True).mask).tolist(),
                    crs=src.crs.to_epsg(),
                    filename=response.headers["content-disposition"],
                )
        result[f"{mode}_{name}"] = case
    # No source mutations or stale provenance may be introduced into subsequent exports.
    if mode == "md":
        assert not any(
            k.startswith("BOWSER_") for k in state.dataset.displacement.attrs
        )
(work / "results.json").write_text(json.dumps(result))
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env["BOWSER_STACK_DATA_FILE"] = str(work / "cube.zarr")
    run = subprocess.run(
        [sys.executable, "-c", script],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=75,
    )
    assert run.returncode == 0, run.stdout[-1000:] + run.stderr[-4000:]
    return json.loads((work / "results.json").read_text())


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_api_dates_units_grid_zero_and_intrinsic_nodata(exports, mode):
    case = exports[f"{mode}_stored"]
    assert case["status"] == 200
    assert "displacement_20260101-20260113.tif" in case["filename"]
    info = json.loads(case["tags"]["BOWSER_EXPORT_PROVENANCE"])
    assert info["reference"]["mode"] == "stored"
    assert info["time"]["selected_index"] == 1
    assert info["masks"]["applied"] == []
    assert info["source"]["units"] == "meters"
    assert case["crs"] == 32631
    assert not case["valid"][0][0]
    assert case["valid"][0][1] and case["values"][0][1] == 0
    assert exports[f"{mode}_clamped"]["tags"] == case["tags"]
    assert "velocity.tif" in exports[f"{mode}_static"]["filename"]
    if mode == "md":
        assert info["source"]["frame"] == "42"


@pytest.mark.parametrize(
    "mode,op,keep_equal", [("md", ">=", True), ("cog", ">", False)]
)
def test_record_actual_mask_operators_and_support(exports, mode, op, keep_equal):
    case = exports[f"{mode}_layer"]
    assert case["status"] == 200
    info = json.loads(case["tags"]["BOWSER_EXPORT_PROVENANCE"])
    mask = info["masks"]["applied"][0]
    assert mask["operator"] == op
    assert mask["threshold"] == 0.5
    assert mask["time_index"] == 1
    assert case["valid"][0][1] == keep_equal
    assert not case["valid"][1][1]
    assert case["values"][2][2] == 8
    assert "_masked.tif" in case["filename"]
    custom = json.loads(exports[f"{mode}_custom"]["tags"]["BOWSER_EXPORT_PROVENANCE"])
    assert custom["masks"]["applied"][0]["file"] == "custom.tif"
    assert str(exports).find("export-provenance") == -1


@pytest.mark.parametrize("mode", ["md", "cog"])
@pytest.mark.parametrize(
    "case",
    [
        "missing_custom",
        "broken_custom",
        "unknown",
        "bad_json",
        "not_list",
        "bad_item",
        "bad_mode",
        "nan",
    ],
)
def test_unapplied_masks_cannot_be_claimed_in_successful_exports(exports, mode, case):
    assert exports[f"{mode}_{case}"]["status"] == 422


def test_preserve_md_max_and_primary_and_reject_unsupported_cog_max(exports):
    assert exports["md_max"]["status"] == 200
    assert not exports["md_max"]["valid"][0][2]
    assert exports["cog_max"]["status"] == 422
    case = exports["md_primary"]
    assert not case["valid"][0][1]  # primary is strict > .5, unlike MD layer min
    info = json.loads(case["tags"]["BOWSER_EXPORT_PROVENANCE"])
    assert info["masks"]["applied"][0]["operator"] == ">"


def test_cog_primary_mask_and_negative_indices_are_reported(exports):
    case = exports["cog_primary"]
    assert case["status"] == 200
    assert case["valid"][0][1]  # configured primary mask includes equal threshold
    assert not case["valid"][1][1]
    info = json.loads(case["tags"]["BOWSER_EXPORT_PROVENANCE"])
    assert info["masks"]["applied"][0]["operator"] == ">="
    assert info["masks"]["applied"][0]["file"] == "quality_20260113.tif"
    assert "_masked.tif" in case["filename"]
    for mode in ("md", "cog"):
        assert exports[f"{mode}_negative"]["status"] == 422
