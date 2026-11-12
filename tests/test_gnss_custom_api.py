"""The user's GNSS files and rasters on both servers: routes and MCP tools.

- ``POST/GET/DELETE /gnss/custom`` answer alike on the full server and bowser-lite;
- ``load_gnss_csv``, ``list_gnss_stations`` and ``convert_to_cog``, called through
  an MCP client session (``bowser.mcp_server.build_server``) as in
  tests/test_mcp_server.py, give what the routes give;
- a server path is read only where the page could read it (``BOWSER_ALLOW_OPEN``);
- ``convert_to_cog`` writes to the conversion cache, uses a COG as it is, and on
  bowser-lite says the full server is needed.

Each app reads its settings at import, so each runs in its own interpreter;
nothing here imports bowser.main, bowser.state or bowser.config.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytest.importorskip("mcp")
pytest.importorskip("titiler.core")
pytest.importorskip("rioxarray")

HERE = Path(__file__).resolve().parent
EXAMPLE = HERE / "data" / "gnss" / "custom_station.csv"

SCRIPT = textwrap.dedent(
    r"""
    import asyncio, importlib, json, sys
    from pathlib import Path
    from types import SimpleNamespace

    import httpx
    import numpy as np
    from fastapi.testclient import TestClient
    from mcp import Client

    which, out, example, work = sys.argv[1:5]
    out, work = Path(out), Path(work)
    module = importlib.import_module(
        "bowser.lite.main" if which == "lite" else "bowser.main"
    )
    app = module.app
    from bowser.assistant.relay import get_settings
    from bowser.mcp_server import build_server

    c = TestClient(app)
    res = {}

    from pydantic import TypeAdapter
    from bowser import api_models as api

    #: The response model of each route, checked against what it sends.
    MODELS = {
        ("POST", "/gnss/custom"): api.GnssCsvLoaded,
        ("GET", "/gnss/custom"): api.CustomGnssStations,
        ("GET", "/gnss/custom/"): api.CustomGnssSeries,
        ("DELETE", "/gnss/custom/"): api.RemovedGnssStation,
    }
    res["model_errors"] = []

    def call(name, method, url, **kw):
        r = c.request(method, url, **kw)
        body = r.json()
        res[name] = {"status": r.status_code, "body": body}
        key = (method, url if url == "/gnss/custom" else "/gnss/custom/")
        if r.status_code == 200:
            adapter = TypeAdapter(MODELS[key])
            again = adapter.dump_python(
                adapter.validate_python(body), mode="json", exclude_unset=True
            )
            if again != body:
                res["model_errors"].append(f"{name}: round trip changed the body")

    text = Path(example).read_text()
    call("upload", "POST", "/gnss/custom",
         json={"text": text, "name": "custom_station.csv"})
    call("list", "GET", "/gnss/custom")
    call("series", "GET", "/gnss/custom/DEMO")
    call("bad", "POST", "/gnss/custom", json={"text": "a,b\n1,2\n", "name": "x.csv"})
    call("both", "POST", "/gnss/custom", json={"text": text, "path": example})
    call("path", "POST", "/gnss/custom", json={"path": example, "station": "PATH1"})
    call("missing", "POST", "/gnss/custom", json={"path": str(work / "nope.csv")})
    call("delete", "DELETE", "/gnss/custom/PATH1")
    call("gone", "GET", "/gnss/custom/PATH1")
    call("delete_gone", "DELETE", "/gnss/custom/PATH1")

    # Rasters: a striped GeoTIFF (not a COG) and a GeoJSON (a vector).
    tif = work / "striped.tif"
    geojson = work / "points.geojson"
    geojson.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {},
         "geometry": {"type": "Point", "coordinates": [-117.67, 33.96]}}]}))
    if which == "full":
        import rasterio
        from rasterio.transform import from_origin
        with rasterio.open(tif, "w", driver="GTiff", width=700, height=600, count=1,
                           dtype="float32", crs="EPSG:4326",
                           transform=from_origin(-117.7, 33.97, 1e-5, 1e-5)) as dst:
            dst.write(np.arange(700 * 600, dtype="float32").reshape(1, 600, 700))
    else:
        tif.write_bytes(b"II*\x00not really a tiff")

    async def via_mcp(calls):
        server = build_server("http://bowser", httpx.ASGITransport(app=app))
        got = {}
        async with Client(server) as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            hints = {
                n: tools[n].annotations.model_dump(by_alias=True)
                for n in ("load_gnss_csv", "list_gnss_stations", "convert_to_cog")
            }
            got["annotations"] = {
                n: [h["readOnlyHint"], h["openWorldHint"]] for n, h in hints.items()
            }
            for key, (name, args) in calls.items():
                r = await client.call_tool(name, args)
                body = r.content[0].text if r.content else ""
                got[key] = {"error": body} if r.is_error else json.loads(body)
        return got

    calls = {
        "load": ("load_gnss_csv", {"path": example, "station": "MCP1", "units": "mm"}),
        "load_bad": ("load_gnss_csv", {"path": str(work / "nope.csv")}),
        "stations": ("list_gnss_stations", {}),
        "info": ("server_info", {}),
        "cog": ("convert_to_cog", {"path": str(tif)}),
        "cog_again": ("convert_to_cog", {"path": str(tif)}),
        "vector": ("convert_to_cog", {"path": str(geojson)}),
    }
    res["mcp"] = asyncio.run(via_mcp(calls))
    if which == "full" and "output" in res["mcp"]["cog"]:
        res["mcp"].update(asyncio.run(via_mcp({
            "cog_of_cog": ("convert_to_cog", {"path": res["mcp"]["cog"]["output"]}),
        })))

    # Opening files off: the page and the tools may not read server paths.
    off = SimpleNamespace(BOWSER_ALLOW_OPEN=False)
    app.dependency_overrides[get_settings] = lambda: off
    module.settings.BOWSER_ALLOW_OPEN = False
    call("path_off", "POST", "/gnss/custom", json={"path": example})
    call("text_off", "POST", "/gnss/custom",
         json={"text": text, "name": "custom_station.csv", "station": "TEXTOFF"})
    res["mcp_off"] = asyncio.run(via_mcp({
        "load": ("load_gnss_csv", {"path": example}),
        "cog": ("convert_to_cog", {"path": str(tif)}),
    }))
    out.write_text(json.dumps(res))
    """
)


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    sys.path.insert(0, str(HERE / "regression"))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("gnss-cube") / "regression.zarr")


@pytest.fixture(scope="module", params=["full", "lite"])
def run(request, cube, tmp_path_factory) -> tuple[str, dict, Path]:
    """``(which, results, work folder)`` of the script on one app."""
    which = request.param
    work = tmp_path_factory.mktemp(f"gnss-{which}")
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(cube),
        BOWSER_ALLOW_OPEN="true",
        BOWSER_UPLOAD_DIR=str(work / "uploads"),
        BOWSER_CONVERT_CACHE_DIR=str(work / "cache"),
    )
    out = work / "out.json"
    proc = subprocess.run(
        [sys.executable, "-c", SCRIPT, which, str(out), str(EXAMPLE), str(work)],
        env=env,
        cwd=work,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stderr[-4000:]
    return which, json.loads(out.read_text()), work


def test_upload_list_series_delete(run):
    _, res, _ = run
    assert not res["model_errors"], res["model_errors"]
    up = res["upload"]
    assert up["status"] == 200, up
    body = up["body"]
    assert (body["file"], body["skipped"]) == ("custom_station.csv", 1)
    st = body["stations"][0]
    assert (st["id"], st["lon"], st["lat"]) == ("DEMO", -117.67462, 33.95859)
    assert (st["units"], st["units_from"], st["custom"]) == ("mm", "header", True)
    assert st["rows"] == body["rows"] == 22
    assert st["vu_mm_yr"] == pytest.approx(-30, abs=3)
    assert "dates" not in st  # the list carries no series

    assert [s["id"] for s in res["list"]["body"]["stations"]] == ["DEMO"]
    series = res["series"]["body"]
    assert res["series"]["status"] == 200
    assert series["station"] == "DEMO" and series["station_page"] is None
    assert len(series["dates"]) == len(series["up_mm"]) == 22
    assert series["up_mm"][0] == 0.0
    assert series["sigma_up_mm"][0] == 2.5
    assert series["frame"] == "IGS20"


def test_errors_say_what_is_wrong(run):
    _, res, _ = run
    assert res["bad"]["status"] == 400
    assert "No columns found" in res["bad"]["body"]["detail"]
    assert res["both"]["status"] == 400
    assert "one of them" in res["both"]["body"]["detail"]
    assert res["missing"]["status"] == 400
    assert "No such file" in res["missing"]["body"]["detail"]
    assert res["delete"] == {"status": 200, "body": {"removed": "PATH1"}}
    assert res["gone"]["status"] == 404
    assert "load the file again" in res["gone"]["body"]["detail"]
    assert res["delete_gone"]["status"] == 404


def test_server_paths_follow_allow_open(run):
    _, res, _ = run
    assert res["path"]["status"] == 200
    assert res["path"]["body"]["stations"][0]["id"] == "PATH1"
    assert res["path_off"]["status"] == 403
    assert "BOWSER_ALLOW_OPEN" in res["path_off"]["body"]["detail"]
    # Sending the text (a file from the user's computer) is always allowed.
    assert res["text_off"]["status"] == 200
    off = res["mcp_off"]
    assert "HTTP 403" in off["load"]["error"]
    assert "HTTP 403" in off["cog"]["error"] or "bowser-lite" in off["cog"]["error"]


def test_load_and_list_tools_give_the_routes_answers(run):
    _, res, _ = run
    mcp = res["mcp"]
    load = mcp["load"]
    st = load["stations"][0]
    assert st["id"] == "MCP1"
    assert (load["rows"], load["skipped"]) == (22, 1)
    assert (st["units"], st["units_from"]) == ("mm", "option")
    assert (st["first_date"], st["last_date"]) == ("2025-11-01", "2026-03-28")
    upload = res["upload"]["body"]["stations"][0]
    for k in ("ve_mm_yr", "vn_mm_yr", "vu_mm_yr", "lon", "lat", "rows"):
        assert st[k] == upload[k], k
    assert "not MIDAS" in load["note"]
    assert "No such file" in mcp["load_bad"]["error"]

    ids = [s["id"] for s in mcp["stations"]["custom"]]
    assert ids == ["DEMO", "MCP1"]
    assert "unr" not in mcp["stations"]
    assert mcp["annotations"] == {
        "load_gnss_csv": [False, False],
        "list_gnss_stations": [True, True],
        "convert_to_cog": [False, False],
    }


def test_convert_to_cog(run):
    which, res, work = run
    mcp = res["mcp"]
    if which == "lite":
        assert "convert_to_cog" in mcp["info"]["unsupported_tools"]
        for key in ("cog", "vector"):
            assert "bowser-lite" in mcp[key]["error"]
            assert "bowser run" in mcp[key]["error"]
        return
    assert "convert_to_cog" not in mcp["info"]["unsupported_tools"]
    cog = mcp["cog"]
    out = Path(cog["output"])
    assert cog["status"] == "ready" and cog["already_cog"] is False
    assert out.parent == work / "cache"  # the conversion cache, not next to the file
    assert out.stat().st_size == cog["size_bytes"] > 0
    assert cog["band_count"] == 1
    again = mcp["cog_again"]
    assert again["output"] == cog["output"] and again["already_cog"] is False
    same = mcp["cog_of_cog"]
    assert same["already_cog"] is True
    assert same["output"] == cog["output"]
    assert same["size_bytes"] == cog["size_bytes"]
    assert "nothing was written" in same["note"]
    assert "vector" in mcp["vector"]["error"]
    assert sorted(p.name for p in (work).iterdir() if p.suffix == ".tif") == [
        "striped.tif"
    ]
