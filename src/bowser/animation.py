"""Bounded raster GIFs of stored epochs, using the native export preparation."""

import json
import re
import threading
import time
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Callable

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .polygon import PolygonMask
from .polygon_masks import _axis

MAX_FRAMES = 90
MAX_NATIVE_PIXELS = 2_000_000
MAX_PIXEL_EPOCHS = 50_000_000
MAX_DISPLAY_PIXELS = 24_000_000
RENDER_LOCK = threading.Lock()


class AnimationRequest(BaseModel):
    """Only explicit saved indices and scalar data; no inferred zero epochs."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    variable: str = Field(min_length=1, max_length=256)
    start_index: int = Field(ge=0)
    end_index: int = Field(ge=0)
    vmin: float
    vmax: float
    colormap: str = Field(default="rdbu_r", min_length=1, max_length=80)
    fps: float = Field(default=2, ge=0.5, le=10)
    width: int = Field(default=512, ge=64, le=1024)
    bounds: list[float] | None = Field(default=None, min_length=4, max_length=4)
    layer_masks: list[PolygonMask] = Field(default_factory=list, max_length=10)
    custom_mask_path: str | None = None
    ref_lon: float | None = Field(default=None, ge=-180, le=180)
    ref_lat: float | None = Field(default=None, ge=-90, le=90)
    ref_buffer_m: float = Field(default=0, ge=0, le=5000)
    ref_time_idx: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def ordered(self):
        """Reject invalid dates/limits instead of silently clamping requests."""
        if not 2 <= self.end_index - self.start_index + 1 <= MAX_FRAMES:
            raise ValueError("Choose 2 to 90 consecutive saved epochs")
        if self.vmin >= self.vmax:
            raise ValueError("Color limits must increase")
        if (self.ref_lon is None) != (self.ref_lat is None):
            raise ValueError("Supply both reference coordinates")
        if self.custom_mask_path is not None:
            raise ValueError("Uploaded masks are not supported by raster GIF yet")
        if self.ref_buffer_m and self.ref_lon is None:
            raise ValueError("A reference radius needs coordinates")
        if self.bounds is not None:
            w, s, e, n = self.bounds
            if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
                raise ValueError(
                    "Use non-wrapping WGS84 bounds [west, south, east, north]"
                )
        return self


def source_info(target, request):
    """Validate scalar source metadata before reading frame arrays."""
    name = request.variable
    indices = list(range(request.start_index, request.end_index + 1))
    if target.mode == "md":
        if name not in target.dataset.data_vars:
            raise ValueError("Unknown animation layer")
        source = target.dataset[name]
        dim = _axis(source)
        if dim is None or dim not in source.coords:
            raise ValueError("Animation needs an explicit saved-epoch axis")
        from .lite.meta import dim_labels

        labels = list(map(str, dim_labels(source, dim)))
        if source.dtype.kind not in "biuf":
            raise ValueError("Animation needs a real-valued scalar layer")
        if not {"x", "y"}.issubset(source.dims):
            raise ValueError("Animation needs spatial x/y dimensions")
        _width, _height = source.sizes["x"], source.sizes["y"]
        transform, crs = (
            source.rio.transform(),
            source.rio.crs or target.dataset.rio.crs,
        )
    else:
        import rasterio

        if name not in target.raster_groups:
            raise ValueError("Unknown animation layer")
        group = target.raster_groups[name]
        labels = list(map(str, group.x_values))
        if not group.file_list or len(labels) != len(group.file_list):
            raise ValueError("Source files and epoch labels must match")
        if any(group.mask_file_list):
            raise ValueError(
                "Configured GeoTIFF masks are not supported by raster GIF yet"
            )
        with rasterio.open(group.file_list[0]) as source:
            if source.count != 1 or np.dtype(source.dtypes[0]).kind not in "biuf":
                raise ValueError("Animation needs a single-band real-valued layer")
            _width, _height, transform, crs = (
                source.width,
                source.height,
                source.transform,
                source.crs,
            )
    if _width < 1 or _height < 1:
        raise ValueError("Animation needs a nonempty spatial grid")
    if request.end_index >= len(labels) or len(labels) < 2:
        raise ValueError("Epoch range is outside the saved source record")
    if len(set(labels)) != len(labels) or any(len(v) > 256 for v in labels):
        raise ValueError("Epoch labels must be unique and bounded")
    if request.ref_time_idx is not None and request.ref_time_idx >= len(labels):
        raise ValueError("Reference epoch is outside the saved record")
    if not crs or transform.b or transform.d or transform.a <= 0 or transform.e >= 0:
        raise ValueError("Raster GIF currently requires a north-up georeferenced grid")
    return labels, indices


@dataclass
class RenderPlan:
    """Metadata-only display read plan; source reference support stays native."""

    labels: list[str]
    indices: list[int]
    dataset: Any
    window: tuple[int, int, int, int]
    level: str
    native_grid: tuple
    size: tuple[int, int]

    def summary(self) -> dict:
        """Return bounded public provenance without source paths."""
        r0, r1, c0, c1 = self.window
        return {
            "level": self.level,
            "read_width": c1 - c0,
            "read_height": r1 - r0,
            "output_width": self.size[0],
            "output_height": self.size[1] + 48,
            "frames": len(self.indices),
        }


def _window(width, height, transform, crs, bounds):
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds

    if bounds is None:
        return (0, height, 0, width)
    box = transform_bounds(4326, crs, *bounds, densify_pts=21)
    if not np.isfinite(box).all():
        raise ValueError("Viewport cannot be projected to the source grid")
    win = from_bounds(*box, transform=transform)
    r0, r1 = (
        max(0, int(np.floor(win.row_off))),
        min(height, int(np.ceil(win.row_off + win.height))),
    )
    c0, c1 = (
        max(0, int(np.floor(win.col_off))),
        min(width, int(np.ceil(win.col_off + win.width))),
    )
    if r0 >= r1 or c0 >= c1:
        raise ValueError("Viewport does not overlap a usable raster window")
    return (r0, r1, c0, c1)


def _reference_work(grid, request, count):
    """Bound native reference IO independently of a cropped/display-level view."""
    if request.ref_lon is None:
        return 0
    crs, transform, width, height = grid
    from pyproj import CRS, Transformer

    cx, cy = Transformer.from_crs(4326, crs, always_xy=True).transform(
        request.ref_lon, request.ref_lat
    )
    col, row = ~transform * (cx, cy)
    if not (0 <= col <= width and 0 <= row <= height):
        raise ValueError("Reference position is outside the source raster")
    radius = request.ref_buffer_m
    if radius:
        projected = CRS.from_user_input(crs)
        if not projected.is_projected or any(
            a.unit_conversion_factor != 1 for a in projected.axis_info[:2]
        ):
            raise ValueError(
                "Median reference buffers require a projected CRS in meters"
            )
        corners = [
            ~transform * (x, y)
            for x in (cx - radius, cx + radius)
            for y in (cy - radius, cy + radius)
        ]
        c0, c1 = (
            max(0, int(np.floor(min(c[0] for c in corners)))),
            min(width, int(np.ceil(max(c[0] for c in corners)))),
        )
        r0, r1 = (
            max(0, int(np.floor(min(c[1] for c in corners)))),
            min(height, int(np.ceil(max(c[1] for c in corners)))),
        )
        pixels = max(0, c1 - c0) * max(0, r1 - r0)
    else:
        pixels = 1
    work = pixels * count * (2 if request.ref_time_idx is not None else 1)
    if pixels > MAX_NATIVE_PIXELS or work > MAX_PIXEL_EPOCHS:
        raise ValueError(
            "Native reference window exceeds raster GIF pixel budget; "
            "reduce radius or epochs"
        )
    return work


def plan_render(target: Any, request: AnimationRequest) -> RenderPlan:
    """Budget the actual read footprint and all display frames before pixel IO."""
    labels, indices = source_info(target, request)
    candidates = []
    if target.mode == "md":
        levels = [("native", target.dataset)]
        levels += [
            (f"pyramid:{i}", level.dataset)
            for i, level in enumerate(target.levels or [])
            if level.dataset is not target.dataset
        ]
        for name, ds in levels:
            if request.variable not in ds or any(
                m.dataset not in ds for m in request.layer_masks
            ):
                continue
            source = ds[request.variable]
            if source.dtype.kind not in "biuf" or source.attrs.get(
                "units"
            ) != target.dataset[request.variable].attrs.get("units"):
                continue
            dim = _axis(source)
            from .lite.meta import dim_labels

            if dim is None or list(map(str, dim_labels(source, dim))) != labels:
                continue  # A pyramid may not change or guess the saved epochs.
            transform, crs = (
                source.rio.transform(recalc=True),
                source.rio.crs or ds.rio.crs,
            )
            if (
                not crs
                or transform.b
                or transform.d
                or transform.a <= 0
                or transform.e >= 0
            ):
                continue
            native_source = target.dataset[request.variable]
            if name != "native":
                if crs != (native_source.rio.crs or target.dataset.rio.crs):
                    continue
                left, bottom, right, top = source.rio.bounds(recalc=True)
                nl, nb, nr, nt = native_source.rio.bounds(recalc=True)
                tolerance = max(abs(transform.a), abs(transform.e))
                if (
                    left > nl + tolerance
                    or bottom > nb + tolerance
                    or right < nr - tolerance
                    or top < nt - tolerance
                ):
                    continue  # A partial-area raster is not a full-source pyramid.
            win = _window(
                source.sizes["x"], source.sizes["y"], transform, crs, request.bounds
            )
            candidates.append(
                (name, ds, win, (crs, transform, source.sizes["x"], source.sizes["y"]))
            )
    else:
        import rasterio

        with rasterio.open(target.raster_groups[request.variable].file_list[0]) as src:
            grid = (src.crs, src.transform, src.width, src.height)
            candidates.append(
                (
                    "native",
                    None,
                    _window(
                        src.width, src.height, src.transform, src.crs, request.bounds
                    ),
                    grid,
                )
            )
            for i, _factor in enumerate(src.overviews(1)):
                with rasterio.open(src.name, OVERVIEW_LEVEL=str(i)) as overview:
                    ov_grid = (
                        overview.crs,
                        overview.transform,
                        overview.width,
                        overview.height,
                    )
                    candidates.append(
                        (
                            f"overview:{i}",
                            None,
                            _window(
                                overview.width,
                                overview.height,
                                overview.transform,
                                overview.crs,
                                request.bounds,
                            ),
                            ov_grid,
                        )
                    )
    if not candidates:
        raise ValueError("No compatible saved display grid is available")

    # A small native crop remains native. Full views prefer the finest existing
    # pyramid fitting the display; no new data pyramid or averaged product is made.
    def pixels(item):
        _, _, (r0, r1, c0, c1), _ = item
        return (r1 - r0) * (c1 - c0)

    reference_work = _reference_work(candidates[0][3], request, len(indices))

    def bounded(item):
        return (
            pixels(item) <= MAX_NATIVE_PIXELS
            and pixels(item) * len(indices) * (1 + len(request.layer_masks))
            + reference_work
            <= MAX_PIXEL_EPOCHS
        )

    native = candidates[0]
    if request.bounds and bounded(native):
        chosen = native
    else:
        fitting = [
            c
            for c in candidates
            if bounded(c)
            and c[2][3] - c[2][2] <= request.width
            and c[2][1] - c[2][0] <= 1024
        ]
        allowed = fitting or [c for c in candidates if bounded(c)]
        if not allowed:
            raise ValueError(
                "Selected read window exceeds raster GIF pixel budget; "
                "crop further, use fewer epochs, or provide a display pyramid"
            )
        chosen = max(fitting, key=pixels) if fitting else min(allowed, key=pixels)
    name, ds, win, grid = chosen
    r0, r1, c0, c1 = win
    w, h = c1 - c0, r1 - r0
    factor = min(request.width / w, 1024 / h)
    size = max(1, round(w * factor)), max(1, round(h * factor))
    if size[0] * (size[1] + 48) * len(indices) > MAX_DISPLAY_PIXELS:
        raise ValueError("Display exceeds GIF pixel budget; reduce width or epochs")
    if ds is not None:
        from rasterio.windows import Window
        from rasterio.windows import transform as window_transform

        cropped = ds.isel(y=slice(r0, r1), x=slice(c0, c1))
        cropped = cropped.rio.write_transform(
            window_transform(Window(c0, r0, w, h), grid[1])
        )
    else:
        cropped = None
    return RenderPlan(labels, indices, cropped, win, name, candidates[0][3], size)


def render(request: AnimationRequest, target: Any, prepare: Callable):
    """Render nearest-neighbor display images; never modify source measurements."""
    from PIL import Image, ImageDraw
    from rio_tiler.colormap import cmap, make_lut

    try:
        lut = make_lut(cmap.get(request.colormap.lower()))
    except Exception as exc:
        raise ValueError("Unknown animation colormap") from exc
    plan = plan_render(target, request)
    labels, indices = plan.labels, plan.indices
    # Reserve two colors for nodata/header text. This display quantization is
    # constant for every frame; it does not affect native data or color limits.
    palette = np.vstack(
        (
            lut[np.round(np.linspace(0, 255, 254)).astype(int), :3],
            [[255, 255, 255], [0, 0, 0]],
        )
    ).astype("uint8")
    frames: list[Image.Image] = []
    support, references = [], []
    units = "stored units (not supplied)"
    started = time.monotonic()
    grid = None
    masks = json.dumps([m.model_dump() for m in request.layer_masks])
    for index in indices:
        if time.monotonic() - started > 120:
            raise ValueError("Raster GIF exceeded the rendering time budget")
        if target.mode == "cog":
            import rasterio

            with rasterio.open(
                target.raster_groups[request.variable].file_list[index]
            ) as src:
                if (src.crs, src.transform, src.width, src.height) != plan.native_grid:
                    raise ValueError("Animation frames must share the same native grid")
        da, _ = prepare(index, masks, plan)
        try:
            native = (da.rio.crs, da.rio.transform(), da.sizes["x"], da.sizes["y"])
            if grid is not None and native != grid:
                raise ValueError("Animation frames must share the same native grid")
            grid = native
            values = np.asarray(da.transpose("y", "x").values)
            valid = np.isfinite(values)
            support.append(int(valid.sum()))
            references.append(da.attrs.get("BOWSER_REFERENCE_VALUE"))
            current_units = str(da.attrs.get("units") or "stored units (not supplied)")[
                :80
            ]
            if frames and current_units != units:
                raise ValueError("Animation frames must retain consistent units")
            units = current_units
            size = plan.size
            scaled = np.clip(
                (np.where(valid, values, request.vmin) - request.vmin)
                / (request.vmax - request.vmin),
                0,
                1,
            )
            pixels = np.where(valid, (scaled * 253).astype("uint8"), 254).astype(
                "uint8"
            )
            image = Image.fromarray(pixels).resize(size, Image.Resampling.NEAREST)
            image.putpalette(palette.ravel().tolist())
            frame = Image.new("P", (size[0], size[1] + 48), 254)
            frame.putpalette(palette.ravel().tolist())
            frame.paste(image, (0, 24))
            draw = ImageDraw.Draw(frame)
            label = labels[index][:100]
            draw.text((4, 4), f"{index + 1}: {label}", fill=255)
            draw.text(
                (4, size[1] + 28),
                f"{request.vmin:g} to {request.vmax:g} {units}",
                fill=255,
            )
            frames.append(frame)
        finally:
            da.close()
    duration = int(round(1000 / request.fps / 10) * 10)
    manifest = {
        "kind": "raster GIF display",
        "variable": request.variable,
        "indices": indices,
        "labels": [labels[i] for i in indices],
        "vmin": request.vmin,
        "vmax": request.vmax,
        "colormap": request.colormap,
        "requested_fps": request.fps,
        "frame_duration_ms": duration,
        "units": units,
        "bounds_wgs84": request.bounds,
        "display_read": plan.summary(),
        "reference_resolution": "native source",
        "valid_native_pixels": support if plan.level == "native" else None,
        "valid_display_pixels": support,
        "support_resolution": "selected display grid",
        "reference": {
            "lon": request.ref_lon,
            "lat": request.ref_lat,
            "radius_m": request.ref_buffer_m,
            "epoch_index": request.ref_time_idx,
            "offsets": references,
        },
        "layer_masks": [m.model_dump() for m in request.layer_masks],
        "custom_mask_applied": bool(request.custom_mask_path),
        "limitations": [
            (
                "Display only: 254 fixed data colors plus white/black; "
                "nearest-neighbor resize"
            ),
            "Equal playback durations do not represent unequal acquisition intervals",
            "No inferred zero epochs, interpolation, smoothing or new fitting",
            (
                "Raster only: no basemap, terrain context, annotations, "
                "opacity blending or linked plot"
            ),
        ],
    }
    output = BytesIO()
    frames[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=0,
        optimize=False,
        disposal=2,
        comment=json.dumps(manifest, allow_nan=False).encode(),
    )

    def safe(text):
        return re.sub(r"[^A-Za-z0-9_-]", "-", str(text))[:40]

    filename = (
        f"{safe(request.variable)}_{safe(labels[indices[0]])}_"
        f"{safe(labels[indices[-1]])}.gif"
    )
    return output.getvalue(), filename
