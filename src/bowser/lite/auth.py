"""HTTP Basic Auth for bowser-lite (``BOWSER_HTPASSWD_FILE``), as in ``bowser.main``."""

from __future__ import annotations

import base64
import hashlib
import hmac
from pathlib import Path
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


def load_htpasswd(path: str) -> dict[str, str]:
    """Parse an htpasswd file into ``{username: hashed_password}``."""
    users: dict[str, str] = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(":", 1)
        if len(parts) == 2:
            users[parts[0]] = parts[1]
    return users


def check_password(stored: str, provided: str) -> bool:
    """Verify a password against an htpasswd entry (``{SHA}`` or bcrypt)."""
    if stored.startswith("{SHA}"):
        digest = base64.b64encode(hashlib.sha1(provided.encode()).digest()).decode()
        return hmac.compare_digest(stored[5:], digest)
    try:
        import bcrypt  # noqa: PLC0415 — optional

        return bcrypt.checkpw(provided.encode(), stored.encode())
    except ImportError:
        return False


class BasicAuthMiddleware(BaseHTTPMiddleware):
    """Ask for a user name and password from an htpasswd file (none listed: open)."""

    def __init__(self, app: Any, htpasswd_file: str) -> None:
        """Guard ``app`` with the users in ``htpasswd_file``."""
        super().__init__(app)
        self.htpasswd_file = Path(htpasswd_file)

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        """Let the request through only with valid credentials."""
        users = (
            load_htpasswd(str(self.htpasswd_file))
            if self.htpasswd_file.exists()
            else {}
        )
        if not users:
            return await call_next(request)
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                decoded = base64.b64decode(auth[6:]).decode("utf-8", errors="replace")
                username, _, password = decoded.partition(":")
                stored = users.get(username)
                if stored and check_password(stored, password):
                    return await call_next(request)
            except Exception:  # noqa: BLE001, S110
                pass
        return Response(
            content="Unauthorized",
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="Bowser"'},
        )
