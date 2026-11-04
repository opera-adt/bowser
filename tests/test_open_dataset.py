"""POST /catalog/open: open a GeoZarr by path at runtime, then route to it by id.

``bowser.main`` reads its settings at import, so the app runs in a subprocess,
as in test_catalog_routing.py.
"""

import os
import subprocess
import sys
import textwrap

import pytest

pytest.importorskip("rioxarray")

from test_catalog_routing import _cube  # noqa: E402

SCRIPT = textwrap.dedent(
    """
    import sys
    from fastapi.testclient import TestClient
    from bowser.main import app

    c = TestClient(app)
    path = sys.argv[1]
    assert c.get("/catalog").json() == {"datasets": [], "allow_open": True}

    r = c.post("/catalog/open", json={"uri": path})
    assert r.status_code == 200, r.text
    opened = r.json()
    assert opened["name"] == "cube-a", opened
    assert opened["id"].startswith("cube-a-"), opened

    q = {
        "dataset_name": "displacement",
        "lon": -117.687,
        "lat": 33.968,
        "dataset": opened["id"],
    }
    p = c.get("/point", params=q)
    assert p.status_code == 200 and p.json() == [10.0, 11.0, 12.0], p.text

    listed = c.get("/catalog").json()["datasets"]
    assert [d["id"] for d in listed] == [opened["id"]], listed
    assert listed[0]["bbox"][0] < -117.68 < listed[0]["bbox"][2], listed

    # Same path again: same id, no duplicate entry.
    assert c.post("/catalog/open", json={"uri": path}).json()["id"] == opened["id"]
    assert len(c.get("/catalog").json()["datasets"]) == 1

    assert c.post("/catalog/open", json={"uri": path + "-missing"}).status_code == 400
    assert c.post("/catalog/open", json={"uri": ""}).status_code == 400

    parent = str(__import__("pathlib").Path(path).parent)
    found = c.post("/catalog/scan", json={"dir": parent}).json()
    assert [x["name"] for x in found["cubes"]] == ["cube-a"], found
    assert c.post("/catalog/scan", json={"dir": path + "-missing"}).status_code == 400
    print("OK")
"""
)

DISABLED = textwrap.dedent(
    """
    from fastapi.testclient import TestClient
    from bowser.main import app

    c = TestClient(app)
    assert c.get("/catalog").json()["allow_open"] is False
    r = c.post("/catalog/open", json={"uri": "/etc"})
    assert r.status_code == 403, r.text
    assert c.post("/catalog/scan", json={"dir": "/"}).status_code == 403
    print("OK")
"""
)


def _run(script, tmp_path, allow, *args):
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("BOWSER_") or k == "BOWSER_OPERA_LOGO"
    }
    env["BOWSER_ALLOW_OPEN"] = allow
    # Start with nothing loaded: an empty catalog (the file need not exist).
    env["BOWSER_CATALOG_FILE"] = str(tmp_path / "catalog.toml")
    env["PYTHONPATH"] = os.pathsep.join(
        filter(None, [os.path.dirname(__file__), env.get("PYTHONPATH")])
    )
    r = subprocess.run(
        [sys.executable, "-c", script, *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    assert r.returncode == 0 and "OK" in r.stdout, r.stdout[-2000:] + r.stderr[-4000:]


def test_open_by_path_then_route_by_id(tmp_path):
    path = tmp_path / "cube-a.zarr"
    _cube(path, 10.0)
    _run(SCRIPT, tmp_path, "true", str(path))


def test_open_is_refused_unless_allowed(tmp_path):
    _run(DISABLED, tmp_path, "false")


LOGO = textwrap.dedent(
    """
    import sys
    from fastapi.testclient import TestClient
    from bowser.main import app

    config = TestClient(app).get("/config").json()
    assert config["opera_logo"] is (sys.argv[1] == "true")
    print("OK")
"""
)


@pytest.mark.parametrize("shown", ["true", "false"])
def test_opera_logo_follows_the_setting(tmp_path, shown, monkeypatch):
    monkeypatch.setenv("BOWSER_OPERA_LOGO", shown)
    _run(LOGO, tmp_path, "false", shown)
