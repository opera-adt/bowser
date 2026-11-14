"""The colorbar route draws every colormap the tiler offers, in the tiler's colours.

rio-tiler colours tiles with maps matplotlib does not ship (its cmocean set), and
the page shows a colorbar for whichever the user picks.
"""

from __future__ import annotations

from io import BytesIO

import matplotlib

matplotlib.use("Agg")

import numpy as np  # noqa: E402
import pytest  # noqa: E402

pytest.importorskip("rio_tiler")
PIL = pytest.importorskip("PIL.Image")

from rio_tiler.colormap import cmap as tiler_colormaps  # noqa: E402

from bowser.utils import (  # noqa: E402
    _colorbar_cmap,
    desensitize_mpl_case,
    generate_colorbar,
    register_custom_colormaps,
)


@pytest.fixture(scope="module", autouse=True)
def _registered():
    register_custom_colormaps()
    desensitize_mpl_case()


def _ends(name: str) -> tuple[np.ndarray, np.ndarray]:
    """Return the RGB at the left and right end of the drawn bar."""
    image = np.asarray(PIL.open(BytesIO(generate_colorbar(name))).convert("RGB"))
    row = image[image.shape[0] // 2]
    return row[12].astype(int), row[-12].astype(int)


def test_every_colormap_the_tiler_offers_has_a_colorbar():
    names = tiler_colormaps.list()
    assert {"algae", "balance", "thermal_r", "viridis", "rdbu_r"} <= set(names)
    unknown_to_matplotlib = [n for n in names if n not in matplotlib.colormaps]
    assert len(unknown_to_matplotlib) >= 40  # the cmocean set and its reverses
    for name in names:
        assert _colorbar_cmap(name).N >= 8, name  # every one resolves
    assert all(_colorbar_cmap(n).N == 256 for n in unknown_to_matplotlib)
    # Drawing all of them is slow; the ones matplotlib lacks are the ones at stake.
    for name in ("algae", "balance_r", "thermal", "viridis"):
        assert generate_colorbar(name)[:4] == b"RIFF", name


@pytest.mark.parametrize("name", ["algae", "balance", "thermal_r"])
def test_a_tiler_only_colormap_is_drawn_in_the_tilers_colours(name):
    table = tiler_colormaps.get(name)
    left, right = _ends(name)
    # WEBP is lossy and the ends are sampled a little inside the bar.
    assert np.abs(left - np.array(table[3][:3])).max() <= 12
    assert np.abs(right - np.array(table[252][:3])).max() <= 12
    assert np.abs(left - right).max() > 30  # a gradient, not one colour


def test_an_unknown_colormap_is_an_error_not_a_default():
    with pytest.raises(ValueError, match="Unknown colormap 'nope'"):
        generate_colorbar("nope")
