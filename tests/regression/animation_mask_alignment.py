"""Independently compare cropped GIF preparation with the actual whole-grid map warp.

Only synthetic inputs are written. A cropped-warp negative control must disagree,
so a passing assertion cannot be explained by an insensitive tiny fixture.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = r"""
import json, sys
import numpy as np
import rioxarray
from fastapi.testclient import TestClient
from bowser import main
from bowser.state import BowserState
from bowser.titiler import RasterGroup
from bowser.animation import AnimationRequest, plan_render
from pyproj import Transformer
from PIL import Image
from io import BytesIO

spec = json.loads(open(sys.argv[1]).read())
ds = main.state.dataset
mask = spec["mask"]
full = ds.displacement.isel(time=0)
plain = BowserState(
    mode="cog",
    raster_groups={
        "displacement": RasterGroup(
            name="displacement",
            file_list=spec["files"],
            uses_spatial_ref=True,
            algorithm="shift",
        )
    },
)
configured = BowserState(
    mode="cog",
    raster_groups={
        "displacement": RasterGroup(
            name="displacement",
            file_list=spec["files"],
            mask_file_list=[mask],
            mask_min_value=0.5,
            uses_spatial_ref=True,
            algorithm="shift",
        )
    },
)
project = Transformer.from_crs(32615, 4326, always_xy=True).transform
records = []
for name, target, custom in [
    ("md_uploaded", main._default_state, mask),
    ("cog_uploaded", plain, mask),
    ("cog_configured", configured, None),
]:
    whole = (
        main._custom_mask_on(full, mask)
        if name == "md_uploaded"
        else main._warped_mask(full, mask, values=True) > 0.5
    )
    for r0, r1, c0, c1 in [(0, 40, 100, 220), (0, 22, 100, 122), (5, 133, 100, 228)]:
        window = (r0, r1, c0, c1)
        crop = ds.isel(y=slice(r0, r1), x=slice(c0, c1))
        kwargs = dict(
            target=target,
            display_dataset=crop if target.mode == "md" else None,
            cog_window=window if target.mode == "cog" else None,
        )
        expected = whole.isel(y=slice(r0, r1), x=slice(c0, c1)).values
        # Reproduce the previous scientific-support error without changing source.
        wrong = main._warped_mask(
            crop.displacement.isel(time=0), mask, values=name != "md_uploaded"
        ).values
        wrong = wrong > 0 if name == "md_uploaded" else wrong > 0.5
        mismatches = int(np.count_nonzero(expected != wrong))
        assert mismatches > 0, (
            name,
            window,
            "fixture does not expose cropped-warp defect",
        )
        for i in range(2):
            prepared, _ = main._prepare_native_export(
                "displacement",
                None,
                i,
                None,
                0.5,
                None,
                custom,
                None,
                None,
                0,
                None,
                **kwargs,
            )
            actual = np.asarray(prepared.values)
            np.testing.assert_array_equal(
                np.isfinite(actual), expected, err_msg=f"{name} {window}"
            )
            np.testing.assert_array_equal(
                actual[expected], np.full(int(expected.sum()), i, dtype="float32")
            )
        # Decode an actual API GIF for the same bounds and compare native support.
        x0, x1 = float(full.x[c0]) - 15, float(full.x[c1 - 1]) + 15
        y0, y1 = float(full.y[r0]) + 15, float(full.y[r1 - 1]) - 15
        corners = [project(x, y) for x, y in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]]
        bounds = [
            min(x for x, y in corners),
            min(y for x, y in corners),
            max(x for x, y in corners),
            max(y for x, y in corners),
        ]
        request = dict(
            variable="displacement",
            start_index=0,
            end_index=1,
            vmin=0,
            vmax=2,
            colormap="viridis",
            width=128,
            bounds=bounds,
            custom_mask_path=custom,
            mask_min_value=0.5,
        )
        plan = plan_render(target, AnimationRequest(**request))
        a, b, c, d = plan.window
        main._default_state = target
        with TestClient(main.app) as client:
            response = client.post("/export/animation", json=request)
        assert response.status_code == 200, response.text[:300]
        with Image.open(BytesIO(response.content)) as gif:
            metadata = json.loads(gif.info["comment"])
        count = int(whole.isel(y=slice(a, b), x=slice(c, d)).values.sum())
        assert metadata["valid_native_pixels"] == [count, count]
        records.append(
            dict(
                case=name,
                window=window,
                incorrect_crop_warp_pixels=mismatches,
                valid_pixels=int(expected.sum()),
                api_support_verified=True,
            )
        )
