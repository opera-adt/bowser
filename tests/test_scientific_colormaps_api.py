"""Exercise every scientific palette through real full/lite rendering endpoints."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


def exercise(work, mode):
    import io

    import numpy as np
    import rasterio
    import rioxarray  # noqa: F401
    import xarray as xr
    from fastapi.testclient import TestClient
    from morecantile import tms
    from PIL import Image

    from bowser.scientific_colormaps import tables

    z, tx, ty = 12, 2048, 2047
    left, bottom, right, top = tms.get("WebMercatorQuad").xy_bounds(tx, ty, z)
    step = (right - left) / 256
    values = np.broadcast_to(np.arange(256, dtype="float32"), (256, 256)).copy()
    values[5, 5] = np.nan
    da = xr.DataArray(
        values,
        dims=("y", "x"),
        name="gradient",
        coords={
            "x": left + (np.arange(256) + 0.5) * step,
            "y": top - (np.arange(256) + 0.5) * step,
        },
        attrs={"units": "1"},
    ).rio.write_crs(3857)
    da.to_dataset().to_zarr(work / "cube.zarr", consolidated=False)
    da.rio.write_nodata(np.nan).rio.to_raster(work / "gradient.tif")
    os.environ.update(
        BOWSER_STACK_DATA_FILE=str(work / "cube.zarr"), BOWSER_REF_WARMUP="0"
    )
    if mode == "lite":
        from bowser.lite.main import app
    else:
        from bowser import main

        app = main.app
        if mode == "cog":
            from bowser.state import BowserState
            from bowser.titiler import RasterGroup

            group = RasterGroup(name="gradient", file_list=[str(work / "gradient.tif")])
            main._default_state = BowserState(
                mode="cog", raster_groups={"gradient": group}
            )
    client = TestClient(app)
    for name, lut in tables().items():
        params = {"variable": "gradient", "rescale": "0,255", "colormap_name": name}
        if mode == "cog":
            params["url"] = str(work / "gradient.tif")
        route = "cog" if mode == "cog" else "md"
        reply = client.get(
            f"/{route}/tiles/WebMercatorQuad/{z}/{tx}/{ty}.png", params=params
        )
        assert reply.status_code == 200, reply.text[:200]
        actual = np.asarray(Image.open(io.BytesIO(reply.content)).convert("RGBA"))
        expected = np.broadcast_to(lut[None, :, :], (256, 256, 4)).copy()
        expected[5, 5, 3] = 0
        np.testing.assert_array_equal(actual[:, :, 3], expected[:, :, 3])
        visible = expected[:, :, 3] > 0
        # RGB under fully transparent nodata is not a displayed color.
        np.testing.assert_array_equal(
            actual[visible], expected[visible], err_msg=f"{mode}: {name}"
        )
        preview = client.get(f"/colorbar/{name}")
        assert preview.status_code == 200
        image = Image.open(io.BytesIO(preview.content)).convert("RGBA")
        assert image.width > 0 and image.height > 0
        if mode == "lite":
            idx = np.round(np.linspace(0, 255, image.width)).astype(int)
            np.testing.assert_array_equal(np.asarray(image)[0], lut[idx])
    exported = client.get("/export/geotiff", params={"variable": "gradient"})
    assert exported.status_code == 200
    with rasterio.MemoryFile(exported.content) as mem, mem.open() as src:
        np.testing.assert_array_equal(src.read(1), values)
    print("All scientific palette endpoints passed", flush=True)


@pytest.mark.parametrize("mode", ["full", "cog", "lite"])
def test_all_palette_tiles_and_previews(tmp_path, mode):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    result = subprocess.run(
        [sys.executable, __file__, str(tmp_path), mode],
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert result.returncode == 0, result.stdout[-1000:] + result.stderr[-3500:]


if __name__ == "__main__":
    exercise(Path(sys.argv[1]), sys.argv[2])
