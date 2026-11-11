"""The page token: what lets Bowser's tools send commands to the open page.

A Bowser server makes a random token when it starts and writes it to a file only
its user can read (mode 0600 in a 0700 folder), named after its port, and removes
it when it stops. ``POST /page/command`` answers only a request that carries the
token (``Authorization: Bearer <token>``, or ``X-Bowser-Page-Token`` where the
Authorization header carries a password), so a page in a browser, another
user's process or a process on another computer cannot drive the map.

``bowser mcp --url http://127.0.0.1:PORT`` reads the file for PORT when it runs
on the same computer as the server; ``--token`` or ``BOWSER_PAGE_TOKEN`` give it
otherwise. The Assistant and the signed-in agent get it from the server itself.

The token is never sent to the page, written to a log or put in an answer. This
module needs only the standard library (``bowser mcp`` imports it).
"""

from __future__ import annotations

import contextlib
import hmac
import os
import secrets
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

#: The variable that gives ``bowser mcp`` (or an agent's ``bowser mcp``) the token.
ENV = "BOWSER_PAGE_TOKEN"
#: The header a client may send instead of ``Authorization: Bearer``.
HEADER = "X-Bowser-Page-Token"
_LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


def folder() -> Path:
    """Return the private folder for token files (created, mode 0700).

    ``$XDG_RUNTIME_DIR/bowser`` where the system has one (it is private to the
    user and emptied at logout), else ``~/.cache/bowser``.
    """
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    base = Path(runtime) if runtime and Path(runtime).is_dir() else None
    if base is None:
        home = Path.home()
        base = (
            home / ".cache"
            if home.is_dir()
            else Path(tempfile.gettempdir()) / f"bowser-{getattr(os, 'getuid', int)()}"
        )
    path = base / "bowser"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    with contextlib.suppress(OSError):
        path.chmod(0o700)
    return path


def path_for(port: int) -> Path:
    """Return the token file of the server on ``port``."""
    return folder() / f"page-token-{int(port)}"


def create(port: int) -> str:
    """Make a new token for the server on ``port`` and write its file (0600)."""
    token = secrets.token_urlsafe(32)
    path = path_for(port)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, token.encode())
    finally:
        os.close(fd)
    tmp.replace(path)
    return token


def remove(port: int, token: str) -> None:
    """Remove ``port``'s token file if it still holds ``token`` (not a newer one)."""
    path = path_for(port)
    with contextlib.suppress(OSError):
        if hmac.compare_digest(path.read_text().strip(), token):
            path.unlink()


def read(port: int) -> str | None:
    """Return the token of the server on ``port``, or None without a file."""
    try:
        return path_for(port).read_text().strip() or None
    except (OSError, ValueError):
        return None


def for_url(url: str) -> str | None:
    """Return the token of the Bowser server at ``url`` on this computer, if any."""
    parts = urlsplit(url)
    if (parts.hostname or "").lower() not in _LOOPBACK:
        return None
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return read(port)


def matches(given: str | None, token: str | None) -> bool:
    """Whether ``given`` is the token (compared in constant time)."""
    return bool(given and token) and hmac.compare_digest(
        str(given).encode(), str(token).encode()
    )
