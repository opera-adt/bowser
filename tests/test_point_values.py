"""Values at a point on the full server: read without dask, same as with it.

A pixel's time series crosses one chunk per time block. The full server reads it
from level 0 opened with ``chunks=None`` (``BowserState.point_dataset``), picking
the pixel before applying the layer masks; through dask the same read builds a
task graph per request. Both must give the same numbers.

``bowser.main`` reads its settings at import, so it runs in its own interpreter;
nothing here imports ``bowser.main``, ``bowser.state`` or ``bowser.config``.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REGRESSION = Path(__file__).resolve().parent / "regression"

pytest.importorskip("rioxarray")

SCRIPT = textwrap.dedent(
    """
    import itertools
    import numpy as np
    import bowser.main as m

    st = m._default_state
    direct = st.point_dataset()
    assert direct is not None and direct["displacement"].chunks is None
    assert st.dataset["displacement"].chunks is not None   # tiles stay on dask
    assert st.point_dataset() is direct                    # opened once

    from pyproj import Transformer
    ds = st.dataset
    to_ll = Transformer.from_crs(ds.rio.crs, "EPSG:4326", always_xy=True)
    w, s = to_ll.transform(float(ds.x.min()), float(ds.y.min()))
    e, n = to_ll.transform(float(ds.x.max()), float(ds.y.max()))
    rng = np.random.default_rng(0)
    # Inside the cube, on its edge and outside it (the nearest pixel answers).
    points = [(rng.uniform(w, e), rng.uniform(s, n)) for _ in range(12)]
    points += [(w, s), (e, n), (w - 0.01, n + 0.01)]
    masks = [
        [],
        [{"dataset": "recommended_mask", "threshold": 0.5, "mode": "min"}],
        [{"dataset": "phase_similarity", "threshold": 0.6, "mode": "max"}],
        [
            {"dataset": "temporal_coherence", "threshold": 0.4, "mode": "min"},
            {"dataset": "recommended_mask", "threshold": 0.5},
            {"dataset": "not_a_layer", "threshold": 0.5},
        ],
    ]
    layers = [v for v in ("displacement", "velocity", "recommended_mask",
                          "connected_component_labels") if v in st.dataset]
    assert len(layers) >= 3, list(st.dataset.data_vars)

    def read(without_dask):
        st._point_dataset = direct if without_dask else False
        out = []
        for name, (lon, lat), lm, t in itertools.product(
            layers, points, masks, (None, 0, 3, 99)
        ):
            out.append(m._get_point_values(name, lon, lat, lm, t))
        return out

    a, b = read(True), read(False)
    assert len(a) == len(layers) * len(points) * len(masks) * 4
    masked = 0
    for x, y in zip(a, b):
        assert x.dtype == y.dtype and x.shape == y.shape, (x.dtype, y.dtype)
        np.testing.assert_array_equal(x, y)
        masked += int(np.isnan(x.astype(float)).any())
    assert 0 < masked < len(a)   # the masks hide some points, not all
    print("OK", len(a), masked)
    """
)


def test_point_values_without_dask_equal_those_with_it(tmp_path):
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    cube = make_cube(tmp_path / "regression.zarr")
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env["BOWSER_STACK_DATA_FILE"] = str(cube)
    r = subprocess.run(
        [sys.executable, "-c", SCRIPT],
        env=env,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    assert r.stdout.strip().splitlines()[-1].startswith("OK")
