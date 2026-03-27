"""Convert dolphin raster outputs to GeoParquet point cloud format.

Reads a dolphin workflow directory, masks by quality metrics, and exports
surviving pixels as two GeoParquet files (points + timeseries) plus a
bowser_manifest.json.
"""

from __future__ import annotations

import concurrent.futures
from datetime import datetime
from glob import glob
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import rasterio as rio
import rasterio.transform
from pyproj import Transformer

if TYPE_CHECKING:
    from rasterio.crs import CRS
    from rasterio.transform import Affine

from .manifest import DatasetManifest, PointLayerConfig


def _find_dolphin_files(work_dir: str) -> dict[str, list[str]]:
    """Discover dolphin output files in a workflow directory.

    Parameters
    ----------
    work_dir : str
        Path to dolphin workflow directory.

    Returns
    -------
    dict[str, list[str]]
        Mapping of dataset name to list of file paths.
    """
    wd = work_dir.rstrip("/")
    candidates = {
        "timeseries": sorted(glob(f"{wd}/timeseries/2*[0-9].tif")),
        "velocity": glob(f"{wd}/timeseries/velocity.tif"),
        "velocity_stderr": glob(f"{wd}/timeseries/velocity_stderr.tif"),
        "temporal_coherence": sorted(
            glob(f"{wd}/interferograms/temporal_coherence_[0-9]*.tif")
        ),
        "temporal_coherence_average": glob(
            f"{wd}/interferograms/temporal_coherence_average*.tif"
        ),
        "amplitude_dispersion": glob(f"{wd}/interferograms/amp_dispersion_looked*.tif"),
        "phase_similarity": sorted(glob(f"{wd}/interferograms/similarity_[0-9]*.tif")),
        "ps_mask": glob(f"{wd}/interferograms/ps_mask_looked*.tif"),
    }
    return {k: v for k, v in candidates.items() if v}


def _read_single_band(path: str) -> tuple[np.ndarray, Affine, CRS]:
    """Read a single-band raster, returning data + georeference info."""
    with rio.open(path) as src:
        data = src.read(1)
        return data, src.transform, src.crs


def _build_mask(
    dolphin_files: dict[str, list[str]],
    coherence_threshold: float,
    amplitude_dispersion_threshold: float | None,
) -> tuple[np.ndarray, Affine, CRS]:
    """Build a boolean mask of pixels that pass quality thresholds.

    Parameters
    ----------
    dolphin_files : dict
        Output of `_find_dolphin_files`.
    coherence_threshold : float
        Minimum temporal coherence to keep a pixel.
    amplitude_dispersion_threshold : float or None
        Maximum amplitude dispersion to keep a pixel (lower = more stable).

    Returns
    -------
    mask : np.ndarray
        Boolean array, True = keep this pixel.
    transform : Affine
        Georeferencing transform.
    crs : CRS
        Coordinate reference system.
    """
    # Use temporal coherence (average if available, else last single-date)
    if "temporal_coherence_average" in dolphin_files:
        coh_path = dolphin_files["temporal_coherence_average"][0]
    elif "temporal_coherence" in dolphin_files:
        coh_path = dolphin_files["temporal_coherence"][-1]
    else:
        msg = (
            "No temporal coherence file found. "
            "Cannot build quality mask without coherence data."
        )
        raise FileNotFoundError(msg)

    coh_data, transform, crs = _read_single_band(coh_path)
    mask = (coh_data > coherence_threshold) & np.isfinite(coh_data)

    if (
        amplitude_dispersion_threshold is not None
        and "amplitude_dispersion" in dolphin_files
    ):
        amp_data, _, _ = _read_single_band(dolphin_files["amplitude_dispersion"][0])
        amp_mask = (amp_data < amplitude_dispersion_threshold) & (amp_data > 0)
        mask &= amp_mask

    return mask, transform, crs