print(json.dumps(dict(status="PASS", cases=records)))
"""


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    out = a.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    for key in [
        "GDAL_DATA",
        "GDAL_DRIVER_PATH",
        "PROJ_DATA",
        "PROJ_LIB",
        "CONDA_PREFIX",
    ]:
        os.environ.pop(key, None)
    import numpy as np
    import rasterio
    import rioxarray  # noqa: F401
    import xarray as xr
    from rasterio.transform import from_origin

    n = 560
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                np.stack(
                    [
                        np.zeros((n, n), dtype="float32"),
                        np.ones((n, n), dtype="float32"),
                    ]
                ),
                {"units": "meters"},
            )
        },
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": 230015.0 + 30 * np.arange(n),
            "y": 3850015.0 - 30 * np.arange(n),
        },
    ).rio.write_crs(32615)
    ds.to_zarr(out / "cube.zarr", consolidated=False)
    files = []
    for i in range(2):
        path = out / f"displacement_{i}.tif"
        ds.displacement.isel(time=i).rio.to_raster(path)
        files.append(str(path))
    west, south, east, north = (
        ds.displacement.isel(time=0).rio.reproject(4326).rio.bounds()
    )
    res = 9.887e-5
    width, height = int((east - west) / res) + 4, int((north - south) / res) + 4
    mask = out / "geographic.tif"
    with rasterio.open(
        mask,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="uint8",
        crs=4326,
        transform=from_origin(west - 2 * res, north + 2 * res, res, res),
    ) as f:
        f.write(
            np.random.default_rng(1).integers(0, 2, (height, width)).astype("uint8"), 1
        )
    spec = out / "input.json"
    spec.write_text(json.dumps({"mask": str(mask), "files": files}))
    inputs = [q for q in out.rglob("*") if q.is_file()]
    before = {q: hashlib.sha256(q.read_bytes()).hexdigest() for q in inputs}
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("BOWSER_")
        and k
        not in [
            "PYTHONPATH",
            "GDAL_DATA",
            "GDAL_DRIVER_PATH",
            "PROJ_DATA",
            "PROJ_LIB",
            "CONDA_PREFIX",
        ]
    }
    env.update(
        PYTHONPATH=str(a.repo.resolve() / "src"),
        BOWSER_STACK_DATA_FILE=str(out / "cube.zarr"),
        BOWSER_DATASET_CONFIG_FILE=str(out / "absent.json"),
        BOWSER_REF_WARMUP="0",
        BOWSER_UPLOAD_DIR=str(out / "uploads"),
        MPLCONFIGDIR=str(out / "mpl"),
        PROJ_NETWORK="OFF",
    )
    run = subprocess.run(
        [sys.executable, "-B", "-c", SCRIPT, str(spec)],
        cwd=out,
        env=env,
        text=True,
        capture_output=True,
        timeout=180,
    )
    (out / "stdout.log").write_text(run.stdout)
    (out / "stderr.log").write_text(run.stderr)
    assert run.returncode == 0, run.stderr[-4000:]
    result = json.loads(run.stdout.strip().splitlines()[-1])
    assert before == {q: hashlib.sha256(q.read_bytes()).hexdigest() for q in inputs}
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
