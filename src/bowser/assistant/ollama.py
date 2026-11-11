"""Ollama on the computer that runs Bowser, with nothing to set up.

The Assistant offers Ollama only when the ``ollama`` program is installed on the
server's computer (:func:`shutil.which`). When it is installed but not answering
on its default port, Bowser starts ``ollama serve`` in the background (a small
environment, its output in Bowser's cache folder), waits until it answers, and
stops it when Bowser exits, but only if Bowser started it. Its models are the
ones installed (``/api/tags``); there is no base URL to set.

Imports ``httpx`` only when it talks to Ollama (the ``assistant`` extra).
"""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

#: Ollama's default address; Bowser uses no other.
HOST = "127.0.0.1:11434"
ROOT = f"http://{HOST}"
#: The OpenAI-compatible API the chat uses.
BASE_URL = f"{ROOT}/v1"
#: Seconds to wait for a started ``ollama serve`` to answer.
START_TIMEOUT = 20.0
#: Variables ``ollama serve`` keeps from Bowser's environment (where it finds its
#: models, GPUs, home and temporary folders); nothing else, so no API keys.
KEEP_ENV = (
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "OLLAMA_MODELS",
    "CUDA_VISIBLE_DEVICES",
    "HIP_VISIBLE_DEVICES",
    "LD_LIBRARY_PATH",
)


def cache_dir() -> Path:
    """Return Bowser's cache folder (``…/bowser``)."""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "bowser" / "Cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "bowser"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "bowser"


class Ollama:
    """The local Ollama server: found, started when needed, and its models.

    Parameters
    ----------
    which : callable, optional
        Finds a program on PATH (:func:`shutil.which`; tests pass a fake).
    popen : callable, optional
        Starts a process (:class:`subprocess.Popen`; tests pass a fake).
    transport : httpx transport, optional
        Replaces the network (tests).
    log_dir : Path, optional
        Where ``ollama serve`` writes its output (default :func:`cache_dir`).
    start_timeout : float, optional
        Seconds to wait for a started server to answer.

    """

    def __init__(
        self,
        which: Callable[[str], str | None] = shutil.which,
        popen: Callable[..., Any] = subprocess.Popen,
        transport: Any = None,
        log_dir: Path | None = None,
        start_timeout: float = START_TIMEOUT,
    ) -> None:
        """Keep the seams; nothing runs until asked."""
        self._which = which
        self._popen = popen
        self._transport = transport
        self._log_dir = log_dir
        self._start_timeout = start_timeout
        self._proc: Any = None
        self._lock = threading.Lock()
        self._atexit = False

    def binary(self) -> str | None:
        """Return the ``ollama`` program's path, or None when not installed."""
        return self._which("ollama")

    def _get(self, path: str, timeout: float = 2.0) -> Any | None:
        import httpx  # noqa: PLC0415

        try:
            with httpx.Client(timeout=timeout, transport=self._transport) as client:
                return client.get(f"{ROOT}{path}")
        except httpx.HTTPError:
            return None

    def running(self) -> bool:
        """Whether Ollama answers on its default port."""
        r = self._get("/api/version")
        return r is not None and r.status_code == 200

    def ensure(self, start: bool = True) -> bool:
        """Return whether Ollama answers, starting ``ollama serve`` if allowed.

        Starts it only when it is installed, not answering and ``start`` is true.
        """
        with self._lock:
            if self.running():
                return True
            program = self.binary()
            if not start or not program:
                return False
            if self._proc is None or self._proc.poll() is not None:
                self._spawn(program)
            deadline = time.monotonic() + self._start_timeout
            while time.monotonic() < deadline:
                if self.running():
                    return True
                if self._proc.poll() is not None:  # it exited: see the log
                    return False
                time.sleep(0.2)
            return False

    def _spawn(self, program: str) -> None:
        log_dir = self._log_dir or cache_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        env = {k: os.environ[k] for k in KEEP_ENV if k in os.environ}
        env["OLLAMA_HOST"] = HOST
        with open(log_dir / "ollama.log", "ab") as log:
            self._proc = self._popen(
                [program, "serve"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=env,
            )
        if not self._atexit:
            atexit.register(self.stop)
            self._atexit = True

    @property
    def started_here(self) -> bool:
        """Whether Bowser started the running ``ollama serve``."""
        return self._proc is not None and self._proc.poll() is None

    def models(self) -> list[str]:
        """Return the installed models (``:latest`` left off), sorted.

        Empty when none are installed or Ollama does not answer.
        """
        r = self._get("/api/tags", timeout=10.0)
        if r is None or r.status_code != 200:
            return []
        try:
            entries = r.json().get("models") or []
        except ValueError:
            return []
        names = {
            str(m.get("name") or m.get("model") or "").removesuffix(":latest")
            for m in entries
            if isinstance(m, dict)
        }
        return sorted(n for n in names if n)

    def stop(self) -> None:
        """Stop ``ollama serve`` if Bowser started it (never one it found running)."""
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


#: The one Ollama this server manages.
OLLAMA = Ollama()
