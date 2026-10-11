"""API regression: the responses the UI depends on, pinned as golden JSON.

Guards UI refactors (e.g. Leaflet -> MapLibre) and backend changes alike: every
request the frontend makes (run_scenarios.py) is replayed against a deterministic
cube (cube.py) in single-dataset and in catalog mode, and compared to
tests/regression/golden/<mode>.json.

Update on purpose, then review the diff:
    BOWSER_UPDATE_GOLDENS=1 pytest tests/regression
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
GOLDEN = HERE / "golden"
UPDATE = os.environ.get("BOWSER_UPDATE_GOLDENS") == "1"

pytest.importorskip("rioxarray")
pytest.importorskip("PIL")


def _run(tmp_path: Path, env_extra: dict, dataset: str = "") -> dict:
    out = tmp_path / "result.json"
    env = {**os.environ, **env_extra, "DATASET": dataset}
    env.pop(
        "BOWSER_STACK_DATA_FILE"
        if "BOWSER_CATALOG_FILE" in env_extra
        else "BOWSER_CATALOG_FILE",
        None,
    )
    r = subprocess.run(
        [sys.executable, str(HERE / "run_scenarios.py"), str(out)],
        env=env,
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    assert r.returncode == 0, r.stderr[-4000:]
    return json.loads(out.read_text())


def _compare(name: str, got: dict) -> None:
    path = GOLDEN / f"{name}.json"
    if UPDATE or not path.exists():
        GOLDEN.mkdir(exist_ok=True)
        path.write_text(json.dumps(got, indent=1, sort_keys=True) + "\n")
        if not UPDATE:
            pytest.fail(
                f"golden {path.name} was missing and has been written; review, commit"
            )
        return
    want = json.loads(path.read_text())
    changed = sorted(k for k in set(want) | set(got) if want.get(k) != got.get(k))
    assert not changed, (
        f"{len(changed)} UI request(s) changed vs {path.name}: {changed}. "
        "If intended, rerun with BOWSER_UPDATE_GOLDENS=1 and review the diff."
    )


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    sys.path.insert(0, str(HERE))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("cube") / "regression.zarr")


def test_single_dataset_mode(cube, tmp_path):
    _compare("single", _run(tmp_path, {"BOWSER_STACK_DATA_FILE": str(cube)}))


def test_catalog_mode(cube, tmp_path):
    from bowser.catalog import CatalogEntry, save_catalog

    catalog = tmp_path / "catalog.toml"
    save_catalog(
        [
            CatalogEntry(
                id="regression",
                name="Regression Dam",
                uri=str(cube),
                bbox=(-117.683, 33.952, -117.666, 33.966),
            )
        ],
        catalog,
    )
    got = _run(tmp_path, {"BOWSER_CATALOG_FILE": str(catalog)}, dataset="regression")
    _compare("catalog", got)


def test_catalog_matches_single():
    """The same cube must answer identically whether served alone or from a catalog."""
    single = json.loads((GOLDEN / "single.json").read_text())
    catalog = json.loads((GOLDEN / "catalog.json").read_text())
    differ = sorted(k for k in single if single[k] != catalog.get(k))
    assert not differ, f"catalog mode answers differently for: {differ}"
