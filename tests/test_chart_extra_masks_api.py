"""Compare point/radius primary and uploaded masks with known native support."""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest


def _exercise(work: Path, mode: str) -> None:
    import numpy as np
    import rioxarray  # noqa: F401
    import xarray as xr
    from fastapi.testclient import TestClient
    from pyproj import Transformer

    x, y = 500005 + 10 * np.arange(12), 115 - 10 * np.arange(12)
    base = np.arange(144, dtype="float32").reshape(12, 12)
    base[6, 6] = 10
    base[3, 3] = 5
    values = np.stack([base * i for i in range(3)])
    primary = np.ones_like(values)
    primary[:, 6, 6] = [1, 0.5, 0]
    quality = np.ones_like(values)
    quality[1, 6, 6] = 0
    custom = np.zeros((12, 12), dtype="float32")
    custom[6, 6] = custom[3, 3] = 1
    dates = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "quality": (("time", "y", "x"), quality),
            "primary": (("time", "y", "x"), primary),
            "custom": (("y", "x"), custom),
        },
        coords={"time": dates, "x": x, "y": y},
    ).rio.write_crs(32631)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    paths: dict[str, list[str | Path]] = {}
    for name in ("displacement", "quality", "primary"):
        paths[name] = []
        for index, date in enumerate(("20260101", "20260113", "20260125")):
            path = work / f"{name}_{date}.tif"
            ds[name].isel(time=index).rio.to_raster(path)
            paths[name].append(str(path))
    custom_path = work / "custom.tif"
    ds.custom.rio.to_raster(custom_path)
    shifted = work / "shifted.tif"
    ds.custom.assign_coords(x=ds.x + 1).rio.to_raster(shifted)
    os.environ["BOWSER_STACK_DATA_FILE"] = str(work / "cube.zarr")
    if mode == "lite":
        from bowser.lite.main import app

        client = TestClient(app, raise_server_exceptions=False)
        result = {}
        for option in (
            {"primary_mask": True},
            {"mask_min_value": 0.5},
            {"custom_mask_path": str(custom_path)},
        ):
            for route in ("multi_point", "buffer_timeseries"):
                response = client.post(
                    "/" + route,
                    json={
                        "dataset_name": "displacement",
                        "points": [],
                        "lon": 3,
                        "lat": 0,
                        **option,
                    },
                )
                result[route + next(iter(option))] = response.status_code
        (work / "result.json").write_text(json.dumps(result))
        return
    from bowser import main
    from bowser.state import BowserState
    from bowser.titiler import RasterGroup

    groups = {
        name: RasterGroup(name=name, file_list=files) for name, files in paths.items()
    }
    groups["displacement"].mask_file_list = paths["primary"]
    groups["displacement"].mask_min_value = 0.5
    groups["incomplete"] = RasterGroup(
        name="incomplete",
        file_list=paths["displacement"],
        mask_file_list=paths["primary"][:2],
    )
    if mode == "cog":
        main._default_state = BowserState(mode="cog", raster_groups=groups)
    client = TestClient(main.app, raise_server_exceptions=False)
    tr = Transformer.from_crs(32631, 4326, always_xy=True)
    lon, lat = tr.transform(x[6], y[6])
    ref_lon, ref_lat = tr.transform(x[3], y[3])
    result = {}
    options: dict[str, Any]
    cog_labels = groups["displacement"].model_dump()["x_values"]
    for name, options in (
        ("raw", {}),
        ("custom", {"custom_mask_path": str(custom_path)}),
        ("primary", {"primary_mask": True, "mask_min_value": 0.5}),
        ("zero_primary", {"primary_mask": True, "mask_min_value": 0}),
        (
            "combined",
            {
                "primary_mask": True,
                "mask_min_value": 0.5,
                "custom_mask_path": str(custom_path),
                "layer_masks": [{"dataset": "quality", "threshold": 0.5}],
            },
        ),
    ):
        if mode == "md" and name in ("primary", "zero_primary", "combined"):
            continue
        expected = []
        expected_buffer = []
        for index in range(3):
            keep = np.ones((12, 12), dtype=bool)
            if "custom_mask_path" in options:
                keep &= custom > (0 if mode == "md" else 0.5)
            if options.get("primary_mask"):
                keep &= (primary[index] != 0) & (
                    primary[index] >= options["mask_min_value"]
                )
            if options.get("layer_masks"):
                keep &= quality[index] >= 0.5 if mode == "md" else quality[index] > 0.5
            label = str(dates[index])[:10] if mode == "md" else cog_labels[index]
            if keep[6, 6]:
                expected.append({"x": label, "y": float(values[index, 6, 6])})
            xx, yy = np.meshgrid(x, y)
            patch = values[index][keep & ((xx - x[6]) ** 2 + (yy - y[6]) ** 2 <= 11**2)]
            if patch.size:
                expected_buffer.append({"x": label, "y": float(np.median(patch))})
        if name == "zero_primary":
            import rasterio

            for index in (0, 2):
                response = client.get(
                    "/export/geotiff",
                    params={
                        "variable": "displacement",
                        "time_idx": index,
                        "mask_min_value": 0,
                    },
                )
                assert response.status_code == 200, response.text[:200]
                with (
                    rasterio.MemoryFile(response.content) as memory,
                    memory.open() as raster,
                ):
                    result[f"export_zero_{index}"] = {
                        "valid": bool(raster.read_masks(1)[6, 6]),
                        "value": float(raster.read(1)[6, 6]),
                    }
        body = {
            "dataset_name": "displacement",
            "points": [{"id": "a", "lon": lon, "lat": lat}],
            **options,
        }
        for route in ("multi_point", "buffer_timeseries"):
            response = client.post(
                "/" + route,
                json={**body, "lon": lon, "lat": lat, "buffer_m": 11, "n_samples": 0},
            )
            result[f"{name}_{route}"] = {
                "status": response.status_code,
                "body": response.json(),
                "expected": expected if route == "multi_point" else expected_buffer,
            }
    for radius in (0, 11):
        response = client.post(
            "/multi_point",
            json={
                "dataset_name": "displacement",
                "points": [{"id": "a", "lon": lon, "lat": lat}],
                "custom_mask_path": str(custom_path),
                "ref_lon": ref_lon,
                "ref_lat": ref_lat,
                "ref_buffer_m": radius,
            },
        )
        result[f"reference_{radius}"] = {
            "status": response.status_code,
            "body": response.json(),
        }
    hidden_lon, hidden_lat = tr.transform(x[6], y[5])
    response = client.post(
        "/multi_point",
        json={
            "dataset_name": "displacement",
            "points": [{"id": "a", "lon": hidden_lon, "lat": hidden_lat}],
            "custom_mask_path": str(custom_path),
        },
    )
    result["hidden"] = {"status": response.status_code, "body": response.json()}
    if mode == "md":
        xx, yy = np.meshgrid(x, y)
        circle = (xx - x[6]) ** 2 + (yy - y[6]) ** 2 <= 11**2
        for kind in ("shifted", "geographic", "resolution"):
            path = work / (kind + ".tif")
            if kind == "geographic":
                ds.custom.rio.reproject(4326).rio.to_raster(path)
            elif kind == "resolution":
                ds.custom.rio.reproject(32631, resolution=5).rio.to_raster(path)
            keep = main._custom_mask_on(ds.displacement, str(path)).values
            assert keep[6, 6] and not keep[5, 6]
            for route in ("multi_point", "buffer_timeseries"):
                response = client.post(
                    "/" + route,
                    json={
                        "dataset_name": "displacement",
                        "points": [
                            {"id": "a", "lon": lon, "lat": lat},
                            {"id": "b", "lon": hidden_lon, "lat": hidden_lat},
                        ],
                        "lon": lon,
                        "lat": lat,
                        "buffer_m": 11,
                        "n_samples": 0,
                        "custom_mask_path": str(path),
                    },
                )
                assert response.status_code == 200, response.text
                body = response.json()
                actual = (
                    body["datasets"][0]["data"]
                    if route == "multi_point"
                    else body["median"]
                )
                expected = (
                    values[:, 6, 6]
                    if route == "multi_point"
                    else np.median(values[:, keep & circle], axis=1)
                )
                assert [row["y"] for row in actual] == expected.tolist()
                if route == "multi_point":
                    assert body["datasets"][1]["data"] == []
                else:
                    assert body["n_pixels"] == int((keep & circle).sum())
                result[f"warped_{kind}_{route}"] = True
    for name, options in (
        ("missing", {"custom_mask_path": str(work / "absent.tif")}),
        ("shifted", {"custom_mask_path": str(shifted)}),
        ("empty", {"custom_mask_path": ""}),
        ("threshold_without_mask", {"mask_min_value": 0.5}),
        ("incomplete", {"dataset_name": "incomplete", "primary_mask": True}),
        ("md_primary", {"primary_mask": True}),
    ):
        if name == "shifted" and mode == "md":
            continue
        if (name == "md_primary") != (mode == "md") and name in (
            "incomplete",
            "md_primary",
        ):
            continue
        for route in ("multi_point", "buffer_timeseries"):
            response = client.post(
                "/" + route,
                json={
                    "dataset_name": "displacement",
                    "points": [{"id": "a", "lon": lon, "lat": lat}],
                    "lon": lon,
                    "lat": lat,
                    "buffer_m": 11,
                    **options,
                },
            )
            result[f"invalid_{name}_{route}"] = response.status_code
    (work / "result.json").write_text(json.dumps(result))


