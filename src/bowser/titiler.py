from __future__ import annotations

import json
import logging
import os
from enum import Enum
from glob import glob
from pathlib import Path
from typing import Any, Callable, Literal

import numpy as np
import simplejson
from pydantic import BaseModel, Field, computed_field, field_validator
from rasterio import windows
from rio_tiler.models import ImageData
from starlette import responses
from titiler.core.algorithm import BaseAlgorithm

from .readers import RasterStackReader
from .utils import list_bucket

logger = logging.getLogger(__name__)

# TODO: Prep COGS with
#  for f in `ls ig*[0-9].tif`; do
#    gdal_translate DERIVED_SUBDATASET:PHASE:$f phase_${f/.tif/.vrt};
#  done


class Algorithm(str, Enum):
    """Available algorithms."""

    PHASE = "phase"
    AMPLITUDE = "amplitude"
    SHIFT = "shift"
    REWRAP = "rewrap"


class Phase(BaseAlgorithm):
    """Creation algorithm for the phase of a complex raster."""

    def __call__(self, img: ImageData) -> ImageData:  # noqa: D102
        return _process_complex(img, np.angle)


class Amplitude(BaseAlgorithm):
    """Custom tile creation algorithm for amplitude of complex data."""

    def __call__(self, img: ImageData) -> ImageData:  # noqa: D102
        return _process_complex(img, np.abs)


class Rewrap(BaseAlgorithm):
    """Creation algorithm for re-wrapping to (-wrap_range/2, wrap_range/2).

    ``shift`` is subtracted first (reference-point correction), then the
    result is multiplied by ``scale_factor`` and wrapped.  ``wrap_range``
    controls the modulo period (default 2π wraps to (−π, π)).

    Accepts both real (already-extracted phase) and complex (CFloat32)
    input. For complex input, ``np.angle`` is applied first so that
    rewrap can be used directly on raw interferogram files without
    needing to chain with the ``phase`` algorithm.
    """

    scale_factor: float = 1.0
    shift: float = 0.0
    wrap_range: float = 2 * np.pi

    def __call__(self, img: ImageData) -> ImageData:  # noqa: D102
        data = img.array
        if np.iscomplexobj(data):
            real = np.angle(data)
            mask = np.logical_or(
                getattr(data, "mask", False),
                np.logical_or(np.isnan(real), real == 0),
            )
            data = np.ma.MaskedArray(real, mask=mask)
        half = self.wrap_range / 2
        return ImageData(
            np.ma.mod(half + self.scale_factor * (data - self.shift), self.wrap_range)
            - half,
            assets=img.assets,
            crs=img.crs,
            bounds=img.bounds,
        )


def _process_complex(
    img: ImageData, func: Callable[[np.ndarray], np.ndarray]
) -> ImageData:
    """Tile algorithm for derived statistics of a complex raster.

    See https://developmentseed.org/titiler/examples/code/tiler_with_custom_algorithm/
    """
    data = func(img.data)
    # Mask at 0  in addition to current mask
    mask = np.logical_or(np.isnan(data), data == 0)

    # Create output ImageData
    return ImageData(
        np.ma.MaskedArray(data, mask=mask),
        assets=img.assets,
        crs=img.crs,
        bounds=img.bounds,
    )


class Shift(BaseAlgorithm):
    """Apply a simple shift (to subtract a reference point."""

    # Parameters
    shift: float | None = 0
    nan_to_zero: bool = True

    def __call__(self, img: ImageData) -> ImageData:  # noqa: D102
        shift = np.nan_to_num(self.shift or 0) if self.nan_to_zero else self.shift
        return ImageData(
            img.array - shift,
            assets=img.assets,
            crs=img.crs,
            bounds=img.bounds,
        )


#: Metres per degree of latitude, and of longitude at the equator (WGS84 mean).
_M_PER_DEG_LAT = 110_574.0
_M_PER_DEG_LON = 111_320.0


def _ground_pixel_size(img: ImageData) -> tuple[float, float]:
    """Return a tile's pixel size on the ground in metres, ``(dx, dy)``.

    Web Mercator pixels shrink on the ground by ``cos(latitude)``; degrees are
    turned into metres at the tile's latitude; other projected CRSs are taken as
    metres.
    """
    a, e = abs(img.transform.a), abs(img.transform.e)
    crs = img.crs
    if crs is None:
        return a, e
    west, south, east, north = img.bounds
    if crs.is_geographic:
        lat = np.deg2rad((south + north) / 2)
        return a * _M_PER_DEG_LON * np.cos(lat), e * _M_PER_DEG_LAT
    if crs.to_epsg() == 3857:
        y = (south + north) / 2
        lat = 2 * np.arctan(np.exp(y / 6_378_137.0)) - np.pi / 2
        return a * np.cos(lat), e * np.cos(lat)
    return a, e


