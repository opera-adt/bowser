"""Exercise actual full/lite tiles, point/radius charts and native exports."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


def _exercise(work: Path, mode: str) -> None:
    import io
    import json

    import numpy as np
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
    base = np.arange(size * size, dtype="float32").reshape(size, size) - 100
    base[0, 0] = np.nan
    base[3, 3] = 0
    factor = np.tile(
        np.array([-10, -5, -2, 0, 2, 5, 10, np.nan] * 2, dtype="float32"), (size, 1)
    )
    factor[4, 4] = -9999
    factor[2, 8], factor[2, 9] = np.inf, -np.inf
    factors = np.stack([factor, factor + 1])
    factors[:, 4, 4] = -9999
    values = np.stack([base * 0, base])
    dates = ["20260101", "20260113"]
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "factor": (("time", "y", "x"), factors, {"_FillValue": -9999}),
            "static_factor": (("y", "x"), factor, {"_FillValue": -9999}),
        },
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": x,
            "y": y,
        },
    ).rio.write_crs(3857)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    original = ds.copy(deep=True)
    files: dict[str, list[str]] = {}
    for name in ds.data_vars:
        files[name] = []
        for index in range(2 if "time" in ds[name].dims else 1):
            frame = ds[name].isel(time=index) if "time" in ds[name].dims else ds[name]
            path = work / f"{name}_{dates[index]}.tif"
            frame.rio.write_nodata(
                -9999 if name != "displacement" else np.nan
            ).rio.to_raster(path)
            files[name].append(str(path))
    os.environ["BOWSER_STACK_DATA_FILE"] = str(work / "cube.zarr")
    if mode == "lite":
        from bowser.lite.main import app

        labels = ["2026-01-01", "2026-01-13"]
    else:
        from bowser import main

        app = main.app
        if mode == "cog":
            from bowser.state import BowserState
            from bowser.titiler import RasterGroup

            groups = {
                name: RasterGroup(name=name, file_list=paths)
                for name, paths in files.items()
            }
            main._default_state = BowserState(mode="cog", raster_groups=groups)
            labels = list(map(str, groups["displacement"].model_dump()["x_values"]))
        else:
            labels = ["2026-01-01", "2026-01-13"]
    client = TestClient(app, raise_server_exceptions=False)
    tr = Transformer.from_crs(3857, 4326, always_xy=True)
    lon, lat = tr.transform(x[5], y[8])
    ring = [
        list(tr.transform(a, b))
        for a, b in [
            (left, bottom),
            (right, bottom),
            (right, top),
            (left, top),
            (left, bottom),
        ]
    ]
    geometry = {"type": "Polygon", "coordinates": [ring]}
    cases = [
        [{"dataset": "factor", "mode": comparison, "threshold": threshold}]
        for comparison in ("abs_min", "abs_max")
        for threshold in (0, 2, 5)
    ]
    cases += [
        [{"dataset": "static_factor", "mode": "abs_max", "threshold": 5}],
        [
            {"dataset": "factor", "mode": "abs_max", "threshold": 5},
            {"dataset": "static_factor", "mode": "min", "threshold": -3},
        ],
    ]
    for masks in cases:
        print(mode, masks, flush=True)
        expected_validity = []
        point_expected, buffer_expected = [], []
        for index in range(2):
            valid = np.isfinite(values[index])
            for mask in masks:
                q = factor if mask["dataset"] == "static_factor" else factors[index]
                if mask["mode"] == "abs_max":
                    keep = np.abs(q) <= mask["threshold"]
                elif mask["mode"] == "abs_min":
                    keep = np.abs(q) >= mask["threshold"]
                else:
                    keep = (
                        q > mask["threshold"]
                        if mode == "cog"
                        else q >= mask["threshold"]
                    )
                valid &= np.isfinite(q) & (q != -9999) & keep
            expected_validity.append(valid)
            if valid[8, 5]:
                point_expected.append(
                    {"x": labels[index], "y": float(values[index, 8, 5])}
                )
            xx, yy = np.meshgrid(x, y)
            in_circle = (xx - x[5]) ** 2 + (yy - y[8]) ** 2 <= (spacing * 1.1) ** 2
            samples = values[index][in_circle & valid]
            if samples.size:
                buffer_expected.append(
                    {"x": labels[index], "y": float(np.median(samples))}
                )
            params = {
                "variable": "displacement",
                "time_idx": index,
                "tilesize": 256,
                "layer_masks": json.dumps(masks),
                "rescale": "-100,200",
                "colormap_name": "rdbu",
            }
            if mode == "cog":
                params["url"] = files["displacement"][index]
            route = "cog" if mode == "cog" else "md"
            image = client.get(
                f"/{route}/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.png",
                params=params,
            )
            assert image.status_code == 200, image.text[:300]
            alpha = (
                np.asarray(Image.open(io.BytesIO(image.content)).convert("RGBA"))[
                    :, :, 3
                ]
                > 0
            )
            np.testing.assert_array_equal(alpha, valid.repeat(16, 0).repeat(16, 1))
            # A signed mask layer can mask itself; abs does not replace its samples.
            if mode in ("md", "cog", "lite"):
                for variable in ("displacement", "factor"):
                    response = client.get(
                        "/export/geotiff", params={**params, "variable": variable}
                    )
                    assert response.status_code == 200, response.text[:300]
                    with (
                        rasterio.MemoryFile(response.content) as memory,
                        memory.open() as raster,
                    ):
                        expected = (
                            values[index]
                            if variable == "displacement"
                            else factors[index]
                        )
                        expected_valid = (
                            valid
                            if variable == "displacement"
                            else np.isfinite(expected) & (expected != -9999)
                        )
                        if variable == "factor":
                            for mask in masks:
                                q = (
                                    factor
                                    if mask["dataset"] == "static_factor"
                                    else factors[index]
                                )
                                expected_valid &= np.isfinite(q) & (q != -9999)
                                if mask["mode"] == "abs_max":
                                    expected_valid &= np.abs(q) <= mask["threshold"]
                                elif mask["mode"] == "abs_min":
                                    expected_valid &= np.abs(q) >= mask["threshold"]
                                else:
                                    expected_valid &= (
                                        q > mask["threshold"]
                                        if mode == "cog"
                                        else q >= mask["threshold"]
                                    )
                        np.testing.assert_array_equal(
                            raster.read_masks(1) > 0, expected_valid
                        )
                        np.testing.assert_array_equal(
                            raster.read(1)[expected_valid], expected[expected_valid]
                        )
                        provenance = json.loads(
                            raster.tags()["BOWSER_EXPORT_PROVENANCE"]
                        )
                        assert provenance["masks"]["applied"][0]["operator"] == (
                            "|value| <="
                            if masks[0]["mode"] == "abs_max"
                            else "|value| >="
                        )
        response = client.post(
            "/multi_point",
            json={
                "dataset_name": "displacement",
                "points": [{"id": "a", "lon": lon, "lat": lat}],
                "layer_masks": masks,
            },
        )
        assert response.status_code == 200, response.text[:300]
        assert response.json()["datasets"][0]["data"] == point_expected
        response = client.post(
            "/buffer_timeseries",
            json={
                "dataset_name": "displacement",
                "lon": lon,
                "lat": lat,
                "buffer_m": spacing * 1.1,
                "n_samples": 0,
                "layer_masks": masks,
            },
        )
        if buffer_expected:
            assert response.status_code == 200, response.text[:300]
            assert response.json()["median"] == buffer_expected
        else:
            assert response.status_code == 404, response.text[:300]
        if mode in ("md", "cog", "lite"):
            for support in ("common", "per_date"):
                response = client.post(
                    "/polygon_timeseries",
                    json={
                        "variable": "displacement",
                        "geometry": geometry,
                        "support": support,
                        "layer_masks": masks,
                    },
                )
                assert response.status_code == 200, response.text[:300]
                rows = response.json()["statistics"]
                common = np.logical_and.reduce(expected_validity)
                for index, row in enumerate(rows):
                    valid = common if support == "common" else expected_validity[index]
                    assert row["count"] == int(valid.sum())
                    assert row["median"] == (
                        float(np.median(values[index][valid])) if valid.any() else None
                    )
                assert response.json()["masks"][0]["operator"] == (
                    "|value| <=" if masks[0]["mode"] == "abs_max" else "|value| >="
                )
    for comparison in ("abs_min", "abs_max"):
        invalid = [{"dataset": "factor", "mode": comparison, "threshold": -1}]
        response = client.post(
            "/multi_point",
            json={
                "dataset_name": "displacement",
                "points": [{"id": "a", "lon": lon, "lat": lat}],
                "layer_masks": invalid,
            },
        )
        assert response.status_code == 422, response.text[:300]
        route = "cog" if mode == "cog" else "md"
        response = client.get(
            f"/{route}/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.png",
            params={
                "variable": "displacement",
                "url": files["displacement"][0],
                "layer_masks": json.dumps(invalid),
            },
        )
        assert response.status_code == 422, response.text[:300]
    xr.testing.assert_identical(ds, original)
    print("Absolute mask API parity passed", flush=True)


@pytest.mark.parametrize("mode", ["md", "cog", "lite"])
def test_absolute_masks_across_actual_apis(tmp_path, mode):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    process = subprocess.run(
        [sys.executable, __file__, str(tmp_path), mode],
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert process.returncode == 0, process.stdout[-1500:] + process.stderr[-4500:]
    assert "Absolute mask API parity passed" in process.stdout


if __name__ == "__main__":
    _exercise(Path(sys.argv[1]), sys.argv[2])
