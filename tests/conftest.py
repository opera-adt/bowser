"""Shared test setup: page token files go to a temporary folder, not the user's."""

import os
import sys

import pytest


@pytest.fixture(autouse=True, scope="session")
def _page_token_folder(tmp_path_factory):
    """Point the page token's folder (``$XDG_RUNTIME_DIR/bowser``) at a temp dir.

    For the whole session, so a server shared by several tests keeps its token.
    """
    runtime = tmp_path_factory.mktemp("runtime")
    runtime.chmod(0o700)
    saved = {k: os.environ.get(k) for k in ("XDG_RUNTIME_DIR", "BOWSER_PAGE_TOKEN")}
    os.environ["XDG_RUNTIME_DIR"] = str(runtime)
    os.environ.pop("BOWSER_PAGE_TOKEN", None)
    yield
    page = sys.modules.get("bowser.assistant.page")
    if page is not None:
        page.forget_token()
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
