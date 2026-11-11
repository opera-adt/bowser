"""A stand-in Bowser page for the page channel's tests (no browser).

Listens on ``GET /page/events`` like the page does (src/assistant/pageChannel.ts),
records each command, answers it with ``handler(name, input)`` (raise
:class:`Refuse` for an error answer) and can say it has the focus.
"""

from __future__ import annotations

import contextlib
import json
import secrets
import threading
from collections.abc import Callable
from typing import Any

import httpx


class Refuse(Exception):
    """The page cannot do it; the message goes back as the page's error."""


class FakePage:
    """One open page on a Bowser server at ``url``."""

    def __init__(
        self,
        url: str,
        handler: Callable[[str, dict], Any] | None = None,
        answer: bool = True,
    ) -> None:
        self.id = "page" + secrets.token_hex(6)
        self.url = url
        self.handler = handler or (lambda name, _args: {"ok": True, "name": name})
        self.answer = answer
        self.commands: list[tuple[str, dict]] = []
        self.status: int | None = None
        self._ready = threading.Event()
        self._stop = False
        self._http = httpx.Client(base_url=url, timeout=30)
        self._thread = threading.Thread(target=self._listen, daemon=True)

    def open(self, focus: bool = True) -> FakePage:
        """Connect; with ``focus``, say the page has the focus."""
        self._thread.start()
        assert self._ready.wait(10), "the page channel did not answer"
        if focus and self.status == 200:
            self.focus()
        return self

    def _listen(self) -> None:
        try:
            with httpx.Client(base_url=self.url, timeout=None) as http:
                with http.stream("GET", "/page/events", params={"page": self.id}) as r:
                    self.status = r.status_code
                    if r.status_code != 200:
                        self._ready.set()
                        return
                    for line in r.iter_lines():
                        if self._stop:
                            return
                        if not line.startswith("data: "):
                            continue
                        msg = json.loads(line[6:])
                        if msg["type"] == "hello":
                            self._ready.set()
                        elif msg["type"] == "command":
                            threading.Thread(
                                target=self._run, args=(msg,), daemon=True
                            ).start()
        except httpx.HTTPError:
            pass
        finally:
            self._ready.set()

    def _run(self, msg: dict) -> None:
        self.commands.append((msg["name"], msg["input"]))
        if not self.answer:
            return
        try:
            body = {"ok": True, "result": self.handler(msg["name"], msg["input"])}
        except Refuse as e:
            body = {"ok": False, "error": str(e)}
        self._http.post("/page/result", json={"page": self.id, "id": msg["id"], **body})

    def focus(self) -> int:
        """Say this page has the focus; return the HTTP status."""
        return self._http.post(
            "/page/focus", json={"page": self.id, "focused": True}
        ).status_code

    def close(self) -> None:
        """Stop listening (the server notices at its next keep-alive)."""
        self._stop = True
        with contextlib.suppress(Exception):
            self._http.close()
