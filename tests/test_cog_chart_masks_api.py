"""Compare GeoTIFF chart support with real masked exports and known samples."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


def _exercise(work: Path) -> None:
    import hashlib

    import numpy as np
    import rasterio
    import rioxarray  # noqa: F401
    import xarray as xr
    from fastapi.testclient import TestClient
    from pyproj import Transformer

    x, y = 500005 + 10 * np.arange(12), 115 - 10 * np.arange(12)
    data = np.arange(144, dtype="float32").reshape(12, 12)
    data[8, 8] = 5
    data[4, 4] = 100
    data[3, 4], data[4, 3], data[4, 5], data[5, 4] = 1, 2, 3, 4
    data[0, 0] = np.nan
    data[3, 3] = 0
    values = np.stack([data * i for i in range(3)])
    quality = np.ones_like(values)
    quality[1, 8, 8] = 0
    quality[2, 8, 7] = 0.5
    quality[1, 4, 4] = 0
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "quality": (("time", "y", "x"), quality),
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
    files = {}
    for name in ("displacement", "quality"):
        files[name] = []
        for index, date in enumerate(("20260101", "20260113", "20260125")):
            path = work / f"{name}_{date}.tif"
            ds[name].isel(time=index).rio.write_nodata(np.nan).rio.to_raster(path)
            if name == "displacement":
                with rasterio.open(path, "r+") as source:
                    valid = np.full((12, 12), 255, dtype="uint8")
                    valid[0, 1] = 0
                    source.write_mask(valid)
            files[name].append(str(path))
    shifted = work / "shifted.tif"
    ds.quality.isel(time=0).assign_coords(x=ds.x + 1).rio.to_raster(shifted)
    os.environ["BOWSER_STACK_DATA_FILE"] = str(work / "cube.zarr")
    from bowser import main
    from bowser.state import BowserState
    from bowser.titiler import RasterGroup

    groups = {
        name: RasterGroup(name=name, file_list=paths) for name, paths in files.items()
    }
    groups["static_quality"] = RasterGroup(
        name="static_quality", file_list=files["quality"][:1]
    )
    groups["wrong_dates"] = RasterGroup(
        name="wrong_dates", file_list=files["quality"][::-1]
    )
    groups["short"] = RasterGroup(name="short", file_list=files["quality"][:2])
    groups["shifted"] = RasterGroup(name="shifted", file_list=[str(shifted)])
    main._default_state = BowserState(mode="cog", raster_groups=groups)
    client = TestClient(main.app, raise_server_exceptions=False)
    tr = Transformer.from_crs(32631, 4326, always_xy=True)
    lon, lat = tr.transform(x[8], y[8])
    ref_lon, ref_lat = tr.transform(x[4], y[4])
    source_hashes = {
        p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in work.glob("*.tif*")
    }
    result = {}
    for name, mode in (
        ("quality", "min"),
        ("quality", "max"),
        ("static_quality", "min"),
    ):
        masks = [{"dataset": name, "threshold": 0.5, "mode": mode}]
        suffix = f"{name}_{mode}"
        body = {
            "dataset_name": "displacement",
            "points": [{"id": "a", "lon": lon, "lat": lat}],
            "layer_masks": masks,
        }
        response = client.post("/multi_point", json=body)
        result[f"point_{suffix}"] = {
            "status": response.status_code,
            "body": response.json(),
        }
        for radius in (1, 11):
            response = client.post(
                "/buffer_timeseries",
                json={
                    **body,
                    "lon": lon,
                    "lat": lat,
                    "buffer_m": radius,
                    "n_samples": 3,
                },
            )
            result[f"buffer_{suffix}_{radius}"] = {
                "status": response.status_code,
                "body": response.json(),
            }
            expected = []
            for index in range(3):
                q = ds.quality.values[0 if name == "static_quality" else index]
                valid_q = np.isfinite(q) & ((q <= 0.5) if mode == "max" else (q > 0.5))
                field = np.where(valid_q, ds.displacement.values[index], np.nan)
                field[0, 1] = np.nan  # the independently imposed GDAL mask
                if mode == "min":
                    exported = client.get(
                        "/export/geotiff",
                        params={
                            "variable": "displacement",
                            "time_idx": index,
                            "layer_masks": json.dumps(masks),
                        },
                    )
                    assert exported.status_code == 200, exported.text[:200]
                    with (
                        rasterio.MemoryFile(exported.content) as memory,
                        memory.open() as src,
                    ):
                        np.testing.assert_array_equal(src.read(1), field)
                yy, xx = np.meshgrid(y, x, indexing="ij")
                patch = field[(xx - x[8]) ** 2 + (yy - y[8]) ** 2 <= radius**2]
                valid = patch[np.isfinite(patch)]
                if valid.size:
                    expected.append(
                        {
                            "x": groups["displacement"].x_values[index],
                            "y": float(np.median(valid)),
                        }
                    )
            result[f"expected_buffer_{suffix}_{radius}"] = expected
    for radius in (0, 11):
        response = client.post(
            "/multi_point",
            json={
                "dataset_name": "displacement",
                "points": [{"id": "a", "lon": lon, "lat": lat}],
                "ref_lon": ref_lon,
                "ref_lat": ref_lat,
                "ref_buffer_m": radius,
            },
        )
        result[f"reference_{radius}"] = {
            "status": response.status_code,
            "body": response.json(),
        }
    for name in ("wrong_dates", "short", "shifted", "missing"):
        for route in ("multi_point", "buffer_timeseries"):
            response = client.post(
                "/" + route,
                json={
                    "dataset_name": "displacement",
                    "points": [{"id": "a", "lon": lon, "lat": lat}],
                    "lon": lon,
                    "lat": lat,
                    "buffer_m": 11,
                    "layer_masks": [{"dataset": name}],
                },
            )
            result[f"invalid_{route}_{name}"] = response.status_code
    # The reference is a stored datum, not a quality-screened observation.
    for radius in (0, 11):
        response = client.post(
            "/multi_point",
            json={
                "dataset_name": "displacement",
                "points": [
                    {
                        "id": "b",
                        "lon": tr.transform(x[7], y[7])[0],
                        "lat": tr.transform(x[7], y[7])[1],
                    }
                ],
                "ref_lon": ref_lon,
                "ref_lat": ref_lat,
                "ref_buffer_m": radius,
                "layer_masks": [{"dataset": "quality", "threshold": 0.5}],
            },
        )
        result[f"raw_reference_{radius}"] = response.json()
    for key, row, col in [("invalid", 0, 1), ("zero", 3, 3)]:
        response = client.get(
            "/point",
            params={
                "dataset_name": "displacement",
                "lon": tr.transform(x[col], y[row])[0],
                "lat": tr.transform(x[col], y[row])[1],
            },
        )
        assert response.status_code == 200, response.text
        result[f"point_{key}"] = response.json()
    assert source_hashes == {
        p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in source_hashes
    }
    (work / "results.json").write_text(json.dumps(result))


@pytest.fixture(scope="module")
def responses(tmp_path_factory):
    work = tmp_path_factory.mktemp("cog-chart-masks")
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    run = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(work)],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert run.returncode == 0, run.stdout[-1000:] + run.stderr[-5000:]
    return json.loads((work / "results.json").read_text())


@pytest.mark.parametrize(
    "name,mode,expected",
    [
        ("quality", "min", [0, 10]),
        ("quality", "max", [5]),
        ("static_quality", "min", [0, 5, 10]),
    ],
)
def test_point_charts_honor_masks(responses, name, mode, expected):
    response = responses[f"point_{name}_{mode}"]
    assert response["status"] == 200
    assert [row["y"] for row in response["body"]["datasets"][0]["data"]] == expected


@pytest.mark.parametrize(
    "name,mode", [("quality", "min"), ("quality", "max"), ("static_quality", "min")]
)
@pytest.mark.parametrize("radius", [1, 11])
def test_buffer_charts_match_known_truth_and_supported_exports(
    responses, name, mode, radius
):
    response = responses[f"buffer_{name}_{mode}_{radius}"]
    assert response["status"] == 200
    assert (
        response["body"]["median"]
        == responses[f"expected_buffer_{name}_{mode}_{radius}"]
    )


@pytest.mark.parametrize("radius,expected", [(0, [0, -95, -190]), (11, [0, 2, 4])])
def test_reference_uses_requested_point_or_buffer(responses, radius, expected):
    response = responses[f"reference_{radius}"]
    assert response["status"] == 200
    assert [row["y"] for row in response["body"]["datasets"][0]["data"]] == expected


@pytest.mark.parametrize("name", ["wrong_dates", "short", "shifted", "missing"])
@pytest.mark.parametrize("route", ["multi_point", "buffer_timeseries"])
def test_invalid_mask_alignment_is_reported(responses, name, route):
    assert responses[f"invalid_{route}_{name}"] == 422


@pytest.mark.parametrize("radius,expected", [(0, [0, -9, -18]), (11, [0, 88, 176])])
def test_display_mask_does_not_change_stored_reference(responses, radius, expected):
    result = responses[f"raw_reference_{radius}"]
    assert [p["y"] for p in result["datasets"][0]["data"]] == expected


def test_unmasked_points_preserve_gdal_validity_and_zero(responses):
    assert responses["point_invalid"] == [None, None, None]
    assert responses["point_zero"] == [0, 0, 0]


if __name__ == "__main__":
    _exercise(Path(sys.argv[1]))
