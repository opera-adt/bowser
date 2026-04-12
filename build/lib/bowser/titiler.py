from __future__ import annotations

import os
from enum import Enum
from glob import glob
from pathlib import Path
from typing import Any, Callable

import numpy as np
import simplejson
from pydantic import BaseModel, computed_field, field_validator
from rio_tiler.models import ImageData
from starlette import responses
from titiler.core.algorithm import BaseAlgorithm

from .readers import RasterStackReader
from .utils import list_bucket

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
    """Creation algorithm for re-wrapping unwrapped phase to (-pi, pi)."""

    scale_factor: float = 1.0

    def __call__(self, img: ImageData) -> ImageData:  # noqa: D102
        return ImageData(
            np.ma.mod(np.pi + (self.scale_factor * img.array), 2 * np.pi) - np.pi,
            # img. - self.shift,
            # np.ma.MaskedArray(data, mask=~mask),
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
        # if len(self.file_list) == 1:
        dates = self._reader.dates
        if not dates or any(d is None for d in dates):
            # otherwise, use indexes
            x_values = np.arange(len(self.file_list)).tolist()
        else:
            x_values = [_format_dates(*k) for k in dates]  # type: ignore[misc]

        return x_values

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


def _format_dates(*dates, fmt="%Y%m%d") -> str:
    return "_".join(f"{d.strftime(fmt)}" for d in dates)


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
