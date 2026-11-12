"""bowser-lite runs without GDAL, rio-tiler, titiler, matplotlib, scipy, dask or S3.

Two checks, each in a fresh interpreter:

- with the heavy packages *hidden* (an import hook makes them look uninstalled, so
  xarray's and pandas' optional imports see them missing too), the app imports and
  answers the UI's requests, tiles included;
- with everything installed, importing and using the app never imports the hard
  dependencies of the full server (rasterio, rio-tiler, titiler, matplotlib,
  rioxarray, s3fs, botocore, ...). dask and pyarrow are left out of this second
  check: xarray and pandas import them opportunistically whenever installed.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

#: Never needed by lite (the full server's GDAL / tiler / plotting / S3 stack).
HEAVY = [
    "rasterio",
    "rio_tiler",
    "titiler",
    "matplotlib",
    "scipy",
    "dask",
    "s3fs",
    "botocore",
    "aiobotocore",
    "boto3",
    "rioxarray",
    "opera_utils",
    "pyarrow",
    "PIL",
    "morecantile",
    "simplejson",
    "starlette_cramjam",
    "shapely",
    "affine",
]
#: Imported by xarray/pandas whenever installed, though lite never uses them.
OPPORTUNISTIC = {"dask", "pyarrow", "scipy"}

USE = """
from fastapi.testclient import TestClient
import bowser.lite.main as m

c = TestClient(m.app)
assert c.get("/datasets").status_code == 200
tj = c.get(
    "/md/WebMercatorQuad/tilejson.json",
    params={"variable": "displacement", "time_idx": 0},
).json()
z = tj["maxzoom"]
import math
lon, lat = tj["center"][:2]
x = int((lon + 180) / 360 * 2**z)
y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z)
r = c.get(
    f"/md/tiles/WebMercatorQuad/{z}/{x}/{y}@1x",
    params={
        "variable": "displacement",
        "time_idx": 1,
        "rescale": "0,2",
        "colormap_name": "rdbu_r",
        "algorithm": "shift",
        "algorithm_params": '{"shift": 1}',
        "layer_masks": '[{"dataset": "displacement", "threshold": 0, "mode": "min"}]',
    },
)
assert r.status_code == 200 and r.content[:4] == b"\\x89PNG", r.text
q = {"dataset_name": "displacement", "lon": lon, "lat": lat}
assert c.get("/point", params=q).status_code == 200
assert c.get("/histogram/displacement").status_code == 200
body = {
    "dataset_name": "displacement",
    "points": [{"id": "a", **q}],
    "calculate_trends": True,
}
assert c.post("/multi_point", json=body).status_code == 200
body = {
    "coords": [[lon - 0.001, lat], [lon + 0.001, lat]],
    "dataset_name": "displacement",
    "sampling_interval": 30,
    "radius": 30,
}
assert c.post("/profile", json=body).status_code == 200
assert c.get("/colorbar/viridis").status_code == 200
# Polygon statistics: the pixels are selected with numpy, not rasterio/shapely.
d = 0.0005
ring = [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d]]
body = {
    "variable": "displacement",
    "geometry": {"type": "Polygon", "coordinates": [ring + ring[:1]]},
}
r = c.post("/polygon_timeseries", json=body)
assert r.status_code == 200 and r.json()["polygon_pixels"] > 0, r.text
# GeoTIFF export: written with numpy, zlib and struct, not GDAL.
r = c.get("/export/geotiff", params={"variable": "displacement", "time_idx": 1})
assert r.status_code == 200 and r.content[:4] == b"II*\\x00", r.text[:200]
assert r.headers["content-type"] == "image/tiff"
assert int(r.headers["content-length"]) == len(r.content) > 500
# The reference finder reuses bowser.reference, which must not need rasterio.
q = {"coherence_layer": "displacement", "similarity_layer": "displacement"}
r = c.get("/reference_candidates", params={**q, "radius_m": 30})
assert r.status_code == 200 and r.json()["recommended"], r.text
"""

HIDE = """
import importlib.abc, sys
HIDDEN = set(HIDDEN_LIST)

# Wrap every finder so a hidden package is never found (find_spec -> None).
class Wrap(importlib.abc.MetaPathFinder):
    def __init__(self, inner):
        self.inner = inner
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in HIDDEN:
            return None
        if not hasattr(self.inner, "find_spec"):
            return None
        return self.inner.find_spec(name, path, target)
    def invalidate_caches(self):
        getattr(self.inner, "invalidate_caches", lambda: None)()
    def find_distributions(self, *args, **kwargs):
        # Hide the packages' metadata too (entry points), as if uninstalled.
        find = getattr(self.inner, "find_distributions", lambda *a, **k: [])
        dists = find(*args, **kwargs)
        return [d for d in dists if _dist_name(d) not in HIDDEN_DISTS]

def _dist_name(d):
    name = (d.metadata["Name"] or "").lower().replace("-", "_").replace(".", "_")
    return "titiler" if name.startswith("titiler") else name

HIDDEN_DISTS = {m.lower() for m in HIDDEN} | {
    "pillow",
    "rio_tiler",
    "opera_utils",
    "starlette_cramjam",
}

sys.meta_path[:] = [Wrap(f) for f in sys.meta_path]
import importlib.util
assert importlib.util.find_spec("rasterio") is None
"""


def _cube(path: Path) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from test_lite_app import _cube as make

    make(path, 1.0)


def _run(script: str, cube: Path) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env["BOWSER_STACK_DATA_FILE"] = str(cube)
    r = subprocess.run(
        [sys.executable, "-c", script],
        env=env,
        capture_output=True,
        text=True,
        cwd=cube.parent,
        timeout=300,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    return r.stdout


def test_lite_works_with_heavy_packages_uninstalled(tmp_path):
    _cube(tmp_path / "c.zarr")
    script = (
        HIDE.replace("HIDDEN_LIST", repr(HEAVY))
        + USE
        + textwrap.dedent(
            """
        loaded = sorted(m for m in HIDDEN if m in sys.modules)
        assert not loaded, loaded
        print("OK")
        """
        )
    )
    assert "OK" in _run(script, tmp_path / "c.zarr")


def test_lite_never_imports_the_full_server_stack(tmp_path):
    _cube(tmp_path / "c.zarr")
    banned = [m for m in HEAVY if m not in OPPORTUNISTIC]
    script = USE + textwrap.dedent(
        f"""
        import sys
        loaded = sorted(m for m in {banned!r} if m in sys.modules)
        assert not loaded, loaded
        assert "bowser.main" not in sys.modules and "bowser.titiler" not in sys.modules
        print("OK")
        """
    )
    assert "OK" in _run(script, tmp_path / "c.zarr")


@pytest.mark.parametrize(
    "module", ["bowser.lite.geo", "bowser.lite.tiles", "bowser.lite.cube"]
)
def test_lite_modules_import_alone(module):
    r = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert r.returncode == 0, r.stderr
