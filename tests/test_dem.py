"""DEM layers: recognising an elevation model, and its hillshade / relief tiles.

``bowser.dem`` and ``bowser.titiler`` read no settings, so they are imported in the
tests. The conversion to COG is in test_convert.py, the routes in test_data_api.py.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio")
pytest.importorskip("titiler.core")

from rasterio.transform import from_origin  # noqa: E402

NODATA = -9999.0


def _hills(n: int) -> np.ndarray:
    """Return an ``n``×``n`` float32 terrain of smooth hills, 60–140 m, NaN-free."""
    y, x = np.mgrid[0:n, 0:n] / n
    z = 100 + 25 * np.sin(6 * x) * np.cos(5 * y) + 15 * np.cos(11 * x + 3 * y)
    return z.astype("float32")


def _write(path: Path, z: np.ndarray, **opts) -> Path:
    """Write ``z`` as a GeoTIFF near -90.13, 34.75 (striped unless ``opts`` say)."""
    profile = {
        "driver": "GTiff",
        "width": z.shape[1],
        "height": z.shape[0],
        "count": 1,
        "dtype": z.dtype.name,
        "crs": "EPSG:4326",
        "transform": from_origin(-90.14, 34.76, 1e-5, 1e-5),
        "nodata": NODATA,
        **opts,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(z, 1)
    return path


# --- recognising a DEM ----------------------------------------------------------


def test_looks_like_dem(tmp_path):
    from bowser import dem

    assert dem.looks_like_dem(_write(tmp_path / "a.tif", _hills(300)))
    rng = np.random.default_rng(0)
    velocity = rng.normal(0, 5, (300, 300)).astype("float32")  # mm/yr around zero
    assert not dem.looks_like_dem(_write(tmp_path / "v.tif", velocity))
    # ...unless its name says it is one.
    assert dem.looks_like_dem(_write(tmp_path / "v.tif", velocity), "site_dtm.tif")
    classes = np.full((50, 50), 3, dtype="uint8")
    assert not dem.looks_like_dem(_write(tmp_path / "c.tif", classes, nodata=0))


# --- rendering ---------------------------------------------------------------------


def _image(z: np.ndarray, res: float, mask: np.ndarray | None = None):
    from rasterio.crs import CRS
    from rio_tiler.models import ImageData

    n = z.shape[0]
    arr = np.ma.MaskedArray(z[None].astype("float32"), mask=mask)
    return ImageData(arr, crs=CRS.from_epsg(32615), bounds=(0, 0, n * res, n * res))


def test_hillshade_is_the_same_at_every_zoom():
    """Slopes are per metre: a 10 % ramp shades alike at 1 m and 8 m pixels."""
    from bowser.titiler import DemRender

    algo = DemRender(style="hillshade", buffer=1)
    shades = []
    for res in (1.0, 8.0):
        x = np.arange(32) * res
        ramp = np.tile(0.1 * x, (32, 1))  # rises 10 % to the east
        shades.append(int(np.ma.median(algo(_image(ramp, res)).array[0])))
    assert shades[0] == shades[1]
    flat = int(np.ma.median(algo(_image(np.full((32, 32), 50.0), 1.0)).array[0]))
    # Facing the sun (west, light from the north-west) is brighter than flat ground.
    assert shades[0] > flat
    # Exaggeration steepens it further.
    steeper = DemRender(style="hillshade", buffer=1, z_exaggeration=3)
    x = np.arange(32.0)
    assert (
        int(np.ma.median(steeper(_image(np.tile(0.1 * x, (32, 1)), 1.0)).array[0]))
        > shades[0]
    )


def test_styles_and_nodata():
    from bowser.titiler import DemRender

    z = _hills(34).astype("float64")
    mask = np.zeros((1, 34, 34), bool)
    mask[0, 10:14, 10:14] = True
    img = _image(z, 1.0, mask)
    hs = DemRender(style="hillshade", buffer=1)(img)
    relief = DemRender(style="relief", vmin=60, vmax=140, buffer=1)(img)
    both = DemRender(style="both", vmin=60, vmax=140, buffer=1)(img)
    assert hs.count == 1 and relief.count == 3 and both.count == 3
    for out in (hs, relief, both):
        assert out.width == 32 and out.height == 32  # the buffer is cropped
        assert out.array.mask[0, 10, 10]  # nodata stays transparent
        assert not out.array.mask[0, 20, 20]
    # The relief follows the colormap: the lowest and highest ground differ in colour.
    inner = z[1:-1, 1:-1]
    lo, hi = (
        np.unravel_index(inner.argmin(), inner.shape),
        np.unravel_index(inner.argmax(), inner.shape),
    )
    assert not np.array_equal(
        relief.array[:, lo[0], lo[1]], relief.array[:, hi[0], hi[1]]
    )
    # Shading changes the relief's colours.
    assert not np.array_equal(both.array, relief.array)
