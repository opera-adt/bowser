from __future__ import annotations

import contextlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    Any,
    Optional,
    Protocol,
    Sequence,
    Type,
    TypedDict,
    runtime_checkable,
)

import attr
import numpy as np
import rasterio as rio
import rasterio.warp
import rasterio.windows
from morecantile import TileMatrixSet
from numpy.typing import ArrayLike
from opera_utils import get_dates
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.dtypes import dtype_fwd
from rio_tiler.constants import WEB_MERCATOR_TMS, WGS84_CRS
from rio_tiler.io import BaseReader, Reader
from rio_tiler.models import BandStatistics, ImageData, Info, PointData
from rio_tiler.types import BBox, Indexes
from tqdm.contrib.concurrent import thread_map

PathOrStr = Path | str

# GDAL 3.11+ interprets NBITS=16 on float32 GeoTIFFs as native Float16
# (datatype code 15). Rasterio builds that lack a mapping for code 15
# raise KeyError on open. Patch the mapping so these files can be read.
_GDAL_FLOAT16_CODE = 15
if _GDAL_FLOAT16_CODE not in dtype_fwd:
    dtype_fwd[_GDAL_FLOAT16_CODE] = "float32"


def _can_use_nbits16() -> bool:
    """Check whether NBITS=16 can be used safely with the current GDAL/rasterio.

    Returns False when GDAL >= 3.11 would reinterpret NBITS=16 float32 as
    Float16 but rasterio has no native Float16 support.  Callers that create
    GeoTIFFs should skip the NBITS=16 creation option when this returns False.
    """
    return (
        _GDAL_FLOAT16_CODE in dtype_fwd and dtype_fwd[_GDAL_FLOAT16_CODE] != "float32"
    )


__all__ = [
    "DatasetReader",
    "StackReader",
    "RasterReader",
    "RasterStackReader",
]

if TYPE_CHECKING:
    from builtins import ellipsis

    Index = ellipsis | slice | int


@runtime_checkable
class DatasetReader(Protocol):
    """An array-like interface for reading input datasets.

    `DatasetReader` defines the abstract interface that types must conform to in order
    to be read by functions which iterate in blocks over the input data.
    Such objects must export NumPy-like `dtype`, `shape`, and `ndim` attributes,
    and must support NumPy-style slice-based indexing.

    Note that this protocol allows objects to be passed to `dask.array.from_array`
    which needs `.shape`, `.ndim`, `.dtype` and support numpy-style slicing.
    """

    dtype: np.dtype
    """numpy.dtype : Data-type of the array's elements."""

    shape: tuple[int, ...]
    """tuple of int : Tuple of array dimensions."""

    ndim: int
    """int : Number of array dimensions."""

    def __getitem__(self, key: tuple[Index, ...], /) -> ArrayLike:
        """Read a block of data."""

    def read_lonlat(self, lon: float, lat: float) -> ArrayLike:
        """Read one pixel from a lat/lon coordinate."""


@runtime_checkable
class StackReader(DatasetReader, Protocol):
    """An array-like interface for reading a 3D stack of input datasets.

    `StackReader` defines the abstract interface that types must conform to in order
    to be valid inputs to be read in functions.
    It is a specialization of [DatasetReader][] that requires a 3D shape.
    """

    ndim: int = 3
    """int : Number of array dimensions."""

    shape: tuple[int, int, int]
    """tuple of int : Tuple of array dimensions."""

    def __len__(self) -> int:
        """Int : Number of images in the stack."""
        return self.shape[0]


def _mask_array(arr: np.ndarray, nodata_value: float | None) -> np.ma.MaskedArray:
    """Mask an array based on a nodata value."""
    if np.isnan(nodata_value):
        return np.ma.masked_invalid(arr)
    return np.ma.masked_equal(arr, nodata_value)


def _ensure_slices(rows: Index, cols: Index) -> tuple[slice, slice]:
    def _parse(key: Index):
        if isinstance(key, int):
            return slice(key, key + 1)
        elif key is ...:
            return slice(None)
        else:
            return key

    return _parse(rows), _parse(cols)


