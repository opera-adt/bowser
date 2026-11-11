"""GET /reference_candidates: the full and lite servers give identical candidates.

The planted-patch cube of tests/test_reference_candidates.py, written as a
GeoZarr store, is asked the same requests through each app, each in its own
interpreter (both read settings at import).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import parity  # noqa: E402
from test_reference_candidates import PATCH, _within, write_cube  # noqa: E402

pytest.importorskip("rioxarray")
pytest.importorskip("titiler.core")


@pytest.fixture(scope="module")
def cube_store(tmp_path_factory) -> Path:
    return write_cube(tmp_path_factory.mktemp("refcand") / "planted.zarr")


def test_full_and_lite_give_identical_candidates(cube_store, tmp_path):
    requests = [
        {"name": "default", "path": "/reference_candidates"},
        {"name": "again", "path": "/reference_candidates", "params": {"n": 3}},
        {
            "name": "masks",
            "path": "/reference_candidates",
            "params": {"radius_m": 60, "use_masks": True, "min_separation_m": 500},
        },
        {
            "name": "single",
            "path": "/reference_candidates",
            "params": {"radius_m": 0, "coherence_min": 0.8, "similarity_min": 0.7},
        },
        {
            "name": "missing",
            "path": "/reference_candidates",
            "params": {"similarity_layer": "nope"},
        },
    ]
    env = {"BOWSER_STACK_DATA_FILE": str(cube_store)}
    procs = [
        parity.run_replay(w, tmp_path / w, env, requests, scenarios=False)
        for w in ("full", "lite")
    ]
    for p in procs:
        parity.wait(p)
    full = json.loads((tmp_path / "full" / "requests.json").read_text())
    lite = json.loads((tmp_path / "lite" / "requests.json").read_text())
    for spec in requests:
        a, b = full[spec["name"]], lite[spec["name"]]
        assert a["status"] == b["status"], (spec, a, b)
        assert a["body"] == b["body"] or not parity.json_diffs(a["body"], b["body"])
    assert full["missing"]["status"] == 404
    assert full["default"]["body"]["cached"] is False
    assert full["again"]["body"]["cached"] is True
    best = full["default"]["body"]["recommended"]
    assert _within(best, PATCH[0], PATCH[1], PATCH[2] - 3)
    # Identical, not merely close: the same code reads the same numbers.
    assert (
        full["default"]["body"]["candidates"] == lite["default"]["body"]["candidates"]
    )


WARM = """
import time
from fastapi.testclient import TestClient
import bowser.lite.main as m
from bowser.refstats import STATS_CACHE

c = TestClient(m.app)
for _ in range(600):
    st = c.get("/reference_candidates/status").json()
    if st["state"] == "ready":
        break
    time.sleep(0.05)
print(st["warm_up"], st["state"], STATS_CACHE.computed)
"""


def test_lite_warms_up_by_default(cube_store, tmp_path):
    import os
    import subprocess

    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_REFSTATS")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(cube_store),
        BOWSER_REFSTATS_CACHE_DIR=str(tmp_path / "refstats"),
        BOWSER_REFSTATS_WARMUP_DELAY_S="0",
        BOWSER_REFSTATS_WARMUP_IDLE_S="0",
    )
    env.pop("BOWSER_CATALOG_FILE", None)
    r = subprocess.run(
        [sys.executable, "-c", WARM],
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=tmp_path,
    )
    assert r.returncode == 0, r.stderr[-3000:]
    # On, and the statistics were computed without anyone asking for a search.
    assert r.stdout.split()[-3:] == ["True", "ready", "3"]