@pytest.fixture(scope="module", params=["md", "cog"])
def responses(tmp_path_factory, request):
    work = tmp_path_factory.mktemp("chart-extra-masks-" + request.param)
    process = subprocess.run(
        [sys.executable, __file__, str(work), request.param],
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert process.returncode == 0, process.stdout + process.stderr
    return request.param, json.loads((work / "result.json").read_text())


@pytest.mark.parametrize(
    "name", ["raw", "custom", "primary", "zero_primary", "combined"]
)
@pytest.mark.parametrize("route", ["multi_point", "buffer_timeseries"])
def test_masks_preserve_known_values_and_valid_zero(responses, name, route):
    mode, results = responses
    if mode == "md" and name in ("primary", "zero_primary", "combined"):
        pytest.skip("GeoZarr map uses layer masks, not configured primary masks")
    value = results[f"{name}_{route}"]
    assert value["status"] == 200
    actual = (
        value["body"]["datasets"][0]["data"]
        if route == "multi_point"
        else value["body"]["median"]
    )
    assert actual == value["expected"]
    assert actual[0]["y"] == 0


@pytest.mark.parametrize("radius", [0, 11])
def test_custom_mask_does_not_change_stored_reference_policy(responses, radius):
    _, results = responses
    value = results[f"reference_{radius}"]
    assert value["status"] == 200
    assert [row["y"] for row in value["body"]["datasets"][0]["data"]] == (
        [0, 5, 10] if radius == 0 else [0, -28, -56]
    )


def test_masked_pixel_does_not_produce_measurements(responses):
    _, results = responses
    assert results["hidden"]["status"] == 200
    assert results["hidden"]["body"]["datasets"][0]["data"] == []


@pytest.mark.parametrize(
    "name",
    [
        "missing",
        "shifted",
        "empty",
        "threshold_without_mask",
        "incomplete",
        "md_primary",
    ],
)
@pytest.mark.parametrize("route", ["multi_point", "buffer_timeseries"])
def test_invalid_masks_are_reported(responses, name, route):
    _, results = responses
    key = f"invalid_{name}_{route}"
    if key not in results:
        pytest.skip("Mode-specific configuration")
    assert results[key] == 422


@pytest.mark.parametrize("index", [0, 2])
def test_zero_primary_export_matches_existing_map_rule(responses, index):
    mode, result = responses
    if mode != "cog":
        pytest.skip("Configured mask is a GeoTIFF setting")
    assert result[f"export_zero_{index}"]["valid"] == (index == 0)
    if index == 0:
        assert result[f"export_zero_{index}"]["value"] == 0


def test_lite_does_not_silently_accept_unsupported_chart_masks(tmp_path):
    process = subprocess.run(
        [sys.executable, __file__, str(tmp_path), "lite"],
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert process.returncode == 0, process.stdout + process.stderr
    statuses = json.loads((tmp_path / "result.json").read_text())
    assert len(statuses) == 6 and set(statuses.values()) == {501}


if __name__ == "__main__":
    _exercise(Path(sys.argv[1]), sys.argv[2])
