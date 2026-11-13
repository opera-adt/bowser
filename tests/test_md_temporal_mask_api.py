"""Check date-aligned GeoZarr support through actual full and lite endpoints."""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest


def _exercise(work: Path, server: str) -> None:
    import io

    import rasterio
    import rioxarray  # noqa: F401
    import xarray as xr
    from fastapi.testclient import TestClient
    from morecantile import tms
    from PIL import Image
    from pyproj import Transformer

    zoom, tile_x, tile_y, size = 12, 2048, 2047, 16
    left, bottom, right, top = tms.get("WebMercatorQuad").xy_bounds(
        tile_x, tile_y, zoom
    )
    spacing = (right - left) / size
    x = left + (np.arange(size) + 0.5) * spacing
    y = top - (np.arange(size) + 0.5) * spacing
    dates = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    data = np.arange(size * size, dtype="float32").reshape(size, size)
    data[0, 0] = np.nan
    data[8, 8] = 5
    values = np.stack([data * 0, data, data * 2])
    quality = np.ones_like(values)
    quality[0, :, :2] = 0
    quality[1, :, :5] = 0
    quality[2, :, :8] = 0
    quality[1, 8, 8] = 0
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "quality": (("time", "y", "x"), quality),
            "static_quality": (("y", "x"), quality[0]),
            "velocity": (("y", "x"), data, {"units": "m/year"}),
            "wrong_quality": (("quality_time", "y", "x"), quality),
            "short_quality": (("ministack", "y", "x"), quality[:2]),
        },
        coords={
            "time": dates,
            "quality_time": dates + np.timedelta64(1, "D"),
            "ministack": [0, 1],
            "x": x,
            "y": y,
        },
    ).rio.write_crs(3857)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    os.environ["BOWSER_STACK_DATA_FILE"] = str(work / "cube.zarr")
    if server == "full":
        from bowser.main import app
    else:
        from bowser.lite.main import app
    client = TestClient(app, raise_server_exceptions=False)
    lon, lat = Transformer.from_crs(3857, 4326, always_xy=True).transform(x[8], y[8])
    result: dict[str, Any] = {"server": server}
    result["layer_info"] = client.get("/datasets").json()
    result["empty_masks"] = client.get(
        "/export/geotiff",
        params={"variable": "displacement", "time_idx": 1, "layer_masks": ""},
    ).status_code
    if server == "full":
        import bowser.main as full

        # The non-dask optimization must retain the same nodata and date-wise
        # contract as lazy samples, and select before comparison/read.
        special = ds[["displacement", "quality"]].copy(deep=True)
        special["quality"].values[1, 8, 8] = -9999
        special["quality"].attrs["missing_value"] = -9999
        masks = [{"dataset": "quality", "threshold": 2, "mode": "max"}]
        samples = full._point_values_direct(
            special, "displacement", x[8], y[8], masks, None
        )
        np.testing.assert_array_equal(samples, [0, np.nan, 10])
        for index in (-1, 0, 1, 2, 99):
            sample = full._point_values_direct(
                special, "displacement", x[8], y[8], masks, index
            )
            np.testing.assert_array_equal(sample, samples[[max(0, min(index, 2))]])

    for name, mode in (
        ("quality", "min"),
        ("quality", "max"),
        ("static_quality", "min"),
    ):
        masks = [{"dataset": name, "threshold": 0.5, "mode": mode}]
        suffix = f"{name}_{mode}"
        point_body = {
            "dataset_name": "displacement",
            "points": [{"id": "a", "lon": lon, "lat": lat}],
            "layer_masks": masks,
        }
        response = client.post("/multi_point", json=point_body)
        result[f"point_{suffix}"] = {
            "status": response.status_code,
            "body": response.json(),
        }
        response = client.post(
            "/buffer_timeseries",
            json={
                "dataset_name": "displacement",
                "lon": lon,
                "lat": lat,
                "buffer_m": spacing / 4,
                "n_samples": 0,
                "layer_masks": masks,
            },
        )
        result[f"buffer_{suffix}"] = {
            "status": response.status_code,
            "body": response.json(),
        }
        expected = quality if name == "quality" else quality[0]
        expected = expected >= 0.5 if mode == "min" else expected <= 0.5
        for index in range(3):
            valid = np.isfinite(values[index]) & (
                expected[index] if expected.ndim == 3 else expected
            )
            response = client.get(
                f"/md/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.png",
                params={
                    "variable": "displacement",
                    "time_idx": index,
                    "layer_masks": json.dumps(masks),
                    "rescale": "0,600",
                    "colormap_name": "rdbu",
                    "tilesize": 256,
                },
            )
            assert response.status_code == 200, response.text[:200]
            alpha = (
                np.asarray(Image.open(io.BytesIO(response.content)).convert("RGBA"))[
                    :, :, 3
                ]
                > 0
            )
            np.testing.assert_array_equal(alpha, valid.repeat(16, 0).repeat(16, 1))
            if server in ("full", "lite"):
                response = client.get(
                    "/export/geotiff",
                    params={
                        "variable": "displacement",
                        "time_idx": index,
                        "layer_masks": json.dumps(masks),
                    },
                )
                assert response.status_code == 200, response.text[:200]
                with (
                    rasterio.MemoryFile(response.content) as memory,
                    memory.open() as src,
                ):
                    np.testing.assert_array_equal(src.read_masks(1) > 0, valid)
                    np.testing.assert_array_equal(
                        src.read(1)[valid], values[index][valid]
                    )
                # Rebaselining must keep the raw reference date even where
                # its display quality fails; only the selected date is masked.
                shifted = client.get(
                    "/export/geotiff",
                    params={
                        "variable": "displacement",
                        "time_idx": index,
                        "ref_time_idx": 1,
                        "layer_masks": json.dumps(masks),
                    },
                )
                assert shifted.status_code == 200, shifted.text[:200]
                with (
                    rasterio.MemoryFile(shifted.content) as memory,
                    memory.open() as src,
                ):
                    np.testing.assert_array_equal(src.read_masks(1) > 0, valid)
                    np.testing.assert_array_equal(
                        src.read(1)[valid], (values[index] - values[1])[valid]
                    )
    for name in ("wrong_quality", "short_quality"):
        masks = [{"dataset": name, "threshold": 0.5}]
        for route in ("multi_point", "buffer_timeseries"):
            body = {
                "dataset_name": "displacement",
                "lon": lon,
                "lat": lat,
                "points": [{"id": "a", "lon": lon, "lat": lat}],
                "buffer_m": spacing / 4,
                "layer_masks": masks,
            }
            response = client.post("/" + route, json=body)
            result[f"invalid_{route}_{name}"] = response.status_code
        response = client.get(
            f"/md/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.png",
            params={
                "variable": "displacement",
                "time_idx": 2,
                "layer_masks": json.dumps(masks),
            },
        )
        result[f"invalid_tile_{name}"] = response.status_code
        response = client.get(
            f"/md/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.png",
            params={"variable": "displacement", "time_idx": 2, "mask_variable": name},
        )
        result[f"invalid_primary_{name}"] = response.status_code
        response = client.get(
            "/export/geotiff",
            params={
                "variable": "displacement",
                "time_idx": 2,
                "layer_masks": json.dumps(masks),
            },
        )
        result[f"invalid_export_{name}"] = response.status_code
    response = client.post(
        "/multi_point",
        json={
            "dataset_name": "velocity",
            "points": [{"id": "a", "lon": lon, "lat": lat}],
            "layer_masks": [{"dataset": "quality"}],
        },
    )
    result["invalid_static_dynamic"] = response.status_code
    if server == "full":
        import dask.array as darr

        graph_results = []
        for n_dates in (5, 50):
            lazy = xr.Dataset(
                {
                    "d": (
                        ("time", "y", "x"),
                        darr.ones((n_dates, 128, 128), chunks=(1, 32, 32)),
                    ),
                    "q": (
                        ("time", "y", "x"),
                        darr.ones((n_dates, 128, 128), chunks=(1, 32, 32)),
                    ),
                },
                coords={
                    "time": np.arange(n_dates),
                    "x": np.arange(128),
                    "y": np.arange(128)[::-1],
                },
            ).rio.write_crs(32631)
            selected = full._build_masked_md_dataarray(
                lazy, "d", 2, None, 0.5, json.dumps([{"dataset": "q"}]), None
            )
            where_tasks = sum(
                str(k[0]).startswith("where-") for k in selected.data.__dask_graph__()
            )
            graph_results.append({"dates": n_dates, "where_tasks": where_tasks})
            np.testing.assert_array_equal(selected.compute(), np.ones((128, 128)))
        result["graph_counts"] = graph_results
    (work / "results.json").write_text(json.dumps(result))


