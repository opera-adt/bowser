"""The desktop app runs bowser-lite by default.

``BOWSER_SERVER=full`` or ``--full`` picks the full server.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from click.testing import CliRunner

from bowser import desktop
from bowser.cli import cli_app


def test_server_app_choice(monkeypatch):
    monkeypatch.delenv("BOWSER_SERVER", raising=False)
    assert desktop.server_app() == "bowser.lite.main:app"
    monkeypatch.setenv("BOWSER_SERVER", "full")
    assert desktop.server_app() == "bowser.main:app"
    assert (
        desktop.server_app("lite") == "bowser.lite.main:app"
    )  # an explicit choice wins
    monkeypatch.setenv("BOWSER_SERVER", "gdal")
    with pytest.raises(ValueError, match="BOWSER_SERVER"):
        desktop.server_app()


def test_local_server_uses_the_chosen_app(monkeypatch):
    monkeypatch.delenv("BOWSER_SERVER", raising=False)
    assert desktop.LocalServer(port=1).app == "bowser.lite.main:app"
    assert desktop.LocalServer(port=1, server="full").app == "bowser.main:app"


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
    opened = call("/catalog/open", {"uri": sys.argv[1]})
    print(json.dumps(opened))
    print(json.dumps(call(f"/datasets?dataset={opened['id']}")["displacement"]["x_values"]))
    full_loaded = "bowser.main" in sys.modules or "rasterio" in sys.modules
    print(json.dumps({"app": server.app, "full_loaded": full_loaded}))
    server.stop()
    """
)


def test_desktop_server_is_lite_and_opens_cubes(tmp_path):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from test_lite_app import _cube

    _cube(tmp_path / "data" / "cube-a.zarr", 10.0)
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(desktop.desktop_env(cfg))
    r = subprocess.run(
        [sys.executable, "-c", SCRIPT, str(tmp_path / "data" / "cube-a.zarr")],
        env=env,
        capture_output=True,
        text=True,
        cwd=cfg,
        timeout=180,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    opened, labels, info = (
        json.loads(line) for line in r.stdout.splitlines() if line[:1] in "{["
    )
    assert opened["name"] == "cube-a"
    assert labels == ["2026-01-01", "2026-01-13", "2026-01-25"]
    assert info == {"app": "bowser.lite.main:app", "full_loaded": False}
    assert (
        "cube-a" in (cfg / "catalog.toml").read_text()
    )  # remembered for the next launch


def test_cli_lite_and_desktop_flags():
    runner = CliRunner()
    out = runner.invoke(cli_app, ["lite", "--help"])
    assert (
        out.exit_code == 0
        and "--stack-file" in out.output
        and "--catalog-file" in out.output
    )
    assert runner.invoke(cli_app, ["lite"]).exit_code == 2  # needs a cube or a catalog
    out = runner.invoke(cli_app, ["desktop", "--help"])
    assert out.exit_code == 0 and "--lite / --full" in out.output


def test_cli_desktop_passes_the_server_choice(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        desktop,
        "run",
        lambda browser=False, server=None: seen.update(browser=browser, server=server),
    )
    runner = CliRunner()
    assert runner.invoke(cli_app, ["desktop", "--full", "--browser"]).exit_code == 0
    assert seen == {"browser": True, "server": "full"}
    assert runner.invoke(cli_app, ["desktop"]).exit_code == 0
    assert seen == {"browser": False, "server": None}


def test_cli_lite_sets_settings_and_runs_uvicorn(monkeypatch, tmp_path):
    import uvicorn

    calls = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: calls.update(app=app, **kw))
    for key in (
        "BOWSER_STACK_DATA_FILE",
        "BOWSER_CATALOG_FILE",
        "BOWSER_ALLOW_OPEN",
        "BOWSER_TITLE",
        "BOWSER_USE_SPATIAL_REFERENCE_DISP",
        "BOWSER_OPERA_LOGO",
        "BOWSER_ASSISTANT",
        "BOWSER_ASSISTANT_PAGE_KEYS",
    ):
        monkeypatch.setenv(
            key, ""
        )  # restored (removed) after the test; the command sets them
    out = CliRunner().invoke(
        cli_app,
        ["lite", "-s", str(tmp_path / "c.zarr"), "--port", "8123", "--title", "T"],
    )
    assert out.exit_code == 0, out.output
    assert calls == {
        "app": "bowser.lite.main:app",
        "host": "127.0.0.1",
        "port": 8123,
        "log_level": "warning",
    }
    assert os.environ["BOWSER_STACK_DATA_FILE"] == str(tmp_path / "c.zarr")
    assert (
        os.environ["BOWSER_ALLOW_OPEN"] == "true" and os.environ["BOWSER_TITLE"] == "T"
    )
    # A local server shows the Assistant, with keys saved from the page.
    assert os.environ["BOWSER_ASSISTANT"] == os.environ["BOWSER_ASSISTANT_PAGE_KEYS"]
    assert os.environ["BOWSER_ASSISTANT"] == "true"
