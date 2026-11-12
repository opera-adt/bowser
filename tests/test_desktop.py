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
    # The Assistant is on, its keys kept with the app's other files.
    assert env["BOWSER_ASSISTANT"] == env["BOWSER_ASSISTANT_PAGE_KEYS"] == "true"
    assert env["BOWSER_ASSISTANT_KEY_FILE"] == str(tmp_path / "assistant.json")


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


class _FakeWindow:
    """A pywebview window whose file dialog returns ``chosen``."""

    def __init__(self, chosen):
        self.chosen = chosen
        self.calls = []

    def create_file_dialog(self, kind, **kwargs):
        self.calls.append((kind, kwargs))
        return self.chosen


@pytest.mark.parametrize("new_api", [True, False])
def test_save_file_writes_what_the_page_sends(tmp_path, monkeypatch, new_api):
    import base64
    import types

    # pywebview 5+ has FileDialog.SAVE; older releases SAVE_DIALOG.
    fake = types.ModuleType("webview")
    if new_api:
        fake.FileDialog = types.SimpleNamespace(SAVE="save", FOLDER="folder")
    else:
        fake.SAVE_DIALOG, fake.FOLDER_DIALOG = "save", "folder"
    monkeypatch.setitem(sys.modules, "webview", fake)

    target = tmp_path / "project.json"
    api = desktop._WindowApi()
    api.window = _FakeWindow((str(target),))
    data = base64.b64encode(b'{"a": 1}').decode()

    assert api.save_file("project.json", data) == str(target)
    assert target.read_bytes() == b'{"a": 1}'
    assert api.window.calls == [("save", {"save_filename": "project.json"})]


def test_save_file_cancelled_writes_nothing(tmp_path, monkeypatch):
    import types

    fake = types.ModuleType("webview")
    fake.FileDialog = types.SimpleNamespace(SAVE="save")
    monkeypatch.setitem(sys.modules, "webview", fake)
    api = desktop._WindowApi()
    api.window = _FakeWindow(None)
    assert api.save_file("x.txt", "eA==") is None
    assert list(tmp_path.iterdir()) == []


def test_missing_std_streams_go_to_a_log_file(tmp_path, monkeypatch):
    # A windowed app on Windows has no console: stdout and stderr are None, and
    # uvicorn's log setup used to crash on them ("Unable to configure formatter").
    uvicorn = pytest.importorskip("uvicorn")
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)
    desktop.ensure_std_streams(tmp_path)
    try:
        uvicorn.Config(lambda *_: None, log_level="warning")
        print("hello", flush=True)
    finally:
        log = sys.stdout
        monkeypatch.undo()
        log.close()
    assert "hello" in (tmp_path / "bowser.log").read_text()


def test_std_streams_are_left_alone_with_a_console(tmp_path):
    out, err = sys.stdout, sys.stderr
    desktop.ensure_std_streams(tmp_path)
    assert (sys.stdout, sys.stderr) == (out, err)
    assert not (tmp_path / "bowser.log").exists()


def test_open_url_opens_only_https_pages_in_the_system_browser(monkeypatch):
    opened = []
    monkeypatch.setattr(
        desktop.webbrowser, "open", lambda url: opened.append(url) or True
    )
    api = desktop._WindowApi()
    assert api.open_url("https://auth.openai.com/api/accounts/authorize?x=1") is True
    assert api.open_url("file:///etc/passwd") is False
    assert api.open_url("javascript:alert(1)") is False
    assert opened == ["https://auth.openai.com/api/accounts/authorize?x=1"]


def test_the_app_packs_what_the_assistant_needs():
    """packaging/requirements-desktop.txt lists every "assistant" extra package.

    bowser-lite imports bowser.assistant at start, so a package missing from the
    frozen app stops it from launching (or fails on the first question).
    """
    import re
    import tomllib
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]

    def names(lines):
        out = set()
        for line in lines:
            line = line.split("#")[0].strip()
            if line:
                out.add(re.split(r"[\[<>=!~ ]", line, maxsplit=1)[0].lower())
        return out

    project = tomllib.loads((root / "pyproject.toml").read_text())
    extra = names(project["project"]["optional-dependencies"]["assistant"])
    packed = names(
        (root / "packaging" / "requirements-desktop.txt").read_text().splitlines()
    )
    assert extra and extra <= packed, sorted(extra - packed)
