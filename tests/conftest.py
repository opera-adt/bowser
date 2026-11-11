"""Shared test setup: page token files go to a temporary folder, not the user's."""

import sys

import pytest


@pytest.fixture(autouse=True)
def _page_token_folder(tmp_path_factory, monkeypatch):
    """Point the page token's folder (``$XDG_RUNTIME_DIR/bowser``) at a temp dir."""
    runtime = tmp_path_factory.mktemp("runtime")
    runtime.chmod(0o700)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(runtime))
    monkeypatch.delenv("BOWSER_PAGE_TOKEN", raising=False)
    yield
    page = sys.modules.get("bowser.assistant.page")
    if page is not None:
        page.forget_token()
