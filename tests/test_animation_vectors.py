"""Outline geometry validation, clipping and display-only behavior."""

from copy import deepcopy

import numpy as np
import pytest

from bowser.animation import AnimationRequest
from bowser.animation_vectors import AnimationOutline, draw_outlines, prepare_outlines


def _grid():
    import rioxarray  # noqa: F401
    import xarray as xr

    return xr.DataArray(
        np.zeros((4, 4)),
        dims=("y", "x"),
        coords={"x": np.arange(4) + 0.5, "y": 3.5 - np.arange(4)},
    ).rio.write_crs(4326)


def test_holes_are_outlined_without_fills_or_false_viewport_edges():
    from PIL import Image

    source = _grid()
    original = source.values.copy()
    geometry = {
        "type": "Polygon",
        "coordinates": [
            [[-1, -1], [5, -1], [5, 5], [-1, 5], [-1, -1]],
            [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
        ],
    }
    before = deepcopy(geometry)
    outline = AnimationOutline(geometries=[geometry])
    paths = prepare_outlines(source, [outline], (400, 400))
    assert len(paths) == 1  # outer real boundary is entirely outside the crop
    image = Image.new("P", (400, 400), 7)
    draw_outlines(image, paths)
    assert image.getpixel((100, 100)) == 255
    assert image.getpixel((200, 200)) == 7  # hole interior is not filled
    assert image.getpixel((0, 0)) == 7  # no invented crop-box outline
    np.testing.assert_array_equal(source.values, original)
    assert geometry == before


def test_supported_geometries_and_ignored_z_coordinates():
    source = _grid()
    examples = [
        {"type": "Point", "coordinates": [1, 2, 99]},
        {"type": "MultiPoint", "coordinates": [[1, 2], [2, 3]]},
        {"type": "LineString", "coordinates": [[1, 1], [3, 3]]},
        {
            "type": "MultiLineString",
            "coordinates": [[[1, 1], [3, 3]], [[1, 3], [3, 1]]],
        },
        {"type": "Polygon", "coordinates": [[[1, 1], [3, 1], [3, 3], [1, 1]]]},
        {"type": "MultiPolygon", "coordinates": [[[[1, 1], [3, 1], [3, 3], [1, 1]]]]},
    ]
    for geometry in examples:
        outline = AnimationOutline(geometries=[geometry])
        assert prepare_outlines(source, [outline], (400, 400))
    assert AnimationOutline(geometries=[examples[0]]).geometries[0]["coordinates"] == [
        1,
        2,
    ]


def test_vertex_budget_and_malformed_shapes_reject_explicitly():
    for geometry in [
        {"type": [], "coordinates": [0, 0]},
        {"type": "LineString", "coordinates": [[0, 0]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1]]]},
        {"type": "Point", "coordinates": [float("nan"), 0]},
    ]:
        with pytest.raises(ValueError):
            AnimationOutline(geometries=[geometry])
    coords = [[i % 2, i % 2] for i in range(3000)]
    outline = {"geometries": [{"type": "LineString", "coordinates": coords}]}
    with pytest.raises(ValueError, match="5000"):
        AnimationRequest(
            variable="displacement",
            start_index=0,
            end_index=1,
            vmin=0,
            vmax=1,
            outlines=[outline, outline],
        )


def test_projection_does_not_use_deprecated_ops_transform(monkeypatch):
    """Shapely 2.2 emits this warning, which strict CI correctly treats as an error."""
    import warnings

    import shapely.ops

    original = shapely.ops.transform

    def deprecated(*args, **kwargs):
        warnings.warn(
            "shapely.ops.transform is deprecated", DeprecationWarning, stacklevel=2
        )
        return original(*args, **kwargs)

    monkeypatch.setattr(shapely.ops, "transform", deprecated)
    outline = AnimationOutline(
        geometries=[{"type": "LineString", "coordinates": [[1, 1], [3, 3]]}]
    )
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        assert prepare_outlines(_grid(), [outline], (400, 400))