class DemRender(BaseAlgorithm):
    """Hillshade and/or colour relief of an elevation model, as one RGB(A) tile.

    Unlike TiTiler's ``hillshade``, which differences neighbouring pixels without
    their size, slopes here are in metres per metre (pixel sizes from the tile's
    transform, on the ground), so the shading looks the same at every zoom and
    ``z_exaggeration`` is a true vertical exaggeration. The tile must be read with
    ``buffer`` extra pixels on each side (TiTiler's ``buffer`` query parameter, the
    same number), which are cropped after the slopes are taken.

    ``style``: ``hillshade`` is a grey shade; ``relief`` colours elevation with
    ``colormap_name`` between ``vmin`` and ``vmax``; ``both`` darkens and lightens
    that relief by the shade (flat ground keeps its colour). Nodata stays
    transparent.
    """

    title: str = "DEM"
    description: str = "Hillshade and/or colour relief of an elevation model."

    style: Literal["hillshade", "relief", "both"] = "both"
    z_exaggeration: float = Field(1.0, ge=0.01, le=1000.0)
    azimuth: float = Field(315.0, ge=0.0, le=360.0)
    altitude: float = Field(45.0, ge=0.0, le=90.0)
    vmin: float | None = None
    vmax: float | None = None
    colormap_name: str = "schwarzwald"
    buffer: int = Field(1, ge=0, le=16)

    input_nbands: int = 1
    output_nbands: int = 3
    output_dtype: str = "uint8"

    def _shade(self, z: np.ndarray, img: ImageData) -> np.ndarray:
        """Return the hillshade in 0..1 (NaN where a neighbour has no data)."""
        dx, dy = _ground_pixel_size(img)
        # Rows run south, so d/drow is minus the northward slope, as in Horn's
        # formulation that GDAL and ESRI use.
        dz_drow, dz_dcol = np.gradient(z, dy, dx)
        k = self.z_exaggeration
        slope = np.arctan(k * np.hypot(dz_dcol, dz_drow))
        aspect = np.arctan2(dz_drow, -dz_dcol)
        zenith = np.deg2rad(90.0 - self.altitude)
        sun = np.deg2rad((360.0 - self.azimuth + 90.0) % 360.0)
        shade = np.cos(zenith) * np.cos(slope) + np.sin(zenith) * np.sin(
            slope
        ) * np.cos(sun - aspect)
        return np.clip(shade, 0.0, 1.0)

    def _relief(self, z: np.ndarray) -> np.ndarray:
        """Return the colour relief as float RGB, shape (3, rows, cols), 0..255."""
        from rio_tiler.colormap import cmap  # noqa: PLC0415

        finite = z[np.isfinite(z)]
        lo, hi = (finite.min(), finite.max()) if finite.size else (0.0, 1.0)
        lo = lo if self.vmin is None else self.vmin
        hi = hi if self.vmax is None else self.vmax
        span = (hi - lo) or 1.0
        idx = np.clip(np.nan_to_num((z - lo) / span * 255.0), 0, 255).astype(np.uint8)
        table = cmap.get(self.colormap_name)
        lut = np.array([table[i][:3] for i in range(256)], dtype=np.float64)
        return np.moveaxis(lut[idx], -1, 0)

    def __call__(self, img: ImageData) -> ImageData:
        """Render the tile."""
        band = img.array[0]
        z = np.ma.filled(band.astype(np.float64), np.nan)
        invalid = np.ma.getmaskarray(band) | ~np.isfinite(z)
        z[invalid] = np.nan

        if self.style == "relief":
            data = self._relief(z)
        else:
            shade = self._shade(z, img)
            invalid = invalid | ~np.isfinite(shade)
            if self.style == "hillshade":
                data = (np.nan_to_num(shade) * 255.0)[None]
            else:
                # Flat ground (shade = sin(altitude)) keeps the relief colour.
                flat = max(np.sin(np.deg2rad(self.altitude)), 1e-3)
                factor = np.clip(0.35 + 0.65 * np.nan_to_num(shade) / flat, 0.0, 1.4)
                data = self._relief(z) * factor

        out = np.clip(data, 0, 255).astype(np.uint8)
        bounds = img.bounds
        b = self.buffer
        if b:
            out, invalid = out[:, b:-b, b:-b], invalid[b:-b, b:-b]
            bounds = windows.bounds(
                windows.Window(b, b, out.shape[2], out.shape[1]), img.transform
            )
        names = ["hillshade"] if out.shape[0] == 1 else ["red", "green", "blue"]
        return ImageData(
            np.ma.MaskedArray(out, mask=np.broadcast_to(invalid, out.shape)),
            assets=img.assets,
            crs=img.crs,
            bounds=bounds,
            band_descriptions=names,
        )


