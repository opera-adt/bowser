"""``/buffer_timeseries`` on a 2-D layer (no time axis), on the full and lite servers.

A 2-D layer is a one-step series without a label, as for ``/chart_point`` and
``/multi_point``: 200, ``labels == []``, so ``median`` and ``samples`` are empty,
and ``n_pixels`` counts the pixels of the circle. A point or circle reference
must not change that (it was a 500 with a circle reference: the 2-D window was
pooled per row, so the reference and the buffer had different lengths).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parity  # noqa: E402

pytest.importorskip("rioxarray")
pytest.importorskip("titiler.core")

REGRESSION = Path(__file__).resolve().parents[1] / "regression"
sys.path.insert(0, str(REGRESSION))
from cube import CENTER_LONLAT, REF_LONLAT  # noqa: E402

BUFFER_M = 90.0
#: Reference variants: none, one pixel, a circle (of another radius than the
#: buffer, so its window has another number of rows).
REFS: dict[str, dict[str, float]] = {
    "noref": {},
    "point": {"ref_lon": REF_LONLAT[0], "ref_lat": REF_LONLAT[1], "ref_buffer_m": 0},
    "circle": {"ref_lon": REF_LONLAT[0], "ref_lat": REF_LONLAT[1], "ref_buffer_m": 150},
}


def _requests() -> list[dict]:
    return [
        {
            "name": f"{layer}_{ref}",
            "method": "POST",
            "path": "/buffer_timeseries",
            "json": {
                "lon": CENTER_LONLAT[0],
                "lat": CENTER_LONLAT[1],
                "dataset_name": layer,
                "buffer_m": BUFFER_M,
                "n_samples": 5,
                "layer_masks": [],
                **body,
            },
        }
        for layer in ("velocity", "displacement")
        for ref, body in REFS.items()
    ]


@pytest.fixture(scope="module")
def responses(tmp_path_factory) -> dict[str, dict]:
    from cube import make_cube

    tmp = tmp_path_factory.mktemp("buffer2d")
    cube = make_cube(tmp / "regression.zarr")
    env = {"BOWSER_STACK_DATA_FILE": str(cube)}
    procs = {
        w: parity.run_replay(w, tmp / w, env, _requests(), scenarios=False)
        for w in ("full", "lite")
    }
    for p in procs.values():
        parity.wait(p)
    return {w: json.loads((tmp / w / "requests.json").read_text()) for w in procs}


@pytest.mark.parametrize("server", ["full", "lite"])
@pytest.mark.parametrize("ref", list(REFS))
def test_2d_layer_is_a_one_step_series_without_labels(responses, server, ref):
    got = responses[server]
    r = got[f"velocity_{ref}"]
    assert r["status"] == 200, r
    body = r["body"]
    assert body["labels"] == body["median"] == []
    assert body["samples"] == [[]] * 5  # one empty series per sampled pixel
    # Every pixel of the circle, as for the 3-D layer at the same place (the
    # regression cube's displacement has no nodata there).
    assert body["n_pixels"] == got["displacement_noref"]["body"]["n_pixels"]
    assert body["n_pixels"] > 20


@pytest.mark.parametrize("server", ["full", "lite"])
@pytest.mark.parametrize("ref", list(REFS))
def test_3d_layer_is_unchanged(responses, server, ref):
    body = responses[server][f"displacement_{ref}"]["body"]
    assert len(body["labels"]) == len(body["median"]) == 6
    assert len(body["samples"]) == 5


@pytest.mark.parametrize("name", [r["name"] for r in _requests()])
def test_full_and_lite_agree(responses, name):
    a, b = responses["full"][name], responses["lite"][name]
    assert a["status"] == b["status"]
    assert not parity.json_diffs(a.get("body"), b.get("body"), name)
