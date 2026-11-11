"""The HTTP API's OpenAPI description, for both servers.

- every route in the schema has a tag, and every route Bowser defines itself has a
  summary and a description (TiTiler's routes keep their own text);
- the routes both servers share take the same parameters and describe the same
  responses (the schema-level counterpart of tests/lite/test_lite_parity.py);
- the response models describe what the endpoints really return: real responses
  from the synthetic cube validate against them and round-trip unchanged.

Each app reads its settings at import, so each runs in its own interpreter.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytest.importorskip("titiler.core")
pytest.importorskip("rioxarray")

HERE = Path(__file__).resolve().parent
GNSS = HERE / "data" / "gnss"

#: The full server's /md tile routes come from TiTiler, which takes many more
#: parameters than lite; lite's must be a subset of them.
TITILER_ROUTES = {
    "GET /md/{tileMatrixSetId}/tilejson.json",
    "GET /md/tiles/{tileMatrixSetId}/{z}/{x}/{y}",
    "GET /md/tiles/{tileMatrixSetId}/{z}/{x}/{y}.{format}",
}
#: Lite's tile routes take ``scale`` and ``format`` as query parameters (TiTiler
#: 2.4 has no ``@{scale}x`` paths and takes ``format`` only in the path).
LITE_ONLY_TILE_QUERY = {"scale", "format"}
#: The binary responses, whose media types differ: the full server sends WEBP
#: colorbars, lite PNG.
BINARY = {"GET /colorbar/{cmap_name}"}

SCRIPT = textwrap.dedent(
    r"""
    import importlib, io, json, sys, urllib.request
    from pathlib import Path

    which, out, cube, gnss_dir, work = sys.argv[1:6]
    work = Path(work)

    from bowser import gnss
    files = {
        gnss.MIDAS_URL: (Path(gnss_dir) / "midas_sample.txt").read_text(),
        gnss.SERIES_URL.format(station="P056"):
            (Path(gnss_dir) / "P056_sample.tenv3").read_text(),
        gnss.STEPS_URL: (Path(gnss_dir) / "steps_sample.txt").read_text(),
        gnss.MONUMENTS_URL: (Path(gnss_dir) / "monuments_sample.txt").read_text(),
    }
    gnss.fetch_text = lambda url, **_: files[url]

    class _Caps(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    WMS = (b'<WMS_Capabilities><Capability><Layer><Title>Root</Title>'
           b'<Layer><Name>a</Name><Title>A layer</Title></Layer>'
           b'<Layer><Name>b</Name></Layer></Layer></Capability></WMS_Capabilities>')
    urllib.request.urlopen = lambda *a, **k: _Caps(WMS)

    from fastapi.routing import APIRoute
    from fastapi.testclient import TestClient
    from pydantic import TypeAdapter

    module = importlib.import_module(
        "bowser.lite.main" if which == "lite" else "bowser.main"
    )
    app = module.app
    result = {"openapi": app.openapi(), "own_routes": [], "checked": {}, "errors": []}

    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.include_in_schema:
            continue
        if not route.endpoint.__module__.startswith("bowser"):
            continue
        for method in sorted(route.methods):
            result["own_routes"].append({
                "key": f"{method} {route.path_format}",
                "summary": route.summary,
                "description": route.description,
                "model": bool(
                    route.response_model or route.responses.get(200, {}).get("model")
                ),
            })

    def model_for(method, path):
        for route in app.routes:
            if (isinstance(route, APIRoute) and route.path_format == path
                    and method in route.methods):
                return route.response_model or route.responses.get(200, {}).get(
                    "model"
                )
        raise KeyError(f"{method} {path}")

    c = TestClient(app)

    def check(name, method, template, url=None, **kw):
        r = c.request(method, url or template, **kw)
        if r.status_code != 200:
            result["errors"].append(f"{name}: HTTP {r.status_code} {r.text[:300]}")
            return
        body = r.json()
        model = model_for(method, template)
        if model is None:
            result["errors"].append(f"{name}: {method} {template} has no model")
            return
        adapter = TypeAdapter(model)
        try:
            value = adapter.validate_python(body)
        except Exception as e:
            result["errors"].append(f"{name}: {e}")
            return
        again = adapter.dump_python(value, mode="json", exclude_unset=True)
        if again != body:
            result["errors"].append(f"{name}: round trip changed the body")
        result["checked"][name] = f"{method} {template}"

    lon, lat = -117.67462, 33.95859
    rlon, rlat = -117.67984, 33.96289
    edge = [-117.66939, 33.95429]
    check("config", "GET", "/config")
    check("mode", "GET", "/mode")
    check("catalog", "GET", "/catalog")
    check("scan", "POST", "/catalog/scan", json={"dir": str(Path(cube).parent)})
    check("open", "POST", "/catalog/open", json={"uri": cube})
    check("catalog_opened", "GET", "/catalog")
    check("datasets", "GET", "/datasets")
    check("variables", "GET", "/variables")
    tb = "/datasets/{dataset_name}/time_bounds"
    check("time_bounds", "GET", tb, "/datasets/displacement/time_bounds")
    check("range", "GET", "/dataset_range/{dataset_name}",
          "/dataset_range/displacement")
    check("histogram", "GET", "/histogram/{dataset_name}",
          "/histogram/displacement", params={"time_index": 3, "nbins": 20})
    pt = {"dataset_name": "displacement", "lon": lon, "lat": lat}
    check("point", "GET", "/point", params=pt)
    check("point_one", "GET", "/point", params={**pt, "time_idx": 2})
    check("point_nodata", "GET", "/point",
          params={**pt, "lon": -117.68245, "lat": 33.96513})
    check("chart_point", "GET", "/chart_point",
          params={**pt, "ref_lon": rlon, "ref_lat": rlat})
    check("trend", "GET", "/trend_analysis/{dataset_name}",
          "/trend_analysis/displacement", params={"lon": lon, "lat": lat})
    points = [
        {"id": "p1", "lon": lon, "lat": lat, "name": "dam", "color": "#f00"},
        {"id": 2, "lon": edge[0], "lat": edge[1]},
    ]
    check("multi_point", "POST", "/multi_point", json={
        "points": points, "dataset_name": "displacement", "ref_lon": rlon,
        "ref_lat": rlat, "calculate_trends": True,
    })
    check("multi_point_plain", "POST", "/multi_point",
          json={"points": points, "dataset_name": "displacement"})
    check("buffer", "POST", "/buffer_timeseries", json={
        "lon": lon, "lat": lat, "dataset_name": "displacement", "buffer_m": 90,
        "n_samples": 3, "ref_lon": rlon, "ref_lat": rlat,
    })
    line = {"coords": [[rlon, rlat], edge], "dataset_name": "displacement",
            "time_index": 5}
    check("profile_list", "POST", "/profile", json={**line, "n_samples": 20})
    check("profile_lines", "POST", "/profile",
          json={**line, "n_samples": 20, "radius": 60, "n_random": 2})
    check("profile_binned", "POST", "/profile",
          json={**line, "radius": 60, "sampling_interval": 90, "n_random": 2})
    if which == "lite":  # the full server's is TiTiler's own model
        check("tilejson", "GET", "/md/{tileMatrixSetId}/tilejson.json",
              "/md/WebMercatorQuad/tilejson.json",
              params={"variable": "displacement", "time_idx": 1})
    check("gnss_stations", "GET", "/gnss/stations",
          params={"west": -125, "south": 30, "east": -110, "north": 45})
    check("gnss_series", "GET", "/gnss/series/{station}", "/gnss/series/P056")
    check("wms", "GET", "/wms_capabilities", params={"url": "https://example.com"})
    if which == "full":
        square = [[lon - 0.002, lat - 0.002], [lon + 0.002, lat - 0.002],
                  [lon + 0.002, lat + 0.002], [lon - 0.002, lat + 0.002],
                  [lon - 0.002, lat - 0.002]]
        check("polygon", "POST", "/polygon_timeseries", json={
            "variable": "displacement",
            "geometry": {"type": "Polygon", "coordinates": [square]},
        })
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin
        tif = work / "overlay.tif"
        with rasterio.open(tif, "w", driver="GTiff", width=8, height=8, count=1,
                           dtype="float32", crs="EPSG:4326",
                           transform=from_origin(lon, lat, 1e-4, 1e-4)) as dst:
            dst.write(np.arange(64, dtype="float32").reshape(1, 8, 8))
        for name in ("upload_mask", "upload_raster"):
            with open(tif, "rb") as f:
                check(name, "POST", f"/{name}",
                      files={"file": ("overlay.tif", f, "image/tiff")})
        # A striped (non-COG) DEM, uploaded: converted in the background, polled.
        y, x = np.mgrid[0:600, 0:600]
        dem_tif = work / "dem.tif"
        with rasterio.open(dem_tif, "w", driver="GTiff", width=600, height=600,
                           count=1, dtype="float32", crs="EPSG:4326", nodata=-9999,
                           transform=from_origin(lon, lat, 1e-5, 1e-5)) as dst:
            dst.write((100 + np.sin(x / 50.0) * np.cos(y / 40.0) * 20)
                      .astype("float32")[None])
        with open(dem_tif, "rb") as f:
            check("upload_data", "POST", "/upload_data",
                  files=[("files", ("dem.tif", f, "image/tiff"))])
        r = c.post("/data", json={"path": str(dem_tif)})
        assert r.status_code == 200, r.text
        job = r.json()
        import time
        t0 = time.time()
        while job["status"] == "converting" and time.time() - t0 < 120:
            time.sleep(0.1)
            job = c.get(f"/data/{job['id']}").json()
        check("data", "POST", "/data", json={"path": str(dem_tif)})
        check("data_status", "GET", "/data/{data_id}", f"/data/{job['id']}")
        check("files", "GET", "/files", params={"dir": str(work)})
    Path(out).write_text(json.dumps(result))
    """
)


def _run(which: str, cube: Path, work: Path) -> dict:
    out = work / f"{which}.json"
    env = {
        **os.environ,
        "BOWSER_STACK_DATA_FILE": str(cube),
        "BOWSER_ALLOW_OPEN": "true",
        "BOWSER_UPLOAD_DIR": str(work / "uploads"),
        "BOWSER_CONVERT_CACHE_DIR": str(work / "convert_cache"),
    }
    env.pop("BOWSER_CATALOG_FILE", None)
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            SCRIPT,
            which,
            str(out),
            str(cube),
            str(GNSS),
            str(work),
        ],
        env=env,
        cwd=work,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stderr[-3000:]
    return json.loads(out.read_text())


@pytest.fixture(scope="module")
def apps(tmp_path_factory) -> dict[str, dict]:
    sys.path.insert(0, str(HERE / "regression"))
    from cube import make_cube

    root = tmp_path_factory.mktemp("api_schema")
    cube = make_cube(root / "cubes" / "regression.zarr")
    # Producer text on a layer with Bowser guidance adds /datasets' "guidance".
    import zarr

    zarr.open_group(str(cube))["displacement"].attrs[
        "description"
    ] = "Producer description of the displacement."
    results = {}
    for which in ("full", "lite"):
        work = root / which
        work.mkdir()
        results[which] = _run(which, cube, work)
    return results


def _operations(schema: dict) -> dict[str, dict]:
    return {
        f"{method.upper()} {path}": op
        for path, item in schema["paths"].items()
        for method, op in item.items()
    }


def _resolve(node, schema: dict, seen: tuple = ()):
    """Inline every ``$ref`` (and drop schema titles, which name Python classes)."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if ref is not None:
            name = ref.rsplit("/", 1)[-1]
            if name in seen:
                return {"$ref": name}
            target = schema["components"]["schemas"][name]
            return _resolve(target, schema, (*seen, name))
        return {
            k: _resolve(v, schema, seen)
            for k, v in node.items()
            if not (k == "title" and isinstance(v, str))
        }
    if isinstance(node, list):
        return [_resolve(v, schema, seen) for v in node]
    return node


def _parameters(op: dict, schema: dict) -> dict[tuple[str, str], dict]:
    return {(p["in"], p["name"]): _resolve(p, schema) for p in op.get("parameters", [])}


@pytest.mark.parametrize("which", ["full", "lite"])
def test_every_route_has_a_summary_and_a_tag(apps, which):
    schema = apps[which]["openapi"]
    untagged = [k for k, op in _operations(schema).items() if not op.get("tags")]
    assert not untagged, untagged
    bare = [
        r["key"]
        for r in apps[which]["own_routes"]
        if not r["summary"] or not r["description"]
    ]
    assert not bare, bare
    assert apps[which]["own_routes"], "no Bowser routes found"
    from bowser.api_models import ROUTES

    ops = _operations(schema)
    for key, doc in ROUTES.items():
        if key in ops:
            assert ops[key]["summary"] == doc["summary"], key
            assert set(ops[key]["tags"]) == set(doc["tags"]), key


def test_shared_routes_have_the_same_parameters_and_responses(apps):
    from bowser.api_models import LITE_501

    full = apps["full"]["openapi"]
    lite = apps["lite"]["openapi"]
    full_ops, lite_ops = _operations(full), _operations(lite)
    shared = sorted(set(full_ops) & set(lite_ops))
    assert len(shared) >= 25, shared
    for key in shared:
        f, li = full_ops[key], lite_ops[key]
        assert f.get("tags") == li.get("tags"), key
        if key in LITE_501:
            assert "501" in li["responses"], key
            continue
        fp, lp = _parameters(f, full), _parameters(li, lite)
        if key in TITILER_ROUTES:
            extra = {
                name
                for (where, name) in set(lp) - set(fp)
                if not (where == "query" and name in LITE_ONLY_TILE_QUERY)
            }
            assert not extra, (key, extra)
            for k in set(lp) & set(fp):
                assert lp[k]["required"] == fp[k]["required"], (key, k)
            continue
        assert fp == lp, key
        assert _resolve(f.get("requestBody"), full) == _resolve(
            li.get("requestBody"), lite
        ), key
        fr = _resolve(f["responses"]["200"].get("content"), full)
        lr = _resolve(li["responses"]["200"].get("content"), lite)
        if key in BINARY:
            assert fr.keys() != {"application/json"} and lr.keys() != {
                "application/json"
            }, key
            continue
        assert fr == lr, key
        # Every shared JSON route describes its body (not the empty schema).
        assert fr["application/json"]["schema"], key


@pytest.mark.parametrize("which", ["full", "lite"])
def test_response_models_match_real_responses(apps, which):
    assert not apps[which]["errors"], apps[which]["errors"]
    checked = set(apps[which]["checked"].values())
    modelled = {r["key"] for r in apps[which]["own_routes"] if r["model"]}
    assert checked == modelled, sorted(checked ^ modelled)
