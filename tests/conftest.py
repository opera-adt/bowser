"""Session-wide test settings.

The reference finder keeps per-pixel statistics on disk under
``$XDG_CACHE_HOME/bowser/refstats``; point that at a temporary folder so tests
never write to the user's cache. ``XDG_CACHE_HOME`` survives the subprocess
helpers that drop ``BOWSER_*`` variables. Nothing from ``bowser`` is imported
here: ``bowser.config`` must not load at collection.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="session", autouse=True)
def _private_cache(tmp_path_factory):
    old = os.environ.get("XDG_CACHE_HOME")
    os.environ["XDG_CACHE_HOME"] = str(tmp_path_factory.mktemp("xdg_cache"))
    yield
    if old is None:
        os.environ.pop("XDG_CACHE_HOME", None)
    else:
        os.environ["XDG_CACHE_HOME"] = old
