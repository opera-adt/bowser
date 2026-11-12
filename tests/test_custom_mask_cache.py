"""A custom mask is warped to a pyramid level once, not for every tile.

``bowser.main`` reads its settings at import, so it runs in its own interpreter;
nothing here imports ``bowser.main``, ``bowser.state`` or ``bowser.config``.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REGRESSION = Path(__file__).resolve().parent / "regression"

pytest.importorskip("rioxarray")
pytest.importorskip("PIL")

SCRIPT = textwrap.dedent(
    """
    import os, sys
    from io import BytesIO
    import numpy as np
    import rioxarray  # noqa: F401
    from PIL import Image
    from fastapi.testclient import TestClient
    import bowser.main as m

    ds = m.state.dataset
    mask = sys.argv[1]

    def write(keep_left: bool, mtime: int) -> None:
        v = ds["velocity"]
        # Stripes two pixels wide, so any tile has about half of each.
        stripes = (np.arange(v.sizes["x"]) // 2) % 2 == (0 if keep_left else 1)
        data = np.broadcast_to(stripes, v.shape).astype("uint8")
        keep = m.xr.DataArray(data, coords={"y": v["y"], "x": v["x"]}, dims=("y", "x"))
        keep.rio.write_crs(ds.rio.crs).rio.to_raster(mask)
        os.utime(mask, (mtime, mtime))

    warps = []
    import rioxarray.raster_array as ra
    reproject_match = ra.RasterArray.reproject_match

    def counted(self, *a, **kw):
        warps.append(1)
        return reproject_match(self, *a, **kw)

    ra.RasterArray.reproject_match = counted

    c = TestClient(m.app)
    # A tile over the middle of the cube (z16 holds about 17x17 of its pixels).
    z, x, y = 16, 11345, 26188
    q = {"variable": "displacement", "time_idx": 3, "rescale": "-0.02,0.02",
         "colormap_name": "gray", "tilesize": 256}

    def alpha(**extra):
        r = c.get(f"/md/tiles/WebMercatorQuad/{z}/{x}/{y}.png", params={**q, **extra})
        assert r.status_code == 200, r.text
        return np.asarray(Image.open(BytesIO(r.content)).convert("RGBA"))[..., 3] > 0

    plain = alpha()
    write(True, 1_700_000_000)
    left = [alpha(custom_mask_path=mask) for _ in range(3)]
    other_step = alpha(custom_mask_path=mask, time_idx=5)
    assert len(warps) == 1, len(warps)          # four tiles, one warp
    assert all((a == left[0]).all() for a in left)
    assert 0.2 < left[0].sum() / plain.sum() < 0.8   # about half is hidden
    assert (other_step == left[0]).all()

    # The file changed: the old result is not served.
    write(False, 1_700_000_100)
    right = alpha(custom_mask_path=mask)
    assert len(warps) == 2
    assert not (right & left[0]).any() and ((right | left[0]) == plain).all()

    # Kept within its budget, the newest last.
    m.CUSTOM_MASK_CACHE_BYTES = 1
    write(True, 1_700_000_200)
    alpha(custom_mask_path=mask)
    assert len(m._custom_masks) == 1
    print("OK")
    """
)


def test_custom_mask_is_warped_once_per_file_and_level(tmp_path):
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    cube = make_cube(tmp_path / "regression.zarr")
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env["BOWSER_STACK_DATA_FILE"] = str(cube)
    r = subprocess.run(
        [sys.executable, "-c", SCRIPT, str(tmp_path / "mask.tif")],
        env=env,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    assert r.stdout.strip().endswith("OK")
