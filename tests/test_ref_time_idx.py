"""``ref_time_idx``: a time step shown relative to another date, on both servers.

The MD tile and tilejson endpoints of the full server (titiler) and of bowser-lite
take an optional ``ref_time_idx``: each pixel is the layer at ``time_idx`` minus
the same layer at ``ref_time_idx``, before masks and the tile algorithm. Without
it the tiles are unchanged (the regression goldens pin that).

Each app reads its settings at import, so each runs in its own interpreter.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

from bowser.lite import tiles

REGRESSION = Path(__file__).resolve().parent / "regression"

pytest.importorskip("rioxarray")
pytest.importorskip("PIL")


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("cube") / "regression.zarr")


def _steps() -> xr.Dataset:
    """Three 2x2 steps: a NaN only in step 0, another only in step 2."""
    data = np.array(
        [
            [[np.nan, 1.0], [2.0, 3.0]],
            [[10.0, 11.0], [12.0, 13.0]],
            [[20.0, 21.0], [22.0, np.nan]],
        ],
        dtype="float32",
    )
    return xr.Dataset(
        {"displacement": (("time", "y", "x"), data, {"units": "meters"})},
        coords={
            "time": np.array(
                ["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]"
            ),
            "y": [1.0, 0.0],
            "x": [0.0, 1.0],
        },
    )


def test_lite_tile_source_subtracts_the_reference_step():
    ds = _steps()
    q = tiles.TileQuery(variable="displacement", time_idx=1, ref_time_idx=0)
    da, _ = tiles.tile_source(ds, q)
    np.testing.assert_array_equal(da.values, [[np.nan, 10.0], [10.0, 10.0]])
    assert da.attrs == {"units": "meters"}
    assert str(da["time"].values)[:10] == "2026-01-13"
    q = tiles.TileQuery(variable="displacement", time_idx=0, ref_time_idx=99)
    da, _ = tiles.tile_source(ds, q)  # clamped to the last step
    np.testing.assert_array_equal(da.values, [[np.nan, -20.0], [-20.0, np.nan]])
    da, _ = tiles.tile_source(ds, tiles.TileQuery(variable="displacement", time_idx=1))
    np.testing.assert_array_equal(da.values, ds.displacement[1].values)


SCRIPT = """
import sys
from io import BytesIO

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

which = sys.argv[1]
if which == "lite":
    from bowser.lite.main import app
else:
    import xarray as xr
    from bowser.main import app, _build_masked_md_dataarray

    data = np.array(
        [[[np.nan, 1.0], [2.0, 3.0]], [[10.0, 11.0], [12.0, 13.0]],
         [[20.0, 21.0], [22.0, np.nan]]], dtype="float32")
    ds = xr.Dataset({"displacement": (("time", "y", "x"), data)},
                    coords={"time": [0, 1, 2], "y": [1.0, 0.0], "x": [0.0, 1.0]})
    def build(**kw):
        return _build_masked_md_dataarray(
            ds, "displacement", 1, None, 0.1, None, None, **kw
        ).values
    np.testing.assert_array_equal(build(ref_time_idx=2), [[-10, -10], [-10, np.nan]])
    np.testing.assert_array_equal(build(), data[1])

c = TestClient(app)
# A tile over the middle of the cube (z16 holds about 17x17 of its 30 m pixels).
z, x, y = 16, 11345, 26188
base = {"variable": "displacement", "rescale": "-0.02,0.02", "colormap_name": "gray",
        "tilesize": 256}
tj = c.get("/md/WebMercatorQuad/tilejson.json",
           params={**base, "time_idx": 5, "ref_time_idx": 2})
assert tj.status_code == 200, tj.text
assert "ref_time_idx=2" in tj.json()["tiles"][0], tj.json()["tiles"][0]
# The browser may keep a tile (its URL names all it is drawn from), not the metadata.
assert "cache-control" not in tj.headers
kept = c.get(
    f"/md/tiles/WebMercatorQuad/{z}/{x}/{y}.png", params={**base, "time_idx": 5}
)
assert kept.headers["cache-control"] == "private, max-age=600", dict(kept.headers)


def tile(**params):
    r = c.get(f"/md/tiles/WebMercatorQuad/{z}/{x}/{y}.png", params={**base, **params})
    assert r.status_code == 200, r.text
    return np.asarray(Image.open(BytesIO(r.content)).convert("RGBA")).astype(int)


# The cube grows linearly in time, so step 5 relative to step 2 is step 3.
rel = tile(time_idx=5, ref_time_idx=2)
assert (rel[..., 3] > 0).mean() > 0.9
assert (np.abs(rel - tile(time_idx=3)) <= 1).all(axis=-1).mean() >= 0.999
assert (np.abs(rel - tile(time_idx=5)) > 1).any(axis=-1).mean() > 0.3
# Relative to itself every valid pixel is 0, the middle of the range.
same = tile(time_idx=4, ref_time_idx=4)
opaque = same[..., 3] > 0
assert opaque.mean() > 0.9 and np.isin(same[..., 0][opaque], (127, 128)).all()
# Masks still apply on top, and the shift algorithm runs after the difference.
masked = tile(time_idx=5, ref_time_idx=2, layer_masks='[{"dataset": '
              '"temporal_coherence", "threshold": 0.9, "mode": "min"}]')
assert (masked[..., 3] > 0).sum() < (rel[..., 3] > 0).sum()
shifted = tile(time_idx=5, ref_time_idx=2, algorithm="shift",
               algorithm_params='{"shift": 0.004}')
assert (shifted[..., 0][opaque] < rel[..., 0][opaque]).mean() > 0.9
print("OK")
"""


@pytest.mark.parametrize("which", ["full", "lite"])
def test_tiles_relative_to_another_step(cube, tmp_path, which):
    if which == "full":
        pytest.importorskip("titiler.core")
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env["BOWSER_STACK_DATA_FILE"] = str(cube)
    r = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(SCRIPT), which],
        env=env,
        capture_output=True,
        text=True,
        cwd=tmp_path,
        timeout=300,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    assert "OK" in r.stdout
