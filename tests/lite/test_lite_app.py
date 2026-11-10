"""bowser-lite's app: catalog routing, opening cubes, pages, and what is not in lite.

``bowser.lite.main`` reads its settings at import, so each app runs in a subprocess,
as in tests/test_catalog_routing.py and tests/test_open_dataset.py.
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

from bowser.catalog import CatalogEntry, save_catalog


def _cube(path: Path, offset: float) -> None:
    """A 3-date 8x8 cube in UTM 11N whose values encode ``offset``.

    The CRS is in ``spatial_ref``.
    """
    from pyproj import CRS

    t = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    x = 436950.0 + 30.0 * (np.arange(8) + 0.5)
    y = 3758490.0 - 30.0 * (np.arange(8) + 0.5)
    data = offset + np.arange(3, dtype="float32")[:, None, None] * np.ones(
        (3, 8, 8), "float32"
    )
    sr = xr.DataArray(0, attrs={"crs_wkt": CRS.from_epsg(32611).to_wkt()})
    xr.Dataset(
        {"displacement": (("time", "y", "x"), data, {"units": "meters"})},
        coords={"time": t, "y": y, "x": x, "spatial_ref": sr},
    ).to_zarr(path, mode="w", consolidated=False)


def _run(script: str, env_extra: dict, *args: str, cwd: Path) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(env_extra)
    r = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=300,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    assert "OK" in r.stdout
    return r.stdout


ROUTING = """
from fastapi.testclient import TestClient
from bowser.lite.main import app

c = TestClient(app)
lon, lat = -117.687, 33.968
q = {"dataset_name": "displacement", "lon": lon, "lat": lat}
a = c.get("/point", params={**q, "dataset": "cube-a"})
b = c.get("/point", params={**q, "dataset": "cube-b"})
assert a.json() == [10.0, 11.0, 12.0], a.text
assert b.json() == [20.0, 21.0, 22.0], b.text
body = {"dataset_name": "displacement", "points": [{"id": "p", "lon": lon, "lat": lat}]}
m = c.post("/multi_point", params={"dataset": "cube-b"}, json=body)
assert m.status_code == 200 and m.json()["datasets"][0]["data"][0]["y"] == 20.0, m.text
for path in (
    "/datasets",
    "/variables",
    "/datasets/displacement/time_bounds",
    "/histogram/displacement",
    "/dataset_range/displacement",
):
    assert c.get(path, params={"dataset": "cube-a"}).status_code == 200, path
assert c.get("/datasets").status_code == 400  # catalog-only: no default cube
tj = c.get(
    "/md/WebMercatorQuad/tilejson.json",
    params={"variable": "displacement", "time_idx": 0, "dataset": "cube-b"},
).json()
assert "dataset=cube-b" in tj["tiles"][0], tj

cfg = c.get("/config", headers={"referer": "http://localhost/?dataset=cube-b"})
expected = {
    "title": "Cube B",
    "opera_logo": False,
    "geotiff_export": False,
    "polygon_stats": False,
    "assistant": {
        "enabled": False,
        "providers": [],
        "configured": [],
        "sign_in": [],
    },
}
assert cfg.json() == expected, cfg.json()
assert c.get("/config").json()["title"] != "Cube B"
assert c.get("/point", params={**q, "dataset": "nope"}).status_code == 404
assert c.get("/datasets", params={"dataset": "nope"}).status_code == 404

