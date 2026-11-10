"""Extra display masks must never revive source nodata or discard band masks."""

import numpy as np
import pytest
from rio_tiler.models import ImageData

from bowser.readers import CustomReader


class _TileSource:
    def __init__(self, image):
        self.image = image

    def tile(self, *_args, **_kwargs):
        return self.image


@pytest.mark.parametrize("dtype", ["uint8", "int16", "float32", "float64"])
@pytest.mark.parametrize("bands", [1, 2])
@pytest.mark.parametrize("kind", ["none", "primary", "extra", "both"])
def test_display_masks_preserve_source_support(dtype, bands, kind):
    values = np.arange(bands * 16, dtype=dtype).reshape(bands, 4, 4)
    values[:, 2, 2] = 0  # legitimate zero measurements, not source nodata
    source_mask = np.zeros(values.shape, dtype=bool)
    source_mask[:, 0, 0] = True
    source_mask[0, 0, 1] = True  # retain partial band support for multiband inputs
    image = ImageData(np.ma.MaskedArray(values.copy(), mask=source_mask.copy()))

    primary = np.ones((1, 4, 4), dtype="float32")
    primary[:, 1, 1] = 0
    extra = np.ones((1, 4, 4), dtype="float32")
    extra[:, 1, 2] = 0
    reader = object.__new__(CustomReader)
    reader.dataset = _TileSource(image)
    reader.input = {"mask_min_value": 0.5}
    reader.mask = (
        _TileSource(ImageData(primary)) if kind in ("primary", "both") else None
    )
    reader._extra_masks = (
        [(_TileSource(ImageData(extra)), 0.5)] if kind in ("extra", "both") else []
    )
    result = reader.tile(0, 0, 0)
    expected = source_mask.copy()
    if kind in ("primary", "both"):
        expected[:, 1, 1] = True
    if kind in ("extra", "both"):
        expected[:, 1, 2] = True
    np.testing.assert_array_equal(np.ma.getmaskarray(result.array), expected)
    np.testing.assert_array_equal(result.data, values)
    np.testing.assert_array_equal(np.ma.getmaskarray(image.array), source_mask)
    assert not np.ma.getmaskarray(result.array)[:, 2, 2].any()
    assert result.array.dtype == values.dtype