@dataclass
class RasterReader(DatasetReader):
    """A single raster band of a GDAL-compatible dataset.

    See Also
    --------
    BinaryReader
    HDF5

    Notes
    -----
    If `keep_open=True`, this class does not store an open file object.
    Otherwise, the file is opened on-demand for reading or writing and closed
    immediately after each read/write operation.
    If passing the `RasterReader` to multiple spawned processes, it is recommended
    to set `keep_open=False` .

    """

    filename: PathOrStr
    """PathOrStr : The file path."""

    band: int
    """int : Band index (1-based)."""

    driver: str
    """str : Raster format driver name."""

    crs: rio.crs.CRS
    """rio.crs.CRS : The dataset's coordinate reference system."""

    transform: rio.transform.Affine
    """
    rasterio.transform.Affine : The dataset's georeferencing transformation matrix.

    This transform maps pixel row/column coordinates to coordinates in the dataset's
    coordinate reference system.
    """

    shape: tuple[int, int]
    dtype: np.dtype

    nodata: Optional[float] = None
    """Optional[float] : Value to use for nodata pixels."""

    keep_open: bool = False
    """bool : If True, keep the rasterio file handle open for faster reading."""

    chunks: Optional[tuple[int, int]] = None
    """Optional[tuple[int, int]] : Chunk shape of the dataset, or None if unchunked."""

    dates: Optional[tuple[datetime, ...]] = None

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """Bounds of dataset in `crs` coordinates."""
        if self.keep_open:
            return self._src.bounds
        with rio.open(self.filename, "r") as src:
            return src.bounds

    @property
    def latlon_bounds(self) -> tuple[float, float, float, float]:
        """Geographic bounds of dataset."""
        bounds = self.bounds
        # See `rasterio/rio/bounds.py``
        return rasterio.warp.transform_bounds(self.crs, {"init": "epsg:4326"}, *bounds)

    @classmethod
    def from_file(
        cls,
        filename: PathOrStr,
        band: int = 1,
        nodata: Optional[float] = None,
        keep_open: bool = False,
        file_date_fmt: str = "%Y%m%d",
        **options,
    ) -> RasterReader:
        """Create a RasterReader from a GDAL-readable filename."""
        if file_date_fmt:
            dates = get_dates(filename, fmt=file_date_fmt)
        else:
            dates = None
        with rio.open(filename, "r", **options) as src:
            shape = (src.height, src.width)
            dtype = np.dtype(src.dtypes[band - 1])
            driver = src.driver
            crs = src.crs
            nodata = nodata or src.nodatavals[band - 1]
            transform = src.transform
            chunks = src.block_shapes[band - 1]

            return cls(
                filename=filename,
                band=band,
                driver=driver,
                crs=crs,
                transform=transform,
                shape=shape,
                dtype=dtype,
                nodata=nodata,
                keep_open=keep_open,
                dates=dates,
                chunks=chunks,
            )

    def __post_init__(self):
        if self.keep_open:
            self._src = rio.open(self.filename, "r")
        self._transformer_to_lonlat = Transformer.from_crs(
            self.crs, 4326, always_xy=True
        )
        self._transformer_from_lonlat = Transformer.from_crs(
            4326, self.crs, always_xy=True
        )

    @property
    def ndim(self) -> int:  # type: ignore[override]
        """Int : Number of array dimensions."""
        return 2

    def __array__(self) -> np.ndarray:
        return self[:, :]

    def _lonlat_to_rowcol(self, lon: float, lat: float) -> tuple[int, int]:
        """Read one pixel from a lat/lon coordinate."""
        x, y = self._transformer_from_lonlat.transform(lon, lat)
        if self.keep_open:
            return self._src.index(x, y)
        with rio.open(self.filename, "r") as src:
            return src.index(x, y)

    def read_lonlat(self, lon: float, lat: float) -> np.ndarray:
        """Read one pixel from a lat/lon coordinate."""
        row, col = self._lonlat_to_rowcol(lon, lat)
        return self[row, col]

    def __getitem__(self, key: tuple[Index, ...], /) -> np.ndarray:
        if key is ... or key == ():
            key = (slice(None), slice(None))

        if not isinstance(key, tuple):
            msg = "Index must be a tuple of slices or integers."
            raise TypeError(msg)

        r_slice, c_slice = _ensure_slices(*key[-2:])
        window = rasterio.windows.Window.from_slices(
            r_slice,
            c_slice,
            height=self.shape[0],
            width=self.shape[1],
        )
        if self.keep_open:
            out = self._src.read(self.band, window=window)

        with rio.open(self.filename) as src:
            out = src.read(self.band, window=window)
        out_masked = _mask_array(out, self.nodata) if self.nodata is not None else out
        # Note that Rasterio doesn't use the `step` of a slice, so we need to
        # manually slice the output array.
        r_step, c_step = r_slice.step or 1, c_slice.step or 1
        return out_masked[::r_step, ::c_step].squeeze()


