"""Simultaneous first spatial queries must not corrupt shared coordinate indexes."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import numpy as np
import pytest
import xarray as xr
from pandas.errors import InvalidIndexError

from bowser.lite.cube import _normalise


def test_concurrent_first_nearest_queries_preserve_unique_coordinates():
    # Long cold indexes release the GIL while pandas builds its hash engine.
    # Coordinates alone suffice: this test never reads measurement pixels.
    for _ in range(12):
        original = xr.Dataset(
            coords={
                "x": 500005.0 + 10 * np.arange(100000),
                "y": 4000005.0 - 10 * np.arange(100000),
            }
        )
        dataset = _normalise(original)
        gate = Barrier(8)

        def query(_):
            gate.wait(timeout=10)
            selected = dataset.sel(x=500016.0, y=3999984.0, method="nearest")
            return float(selected.x), float(selected.y)

        with ThreadPoolExecutor(max_workers=8) as pool:
            values = list(pool.map(query, range(8)))
        assert values == [(500015.0, 3999985.0)] * 8
        xr.testing.assert_identical(dataset, original)


def test_actual_duplicate_coordinates_are_not_repaired_or_silently_accepted():
    source = xr.Dataset(coords={"x": [1.0, 1.0, 2.0], "y": [3.0, 2.0, 1.0]})
    normalized = _normalise(source)
    xr.testing.assert_identical(normalized, source)
    with pytest.raises(InvalidIndexError):
        normalized.sel(x=1.1, method="nearest")
