"""Draw the desktop app icons from the Bowser mark (src/assets/bowser-mark.svg).

    python packaging/make_icons.py

Writes packaging/bowser.icns (macOS) and packaging/bowser.ico (Windows), which
packaging/bowser.spec picks up. Needs only Pillow: the mark is a few shapes, so
it is drawn here instead of rendering the SVG. Keep the two in step.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
TOP, BOTTOM = (0x5B, 0xC0, 0xBE), (0x0A, 0x7D, 0x7B)  # the mark's gradient
SS = 4  # supersampling, for smooth edges


def mark(size: int) -> Image.Image:
    """Draw the mark full-bleed on a ``size`` square, in the SVG's 32-unit grid."""
    n = size * SS
    u = n / 32  # one SVG unit

    # Diagonal gradient, clipped to the rounded tile (rx = 8).
    g = 256
    small = Image.new("RGB", (g, g))
    px = small.load()
    for y in range(g):
        for x in range(g):
            t = (x + y) / (2 * (g - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    grad = small.resize((n, n), Image.BILINEAR)
    tile = Image.new("L", (n, n), 0)
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, n - 1, n - 1), radius=8 * u, fill=255)
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    img.paste(grad, (0, 0), tile)

    def line(points, width, alpha=255):
        layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        pts = [(x * u, y * u) for x, y in points]
        w = round(width * u)
        d.line(pts, fill=(255, 255, 255, alpha), width=w, joint="curve")
        for x, y in (pts[0], pts[-1]):  # round caps
            d.ellipse(
                (x - w / 2, y - w / 2, x + w / 2, y + w / 2),
                fill=(255, 255, 255, alpha),
            )
        img.alpha_composite(layer)

    line([(6, 24.5), (26, 24.5)], 1.4, alpha=round(0.55 * 255))  # baseline
    trace = [(6.5, 9.5), (11, 11), (15, 15.2), (19, 14), (22.4, 19.2), (25.5, 20.5)]
    line(trace, 2.4)
    d = ImageDraw.Draw(img)
    for cx, cy, r in ((11, 11, 1.5), (19, 14, 1.5), (25.5, 20.5, 1.8)):
        d.ellipse(
            ((cx - r) * u, (cy - r) * u, (cx + r) * u, (cy + r) * u), fill="white"
        )
    return img.resize((size, size), Image.LANCZOS)


def mac_icon(size: int = 1024) -> Image.Image:
    """Return the mark on Apple's icon grid: an 824 px tile centred in 1024."""
    tile = round(size * 824 / 1024)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(mark(tile), ((size - tile) // 2, (size - tile) // 2))
    return canvas


def main() -> None:
    """Write bowser.icns and bowser.ico next to this script."""
    mac_icon().save(HERE / "bowser.icns")
    big = mark(256)
    big.save(
        HERE / "bowser.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    )
    print("wrote", HERE / "bowser.icns", HERE / "bowser.ico")


if __name__ == "__main__":
    main()
