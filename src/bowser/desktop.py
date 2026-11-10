"""Bowser as a desktop app: the server on this computer plus a window.

No terminal is needed. ``bowser desktop`` (or the packaged app) starts the server on
a free local port with an empty catalog kept in the user's settings folder, then
opens the start screen (the dataset picker) in its own window. Cubes opened there
are remembered for next time. Without pywebview it opens the default browser
instead. Closing the window stops the server.

The server is bowser-lite (``bowser.lite.main:app``: GeoZarr cubes, no GDAL) unless
``BOWSER_SERVER=full`` (or ``server="full"``) asks for the full one, which adds
GeoTIFF uploads, exports and COG stacks but needs rasterio/titiler installed.
"""

from __future__ import annotations

import base64
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any

APP_NAME = "Bowser"
#: The ASGI app of each server the desktop app can run.
SERVER_APPS = {"lite": "bowser.lite.main:app", "full": "bowser.main:app"}
DEFAULT_SERVER = "lite"


def server_app(server: str | None = None) -> str:
    """Return the ASGI app to run: ``server``, else ``$BOWSER_SERVER``, else lite."""
    name = (server or os.environ.get("BOWSER_SERVER") or DEFAULT_SERVER).strip().lower()
    if name not in SERVER_APPS:
        raise ValueError(
            f"BOWSER_SERVER must be one of {sorted(SERVER_APPS)}, not {name!r}"
        )
    return SERVER_APPS[name]


def user_dir() -> Path:
    """Where the app keeps its catalog and uploads (created if missing)."""
    if sys.platform == "win32":
        base = (
            Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
            / APP_NAME
        )
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_NAME
    else:
        base = (
            Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
            / APP_NAME.lower()
        )
    base.mkdir(parents=True, exist_ok=True)
    return base


def ensure_std_streams(folder: Path) -> None:
    """Point a missing ``sys.stdout``/``sys.stderr`` at ``folder/bowser.log``.

    A windowed (no console) app on Windows starts with both set to None, and
    uvicorn's log formatter calls ``isatty()`` on them, so the app crashed at
    start. The log file also gives users something to send when it fails.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    log = open(folder / "bowser.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    if sys.stdout is None:
        sys.stdout = log
    if sys.stderr is None:
        sys.stderr = log


def free_port() -> int:
    """Return a port nothing listens on, picked by the OS."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def desktop_env(folder: Path) -> dict[str, str]:
    """Return the app's settings: a kept catalog, opening allowed, uploads here.

    The Assistant is on, with keys saved on this computer from the page.
    """
    (folder / "uploads").mkdir(exist_ok=True)
    return {
        "BOWSER_CATALOG_FILE": str(folder / "catalog.toml"),
        "BOWSER_ALLOW_OPEN": "true",
        "BOWSER_REMEMBER_OPENED": "true",
        "BOWSER_UPLOAD_DIR": str(folder / "uploads"),
        "BOWSER_ASSISTANT": "true",
        "BOWSER_ASSISTANT_PAGE_KEYS": "true",
        "BOWSER_ASSISTANT_KEY_FILE": str(folder / "assistant.json"),
    }


class LocalServer:
    """Bowser's server in a background thread on 127.0.0.1."""

    def __init__(self, port: int | None = None, server: str | None = None) -> None:
        """Set up the server on ``port`` (a free one if None); call :meth:`start`."""
        import uvicorn  # noqa: PLC0415

        self.port = port or free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.app = server_app(server)
        config = uvicorn.Config(
            self.app, host="127.0.0.1", port=self.port, log_level="warning"
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(
            target=self._server.run, name="bowser-server", daemon=True
        )

    def start(self, timeout: float = 120.0) -> None:
        """Start, and wait until the server answers.

        Opening the first cube can take a while.
        """
        self._thread.start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self._thread.is_alive():
                raise RuntimeError("Bowser's server stopped while starting")
            try:
                with urllib.request.urlopen(f"{self.url}/catalog", timeout=2) as r:  # noqa: S310
                    if r.status == 200:
                        return
            except OSError:
                time.sleep(0.2)
        raise TimeoutError(f"Bowser's server did not start within {timeout:.0f} s")

    def stop(self) -> None:
        """Ask the server to exit and wait for its thread."""
        self._server.should_exit = True
        self._thread.join(timeout=10)

    def wait(self) -> None:
        """Block until the server stops."""
        self._thread.join()


class _WindowApi:
    """What the page may ask of the app window (``window.pywebview.api``)."""

    def __init__(self) -> None:
        self.window: Any = None

    def pick_folder(self) -> str | None:
        """Show a native folder chooser; return the folder, or None if cancelled."""
        chosen = self._dialog("FOLDER") if self.window else None
        return _first(chosen)

    def save_file(self, name: str, data_base64: str) -> str | None:
        """Ask where to save ``name`` and write the bytes there.

        The page calls this instead of a download link, which the app window
        cannot follow: Windows ignored it, and macOS replaced the page with the
        file. Return the path written, or None if cancelled.
        """
        if not self.window:
            return None
        path = _first(self._dialog("SAVE", save_filename=name))
        if not path:
            return None
        Path(path).write_bytes(base64.b64decode(data_base64))
        return path

    def _dialog(self, kind: str, **kwargs: Any) -> Any:
        """Open a pywebview file dialog of ``kind`` (FOLDER, SAVE or OPEN)."""
        import webview  # noqa: PLC0415

        # pywebview 5+ has webview.FileDialog.<KIND>; older ones <KIND>_DIALOG.
        dialogs = getattr(webview, "FileDialog", None)
        flag = getattr(dialogs, kind, None) or getattr(webview, f"{kind}_DIALOG")
        return self.window.create_file_dialog(flag, **kwargs)


def _first(chosen: Any) -> str | None:
    """Return the path a dialog chose: a string, a list of them, or nothing."""
    if not chosen:
        return None
    return chosen if isinstance(chosen, str) else chosen[0]


def run(browser: bool = False, server: str | None = None) -> None:
    """Start the server and show Bowser.

    The server is lite unless ``server`` or ``$BOWSER_SERVER`` say full.
    """
    folder = user_dir()
    ensure_std_streams(folder)
    os.environ.update(desktop_env(folder))
    local = LocalServer(server=server)
    print(f"Starting Bowser on {local.url} …", flush=True)
    local.start()
    try:
        import webview  # noqa: PLC0415
    except ImportError:
        webview = None
    if browser or webview is None:
        webbrowser.open(local.url)
        print(
            f"Bowser is open in your browser at {local.url}. "
            "Close this window to quit.",
            flush=True,
        )
        try:
            local.wait()
        except KeyboardInterrupt:
            local.stop()
        return
    api = _WindowApi()
    api.window = webview.create_window(
        APP_NAME, local.url, js_api=api, width=1440, height=900, min_size=(900, 600)
    )
    try:
        webview.start()
    finally:
        local.stop()


if __name__ == "__main__":  # the packaged app's entry point
    run(
        browser="--browser" in sys.argv, server="full" if "--full" in sys.argv else None
    )
