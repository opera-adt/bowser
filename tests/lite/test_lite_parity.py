"""bowser-lite answers the UI like the full server: same JSON, (almost) the same tiles.

The regression scenarios (tests/regression/run_scenarios.py) and a set of map tiles
are replayed against both apps on the same cube, each in its own interpreter:

- JSON bodies must be equal (numbers within a relative 1e-6);
- tiles are decoded: per tile, at least 99% of pixels must agree (same
  transparency and, where opaque, RGB within one step per channel); over all tiles
  the transparency masks must agree on >= 99.99% of pixels.

The expected differences: ``/colorbar`` is a PNG (the full server sends WEBP),
and the two renderers permit the rounding differences tested below, so the
scenario's exact tile fingerprints are not compared between servers. Both
request paths explicitly select lossless PNG at the same pixel dimensions.

The real-cube test runs when ``BOWSER_LITE_REAL_CUBE`` (or the default path
below) points at a DISP GeoZarr; it only reads it.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parity  # noqa: E402

pytest.importorskip("rioxarray")
pytest.importorskip("titiler.core")
pytest.importorskip("PIL")

REGRESSION = Path(__file__).resolve().parents[1] / "regression"
REAL_CUBE = Path(
    os.environ.get(
        "BOWSER_LITE_REAL_CUBE",
        "/u/aurora-r0/govorcin/05_Applications/DAMS/Arkabutla/S1/results/arkabutla_asc_disp.zarr",
    )
)
#: The scenario entries that legitimately differ (see the module docstring).
LOOSE = {"colorbar", "tile_z14", "tile_z16"}


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("cube") / "regression.zarr")


def _replay_both(
    out: Path, env: dict, requests: list[dict], scenarios: bool = True
) -> tuple[Path, Path]:
    procs = [
        parity.run_replay(w, out / w, env, requests, scenarios)
        for w in ("full", "lite")
    ]
    for p in procs:
        parity.wait(p)
    return out / "full", out / "lite"


def _compare_scenarios(full: Path, lite: Path) -> None:
    a = json.loads((full / "scenarios.json").read_text())
    b = json.loads((lite / "scenarios.json").read_text())
    assert a.keys() == b.keys()
    diffs = [
        d for k in sorted(a) if k not in LOOSE for d in parity.json_diffs(a[k], b[k], k)
    ]
    assert not diffs, diffs[:20]
    assert b["colorbar"] == {"status": 200, "content_type": "image/png"}
    for k in ("tile_z14", "tile_z16"):
        assert (
            a[k]["status"] == b[k]["status"] == 200 and a[k]["shape"] == b[k]["shape"]
        )
        assert abs(a[k]["opaque_fraction"] - b[k]["opaque_fraction"]) <= 0.001


def _compare_requests(full: Path, lite: Path, requests: list[dict]) -> dict:
    """Assert JSON equality and tile agreement; return totals for the report."""
    a = json.loads((full / "requests.json").read_text())
    b = json.loads((lite / "requests.json").read_text())
    totals = {
        "tiles": 0,
        "pixels": 0,
        "alpha_mismatch": 0,
        "opaque": 0,
        "rgb_close": 0,
        "worst_tile_agreement": 1.0,
    }
    for spec in requests:
        name = spec["name"]
        assert a[name]["status"] == b[name]["status"], (name, a[name], b[name])
        if "tile" not in spec:
            diffs = parity.json_diffs(a[name].get("body"), b[name].get("body"), name)
            assert not diffs, diffs[:20]
            continue
        if a[name]["status"] != 200:
            continue
        t = parity.tile_agreement(
            (full / "tiles" / f"{name}.png").read_bytes(),
            (lite / "tiles" / f"{name}.png").read_bytes(),
        )
        agree = (
            t["pixels"] - t["alpha_mismatch"] - (t["opaque"] - t["rgb_close"])
        ) / t["pixels"]
        assert agree >= parity.MIN_RGB_AGREEMENT, (name, t)
        totals["tiles"] += 1
        totals["worst_tile_agreement"] = min(totals["worst_tile_agreement"], agree)
        for k in ("pixels", "alpha_mismatch", "opaque", "rgb_close"):
            totals[k] += t[k]
    assert totals["tiles"] > 0
    assert totals["alpha_mismatch"] / totals["pixels"] <= 1e-4, totals
    print(json.dumps(totals))
    return totals


@pytest.fixture(scope="module")
def regression_requests() -> list[dict]:
    bounds = [
        -117.68245924318603,
        33.95205822959155,
        -117.6667721606298,
        33.965130075206275,
    ]
    return parity.regression_requests(bounds)


def test_single_dataset_parity(cube, tmp_path, regression_requests):
    full, lite = _replay_both(
        tmp_path, {"BOWSER_STACK_DATA_FILE": str(cube)}, regression_requests
    )
    _compare_scenarios(full, lite)
    totals = _compare_requests(full, lite, regression_requests)
    assert totals["rgb_close"] / totals["opaque"] >= 0.999, totals


def test_catalog_parity(cube, tmp_path, regression_requests):
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
    os.environ["DATASET"] = "regression"
    try:
        full, lite = _replay_both(
            tmp_path, {"BOWSER_CATALOG_FILE": str(catalog)}, regression_requests[::7]
        )
    finally:
        os.environ.pop("DATASET")
    _compare_scenarios(full, lite)
    _compare_requests(full, lite, regression_requests[::7])


@pytest.mark.skipif(not REAL_CUBE.exists(), reason="real DISP cube not available")
def test_real_cube_parity(tmp_path):
    from bowser.lite.cube import open_cube
    from bowser.lite.meta import latlon_bounds

    bounds = list(latlon_bounds(open_cube(str(REAL_CUBE))))
    requests = parity.real_cube_requests(bounds)
    full, lite = _replay_both(
        tmp_path, {"BOWSER_STACK_DATA_FILE": str(REAL_CUBE)}, requests, scenarios=False
    )
    totals = _compare_requests(full, lite, requests)
    assert totals["rgb_close"] / totals["opaque"] >= 0.99, totals
