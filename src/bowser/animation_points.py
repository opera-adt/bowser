"""Bounded native-pixel histories and an optional synchronized GIF plot."""

from datetime import datetime, timezone

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

PLOT_HEIGHT = 240


class AnimationPoint(BaseModel):
    """One explicitly selected native-pixel plot location."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(default="Point", max_length=80)
    lon: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)
    color: str = Field(default="#2468aa", pattern=r"^#[0-9a-fA-F]{6}$")


def elapsed_times(labels):
    """Use actual elapsed time; never turn arbitrary saved labels into dates."""
    try:
        dates = [
            datetime.fromisoformat(label.replace("Z", "+00:00")) for label in labels
        ]
        seconds = np.array(
            [
                (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()
                for d in dates
            ]
        )
    except (ValueError, OverflowError, OSError) as exc:
        raise ValueError("Point plots require explicit ISO acquisition dates") from exc
    if not np.all(np.diff(seconds) > 0):
        raise ValueError("Point plot dates must be unique and increasing")
    return (seconds - seconds[0]) / (seconds[-1] - seconds[0])


def locate_points(da, points):
    """Containing native pixel; no interpolation, clamping or averaging."""
    return locate_grid_points(
        (da.rio.crs, da.rio.transform(), da.sizes["x"], da.sizes["y"]), points
    )


def locate_grid_points(grid, points):
    """Locate native pixel centers from grid metadata without reading pixels."""
    from pyproj import Transformer

    crs, transform, width, height = grid
    transformer = Transformer.from_crs(4326, crs, always_xy=True)
    inverse = ~transform
    records = []
    for point in points:
        x, y = transformer.transform(point.lon, point.lat)
        col, row = inverse * (x, y)
        if not (0 <= row < height and 0 <= col < width):
            raise ValueError("Animation point is outside the native source grid")
        records.append(
            {**point.model_dump(), "row": int(row), "col": int(col), "values": []}
        )
    return records


def sample_points(da, records):
    """Retain masked/referenced values, with missing measurements as null."""
    for record in records:
        value = float(da.isel(y=record["row"], x=record["col"]).values.item())
        record["values"].append(value if np.isfinite(value) else None)


def draw_locations(frame, da, records, native_transform, raster_size):
    """Mark sampled pixel centers inside the exported crop; others remain plot-only."""
    from PIL import ImageDraw

    draw = ImageDraw.Draw(frame)
    inverse = ~da.rio.transform()
    for i, record in enumerate(records):
        x, y = native_transform * (record["col"] + 0.5, record["row"] + 0.5)
        col, row = inverse * (x, y)
        if 0 <= row < da.sizes["y"] and 0 <= col < da.sizes["x"]:
            cx = round(col / da.sizes["x"] * raster_size[0])
            cy = 24 + round(row / da.sizes["y"] * raster_size[1])
            draw.ellipse((cx - 4, cy - 4, cx + 4, cy + 4), fill=248 + i, outline=255)
            draw.text((cx + 5, cy - 5), str(i + 1), fill=255)


def add_plots(frames, records, times, labels, units):
    """Draw fixed axes and all saved samples; move only the acquisition cursor."""
    from PIL import Image, ImageDraw

    finite = [v for record in records for v in record["values"] if v is not None]
    if finite:
        low, high = min(finite), max(finite)
        padding = (high - low) * 0.1 if high != low else max(abs(high) * 0.1, 0.001)
        low, high = low - padding, high + padding
    else:
        low, high = -1, 1
    result = []
    for index, frame in enumerate(frames):
        width, start = frame.size
        image = Image.new("P", (width, start + PLOT_HEIGHT), 254)
        image.putpalette(frame.getpalette())
        image.paste(frame, (0, 0))
        draw = ImageDraw.Draw(image)
        left, right, top, bottom = 48, width - 12, start + 28, start + 150

        def x(t):
            return round(left + float(t) * (right - left))

        def y(v):
            return round(bottom - (v - low) / (high - low) * (bottom - top))

        draw.text((4, start + 4), f"Point histories ({units})", fill=255)
        draw.line((left, top, left, bottom, right, bottom), fill=255)
        for value in (low, (low + high) / 2, high):
            draw.text((2, y(value) - 4), f"{value:.3g}", fill=255)
        draw.text((left, bottom + 6), labels[0][:10], fill=255)
        draw.text((max(left, right - 65), bottom + 6), labels[-1][:10], fill=255)
        draw.line((x(times[index]), top, x(times[index]), bottom), fill=253)
        for i, record in enumerate(records):
            color = 248 + i
            values = record["values"]
            for j, value in enumerate(values):
                if value is None:
                    continue
                if j > 0 and values[j - 1] is not None:
                    draw.line(
                        (x(times[j - 1]), y(values[j - 1]), x(times[j]), y(value)),
                        fill=color,
                        width=2,
                    )
                radius = 4 if j == index else 2
                draw.ellipse(
                    (
                        x(times[j]) - radius,
                        y(value) - radius,
                        x(times[j]) + radius,
                        y(value) + radius,
                    ),
                    fill=color,
                )
            draw.text(
                (8 + (i % 2) * (width // 2), start + 184 + (i // 2) * 16),
                f"{i + 1}: {record['name'][:20]}",
                fill=color,
            )
        if not finite:
            draw.text((left + 4, top + 8), "No valid point measurements", fill=255)
        result.append(image)
    return result, {
        "time_spacing": "elapsed acquisition time",
        "y_limits": [low, high],
        "sample_policy": "containing native pixel; no spatial averaging",
        "missing_values": "gaps; no lines across missing epochs",
        "height": PLOT_HEIGHT,
    }
