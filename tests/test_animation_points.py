"""Point plot display invariants independent of raster IO."""

import numpy as np
import pytest

from bowser.animation_points import add_plots, elapsed_times


def test_elapsed_dates_are_not_equal_spaced_frames():
    np.testing.assert_allclose(
        elapsed_times(["2026-01-01", "2026-01-02", "2026-01-05"]), [0, 0.25, 1]
    )
    for labels in (
        ["first", "last"],
        ["2026-01-02", "2026-01-01"],
        ["2026-01-01", "2026-01-01"],
    ):
        with pytest.raises(ValueError):
            elapsed_times(labels)


def test_plot_leaves_missing_epochs_as_gaps_and_moves_the_cursor():
    from PIL import Image

    palette = np.zeros((256, 3), dtype="uint8")
    palette[248] = [36, 104, 170]
    palette[253] = [128, 128, 128]
    palette[254] = [255, 255, 255]
    frames = []
    for _ in range(3):
        frame = Image.new("P", (320, 80), 254)
        frame.putpalette(palette.ravel().tolist())
        frames.append(frame)
    records = [{"name": "Known point", "values": [0, None, 10]}]
    images, metadata = add_plots(
        frames,
        records,
        [0, 0.25, 1],
        ["2026-01-01", "2026-01-02", "2026-01-05"],
        "meters",
    )
    assert metadata["y_limits"] == [-1, 11]
    # There must be no line through the missing second observation.
    assert images[0].getpixel((113, 194)) != 248
    # The second date is one quarter along the real elapsed-time axis.
    assert images[1].getpixel((113, 160)) == 253
    # The active last sample is highlighted without inventing a missing sample.
    assert images[2].getpixel((304, 118)) == 248
    assert images[0].getpixel((304, 118)) != 248
    assert records[0]["values"] == [0, None, 10]
