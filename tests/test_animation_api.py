"""Decode actual GIFs; compare known source values, masks and native references."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


def exercise(work, mode):
    import hashlib
    import io
    import json

    import numpy as np
    import rioxarray  # noqa: F401
    import xarray as xr
    from fastapi.testclient import TestClient
    from PIL import Image
    from pyproj import Transformer
    from rio_tiler.colormap import cmap

    base = np.arange(16, dtype="float32").reshape(4, 4)
    base[0, 3] = np.nan
    values = np.stack([base * 0, base, base * 2])
    quality = np.ones_like(values)
    quality[1, 2, 2] = 0
    quality[1, 1, 1] = 0  # display masking must not change the raw reference
    dates = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "quality": (("time", "y", "x"), quality),
            "wrong_quality": (("mask_time", "y", "x"), quality),
            "velocity": (("y", "x"), base, {"units": "m/year"}),
        },
        coords={
            "time": dates,
            "mask_time": dates + np.timedelta64(1, "D"),
            "x": 500005 + np.arange(4) * 10,
            "y": 35 - np.arange(4) * 10,
        },
    ).rio.write_crs(32631)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    paths = {}
    for name in ("displacement", "quality"):
        paths[name] = []
        for i in range(3):
            stamp = str(dates[i])[:10].replace("-", "")
            p = work / f"{name}_{stamp}.tif"
            ds[name].isel(time=i).rio.write_nodata(np.nan).rio.to_raster(p)
            paths[name].append(str(p))
    before = {
        p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
        for files in paths.values()
        for p in files
    }
    os.environ.update(
        BOWSER_STACK_DATA_FILE=str(work / "cube.zarr"), BOWSER_REF_WARMUP="0"
    )
    if mode == "lite":
        from bowser.lite.main import app

        client = TestClient(app)
        assert client.get("/export/animation").json()["supported"] is False
        assert client.post("/export/animation", json={}).status_code == 501
        return
    from bowser import main
    from bowser.animation import RENDER_LOCK
    from bowser.state import BowserState
    from bowser.titiler import RasterGroup

    if mode == "cog":
        groups = {
            name: RasterGroup(
                name=name,
                file_list=files,
                uses_spatial_ref=name == "displacement",
                algorithm="shift" if name == "displacement" else None,
            )
            for name, files in paths.items()
        }
        main._default_state = BowserState(mode="cog", raster_groups=groups)
    client = TestClient(main.app, raise_server_exceptions=False)
    assert client.get("/config").json()["raster_animation"] is True
    assert client.get("/export/animation").json()["supported"] is True
    body = {
        "variable": "displacement",
        "start_index": 0,
        "end_index": 2,
        "vmin": 0,
        "vmax": 20,
        "colormap": "viridis",
        "width": 64,
        "layer_masks": [{"dataset": "quality", "threshold": 0.5, "mode": "min"}],
    }
    response = client.post("/export/animation", json=body)
    assert response.status_code == 200, response.text[:500]
    assert response.headers["content-type"] == "image/gif"
    assert "2026-01-01" in response.headers["content-disposition"]
    image = Image.open(io.BytesIO(response.content))
    assert image.n_frames == 3
    manifest = json.loads(image.info["comment"])
    assert manifest["valid_native_pixels"] == [15, 13, 15]
    assert manifest["indices"] == [0, 1, 2] and manifest["labels"][2] == "2026-01-25"
    assert manifest["frame_duration_ms"] == 500
    assert manifest["reference"]["offsets"] == [None, None, None]
    for i in range(3):
        image.seek(i)
        a = np.asarray(image.convert("RGB"))
        assert image.info["duration"] == 500
        pixel = a[24 + 2 * 16 + 8, 2 * 16 + 8]
        expected = (
            [255, 255, 255] if i == 1 else cmap.get("viridis")[0 if i == 0 else 255][:3]
        )
        np.testing.assert_array_equal(pixel, expected)
    # Mask all dates: no missing observations become zero; labels still retain
    # three separate saved frames instead of GIF coalescing an empty image.
    empty = client.post(
        "/export/animation",
        json={**body, "layer_masks": [{"dataset": "quality", "threshold": 2}]},
    )
    assert empty.status_code == 200, empty.text[:300]
    no_data = Image.open(io.BytesIO(empty.content))
    assert no_data.n_frames == 3
    assert json.loads(no_data.info["comment"])["valid_native_pixels"] == [0, 0, 0]
    tr = Transformer.from_crs(32631, 4326, always_xy=True)
    lon, lat = tr.transform(500015, 25)
    ref = client.post(
        "/export/animation",
        json={**body, "ref_lon": lon, "ref_lat": lat, "vmin": -10, "vmax": 10},
    )
    assert ref.status_code == 200, ref.text[:300]
    ref_image = Image.open(io.BytesIO(ref.content))
    reference = json.loads(ref_image.info["comment"])["reference"]
    assert list(map(float, reference["offsets"])) == [0, 5, 10]
    ref_image.seek(2)
    np.testing.assert_array_equal(
        np.asarray(ref_image.convert("RGB"))[24 + 40, 40], cmap.get("viridis")[255][:3]
    )
    for change in [
        {"end_index": 99},
        {"end_index": 0},
        {"vmax": 0},
        {"colormap": "unknown"},
        {"variable": "velocity"},
        {"ref_lon": lon},
        {"ref_time_idx": 99},
        {"bounds": [170, -5, -170, 5]},
        {"annotations": {}},
        {"custom_mask_path": "unsupported-mask.tif"},
        {"bounds": [1, 1, 2, 2]},
        {"layer_masks": [{"dataset": "quality", "threshold": 0.5, "mode": "unknown"}]},
    ]:
        reply = client.post("/export/animation", json={**body, **change})
        assert reply.status_code == 422, (change, reply.status_code, reply.text[:200])
    if mode == "md":
        wrong = client.post(
            "/export/animation",
            json={**body, "layer_masks": [{"dataset": "wrong_quality"}]},
        )
        native = client.get(
            "/export/geotiff",
            params={
                "variable": "displacement",
                "time_idx": 1,
                "layer_masks": json.dumps([{"dataset": "wrong_quality"}]),
            },
        )
        assert wrong.status_code == native.status_code  # no independent GIF mask policy
    nan = client.post(
        "/export/animation",
        content=json.dumps({**body, "vmin": float("nan")}),
        headers={"Content-Type": "application/json"},
    )
    assert nan.status_code == 422, nan.text
    assert RENDER_LOCK.acquire(False)
    try:
        assert client.post("/export/animation", json=body).status_code == 409
    finally:
        RENDER_LOCK.release()
    import bowser.animation as animation

    maximum = animation.MAX_NATIVE_PIXELS
    animation.MAX_NATIVE_PIXELS = 1
    try:
        reject = client.post("/export/animation", json=body)
        assert reject.status_code == 422 and "budget" in reject.json()["detail"]
    finally:
        animation.MAX_NATIVE_PIXELS = maximum
    for p, checksum in before.items():
        assert hashlib.sha256(Path(p).read_bytes()).hexdigest() == checksum
    print("GIF values, timing, masks, reference, bounds and budgets passed")


@pytest.mark.parametrize("mode", ["md", "cog", "lite"])
def test_animation_contract(tmp_path, mode):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    done = subprocess.run(
        [sys.executable, __file__, str(tmp_path), mode],
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert done.returncode == 0, done.stdout[-1000:] + done.stderr[-3500:]


if __name__ == "__main__":
    exercise(Path(sys.argv[1]), sys.argv[2])
