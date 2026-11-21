"""Bounded display backgrounds without URLs or source properties."""

import base64
from io import BytesIO

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator


class AnimationBackground(BaseModel):
    """A north-up Web Mercator PNG captured from the currently visible background."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    png: str = Field(min_length=1, max_length=6_000_000)
    bounds: list[float] = Field(min_length=4, max_length=4)
    attribution: str = Field(min_length=1, max_length=280)

    @model_validator(mode="after")
    def ordered(self):
        """Reject wrapping/degenerate extents and control characters."""
        w, s, e, n = self.bounds
        if not (
            -20_037_509 <= w < e <= 20_037_509 and -20_037_509 <= s < n <= 20_037_509
        ):
            raise ValueError("Background bounds must be non-wrapping Web Mercator")
        if any(ord(c) < 32 for c in self.attribution):
            raise ValueError("Background attribution must be plain single-line text")
        return self


def background_image(spec, da, size):
    """Warp only a bounded RGBA display image onto the chosen raster grid."""
    from PIL import Image
    from rasterio.enums import Resampling
    from rasterio.transform import Affine, from_bounds
    from rasterio.warp import reproject

    try:
        prefix = "data:image/png;base64,"
        if not spec.png.startswith(prefix):
            raise ValueError("Background must be a PNG data URL")
        raw = base64.b64decode(spec.png[len(prefix) :], validate=True)
        image = Image.open(BytesIO(raw))
        if (
            image.format != "PNG"
            or not 1 <= image.width <= 1024
            or not 1 <= image.height <= 1024
        ):
            raise ValueError("Background PNG must be at most 1024 pixels per side")
        image.load()
        source = np.asarray(image.convert("RGBA"))
    except Exception as exc:
        raise ValueError("Invalid bounded background PNG") from exc
    destination = np.zeros((size[1], size[0], 4), dtype="uint8")
    transform = da.rio.transform() * Affine.scale(
        da.sizes["x"] / size[0], da.sizes["y"] / size[1]
    )
    for band in range(4):
        reproject(
            source[:, :, band],
            destination[:, :, band],
            src_crs="EPSG:3857",
            src_transform=from_bounds(*spec.bounds, image.width, image.height),
            dst_crs=da.rio.crs,
            dst_transform=transform,
            resampling=Resampling.nearest,
        )
    return Image.fromarray(destination)


def context_palette(background, palette, opacity):
    """One GIF palette shared by every frame, including reserved annotation colors."""
    from PIL import Image

    bg = np.asarray(background.convert("RGB").resize((128, 128)))
    reduced = background.convert("RGB").resize((128, 128)).quantize(colors=16)
    table = np.asarray(reduced.getpalette(), dtype="uint8").reshape(-1, 3)
    representatives = table[[index for _, index in reduced.getcolors()]]
    blends = (
        np.rint(
            opacity * palette[None, :, :] + (1 - opacity) * representatives[:, None, :]
        )
        .astype("uint8")
        .reshape(-1, 3)
    )
    samples = np.vstack((bg.reshape(-1, 3), np.tile(blends, (8, 1))))
    image = Image.fromarray(samples.reshape(-1, 1, 3).astype("uint8")).quantize(
        colors=248
    )
    rgb = np.array(image.getpalette(), dtype="uint8").reshape(-1, 3)
    result = palette.copy()
    result[:248] = rgb[0]
    result[: min(248, len(rgb))] = rgb[:248]
    return result


def composite_background(image, valid, background, opacity, palette):
    """Place valid raster colors over context; nodata never becomes a measurement."""
    from PIL import Image

    alpha = Image.fromarray(
        (np.asarray(valid, dtype="uint8") * round(opacity * 255))
    ).resize(image.size, Image.Resampling.NEAREST)
    foreground = image.convert("RGBA")
    foreground.putalpha(alpha)
    base = Image.alpha_composite(
        Image.new("RGBA", background.size, "white"), background
    )
    rgb = Image.alpha_composite(base, foreground).convert("RGB")
    colors = Image.new("P", (1, 1))
    colors.putpalette(palette.ravel().tolist())
    return rgb.quantize(palette=colors, dither=Image.Dither.NONE)


class AnimationLabel(BaseModel):
    """A bounded user-selected text label, with no HTML or feature attributes."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    text: str = Field(min_length=1, max_length=80)
    font_size: int = Field(default=12, ge=8, le=72, strict=True)
    lon: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)
    color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")


def annotation_font(size):
    """Use the existing bundled Unicode font for labels and source attribution."""
    from pathlib import Path

    import matplotlib
    from PIL import ImageFont

    path = Path(matplotlib.get_data_path()) / "fonts/ttf/DejaVuSans.ttf"
    return ImageFont.truetype(str(path), size)


def draw_labels(image, da, labels, size, palette):
    """Place fixed-size labels on the raster; geographic coordinates stay explicit."""
    from PIL import ImageDraw
    from pyproj import Transformer

    transform = Transformer.from_crs(4326, da.rio.crs, always_xy=True)
    draw = ImageDraw.Draw(image)
    for label in labels:
        x, y = transform.transform(label.lon, label.lat)
        col, row = ~da.rio.transform() * (x, y)
        px, py = col * size[0] / da.sizes["x"], row * size[1] / da.sizes["y"]
        if not (0 <= px < size[0] and 0 <= py < size[1]):
            continue
        color = np.array(list(bytes.fromhex(label.color[1:])), dtype=float)
        index = int(np.argmin(((palette.astype(float) - color) ** 2).sum(axis=1)))
        font = annotation_font(label.font_size)
        draw.text(
            (px, py),
            label.text,
            font=font,
            fill=index,
            stroke_width=1,
            stroke_fill=254 if color.mean() < 128 else 255,
        )