r = c.get("/", follow_redirects=False)
assert r.status_code in (302, 307) and r.headers["location"] == "/picker", r.headers
r = c.get("/picker", follow_redirects=False)
assert r.headers["location"] == "/static/picker.html"
assert c.get("/static/picker.html").status_code == 200
assert [d["id"] for d in c.get("/catalog").json()["datasets"]] == ["cube-a", "cube-b"]
assert c.post("/catalog/open", json={"uri": "x"}).status_code == 403
assert c.post("/catalog/scan", json={"dir": "."}).status_code == 403
print("OK")
"""


def test_catalog_routes_by_dataset(tmp_path):
    entries = []
    for key, name, offset in (("cube-a", "Cube A", 10.0), ("cube-b", "Cube B", 20.0)):
        _cube(tmp_path / f"{key}.zarr", offset)
        entries.append(
            CatalogEntry(
                id=key,
                name=name,
                uri=str(tmp_path / f"{key}.zarr"),
                bbox=(-117.69, 33.96, -117.68, 33.97),
            )
        )
    save_catalog(entries, tmp_path / "catalog.toml")
    _run(ROUTING, {"BOWSER_CATALOG_FILE": str(tmp_path / "catalog.toml")}, cwd=tmp_path)


OPEN = """
import sys, pathlib
from fastapi.testclient import TestClient
from bowser.lite.main import app

c = TestClient(app)
path = sys.argv[1]
assert c.get("/catalog").json() == {"datasets": [], "allow_open": True}
r = c.post("/catalog/open", json={"uri": path})
assert r.status_code == 200, r.text
opened = r.json()
assert opened["name"] == "cube-a" and opened["id"].startswith("cube-a-"), opened
q = {
    "dataset_name": "displacement",
    "lon": -117.687,
    "lat": 33.968,
    "dataset": opened["id"],
}
assert c.get("/point", params=q).json() == [10.0, 11.0, 12.0]
listed = c.get("/catalog").json()["datasets"]
assert [d["id"] for d in listed] == [opened["id"]], listed
assert listed[0]["bbox"][0] < -117.68 < listed[0]["bbox"][2], listed
assert c.post("/catalog/open", json={"uri": path}).json()["id"] == opened["id"]
assert len(c.get("/catalog").json()["datasets"]) == 1
assert c.post("/catalog/open", json={"uri": path + "-missing"}).status_code == 400
assert c.post("/catalog/open", json={"uri": ""}).status_code == 400
# Not a cube.
assert c.post("/catalog/open", json={"uri": sys.argv[2]}).status_code == 400
found = c.post("/catalog/scan", json={"dir": str(pathlib.Path(path).parent)}).json()
assert [x["name"] for x in found["cubes"]] == ["cube-a"], found
assert c.post("/catalog/scan", json={"dir": path + "-missing"}).status_code == 400
print("OK")
"""


def test_open_and_remember(tmp_path):
    from bowser.catalog import load_catalog

    _cube(tmp_path / "data" / "cube-a.zarr", 10.0)
    (tmp_path / "data" / "notes").mkdir()
    catalog = tmp_path / "catalog.toml"
    env = {
        "BOWSER_CATALOG_FILE": str(catalog),
        "BOWSER_ALLOW_OPEN": "true",
        "BOWSER_REMEMBER_OPENED": "true",
    }
    _run(
        OPEN,
        env,
        str(tmp_path / "data" / "cube-a.zarr"),
        str(tmp_path / "data" / "notes"),
        cwd=tmp_path,
    )
    assert [e.uri for e in load_catalog(catalog)] == [
        str((tmp_path / "data" / "cube-a.zarr").resolve())
    ]


SINGLE = """
from fastapi.testclient import TestClient
from bowser.lite.main import app

c = TestClient(app)
assert c.get("/mode").json() == {"mode": "md"}
for path, method in (
    ("/upload_raster", "post"),
    ("/upload_mask", "post"),
    ("/export/geotiff", "get"),
    ("/cog/WebMercatorQuad/tilejson.json", "get"),
    ("/overlay/WebMercatorQuad/tilejson.json", "get"),
):
    r = getattr(c, method)(path)
    assert r.status_code == 501, (path, r.text)
    assert "full Bowser server" in r.json()["detail"], (path, r.text)
