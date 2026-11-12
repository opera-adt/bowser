"""``/datasets`` in MD mode: ``n_time_steps``, no fake ``file_list`` URIs.

A cube layer has no files: tiles are asked for by ``variable`` + ``time_idx``, so
the payload carries the number of steps rather than ``variable:foo:time:N``
strings. Both servers must answer the same. Each app reads its settings at
import, so each runs in its own interpreter.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REGRESSION = Path(__file__).resolve().parent / "regression"

pytest.importorskip("rioxarray")

_SCRIPT = textwrap.dedent(
    """
    import importlib, json, sys
    from fastapi.testclient import TestClient
    app = importlib.import_module(sys.argv[1]).app
    r = TestClient(app).get("/datasets")
    assert r.status_code == 200, r.text
    print(json.dumps(r.json()))
    """
)


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("cube") / "regression.zarr")


def _datasets(module: str, cube: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env["BOWSER_STACK_DATA_FILE"] = str(cube)
    r = subprocess.run(
        [sys.executable, "-c", _SCRIPT, module],
        env=env,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stderr[-4000:]
    return json.loads(r.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("module", ["bowser.main", "bowser.lite.main"])
def test_md_datasets_carry_n_time_steps(cube, module):
    info = _datasets(module, cube)
    assert info["displacement"]["n_time_steps"] == len(info["displacement"]["x_values"])
    assert info["displacement"]["n_time_steps"] > 1
    assert info["velocity"]["n_time_steps"] == 1  # 2D layer
    for name, entry in info.items():
        assert "file_list" not in entry, name
        assert "mask_file_list" not in entry, name


_CACHE_SCRIPT = textwrap.dedent(
    """
    import json
    from fastapi.testclient import TestClient
    import bowser.main as m
    built = []
    build = m.create_xarray_dataset_info
    m.create_xarray_dataset_info = lambda ds: (built.append(id(ds)), build(ds))[1]
    c = TestClient(m.app)
    first, second = c.get("/datasets").json(), c.get("/datasets").json()
    other = m.state.dataset.copy()
    m.xarray_dataset_info(other)
    m.xarray_dataset_info(other)
    print(json.dumps({"same": first == second, "expected": first == build(
        m.state.dataset), "built": len(built), "distinct": len(set(built))}))
    """
)


def test_full_server_builds_dataset_info_once_per_opened_cube(cube):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env["BOWSER_STACK_DATA_FILE"] = str(cube)
    r = subprocess.run(
        [sys.executable, "-c", _CACHE_SCRIPT], env=env, capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr[-4000:]
    out = json.loads(r.stdout.strip().splitlines()[-1])
    # Two requests, one build; another dataset gets its own, also once.
    assert out == {"same": True, "expected": True, "built": 2, "distinct": 2}
