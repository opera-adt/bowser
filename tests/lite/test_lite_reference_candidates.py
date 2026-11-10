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