r = c.get("/colorbar/RdBu_r")
assert r.status_code == 200 and r.headers["content-type"] == "image/png"
assert r.content[:4] == b"\\x89PNG"
assert c.get("/colorbar/nope").status_code == 500
base = {
    "variable": "displacement",
    "time_idx": 1,
    "rescale": "0,30",
    "colormap_name": "viridis",
}
tj = c.get("/md/WebMercatorQuad/tilejson.json", params=base).json()
z = tj["minzoom"]
import math
lon, lat = tj["center"][:2]
x = int((lon + 180) / 360 * 2**z)
y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z)
url = tj["tiles"][0].split("testserver")[1].format(z=z, x=x, y=y)
r = c.get(url)
assert r.status_code == 200 and r.headers["content-type"] == "image/png", r.text
for suffix in (".png", "@2x.png", "@2x"):
    r = c.get(f"/md/tiles/WebMercatorQuad/{z}/{x}/{y}{suffix}", params=base)
    assert r.status_code == 200, (suffix, r.text)
tile = f"/md/tiles/WebMercatorQuad/{z}/{x}/{y}"
from io import BytesIO
from PIL import Image
for size in (128, 256, 512):
    params = {**base, "tilesize": size}
    r = c.get(f"{tile}.png", params=params)
    assert r.status_code == 200, r.text
    assert Image.open(BytesIO(r.content)).size == (size, size)
    metadata = c.get("/md/WebMercatorQuad/tilejson.json", params=params).json()
    template = metadata["tiles"][0].split("testserver")[1]
    r = c.get(template.format(z=z, x=x, y=y))
    assert r.status_code == 200, r.text
    assert Image.open(BytesIO(r.content)).size == (size, size)
assert c.get(tile, params={**base, "tilesize": 0}).status_code == 422
tj_url = "/md/WebMercatorQuad/tilejson.json"
assert c.get(tj_url, params={**base, "tilesize": -1}).status_code == 422
metadata = c.get(tj_url, params={**base, "tile_scale": 2}).json()
template = metadata["tiles"][0].split("testserver")[1]
png = c.get(template.format(z=z, x=x, y=y)).content
assert Image.open(BytesIO(png)).size == (512, 512)
# Keep legacy @Nx requests working; an explicit modern tilesize takes priority.
r = c.get(f"{tile}@2x.png", params={**base, "tilesize": 128})
assert Image.open(BytesIO(r.content)).size == (128, 128)
assert c.get(f"{tile}.jpg", params=base).status_code == 501
assert c.get(f"/md/tiles/WebMercatorQuad/12/0/0", params=base).status_code == 404
assert c.get(f"/md/tiles/WGS1984Quad/{z}/{x}/{y}", params=base).status_code == 422
assert c.get(tile, params={**base, "colormap_name": "nope"}).status_code == 422
assert c.get(tile, params={**base, "algorithm": "hillshade"}).status_code == 422
assert c.get(tile, params={**base, "variable": "nope"}).status_code == 404
no_time = {k: v for k, v in base.items() if k != "time_idx"}
assert c.get(tile, params=no_time).status_code == 400
# The app page, not the picker.
assert c.get("/", follow_redirects=False).status_code == 200
print("OK")
"""


def test_single_cube_pages_tiles_and_not_in_lite(tmp_path):
    _cube(tmp_path / "cube.zarr", 10.0)
    _run(SINGLE, {"BOWSER_STACK_DATA_FILE": str(tmp_path / "cube.zarr")}, cwd=tmp_path)


def test_wms_layers_are_parsed():
    from bowser.lite.wms import parse_named_layers

    xml = b"""<WMS_Capabilities xmlns="http://www.opengis.net/wms"><Capability><Layer><Title>root</Title>
      <Layer><Name>a</Name><Title>A</Title></Layer><Layer><Name>b</Name></Layer><Layer><Name>a</Name></Layer>
    </Layer></Capability></WMS_Capabilities>"""
    assert parse_named_layers(xml) == [
        {"name": "a", "title": "A"},
        {"name": "b", "title": "b"},
    ]


@pytest.mark.parametrize(
    "stored,ok",
    [
        ("{SHA}qUqP5cyxm6YcTAhz05Hph5gvu9M=", True),
        ("{SHA}nope", False),
        ("$apr1$x", False),
    ],
)
def test_basic_auth_passwords(stored, ok):
    from bowser.lite.auth import check_password

    assert check_password(stored, "test") is ok
