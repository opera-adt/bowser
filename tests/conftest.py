<<<<<<< HEAD
"""Shared test setup: page token files go to a temporary folder, not the user's."""

import os
import sys
=======
"""Session-wide test settings.

The reference finder keeps per-pixel statistics on disk under
``$XDG_CACHE_HOME/bowser/refstats``; point that at a temporary folder so tests
never write to the user's cache. ``XDG_CACHE_HOME`` survives the subprocess
helpers that drop ``BOWSER_*`` variables. Nothing from ``bowser`` is imported
here: ``bowser.config`` must not load at collection.
"""

from __future__ import annotations

import os
>>>>>>> upstream/main

import pytest


<<<<<<< HEAD
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
=======
@pytest.fixture(scope="session", autouse=True)
def _private_cache(tmp_path_factory):
    old = os.environ.get("XDG_CACHE_HOME")
    os.environ["XDG_CACHE_HOME"] = str(tmp_path_factory.mktemp("xdg_cache"))
    yield
    if old is None:
        os.environ.pop("XDG_CACHE_HOME", None)
    else:
        os.environ["XDG_CACHE_HOME"] = old
>>>>>>> upstream/main
