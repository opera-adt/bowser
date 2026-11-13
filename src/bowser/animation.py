"""Bounded raster GIFs of stored epochs, using the native export preparation."""

import json
import re
import threading
import time
from io import BytesIO
from typing import Any, Callable

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .polygon import NativeGrid, PolygonMask
from .polygon_masks import _axis, raster_masks, xarray_masks

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
    """Validate scalar source/mask metadata before reading frame arrays."""
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
        width, height = source.sizes["x"], source.sizes["y"]
        transform, crs = (
            source.rio.transform(),
            source.rio.crs or target.dataset.rio.crs,
        )
        xarray_masks(source, target.dataset, request, crs)
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
            width, height, transform, crs = (
                source.width,
                source.height,
                source.transform,
                source.crs,
            )
        masks = raster_masks(
            target.raster_groups,
            request,
            labels,
            NativeGrid(crs, transform, width, height),
        )
        for index in indices:
            if index < len(labels):
                masks.valid(index, slice(0, 1), slice(0, 1), (1, 1))
    if request.end_index >= len(labels) or len(labels) < 2:
        raise ValueError("Epoch range is outside the saved source record")
    if len(set(labels)) != len(labels) or any(len(v) > 256 for v in labels):
        raise ValueError("Epoch labels must be unique and bounded")
    if request.ref_time_idx is not None and request.ref_time_idx >= len(labels):
        raise ValueError("Reference epoch is outside the saved record")
    if not crs or transform.b or transform.d or transform.a <= 0 or transform.e >= 0:
        raise ValueError("Raster GIF currently requires a north-up georeferenced grid")
    if (
        width * height > MAX_NATIVE_PIXELS
        or width * height * len(indices) > MAX_PIXEL_EPOCHS
    ):
        raise ValueError(
            "Source exceeds raster GIF pixel budget; "
            "use a smaller prepared subset or fewer epochs"
        )
    return labels, indices


def render(request: AnimationRequest, target: Any, prepare: Callable):
    """Render nearest-neighbor display images; never modify source measurements."""
    from PIL import Image, ImageDraw
    from rasterio.warp import transform_bounds
    from rio_tiler.colormap import cmap, make_lut

    try:
        lut = make_lut(cmap.get(request.colormap.lower()))
    except Exception as exc:
        raise ValueError("Unknown animation colormap") from exc
    labels, indices = source_info(target, request)
    # Reserve two colors for nodata/header text. This display quantization is
    # constant for every frame; it does not affect native data or color limits.
    palette = np.vstack(
        (
            lut[np.round(np.linspace(0, 255, 254)).astype(int), :3],
            [[255, 255, 255], [0, 0, 0]],
        )
    ).astype("uint8")
    frames, support, references = [], [], []
    units = "stored units (not supplied)"
    started = time.monotonic()
    grid = None
    masks = json.dumps([m.model_dump() for m in request.layer_masks])
    for index in indices:
        if time.monotonic() - started > 120:
            raise ValueError("Raster GIF exceeded the rendering time budget")
        da, _ = prepare(index, masks)
        try:
            native = (da.rio.crs, da.rio.transform(), da.sizes["x"], da.sizes["y"])
            if grid is not None and native != grid:
                raise ValueError("Animation frames must share the same native grid")
            grid = native
            if request.bounds:
                box = transform_bounds(
                    4326, da.rio.crs, *request.bounds, densify_pts=21
                )
                from rioxarray.exceptions import RioXarrayError

                try:
                    da = da.rio.clip_box(*box, allow_one_dimensional_raster=True)
                except RioXarrayError as exc:
                    raise ValueError(
                        "Viewport does not overlap a usable raster window"
                    ) from exc
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
            h, w = values.shape
            factor = min(request.width / w, 1024 / h)
            size = (max(1, round(w * factor)), max(1, round(h * factor)))
            if size[0] * size[1] * len(indices) > MAX_DISPLAY_PIXELS:
                raise ValueError(
                    "Display exceeds GIF pixel budget; reduce width or epochs"
                )
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
        "valid_native_pixels": support,
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