@pytest.fixture(scope="module", params=["full", "lite"])
def responses(request, tmp_path_factory):
    work = tmp_path_factory.mktemp("md-temporal-" + request.param)
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    run = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(work), request.param],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert run.returncode == 0, run.stdout[-1000:] + run.stderr[-4000:]
    return json.loads((work / "results.json").read_text())


@pytest.mark.parametrize("kind", ["point", "buffer"])
@pytest.mark.parametrize(
    "name,mode,expected",
    [
        ("quality", "min", [0, 10]),
        ("quality", "max", [5]),
        ("static_quality", "min", [0, 5, 10]),
    ],
)
def test_correct_mask_for_every_chart_date(responses, kind, name, mode, expected):
    response = responses[f"{kind}_{name}_{mode}"]
    assert response["status"] == 200
    data = (
        response["body"]["datasets"][0]["data"]
        if kind == "point"
        else response["body"]["median"]
    )
    assert [row["y"] for row in data] == expected
    dates = {0: "2026-01-01", 5: "2026-01-13", 10: "2026-01-25"}
    assert [row["x"] for row in data] == [dates[value] for value in expected]


@pytest.mark.parametrize("name", ["wrong_quality", "short_quality"])
@pytest.mark.parametrize(
    "route", ["multi_point", "buffer_timeseries", "tile", "primary", "export"]
)
def test_incompatible_mask_axes_are_explicit_errors(responses, name, route):
    assert responses[f"invalid_{route}_{name}"] == 422


def test_dynamic_mask_not_guessed_for_static_velocity(responses):
    assert responses["invalid_static_dynamic"] == 422


def test_mask_metadata_explains_axes_and_static_summaries(responses):
    layers = responses["layer_info"]
    assert layers["displacement"]["mask_compatibility"]["quality"] is None
    assert layers["displacement"]["mask_compatibility"]["static_quality"] is None
    assert "Dynamic" in layers["displacement"]["mask_compatibility"]["short_quality"]
    assert "Dynamic" in layers["velocity"]["mask_compatibility"]["quality"]
    assert layers["velocity"]["mask_compatibility"]["static_quality"] is None
    assert responses["empty_masks"] == 200


def test_mask_where_graph_does_not_scale_with_unrequested_dates(responses):
    if responses["server"] != "full":
        return
    counts = responses["graph_counts"]
    assert [row["where_tasks"] for row in counts] == [16, 16]


if __name__ == "__main__":
    _exercise(Path(sys.argv[1]), sys.argv[2])
