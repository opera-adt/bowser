"""Display backgrounds preserve measurements and use bounded inputs."""

import base64
import json
from io import BytesIO
from types import SimpleNamespace

import numpy as np
import pytest
import rioxarray  # noqa: F401
import xarray as xr
from PIL import Image

from bowser.animation import AnimationRequest, render
from bowser.animation_background import AnimationBackground, background_image


def png(size=(64, 64), color=(0, 160, 0, 255)):
    buf = BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def source():
    a = np.arange(32, dtype="float32").reshape(2, 4, 4)
    a[:, 0, 0] = np.nan
    a[:, 1, 1] = 0
    return xr.Dataset(
        {"d": (("time", "y", "x"), a, {"units": "meters"})},
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": [0.5, 1.5, 2.5, 3.5],
            "y": [3.5, 2.5, 1.5, 0.5],
        },
    ).rio.write_crs(3857)


def test_bounded_background_projection_and_invalid_images():
    da = source().d.isel(time=0)
    spec = AnimationBackground(
        png=png(), bounds=[0, 0, 4, 4], attribution="Synthetic tiles"
    )
    out = background_image(spec, da, (40, 40))
    assert out.size == (40, 40)
    assert out.getpixel((20, 20)) == (0, 160, 0, 255)
    for value in [
        "data:image/jpeg;base64,xxx",
        png((1025, 2)),
        "data:image/png;base64,broken",
    ]:
        with pytest.raises(ValueError, match="bounded background"):
            background_image(spec.model_copy(update={"png": value}), da, (40, 40))
    with pytest.raises(ValueError):
        AnimationBackground(png=png(), bounds=[4, 0, 0, 4], attribution="tiles")
    with pytest.raises(ValueError):
        AnimationBackground(png=png(), bounds=[0, 0, 4, 4], attribution="bad\ncredit")


@pytest.mark.parametrize("opacity", [0, 0.5, 1])
def test_actual_gif_keeps_native_support_and_reference_independent_of_context(opacity):
    ds = source()
    before = ds.d.values.copy()
    target = SimpleNamespace(mode="md", dataset=ds, levels=[])
    args = {
        "variable": "d",
        "start_index": 0,
        "end_index": 1,
        "vmin": 0,
        "vmax": 31,
        "width": 320,
        "bounds": [0, 0, 0.00003593, 0.00003593],
    }

    def prepare(index, _masks, plan):
        return plan.dataset.d.isel(time=index).copy(), "unused"

    plain, _ = render(AnimationRequest(**args), target, prepare)
    spec = {"png": png(), "bounds": [0, 0, 4, 4], "attribution": "Synthetic tiles"}
    data, _ = render(
        AnimationRequest(
            **args, include_context=True, background=spec, raster_opacity=opacity
        ),
        target,
        prepare,
    )
    with Image.open(BytesIO(data)) as gif, Image.open(BytesIO(plain)) as original:
        metadata = json.loads(gif.info["comment"])
        old = json.loads(original.info["comment"])
        assert (
            metadata["valid_display_pixels"] == old["valid_display_pixels"] == [15, 15]
        )
        assert metadata["reference"] == old["reference"]
        assert metadata["background"]["attribution"] == "Synthetic tiles"
        assert "data:image" not in gif.info["comment"].decode()
        assert gif.height == original.height + 80
        # Source nodata reveals background; it is never converted to zero data.
        assert gif.convert("RGB").getpixel((20, 44)) == (0, 160, 0)
        if opacity == 0:
            assert gif.convert("RGB").getpixel((200, 224)) == (0, 160, 0)
    np.testing.assert_equal(ds.d.values, before)


def test_context_is_explicit_and_text_is_bounded():
    args = {"variable": "d", "start_index": 0, "end_index": 1, "vmin": 0, "vmax": 1}
    with pytest.raises(ValueError):
        AnimationRequest(**args, include_context=True)
    with pytest.raises(ValueError):
        AnimationRequest(
            **args, labels=[{"text": "x", "lon": 0, "lat": 0, "color": "bad"}]
        )
    with pytest.raises(ValueError):
        AnimationRequest(**args, labels=[{"text": "x", "lon": 0, "lat": 0}] * 21)


def test_context_labels_and_native_point_histories_work_together():
    ds = source()
    target = SimpleNamespace(mode="md", dataset=ds, levels=[])
    request = AnimationRequest(
        variable="d",
        start_index=0,
        end_index=1,
        vmin=0,
        vmax=31,
        width=320,
        bounds=[0, 0, 0.00003593, 0.00003593],
        include_context=True,
        background={
            "png": png(),
            "bounds": [0, 0, 4, 4],
            "attribution": "Synthetic tiles",
        },
        labels=[
            {
                "text": "Known area",
                "lon": 0.00001347,
                "lat": 0.00001347,
                "color": "#ffffff",
            }
        ],
        points=[
            {
                "id": "p",
                "name": "Known pixel",
                "lon": 0.00001347,
                "lat": 0.00001347,
                "color": "#2468aa",
            }
        ],
    )

    def prepare(index, _masks, plan):
        return plan.dataset.d.isel(time=index).copy(), "unused"

    data, _ = render(request, target, prepare)
    with Image.open(BytesIO(data)) as gif:
        metadata = json.loads(gif.info["comment"])
        assert metadata["point_histories"][0]["values"] == [9, 25]
        assert metadata["text_labels"][0]["text"] == "Known area"
        assert metadata["plot"] is not None