class LosEnu(BaseModel):
    """Ground-to-satellite unit vector in local ENU components."""

    east: float
    north: float
    up: float


class LosMetadata(BaseModel):
    """Satellite viewing geometry for an InSAR stack.

    Incidence angle and the ground-to-satellite ENU vector each take three
    samples across the swath (near/center/far). Near and far are optional;
    ``center`` is the required reference value. The UI draws near↔far as the
    swath extent in the side-view icon.

    Attributes
    ----------
    heading_deg
        Ground-track heading, degrees clockwise from geographic north.
    incidence_deg
        Center-swath incidence angle (degrees).
    incidence_deg_near, incidence_deg_far
        Near-range and far-range incidence angles (degrees).
    los_enu_ground_to_sat
        Center-swath unit vector from ground to satellite in local ENU.
    los_enu_ground_to_sat_near, los_enu_ground_to_sat_far
        Near-range and far-range ENU vectors.

    """

    heading_deg: float
    incidence_deg: float
    incidence_deg_near: float | None = None
    incidence_deg_far: float | None = None
    los_enu_ground_to_sat: LosEnu | None = None
    los_enu_ground_to_sat_near: LosEnu | None = None
    los_enu_ground_to_sat_far: LosEnu | None = None


def _swath_triple(v: Any) -> tuple[Any, Any, Any]:
    """Normalize either a scalar/flat-dict or a ``{near, center, far}`` dict.

    Returns ``(center, near, far)``. For the old schema (scalar incidence or
    flat ENU dict like ``{east, north, up}``), near/far are ``None``. For the
    new swath schema, pulls the three samples out.
    """
    if isinstance(v, dict) and "center" in v:
        return v["center"], v.get("near"), v.get("far")
    return v, None, None


def load_los_metadata(directory: str | Path) -> LosMetadata | None:
    """Load LOS metadata from ``heading_angle.json`` and ``los_enu.json``.

    Reads the two JSONs from ``directory``. Accepts both the legacy scalar
    schema and the new per-swath schema (``{near, center, far}`` for
    incidence and ENU). Returns ``None`` if neither file exists.
    """
    d = Path(directory)
    if not d.is_dir():
        return None

    heading_path = d / "heading_angle.json"
    los_path = d / "los_enu.json"

    if not heading_path.exists() and not los_path.exists():
        return None

    heading_deg: float | None = None
    if heading_path.exists():
        with heading_path.open() as f:
            heading_deg = json.load(f)["heading_angle_deg"]

    incidence_center: float | None = None
    incidence_near: float | None = None
    incidence_far: float | None = None
    los_center: LosEnu | None = None
    los_near: LosEnu | None = None
    los_far: LosEnu | None = None

    if los_path.exists():
        with los_path.open() as f:
            data = json.load(f)

        inc_c, inc_n, inc_f = _swath_triple(data["incidence_angle_deg"])
        incidence_center = float(inc_c)
        incidence_near = float(inc_n) if inc_n is not None else None
        incidence_far = float(inc_f) if inc_f is not None else None

        los_c, los_n, los_f = _swath_triple(data["los_enu_ground_to_satellite"])
        los_center = LosEnu(**los_c)
        los_near = LosEnu(**los_n) if los_n is not None else None
        los_far = LosEnu(**los_f) if los_f is not None else None

    if heading_deg is None or incidence_center is None:
        logger.warning(
            "Incomplete LOS metadata in %s (heading=%s, incidence=%s) — skipping",
            d,
            heading_deg,
            incidence_center,
        )
        return None

    return LosMetadata(
        heading_deg=heading_deg,
        incidence_deg=incidence_center,
        incidence_deg_near=incidence_near,
        incidence_deg_far=incidence_far,
        los_enu_ground_to_sat=los_center,
        los_enu_ground_to_sat_near=los_near,
        los_enu_ground_to_sat_far=los_far,
    )


