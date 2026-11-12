"""Exercise upper-bound display masks without reviving invalid observations."""

import numpy as np
import pytest
from rio_tiler.errors import TileOutsideBounds
from rio_tiler.models import ImageData

from bowser.readers import CustomReader


class TileSource:
    def __init__(self, image=None, error=None):
        self.image = image
        self.error = error

    def tile(self, *_args, **_kwargs):
        if self.error:
            raise self.error
        return self.image


@pytest.mark.parametrize("mode", ["min", "max"])
@pytest.mark.parametrize("threshold", [-1.0, 0.0, 0.5])
@pytest.mark.parametrize("dtype", ["float32", "int16"])
@pytest.mark.parametrize("bands", [1, 2])
def test_signed_thresholds_preserve_source_and_mask_support(
    mode, threshold, dtype, bands
):
    data = np.arange(bands * 12, dtype=dtype).reshape(bands, 3, 4)
    data[:, 0, 0] = 0  # a valid stationary measurement
    source_invalid = np.zeros(data.shape, bool)
    source_invalid[0, 2, 3] = True
    if bands == 2:
        source_invalid[1, 2, 2] = True
    source = ImageData(np.ma.array(data, mask=source_invalid))
    quality = np.array(
        [[-2, -1, 0, 0.5], [1, np.nan, np.inf, -np.inf], [0, 0, 0, 0]], dtype="float32"
    )
    mask_invalid = np.zeros((1, 3, 4), bool)
    mask_invalid[0, 2, 0] = True
    mask = ImageData(np.ma.array(quality[None], mask=mask_invalid))
    reader = object.__new__(CustomReader)
    reader.dataset = TileSource(source)
    reader.mask = None
    reader.input = {"mask_min_value": 0.5}
    reader._extra_masks = [(TileSource(mask), threshold, mode)]
    actual = reader.tile(0, 0, 0)
    expected_keep = (quality > threshold) if mode == "min" else (quality <= threshold)
    expected_invalid = (
        source_invalid
        | mask_invalid
        | ~np.isfinite(quality)[None]
        | ~expected_keep[None]
    )
    np.testing.assert_array_equal(np.ma.getmaskarray(actual.array), expected_invalid)
    np.testing.assert_array_equal(actual.data, data)
    np.testing.assert_array_equal(np.ma.getmaskarray(source.array), source_invalid)


@pytest.mark.parametrize("mode", ["min", "max"])
def test_mask_outside_coverage_cannot_be_skipped(mode):
    reader = object.__new__(CustomReader)
    reader.dataset = TileSource(ImageData(np.ones((1, 2, 2))))
    reader.mask = None
    reader.input = {"mask_min_value": 0.5}
    reader._extra_masks = [
        (TileSource(error=TileOutsideBounds("Outside mask")), 0.5, mode)
    ]
    assert np.ma.getmaskarray(reader.tile(0, 0, 0).array).all()


def test_broken_mask_cannot_silently_return_unmasked_pixels():
    reader = object.__new__(CustomReader)
    reader.dataset = TileSource(ImageData(np.ones((1, 2, 2))))
    reader.mask = None
    reader.input = {"mask_min_value": 0.5}
    reader._extra_masks = [(TileSource(error=OSError("Unreadable mask")), 0.5)]
    with pytest.raises(OSError, match="Unreadable mask"):
        reader.tile(0, 0, 0)
