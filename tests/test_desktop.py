"""The desktop app: its settings folder, the local server, and remembered cubes."""

import json
import os
import subprocess
import sys
import textwrap

import pytest

from bowser import desktop


def test_user_dir_per_platform(tmp_path, monkeypatch):
    monkeypatch.setattr(desktop.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(sys, "platform", "darwin")
    assert desktop.user_dir() == tmp_path / "Library" / "Application Support" / "Bowser"
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    assert desktop.user_dir() == tmp_path / "Roaming" / "Bowser"
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    assert desktop.user_dir() == tmp_path / "cfg" / "bowser"
    assert (tmp_path / "cfg" / "bowser").is_dir()


def test_desktop_settings_allow_opening_and_remember(tmp_path):
    env = desktop.desktop_env(tmp_path)
    assert env["BOWSER_CATALOG_FILE"] == str(tmp_path / "catalog.toml")
    assert env["BOWSER_ALLOW_OPEN"] == env["BOWSER_REMEMBER_OPENED"] == "true"
    assert (tmp_path / "uploads").is_dir()


SCRIPT = textwrap.dedent(
    """
    import json, sys, urllib.request
    from bowser.desktop import LocalServer

    server = LocalServer()
    server.start()
    def call(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        req = urllib.request.Request(server.url + path, data=data, headers=headers)
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    if sys.argv[1] == "open":
        print(json.dumps(call("/catalog/open", {"uri": sys.argv[2]})))
    print(json.dumps(call("/catalog")))
    server.stop()
"""
)


def _run(tmp_path, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(desktop.desktop_env(tmp_path))
    env["PYTHONPATH"] = os.pathsep.join(
        filter(None, [os.path.dirname(__file__), env.get("PYTHONPATH")])
    )
    r = subprocess.run(
        [sys.executable, "-c", SCRIPT, *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=tmp_path,
        timeout=180,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    return [json.loads(line) for line in r.stdout.splitlines() if line.startswith("{")]


def test_opened_cubes_are_listed_on_the_next_launch(tmp_path):
    pytest.importorskip("rioxarray")
    from test_catalog_routing import _cube

    cube = tmp_path / "data" / "cube-a.zarr"
    _cube(cube, 10.0)
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    opened, listing = _run(cfg, "open", str(cube))
    assert [d["id"] for d in listing["datasets"]] == [opened["id"]]
    # A fresh server (the app started again) reads the remembered catalog.
    (again,) = _run(cfg, "list")
    assert [d["uri"] for d in again["datasets"]] == [str(cube.resolve())]
    assert again["allow_open"] is True
