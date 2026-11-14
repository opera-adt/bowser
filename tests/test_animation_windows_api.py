"""Large metadata-only sources exercise bounded GIF reads through the real API."""

import os
import subprocess
import sys
from pathlib import Path


def exercise(work):
    import io
    import json

    import dask.array as darr
    import numpy as np
    import rasterio
    import rioxarray  # noqa: F401
    import xarray as xr
    from fastapi.testclient import TestClient
    from PIL import Image
    from pyproj import Transformer
    from rasterio.transform import from_origin
    from rio_tiler.colormap import cmap

    seed = xr.Dataset(
        {"displacement": (("time", "y", "x"), np.zeros((2, 2, 2), dtype="float32"))},
        coords={"time": [0, 1], "x": [500005, 500015], "y": [15, 5]},
    ).rio.write_crs(32631)
    seed.to_zarr(work / "seed.zarr", consolidated=False)
    os.environ["BOWSER_STACK_DATA_FILE"] = str(work / "seed.zarr")
    from bowser import animation, main
    from bowser.state import BowserState, PyramidLevel
    from bowser.titiler import RasterGroup

    reads = []

    def values(block, block_info=None):
        info = block_info[None]
        reads.append(info["array-location"])
        return np.full(block.shape, 10 + info["chunk-location"][0], dtype="float32")

    h, w = 4121, 5876  # A full DISP-S1-sized grid: no full array is allocated.
    large = darr.map_blocks(
        values,
        darr.empty((2, h, w), chunks=(1, 128, 128), dtype="float32"),
        dtype="float32",
        meta=np.empty((0, 0, 0), dtype="float32"),
    )
    dates = np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]")
    ds = xr.Dataset(
        {"displacement": (("time", "y", "x"), large, {"units": "meters"})},
        coords={
            "time": dates,
            "x": 500005 + 10 * np.arange(w),
            "y": 10 * h - 5 - 10 * np.arange(h),
        },
    ).rio.write_crs(32631)
    main._default_state = BowserState(mode="md", dataset=ds)
    client = TestClient(main.app, raise_server_exceptions=False)
    body = {
        "variable": "displacement",
        "start_index": 0,
        "end_index": 1,
        "vmin": 0,
        "vmax": 100,
        "width": 64,
        "colormap": "viridis",
    }
    tr = Transformer.from_crs(32631, 4326, always_xy=True)
    west, south = tr.transform(500010, 10 * h - 500)
    east, north = tr.transform(500490, 10 * h - 10)
    cropped = {**body, "bounds": [west, south, east, north]}
    response = client.post("/export/animation", json=cropped)
    assert response.status_code == 200, response.text[:300]
    frame_reads = list(reads)
    reads.clear()
    plan = client.post("/export/animation/plan", json=cropped)
    assert plan.status_code == 200, plan.text
    assert reads == [], "Preflight read source pixels"
    assert plan.json()["read_width"] < 60 and plan.json()["read_height"] < 60
    image = Image.open(io.BytesIO(response.content))
    meta = json.loads(image.info["comment"])
    assert image.n_frames == 2
    assert meta["display_read"]["level"] == "native"
    assert all(v < 3600 for v in meta["valid_display_pixels"])
    assert frame_reads and all(
        r[1][1] <= 128 and r[2][1] <= 128 for r in frame_reads
    ), frame_reads
    reads.clear()
    assert client.post("/export/animation", json=body).status_code == 422
    assert not reads, "Oversized full grid was read before rejection"

    # Display budget is also validated before any source frame is read.
    maximum = animation.MAX_DISPLAY_PIXELS
    animation.MAX_DISPLAY_PIXELS = 1
    try:
        reply = client.post("/export/animation", json=cropped)
        assert reply.status_code == 422 and "Display" in reply.json()["detail"]
        assert not reads
    finally:
        animation.MAX_DISPLAY_PIXELS = maximum

    # A saved pyramid has intentionally different values. A native reference
    # outside the crop/display level must not be replaced by a pyramid sample.
    coarse = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                np.stack(
                    [np.full((45, 64), 100 + i, dtype="float32") for i in range(2)]
                ),
                {"units": "meters"},
            )
        },
        coords={
            "time": dates,
            "x": 500000 + (np.arange(64) + 0.5) * (10 * w / 64),
            "y": 10 * h - (np.arange(45) + 0.5) * (10 * h / 45),
        },
    ).rio.write_crs(32631)
    main._default_state.levels = [
        PyramidLevel.from_dataset("0", ds),
        PyramidLevel.from_dataset("1", coarse),
    ]
    lon, lat = tr.transform(520005, 20005)
    reply = client.post(
        "/export/animation", json={**body, "ref_lon": lon, "ref_lat": lat}
    )
    assert reply.status_code == 200, reply.text[:300]
    image = Image.open(io.BytesIO(reply.content))
    meta = json.loads(image.info["comment"])
    assert meta["display_read"]["level"] == "pyramid:1"
    assert list(map(float, meta["reference"]["offsets"])) == [10, 11]
    assert meta["valid_native_pixels"] is None
    image.seek(0)
    # Display value is 100 - native reference 10 = 90, not 100 - 100 = 0.
    lut = np.round(np.linspace(0, 255, 254)).astype(int)
    np.testing.assert_array_equal(
        np.asarray(image.convert("RGB"))[24 + 32, 32],
        cmap.get("viridis")[int(lut[int(0.9 * 253)])][:3],
    )
    assert all((r[1][1] - r[1][0]) <= 128 and (r[2][1] - r[2][0]) <= 128 for r in reads)
    reads.clear()
    # Native-reference budget cannot be bypassed by a tiny display crop.
    maximum = animation.MAX_NATIVE_PIXELS
    animation.MAX_NATIVE_PIXELS = 100000
    try:
        reject = client.post(
            "/export/animation",
            json={**cropped, "ref_lon": lon, "ref_lat": lat, "ref_buffer_m": 5000},
        )
        assert (
            reject.status_code == 422 and "reference" in reject.json()["detail"].lower()
        )
        assert not reads
    finally:
        animation.MAX_NATIVE_PIXELS = maximum

    # Direct GeoTIFFs with overviews use their stored display pyramid too.
    files = []
    for i in range(2):
        path = work / f"displacement_2026010{i + 1}.tif"
        files.append(str(path))
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            height=128,
            width=128,
            count=1,
            dtype="float32",
            crs=32631,
            transform=from_origin(500000, 1280, 10, 10),
        ) as dst:
            dst.write(np.full((128, 128), i + 10, dtype="float32"), 1)
            dst.build_overviews([2, 4], rasterio.enums.Resampling.nearest)
    group = RasterGroup(name="displacement", file_list=files)
    main._default_state = BowserState(mode="cog", raster_groups={"displacement": group})
    reply = client.post("/export/animation", json=body)
    assert reply.status_code == 200, reply.text[:300]
    meta = json.loads(Image.open(io.BytesIO(reply.content)).info["comment"])
    assert meta["display_read"]["level"] == "overview:0"
    assert meta["display_read"]["read_width"] == 64
    print("Large crop, pre-read budgets, native reference, saved MD/COG pyramids PASS")


def test_large_animation_windows_and_pyramids(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    run = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(tmp_path)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert run.returncode == 0, run.stdout[-1500:] + run.stderr[-4500:]


if __name__ == "__main__":
    exercise(Path(sys.argv[1]))
