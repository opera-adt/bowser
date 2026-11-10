"""Source metadata and unchanged point values in full/lite MD and direct TIFF modes."""

import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import rioxarray  # noqa: F401
import xarray as xr
from pyproj import Transformer


def _exercise(work: Path) -> None:
    import json

    from fastapi.testclient import TestClient

    from bowser import main
    from bowser.lite import main as lite
    from bowser.state import BowserState
    from bowser.titiler import RasterGroup

    md = main._default_state
    groups = {}
    for name in md.dataset.data_vars:
        if name == "spatial_ref":
            continue
        files = [
            str(work / f"{name}_{idx}.tif")
            for idx in range(2 if name == "displacement" else 1)
        ]
        groups[name] = RasterGroup(name=name, file_list=files)
    cog = BowserState(mode="cog", raster_groups=groups)
    x, y = float(md.dataset.x[5]), float(md.dataset.y[4])
    lon, lat = Transformer.from_crs(32611, 4326, always_xy=True).transform(x, y)
    snapshots = {}
    for mode in ("md", "cog", "lite"):
        main._default_state = cog if mode == "cog" else md
        client = TestClient(lite.app if mode == "lite" else main.app)
        response = client.get("/datasets")
        assert response.status_code == 200, (mode, response.text)
        data = response.json()
        displacement = data["displacement"]
        assert displacement["unit"] == "cm"
        assert (
            displacement["source_description"]
            == "Source positive direction: away from sensor."
        )
        assert displacement["description"] == (
            "Source positive direction: away from sensor."
        )
        assert displacement["description_source"] == "source"
        assert "not automatically total 3D movement" in displacement["guidance"]
        assert "guidance" not in data["unfamiliar"]
        assert data["water_mask"]["description_source"] == "bowser"
        assert displacement["los_metadata"] is None
        assert data["water_mask"]["source_flags"] == [
            {"value": "0", "label": "land"},
            {"value": "1", "label": "water"},
        ]
        assert data["unfamiliar"]["description"] == "Temperature anomaly."
        assert data["unfamiliar"]["description_source"] == "source"
        assert data["undocumented"]["unit"] == ""
        assert data["undocumented"]["unit_status"] == "missing"
        assert data["undocumented"]["description_source"] == "unknown"
        for epoch in (0, 1):
            response = client.get(
                "/point",
                params={
                    "dataset_name": "displacement",
                    "lon": lon,
                    "lat": lat,
                    "time_idx": epoch,
                },
            )
            assert response.status_code == 200, (mode, response.text)
            expected = 0 if epoch == 0 else 4 * 16 + 5
            assert response.json() == [expected], (mode, response.json())
        snapshots[mode] = {
            key: displacement[key]
            for key in (
                "description",
                "description_source",
                "guidance",
                "source_description",
                "source_flags",
                "unit",
                "unit_status",
            )
        }
    assert snapshots["md"] == snapshots["lite"] == snapshots["cog"]
    print(json.dumps({"status": "PASS", "modes": list(snapshots)}))


def test_actual_dataset_endpoints_and_point_values(tmp_path):
    values = np.arange(16 * 16, dtype="float32").reshape(16, 16)
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                np.stack([values * 0, values]),
                {
                    "units": "cm",
                    "description": "Source positive direction: away from sensor.",
                },
            ),
            "water_mask": (
                ("y", "x"),
                (values % 2).astype("uint8"),
                {
                    "units": "unitless",
                    "flag_values": [0, 1],
                    "flag_meanings": "land water",
                },
            ),
            "unfamiliar": (
                ("y", "x"),
                values,
                {"description": "Temperature anomaly.", "units": "K"},
            ),
            "undocumented": (("y", "x"), values),
        },
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": 500000 + 30 * (np.arange(16) + 0.5),
            "y": 4000000 - 30 * (np.arange(16) + 0.5),
        },
    ).rio.write_crs(32611)
    ds.to_zarr(tmp_path / "cube.zarr", consolidated=False)
    for name in ds.data_vars:
        for idx in range(2 if "time" in ds[name].dims else 1):
            layer = ds[name].isel(time=idx) if "time" in ds[name].dims else ds[name]
            layer.rio.to_raster(tmp_path / f"{name}_{idx}.tif")
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("BOWSER_")
    }
    env["BOWSER_STACK_DATA_FILE"] = str(tmp_path / "cube.zarr")
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(tmp_path)],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout[-1000:] + result.stderr[-5000:]


if __name__ == "__main__":
    _exercise(Path(sys.argv[1]))