class RasterGroup(BaseModel):
    """A group of rasters to view."""

    name: str
    file_list: list[str | Path]
    mask_file_list: list[str | Path] = []
    nodata: float | None = None
    uses_spatial_ref: bool = False
    algorithm: str | None = None
    mask_min_value: float = 0.1
    file_date_fmt: str | None = "%Y%m%d"
    los_metadata: LosMetadata | None = None
    _reader: RasterStackReader
    _disable_tqdm: bool = True

    @field_validator("file_list")
    @classmethod
    def _ensure_string(cls, v: Any):
        return list(map(os.fspath, v))

    def model_post_init(self, __context: Any) -> None:  # noqa: D102
        super().model_post_init(__context)

        self._reader = RasterStackReader.from_file_list(
            self.file_list,
            bands=1,
            keep_open=False,
            num_threads=3,
            nodata=self.nodata,
            file_date_fmt=self.file_date_fmt,
            disable_tqdm=self._disable_tqdm,
        )

    @computed_field
    def bounds(self) -> tuple[float, float, float, float]:
        """Project (left, bottom, right, top) bounds in the raster's CRS."""
        return self._reader.bounds

    @computed_field
    def latlon_bounds(self) -> tuple[float, float, float, float]:
        """Geographical (left, bottom, right, top) bounds of the raster group."""
        return self._reader.latlon_bounds

    # @functools.cached_property
    @computed_field
    def x_values(self) -> list[str | int]:
        """Vales to use for the x axis of a time series plot."""
        dates = self._reader.dates
        # Check if all dates are valid and non-empty
        if not dates or any((d is None or not d) for d in dates):
            return np.arange(len(self.file_list)).tolist()

        # For time series plotting, use the last date (secondary/end date)
        x_values = [k[-1].strftime("%Y-%m-%d") for k in dates]  # type: ignore[misc, index]

        # If secondary dates have duplicates (e.g., interferograms with varying
        # reference dates), use full "ref_secondary" date pair labels instead.
        # The frontend renders these with a category scale.
        if len(set(x_values)) != len(x_values):
            return [
                "_".join(d.strftime("%Y-%m-%d") for d in k)  # type: ignore[union-attr]
                for k in dates
            ]

        return x_values

    @computed_field
    def reference_date(self) -> str | None:
        """Return the common reference date when all files share a first date."""
        dates = self._reader.dates
        if not dates or any(not d for d in dates):
            return None
        # Check for multi-date filenames (e.g., interferograms)
        if not all(len(d) > 1 for d in dates):  # type: ignore[arg-type, union-attr]
            return None
        first_dates = {d[0] for d in dates}  # type: ignore[index]
        if len(first_dates) == 1:
            return first_dates.pop().strftime("%Y-%m-%d")
        return None

    @classmethod
    def from_glob(
        cls,
        glob_str: str,
        *,
        name: str,
        algorithm: str | None = None,
        nodata: float | None = None,
    ) -> RasterGroup:
        """Construct a RasterGroup from a glob string.

        Can be either a local path, or an s3 url.
        """
        file_list = _find_files(glob_str)
        if not file_list:
            raise ValueError("No files found.")

        return cls(
            name=name,
            file_list=_find_files(glob_str),
            algorithm=algorithm,
            nodata=nodata,
        )


def _find_files(glob_str: str) -> list[str]:
    if "*" not in glob_str:
        file_list = [glob_str]
    elif glob_str.startswith("s3://"):
        # Need to split the '*' from the rest of the path
        file_list = list_bucket(full_bucket_glob=glob_str)
    else:
        file_list = sorted(glob(glob_str))
    return file_list


# https://github.com/developmentseed/titiler/blob/0fddd7ed268557e82a5e1520cdd7fdf084afa1b8/src/titiler/core/titiler/core/resources/responses.py#L15
class JSONResponse(responses.JSONResponse):
    """Custom JSON Response."""

    def render(self, content: Any) -> bytes:
        """Render JSON.

        Same defaults as starlette.responses.JSONResponse.render but allow NaN
        to be replaced by null using simplejson
        """
        return simplejson.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
            ignore_nan=True,
        ).encode("utf-8")