def _pixel_coords_to_lonlat(
    rows: np.ndarray,
    cols: np.ndarray,
    transform: rio.transform.Affine,
    crs: rio.crs.CRS,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert pixel row/col indices to WGS84 lon/lat arrays."""
    # Pixel center coordinates in the raster's CRS
    xs, ys = rio.transform.xy(transform, rows, cols)
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)

    if crs.to_epsg() == 4326:
        return xs, ys

    transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    lons, lats = transformer.transform(xs, ys)
    return np.asarray(lons), np.asarray(lats)


def _read_static_attribute(path: str, mask: np.ndarray) -> np.ndarray:
    """Read a single-band raster and extract values at masked pixel locations."""
    data, _, _ = _read_single_band(path)
    return data[mask].astype(np.float32)


def _parse_dates_from_filenames(file_list: list[str]) -> list[datetime]:
    """Extract dates from dolphin timeseries filenames like '20210606.tif'."""
    from opera_utils import get_dates

    dates = []
    for f in file_list:
        d = get_dates(f)
        assert d, f"Could not parse date from {f}"
        # For timeseries files, take the last date (secondary)
        dates.append(d[-1])
    return dates


def convert_dolphin(
    work_dir: str,
    output_dir: str,
    coherence_threshold: float = 0.5,
    amplitude_dispersion_threshold: float | None = None,
) -> Path:
    """Convert a dolphin workflow directory to GeoParquet point cloud.

    Parameters
    ----------
    work_dir : str
        Path to dolphin workflow directory.
    output_dir : str
        Directory to write output files.
    coherence_threshold : float
        Minimum temporal coherence to include a pixel. Default 0.5.
    amplitude_dispersion_threshold : float or None
        Maximum amplitude dispersion to include a pixel. None to skip.

    Returns
    -------
    Path
        Path to the generated bowser_manifest.json.
    """
    import geopandas as gpd

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"Scanning dolphin outputs in {work_dir}...")
    dolphin_files = _find_dolphin_files(work_dir)

    assert (
        "timeseries" in dolphin_files
    ), f"No timeseries files found in {work_dir}/timeseries/"

    # Build quality mask
    print(f"Building quality mask (coherence > {coherence_threshold})...")
    mask, transform, crs = _build_mask(
        dolphin_files, coherence_threshold, amplitude_dispersion_threshold
    )
    n_points = int(mask.sum())
    print(f"  {n_points:,} pixels pass quality threshold")

    if n_points == 0:
        print("No pixels pass quality threshold. Writing empty outputs.")
        # Write empty GeoParquet files
        import geopandas as gpd

        empty_gdf = gpd.GeoDataFrame(
            {"point_id": np.array([], dtype=np.uint64)},
            geometry=[],
            crs="EPSG:4326",
        )
        points_path = output_path / "points.parquet"
        empty_gdf.to_parquet(points_path)

        ts_table = pa.table(
            {
                "point_id": pa.array([], type=pa.uint64()),
                "date": pa.array([], type=pa.date32()),
                "displacement": pa.array([], type=pa.float32()),
            }
        )
        ts_path = output_path / "timeseries.parquet"
        pq.write_table(ts_table, ts_path)

        manifest = DatasetManifest(
            name=Path(work_dir).name,
            layers={
                "ps_points": PointLayerConfig(
                    points_source=str(points_path),
                    timeseries_source=str(ts_path),
                ),
            },
        )
        manifest_path = output_path / "bowser_manifest.json"
        manifest.save(manifest_path)
        return manifest_path

    # Get pixel coordinates of surviving points
    rows, cols = np.where(mask)
    lons, lats = _pixel_coords_to_lonlat(rows, cols, transform, crs)

    # Assign point IDs
    point_ids = np.arange(n_points, dtype=np.uint64)

    # Build points table — read static attributes in parallel
    print("Reading static attributes...")
    points_data: dict[str, np.ndarray] = {
        "point_id": point_ids,
    }
    col_metadata: dict[str, dict[str, str]] = {
        "point_id": {},
    }

    attr_reads: list[tuple[str, str, dict[str, str]]] = []
    if "velocity" in dolphin_files:
        attr_reads.append(
            ("velocity", dolphin_files["velocity"][0], {"units": "mm/yr"})
        )
    if "velocity_stderr" in dolphin_files:
        attr_reads.append(
            ("velocity_std", dolphin_files["velocity_stderr"][0], {"units": "mm/yr"})
        )
    if "temporal_coherence_average" in dolphin_files:
        attr_reads.append(
            ("temporal_coherence", dolphin_files["temporal_coherence_average"][0], {})
        )
    elif "temporal_coherence" in dolphin_files:
        attr_reads.append(
            ("temporal_coherence", dolphin_files["temporal_coherence"][-1], {})
        )
    if "amplitude_dispersion" in dolphin_files:
        attr_reads.append(
            ("amplitude_dispersion", dolphin_files["amplitude_dispersion"][0], {})
        )

    with concurrent.futures.ThreadPoolExecutor() as pool:
        futures = {
            pool.submit(_read_static_attribute, path, mask): (name, md)
            for name, path, md in attr_reads
        }
        for future in concurrent.futures.as_completed(futures):
            name, md = futures[future]
            points_data[name] = future.result()
            col_metadata[name] = md

    # Create GeoDataFrame using vectorized geometry construction
    geometry = gpd.points_from_xy(lons, lats, crs="EPSG:4326")
    gdf = gpd.GeoDataFrame(points_data, geometry=geometry, crs="EPSG:4326")

    # Sort by spatial locality for better bbox query performance
    # Use a simple Morton/Z-order approximation: interleave quantized lon/lat bits
    gdf = gdf.sort_values(
        by=["point_id"],
        key=lambda _: _morton_key(lons, lats),
    )

    points_path = output_path / "points.parquet"
    print(f"Writing {points_path} ({n_points:,} points)...")
    gdf.to_parquet(points_path, row_group_size=100_000)

    # Build time series table
    ts_files = dolphin_files["timeseries"]
    dates = _parse_dates_from_filenames(ts_files)
    n_dates = len(dates)
    print(f"Reading displacement time series ({n_dates} dates)...")

    # Pre-allocate arrays for the long-form table
    total_rows = n_points * n_dates
    ts_point_ids = np.repeat(point_ids, n_dates)
    date_list = [d.date() for d in dates]
    ts_dates = date_list * n_points
    ts_displacement = np.empty(total_rows, dtype=np.float32)

    # Read each date's raster and extract values at masked pixels (parallel I/O)
    def _read_masked(ts_file: str) -> np.ndarray:
        data, _, _ = _read_single_band(ts_file)
        return data[mask].astype(np.float32)

    with concurrent.futures.ThreadPoolExecutor() as pool:
        future_to_idx: dict[concurrent.futures.Future[np.ndarray], int] = {
            pool.submit(_read_masked, f): i for i, f in enumerate(ts_files)
        }
        for future in concurrent.futures.as_completed(future_to_idx):
            idx = future_to_idx[future]
            ts_displacement[idx::n_dates] = future.result()

    # Write timeseries as Parquet with row groups organized by point_id
    # Each row group holds `points_per_group * n_dates` rows
    points_per_group = max(1, 500)
    row_group_size = points_per_group * n_dates

    ts_table = pa.table(
        {
            "point_id": pa.array(ts_point_ids, type=pa.uint64()),
            "date": pa.array(ts_dates, type=pa.date32()),
            "displacement": pa.array(ts_displacement, type=pa.float32()),
        }
    )

    ts_path = output_path / "timeseries.parquet"
    print(f"Writing {ts_path} ({total_rows:,} rows, ~{row_group_size:,} rows/group)...")

    # Add column metadata for units
    ts_col_metadata = {"displacement": {"units": "mm"}}
    ts_schema = ts_table.schema
    new_fields = []
    for field in ts_schema:
        if field.name in ts_col_metadata:
            field_md: dict = {
                k.encode(): v.encode() for k, v in ts_col_metadata[field.name].items()
            }
            new_fields.append(field.with_metadata(field_md))
        else:
            new_fields.append(field)
    ts_table = ts_table.cast(pa.schema(new_fields))

    pq.write_table(ts_table, ts_path, row_group_size=row_group_size)

    # Compute bounds
    bounds = [
        float(lons.min()),
        float(lats.min()),
        float(lons.max()),
        float(lats.max()),
    ]

    # Generate manifest
    manifest = DatasetManifest(
        name=Path(work_dir).name,
        description=f"Dolphin output converted from {work_dir}",
        layers={
            "ps_points": PointLayerConfig(
                points_source=str(points_path),
                timeseries_source=str(ts_path),
                default_color_by="velocity",
                default_colormap="RdBu_r",
            ),
        },
        bounds=bounds,
    )

    manifest_path = output_path / "bowser_manifest.json"
    manifest.save(manifest_path)
    print(f"Manifest written to {manifest_path}")

    return manifest_path


def _morton_key(lons: np.ndarray, lats: np.ndarray, bits: int = 16) -> np.ndarray:
    """Compute approximate Morton/Z-order curve index for spatial sorting.

    Interleaves quantized longitude and latitude bits to produce a sort key
    that clusters spatially nearby points together.

    Parameters
    ----------
    lons, lats : np.ndarray
        Coordinate arrays.
    bits : int
        Quantization precision.

    Returns
    -------
    np.ndarray
        Integer sort keys (uint64).
    """
    # Normalize to [0, 2^bits)
    lon_min, lon_max = lons.min(), lons.max()
    lat_min, lat_max = lats.min(), lats.max()
    lon_range = lon_max - lon_min if lon_max > lon_min else 1.0
    lat_range = lat_max - lat_min if lat_max > lat_min else 1.0
    max_val = (1 << bits) - 1

    qlon = ((lons - lon_min) / lon_range * max_val).astype(np.uint64)
    qlat = ((lats - lat_min) / lat_range * max_val).astype(np.uint64)

    # Vectorized bit interleave using part1by1 (spread bits of x)
    def _part1by1(x: np.ndarray) -> np.ndarray:
        """Spread the lower 16 bits of x: insert a 0 bit between each."""
        x = x & np.uint64(0x0000FFFF)
        x = (x | (x << np.uint64(8))) & np.uint64(0x00FF00FF)
        x = (x | (x << np.uint64(4))) & np.uint64(0x0F0F0F0F)
        x = (x | (x << np.uint64(2))) & np.uint64(0x33333333)
        x = (x | (x << np.uint64(1))) & np.uint64(0x55555555)
        return x

    return _part1by1(qlon) | (_part1by1(qlat) << np.uint64(1))
