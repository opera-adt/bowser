"""Check native polygon statistics through full-server and catalog APIs."""

import json
import os
import subprocess
import sys

import numpy as np
import pytest
import rioxarray  # noqa: F401
import xarray as xr
from pyproj import Transformer

from bowser.catalog import CatalogEntry, save_catalog


@pytest.fixture(scope="module")
def responses(tmp_path_factory):
    work = tmp_path_factory.mktemp("polygon-api")
    field = np.arange(16, dtype="float32").reshape(4, 4)
    field[0, 0] = np.nan
    field[1, 1] = 0
    values = np.stack([field * 0, field, field * 2])
    values[1, 2, 2] = np.nan
    dates = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "velocity": (("y", "x"), field, {"units": "m/year"}),
            "bad_shape": (("other", "time", "y", "x"), values[None]),
        },
        coords={
            "time": dates,
            "other": [0],
            "x": [500005, 500015, 500025, 500035],
            "y": [35, 25, 15, 5],
        },
    ).rio.write_crs(32631)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    other = ds[["displacement"]] + 100
    other.displacement.attrs["units"] = "meters"
    other.to_zarr(work / "other.zarr", consolidated=False)
    save_catalog(
        [
            CatalogEntry(
                id="other",
                name="Other cube",
                uri=str(work / "other.zarr"),
                bbox=(2, 0, 4, 1),
            )
        ],
        work / "catalog.toml",
    )
    for index, date in enumerate(("20260101", "20260113", "20260125")):
        ds.displacement.isel(time=index).rio.write_nodata(np.nan).rio.to_raster(
            work / f"displacement_{date}.tif"
        )
    ds.velocity.rio.write_nodata(np.nan).rio.to_raster(work / "velocity.tif")
    transform = Transformer.from_crs(32631, 4326, always_xy=True)
    ring = [
        transform.transform(x, y)
        for x, y in (
            (500010, 10),
            (500030, 10),
            (500030, 30),
            (500010, 30),
            (500010, 10),
        )
    ]
    geometry = {"type": "Polygon", "coordinates": [ring]}
    (work / "geometry.json").write_text(json.dumps(geometry))
    script = r"""
import json
from pathlib import Path
from fastapi.testclient import TestClient
from bowser import main
from bowser.state import BowserState
from bowser.titiler import RasterGroup

work = Path.cwd()
geometry = json.loads((work / "geometry.json").read_text())
body = {"variable": "displacement", "geometry": geometry}
md = main._default_state
cog = BowserState(
    mode="cog",
    raster_groups={
        "displacement": RasterGroup(
            name="displacement",
            file_list=[
                str(work / f"displacement_{d}.tif")
                for d in ("20260101", "20260113", "20260125")
            ],
            uses_spatial_ref=True,
            algorithm="shift",
        ),
        "velocity": RasterGroup(
            name="velocity", file_list=[str(work / "velocity.tif")]
        ),
    },
)
result = {}
client = TestClient(main.app)
for mode, state in (("md", md), ("cog", cog)):
    main._default_state = state
    for name, updates in {
        "common": {},
        "per_date": {"support": "per_date"},
        "static": {"variable": "velocity"},
        "unknown": {"variable": "missing"},
        "reference": {"ref_lon": 3, "ref_lat": 0},
        "masks": {"layer_masks": []},
        "custom": {"custom_mask_path": "mask.tif"},
        "bad_percentiles": {"percentiles": [101]},
        "empty": {"geometry": {"type": "Polygon", "coordinates": []}},
    }.items():
        response = client.post("/polygon_timeseries", json={**body, **updates})
        result[f"{mode}_{name}"] = {
            "status": response.status_code,
            "body": response.json(),
        }
main._default_state = md
for name, query in (
    ("catalog", {"dataset": "other"}),
    ("bad_catalog", {"dataset": "absent"}),
):
    response = client.post("/polygon_timeseries", params=query, json=body)
    result[name] = {"status": response.status_code, "body": response.json()}
response = client.post("/polygon_timeseries", json={**body, "variable": "bad_shape"})
result["bad_shape"] = {"status": response.status_code}
assert not any(k.startswith("BOWSER_") for k in md.dataset.displacement.attrs)
from bowser.lite.main import app as lite

response = TestClient(lite).post("/polygon_timeseries", json=body)
result["lite"] = {"status": response.status_code, "body": response.json()}
(work / "result.json").write_text(json.dumps(result))
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(work / "cube.zarr"),
        BOWSER_CATALOG_FILE=str(work / "catalog.toml"),
    )
    run = subprocess.run(
        [sys.executable, "-c", script],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=75,
    )
    assert run.returncode == 0, run.stdout[-1000:] + run.stderr[-5000:]
    return json.loads((work / "result.json").read_text())


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_known_endpoint_statistics_labels_units_and_scope(responses, mode):
    case = responses[f"{mode}_common"]
    assert case["status"] == 200
    result = case["body"]
    assert result["labels"] == ["2026-01-01", "2026-01-13", "2026-01-25"]
    assert result["units"] == "meters"
    assert result["polygon_pixels"] == 4
    assert result["common_pixels"] == 3
    assert result["valid_per_date"] == [4, 3, 4]
    assert [row["mean"] for row in result["statistics"]] == [0, 5, 10]
    assert [row["median"] for row in result["statistics"]] == [0, 6, 12]
    assert result["reference"] == "stored"
    assert result["component_compatibility"] == "unverified"
    assert result["optional_masks_applied"] is False
    assert result["grid"]["crs"] == "EPSG:32631"
    per_date = responses[f"{mode}_per_date"]["body"]
    assert [row["mean"] for row in per_date["statistics"]] == [0, 5, 12.5]
    assert any("membership changes" in w for w in per_date["warnings"])
    assert responses[f"{mode}_static"]["status"] == 200
    assert responses[f"{mode}_static"]["body"]["units"] == "m/year"


@pytest.mark.parametrize("mode", ["md", "cog"])
@pytest.mark.parametrize("case", ["reference", "custom", "bad_percentiles", "empty"])
def test_unsupported_arguments_not_silently_ignored(responses, mode, case):
    assert responses[f"{mode}_{case}"]["status"] == 422


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_explicit_empty_masks_preserve_the_stored_summary(responses, mode):
    assert responses[f"{mode}_masks"]["status"] == 200
    assert responses[f"{mode}_masks"]["body"] == responses[f"{mode}_common"]["body"]


def test_catalog_isolation_and_lite_scope(responses):
    assert responses["catalog"]["status"] == 200
    assert [r["mean"] for r in responses["catalog"]["body"]["statistics"]] == [
        100,
        105,
        110,
    ]
    assert responses["bad_catalog"]["status"] == 404
    assert (
        responses["md_unknown"]["status"] == responses["cog_unknown"]["status"] == 404
    )
    assert responses["bad_shape"]["status"] == 422
    # bowser-lite answers the same request with the same body (numpy selection).
    assert responses["lite"]["status"] == 200
    assert responses["lite"]["body"] == responses["md_common"]["body"]