def _read_3d(
    key: tuple[Index, ...], readers: Sequence[DatasetReader], num_threads: int = 1
):
    # Check that it's a tuple of slices
    if not isinstance(key, tuple):
        msg = "Index must be a tuple of slices."
        raise TypeError(msg)
    if len(key) not in (1, 3):
        msg = "Index must be a tuple of 1 or 3 slices."
        raise TypeError(msg)
    # If only the band is passed (e.g. stack[0]), convert to (0, :, :)
    if len(key) == 1:
        key = (key[0], slice(None), slice(None))
    # unpack the slices
    bands, rows, cols = key
    # convert the rows/cols to slices
    r_slice, c_slice = _ensure_slices(rows, cols)

    if isinstance(bands, slice):
        # convert the bands to -1-indexed list
        total_num_bands = len(readers)
        band_idxs = list(range(*bands.indices(total_num_bands)))
    elif isinstance(bands, int):
        band_idxs = [bands]
    else:
        msg = "Band index must be an integer or slice."
        raise TypeError(msg)

    # Get only the bands we need
    if num_threads == 1:
        out = np.stack([readers[i][r_slice, c_slice] for i in band_idxs], axis=0)
    else:
        with ThreadPoolExecutor(max_workers=num_threads) as executor:
            results = executor.map(lambda i: readers[i][r_slice, c_slice], band_idxs)
        out = np.stack(list(results), axis=0)

    # TODO: Do i want a "keep_dims" option to not collapse singleton dimensions?
    return np.squeeze(out)


@dataclass
class BaseStackReader(StackReader):
    """Base class for stack readers."""

    file_list: Sequence[PathOrStr]
    readers: Sequence[DatasetReader]
    num_threads: int = 1
    nodata: Optional[float] = None

    def __getitem__(self, key: tuple[Index, ...], /) -> np.ndarray:
        return _read_3d(key, self.readers, num_threads=self.num_threads)

    @property
    def shape_2d(self):
        return self.readers[0].shape

    @property
    def shape(self):
        return (len(self.file_list), *self.shape_2d)

    @property
    def dtype(self):
        return self.readers[0].dtype


@dataclass
class RasterStackReader(BaseStackReader):
    """A stack of datasets for any GDAL-readable rasters.

    See Also
    --------
    BinaryStackReader
    HDF5StackReader

    Notes
    -----
    If `keep_open=True`, this class stores an open file object.
    Otherwise, the file is opened on-demand for reading or writing and closed
    immediately after each read/write operation.

    """

    readers: Sequence[RasterReader]

    def __post_init__(self):
        self._transformer_to_lonlat = self.readers[0]._transformer_to_lonlat
        self._transformer_from_lonlat = self.readers[0]._transformer_from_lonlat

    @classmethod
    def from_file_list(
        cls,
        file_list: Sequence[PathOrStr],
        bands: int | Sequence[int] = 1,
        keep_open: bool = False,
        num_threads: int = 1,
        nodata: Optional[float] = None,
        file_date_fmt: str | None = "%Y%m%d",
        num_parallel_open: int = 15,
        disable_tqdm: bool = False,
    ) -> RasterStackReader:
        """Create a RasterStackReader from a list of files.

        Parameters
        ----------
        file_list : Sequence[PathOrStr]
            list of paths to the files to read.
        bands : int | Sequence[int]
            Band to read from each file.
            If a single int, will be used for all files.
            Default = 1.
        keep_open : bool, optional (default False)
            If True, keep the rasterio file handles open for faster reading.
        num_threads : int, optional (default 1)
            Number of threads to use for reading each timeseries pixel.
            Default is 1.
        nodata : float, optional
            Manually set value to use for nodata pixels, by default None
        file_date_fmt : str, optional
            String format for date/datetimes in filenames.
            If None, does no date parsing.
        num_parallel_open : int
            Parallelism to use when opening files for the first time.
            Default is 15.
        disable_tqdm : bool
            Disable tqdm progress bar while loading files.

        Returns
        -------
        RasterStackReader
            The RasterStackReader object.

        """
        if isinstance(bands, int):
            bands = [bands] * len(file_list)

        def _read(file_band):
            f, b = file_band
            return RasterReader.from_file(
                f, band=b, keep_open=keep_open, file_date_fmt=file_date_fmt
            )

        readers = thread_map(
            _read,
            list(zip(file_list, bands)),
            max_workers=num_parallel_open,
            desc="Reading raster metadata",
            disable=disable_tqdm,
        )
        # Check if nodata values were found in the files
        nds = {r.nodata for r in readers}
        if len(nds) == 1:
            nodata = nds.pop()
        return cls(file_list, readers, num_threads=num_threads, nodata=nodata)

    def read_lonlat(self, lon: float, lat: float) -> np.ndarray:
        """Read all values at one pixel from a lat/lon coordinate."""
        row, col = self.readers[0]._lonlat_to_rowcol(lon, lat)
        return self[:, row, col]

    @property
    def dates(self) -> list[tuple[datetime, ...] | None]:
        """Get the dates of each band in the stack."""
        return [r.dates for r in self.readers]

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """Get the bounds of the stack in the dataset's CRS."""
        return self.readers[0].bounds

    @property
    def latlon_bounds(self) -> tuple[float, float, float, float]:
        """Get the geographic bounds of the stack."""
        return self.readers[0].latlon_bounds


