"""The routes that add files to the map: POST /upload_data, POST /data, GET /data/...

``bowser.main`` reads its settings at import, so it runs in its own interpreter.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytest.importorskip("rasterio")
pytest.importorskip("titiler.core")
gdal = pytest.importorskip("osgeo.gdal")

from test_convert import squares  # noqa: E402
from test_dem import NODATA, _hills, _write  # noqa: E402

HERE = Path(__file__).resolve().parent

SCRIPT = textwrap.dedent(
    r"""
    import json, sys, time
    from fastapi.testclient import TestClient
    from bowser import convert
    from bowser.main import app

    # 3000 parcels stand in for a vector over the 50 000-feature threshold.
    convert.PMTILES_MIN_FEATURES = 2000
    dem, parcels, other, out = sys.argv[1:5]
    c = TestClient(app)
    result = {"config": c.get("/config").json()}

    def wait(job):
        t0 = time.time()
        while job.get("status") == "converting" and time.time() - t0 < 120:
            time.sleep(0.1)
            job = c.get(f"/data/{job['id']}").json()
        return job

    def add(path, name=""):
        r = c.post("/data", json={"path": path, "name": name})
        return r.status_code, r.json()

    # The preset DEM (BOWSER_OVERLAY_FILES), a server path: allowed without
    # BOWSER_ALLOW_OPEN.
    code, job = add(dem)
    result["dem_first"] = [code, job]
    result["dem"] = wait(job)
    params = json.dumps({"style": "both", "vmin": 60, "vmax": 140,
                         "z_exaggeration": 2})
    # Zoom 16 tile over the DEM (lon -90.1325, lat 34.7525).
    t = c.get("/overlay/tiles/WebMercatorQuad/16/16359/26013.png", params={
        "url": result["dem"].get("cog"), "bidx": 1, "buffer": 1,
        "algorithm": "dem", "algorithm_params": params, "resampling": "bilinear",
    })
    result["tile"] = [t.status_code, t.headers.get("content-type")]

    # Any other server path needs BOWSER_ALLOW_OPEN.
    result["other"] = add(other)

    # An upload is always allowed: a large vector, tiled to PMTiles.
    with open(parcels, "rb") as f:
        up = c.post("/upload_data", files=[("files", ("parcels.geojson", f))])
    result["upload"] = [up.status_code, up.json()]
    code, job = add(up.json()["path"], "parcels.geojson")
    result["vector_first"] = [code, job]
    job = wait(job)
    result["vector"] = job
    url = job.get("url") or "/data/missing.pmtiles"
    whole = c.get(url)
    part = c.get(url, headers={"Range": "bytes=0-126"})
    result["whole"] = [whole.status_code, len(whole.content),
                       whole.headers.get("content-type"),
                       whole.headers.get("accept-ranges")]
    result["range"] = [part.status_code, part.content.hex(),
                       part.headers.get("content-range")]
    result["wrong_format"] = c.get(url.replace(".pmtiles", ".geojson")).status_code
    result["unknown"] = c.get("/data/" + "0" * 24).status_code
    result["unknown_file"] = c.get("/data/" + "0" * 24 + ".pmtiles").status_code

    # A Shapefile's parts, uploaded together, become one layer.
    parts = sys.argv[5:]
    files = [("files", (p.rsplit("/", 1)[-1], open(p, "rb"))) for p in parts]
    up = c.post("/upload_data", files=files)
    result["shp_upload"] = up.json()
    result["shp"] = wait(add(up.json()["path"], "wells.shp")[1])
    if result["shp"].get("url"):
        result["shp_geojson"] = c.get(result["shp"]["url"]).json()
    open(out, "w").write(json.dumps(result))
    """
)


def _shapefile(folder: Path) -> list[Path]:
    """Write two wells as a Shapefile in UTM 15N; return its parts."""
    from osgeo import ogr, osr

    ogr.UseExceptions()
    osr.UseExceptions()
    folder.mkdir()
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(32615)
    ds = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(str(folder / "w.shp"))
    layer = ds.CreateLayer("w", srs, ogr.wkbPoint)
    layer.CreateField(ogr.FieldDefn("well", ogr.OFTString))
    for name, x in (("A", 220000), ("B", 221000)):
        f = ogr.Feature(layer.GetLayerDefn())
        f.SetField("well", name)
        f.SetGeometry(ogr.CreateGeometryFromWkt(f"POINT ({x} 3850000)"))
        layer.CreateFeature(f)
    ds = None
    return sorted(folder.iterdir())


def _serve(tmp_path: Path, env_extra: dict[str, str]) -> dict:
    sys.path.insert(0, str(HERE / "regression"))
    from cube import make_cube

    cube = make_cube(tmp_path / "cube.zarr")
    dem = _write(tmp_path / "lidar.tif", _hills(1500))
    other = _write(tmp_path / "other.tif", _hills(600))
    parcels = squares(tmp_path / "parcels.geojson", 3000)
    out = tmp_path / "out.json"
    env = {
        **os.environ,
        "BOWSER_STACK_DATA_FILE": str(cube),
        "BOWSER_UPLOAD_DIR": str(tmp_path / "uploads"),
        "BOWSER_CONVERT_CACHE_DIR": str(tmp_path / "cache"),
        "BOWSER_OVERLAY_FILES": json.dumps([str(dem)]),
        **env_extra,
    }
    env.pop("BOWSER_CATALOG_FILE", None)
    args = [str(dem), str(parcels), str(other), str(out)]
    args += [str(p) for p in _shapefile(tmp_path / "shp")]
    proc = subprocess.run(
        [sys.executable, "-c", SCRIPT, *args],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-4000:]
    return json.loads(out.read_text())


def test_adding_files(tmp_path):
    res = _serve(tmp_path, {"BOWSER_ALLOW_OPEN": "false"})
    cfg = res["config"]
    assert cfg["data_conversion"] == {
        "cog": True,
        "pmtiles": True,
        "pmtiles_min_mb": 20,
    }
    assert cfg["overlay_files"] == [str(tmp_path / "lidar.tif")]
    assert "dem_layer" not in cfg and "dem_file" not in cfg

    # The preset DEM: converted to a COG in the cache, recognised as a DEM, tiled.
    code, first = res["dem_first"]
    assert code == 200 and first["status"] == "converting", first
    assert first["kind"] == "raster" and first["format"] == "cog"
    dem = res["dem"]
    assert dem["status"] == "ready" and dem["converted"] and dem["dem"], dem
    assert Path(dem["cog"]).parent == tmp_path / "cache"
    assert dem["band_count"] == 1 and dem["nodata"] == NODATA
    assert 55 < dem["bands"][0]["p2"] < dem["bands"][0]["p98"] < 145
    w, s, e, n = dem["bounds"]
    assert w < -90.13 < e and s < 34.75 < n
    assert res["tile"] == [200, "image/png"]

    # Other server paths: the same gate and wording as Project › Open data.
    code, body = res["other"]
    assert code == 403
    assert body["detail"].startswith("Opening data from the page is off on this server")

    # The large vector upload: tiled, then served in byte ranges.
    assert res["upload"][0] == 200
    up = res["upload"][1]
    assert Path(up["path"]).parent == tmp_path / "uploads"
    assert up["name"] == "parcels.geojson"
    code, first = res["vector_first"]
    assert code == 200 and first["format"] == "pmtiles", first
    assert first["feature_count"] == 3000 and first["layers"]
    vec = res["vector"]
    assert vec["status"] == "ready" and vec["name"] == "parcels.geojson", vec
    assert vec["url"] == f"/data/{vec['id']}.pmtiles"
    status, size, ctype, ranges = res["whole"]
    assert status == 200 and size > 1000 and ctype == "application/vnd.pmtiles"
    assert ranges == "bytes"
    status, head, crange = res["range"]
    head = bytes.fromhex(head)
    assert status == 206 and len(head) == 127 and crange == f"bytes 0-126/{size}"
    assert head[:8] == b"PMTiles\x03" and head[99] == 1  # vector tiles
    # The converted archive sits next to the upload, swept with it.
    assert list((tmp_path / "uploads").glob(f"{vec['id']}.pmtiles"))
    assert res["wrong_format"] == 404
    assert res["unknown"] == 404 and res["unknown_file"] == 404

    # The Shapefile: small, so one GeoJSON in WGS84 with its attributes.
    assert res["shp_upload"]["path"].endswith("_w.shp")
    shp = res["shp"]
    assert shp["status"] == "ready" and shp["format"] == "geojson", shp
    fc = res["shp_geojson"]
    assert [f["properties"]["well"] for f in fc["features"]] == ["A", "B"]
    lon, lat = fc["features"][0]["geometry"]["coordinates"]
    assert -96.1 < lon < -96.0 and 34.7 < lat < 34.8  # from UTM 15N


SCRIPT_OPEN = textwrap.dedent(
    r"""
    import json, sys
    from fastapi.testclient import TestClient
    from bowser.main import app

    path, out = sys.argv[1:3]
    r = TestClient(app).post("/data", json={"path": path})
    open(out, "w").write(json.dumps([r.status_code, r.json()]))
    """
)


def test_server_paths_with_allow_open(tmp_path):
    """With BOWSER_ALLOW_OPEN, any file the server can read may be added."""
    sys.path.insert(0, str(HERE / "regression"))
    import rasterio.shutil
    from cube import make_cube

    cog = tmp_path / "cog.tif"
    rasterio.shutil.copy(_write(tmp_path / "s.tif", _hills(600)), cog, driver="COG")
    out = tmp_path / "out.json"
    env = {
        **os.environ,
        "BOWSER_STACK_DATA_FILE": str(make_cube(tmp_path / "cube.zarr")),
        "BOWSER_UPLOAD_DIR": str(tmp_path / "uploads"),
        "BOWSER_CONVERT_CACHE_DIR": str(tmp_path / "cache"),
        "BOWSER_ALLOW_OPEN": "true",
    }
    env.pop("BOWSER_CATALOG_FILE", None)
    env.pop("BOWSER_OVERLAY_FILES", None)
    proc = subprocess.run(
        [sys.executable, "-c", SCRIPT_OPEN, str(cog), str(out)],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stderr[-4000:]
    code, job = json.loads(out.read_text())
    assert code == 200, job
    # Already a COG: used where it is, at once.
    assert job["status"] == "ready" and job["cog"] == str(cog) and not job["converted"]


SCRIPT_FILES = textwrap.dedent(
    r"""
    import json, sys
    from fastapi.testclient import TestClient
    from bowser.main import app

    folder, out = sys.argv[1:3]
    c = TestClient(app)
    res = {}
    for name, params in (
        ("listing", {"dir": folder}),
        ("default", {}),
        ("file", {"dir": folder + "/dem.tif"}),
        ("missing", {"dir": folder + "/nope"}),
    ):
        r = c.get("/files", params=params)
        res[name] = [r.status_code, r.json()]
    open(out, "w").write(json.dumps(res))
    """
)


def _files(tmp_path, allow_open: bool) -> dict:
    sys.path.insert(0, str(HERE / "regression"))
    from cube import make_cube

    cube = make_cube(tmp_path / "cubes" / "cube.zarr")
    folder = tmp_path / "data"
    (folder / "lidar").mkdir(parents=True)
    (folder / "dem.tif").write_bytes(b"x" * 12)
    (folder / "readme.md").write_text("x")
    out = tmp_path / "out.json"
    env = {
        **os.environ,
        "BOWSER_STACK_DATA_FILE": str(cube),
        "BOWSER_UPLOAD_DIR": str(tmp_path / "uploads"),
        "BOWSER_CONVERT_CACHE_DIR": str(tmp_path / "cache"),
        "BOWSER_ALLOW_OPEN": str(allow_open).lower(),
    }
    env.pop("BOWSER_CATALOG_FILE", None)
    env.pop("BOWSER_OVERLAY_FILES", None)
    proc = subprocess.run(
        [sys.executable, "-c", SCRIPT_FILES, str(folder), str(out)],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stderr[-4000:]
    return json.loads(out.read_text())


def test_browsing_server_folders(tmp_path):
    """GET /files: one folder, its sub-folders and the files the page adds."""
    res = _files(tmp_path, allow_open=True)
    code, body = res["listing"]
    assert code == 200, body
    data = tmp_path.resolve() / "data"
    assert body == {
        "dir": str(data),
        "parent": str(tmp_path.resolve()),
        "entries": [
            {
                "name": "lidar",
                "path": str(data / "lidar"),
                "type": "dir",
                "size": None,
                "kind": None,
            },
            {
                "name": "dem.tif",
                "path": str(data / "dem.tif"),
                "type": "file",
                "size": 12,
                "kind": "raster",
            },
        ],
        "truncated": False,
        "skipped": 0,
    }
    # Without a folder: the one the cube is in.
    code, body = res["default"]
    assert code == 200 and body["dir"] == str(tmp_path.resolve() / "cubes"), body
    # A file, or nothing there: 400.
    code, body = res["file"]
    assert code == 400 and body["detail"].endswith("dem.tif is not a folder"), body
    assert res["missing"][0] == 400


def test_browsing_is_gated_like_server_paths(tmp_path):
    """Off unless BOWSER_ALLOW_OPEN, with POST /data's wording."""
    res = _files(tmp_path, allow_open=False)
    for name in ("listing", "default", "file"):
        code, body = res[name]
        assert code == 403, (name, body)
        assert body["detail"] == (
            "Opening data from the page is off on this server "
            "(set BOWSER_ALLOW_OPEN=true, or run `bowser run` locally)."
        )