#########################33
# https://github.com/developmentseed/titiler/discussions/780
#########################33
class Input(TypedDict, total=True):
    """Reader Options."""

    data: str
    mask: str | None
    mask_min_value: float


@attr.s
class CustomReader(BaseReader):
    input: Input = attr.ib()

    tms: TileMatrixSet = attr.ib(default=WEB_MERCATOR_TMS)
    geographic_crs: CRS = attr.ib(default=WGS84_CRS)

    dataset: Type[Reader] = attr.ib(
        init=False,
    )
    mask: Optional[Type[Reader]] = attr.ib(
        init=False,
    )

    colormap: dict = attr.ib(init=False, default=None)

    # Context Manager to handle rasterio open/close
    _ctx_stack = attr.ib(init=False, factory=contextlib.ExitStack)

    def __attrs_post_init__(self):
        """Define _kwargs, open dataset and get info."""
        self.dataset = self._ctx_stack.enter_context(Reader(self.input["data"]))
        if self.input["mask"]:
            self.mask = self._ctx_stack.enter_context(Reader(self.input["mask"]))
        else:
            self.mask = None

        self.bounds = self.dataset.bounds
        self.crs = self.dataset.crs
        self.colormap = self.dataset.colormap

    @property
    def minzoom(self):
        """Return dataset minzoom."""
        return self.dataset.minzoom

    @property
    def maxzoom(self):
        """Return dataset maxzoom."""
        return self.dataset.maxzoom

    def close(self):
        """Close rasterio dataset."""
        self._ctx_stack.close()

    def __exit__(self, exc_type, exc_value, traceback):
        """Support using with Context Managers."""
        self.close()

    def info(self) -> Info:
        # could return self.dataset.info()
        raise NotImplementedError

    def statistics(self, *args, **kwargs) -> dict[str, BandStatistics]:
        # could return self.dataset.statistics(*args, **kwargs)
        raise NotImplementedError

    def tile(
        self,
        tile_x: int,
        tile_y: int,
        tile_z: int,
        tilesize: int = 256,
        indexes: Optional[Indexes] = None,
        expression: Optional[str] = None,
        **kwargs: Any,
    ) -> ImageData:
        img = self.dataset.tile(
            tile_x,
            tile_y,
            tile_z,
            tilesize,
            indexes=indexes,
            expression=expression,
            **kwargs,
        )

        # https://rasterio.readthedocs.io/en/stable/topics/masks.html#nodata-representations-in-raster-files
        if self.mask is not None:
            mask_layer_img = self.mask.tile(
                tile_x,
                tile_y,
                tile_z,
                tilesize,
                indexes=1,
                **kwargs,
            )

            # Combine the invalid pixels of `.mask` and `.img`
            bad_image_pixels = img.mask == 0
            # img.mask has "valid" = 255, "invalid" = 0
            # need to convert it to numpy style
            filled_mask_layer = np.squeeze(mask_layer_img.array.filled(0))
            bad_mask_pixels = filled_mask_layer == 0

            # Also mask out the pixels which don't pass the threshold
            pixels_below_threshold = filled_mask_layer < self.input["mask_min_value"]
            combined_mask = np.logical_or.reduce(
                [
                    bad_image_pixels,
                    bad_mask_pixels,
                    pixels_below_threshold,
                ]
            )
            img = ImageData(
                np.ma.MaskedArray(img.data, mask=combined_mask),
                assets=img.assets,
                crs=img.crs,
                bounds=img.bounds,
            )

        return img

    def part(self, bbox: BBox) -> ImageData:
        raise NotImplementedError

    def preview(self) -> ImageData:
        raise NotImplementedError

    def point(self, lon: float, lat: float) -> PointData:
        raise NotImplementedError

    def feature(self, shape: dict) -> ImageData:
        raise NotImplementedError

    def read(
        self,
        indexes: Optional[Indexes] = None,
        expression: Optional[str] = None,
        **kwargs: Any,
    ) -> ImageData:
        raise NotImplementedError
