"""Tests for the dolphin-to-GeoParquet converter."""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pyarrow.parquet as pq
import rasterio as rio
from rasterio.transform import from_bounds

from bowser._convert_dolphin import convert_dolphin


def _make_synthetic_dolphin_dir(tmp_path: Path, n_dates: int = 5) -> Path:
    """Create a minimal synthetic dolphin workflow directory for testing."""
    work_dir = tmp_path / "dolphin_work"
    ts_dir = work_dir / "timeseries"
    ifg_dir = work_dir / "interferograms"
    ts_dir.mkdir(parents=True)
    ifg_dir.mkdir(parents=True)

    # Small 10x10 raster, EPSG:4326 for simplicity
    nrows, ncols = 10, 10
    west, south, east, north = -118.5, 33.8, -118.4, 33.9
    transform = from_bounds(west, south, east, north, ncols, nrows)
    crs = rio.crs.CRS.from_epsg(4326)
    profile = {
        "driver": "GTiff",
        "height": nrows,
        "width": ncols,
        "count": 1,
        "dtype": "float32",
        "crs": crs,
        "transform": transform,
        "nodata": 0.0,
    }

    # Temporal coherence: top half > 0.7, bottom half < 0.3
    coh = np.zeros((nrows, ncols), dtype=np.float32)
    coh[:5, :] = 0.8
    coh[5:, :] = 0.2
    coh_path = ifg_dir / "temporal_coherence_average_20200101_20201231.tif"
    with rio.open(coh_path, "w", **profile) as dst:
        dst.write(coh, 1)

    # Velocity: linear gradient
    vel = np.linspace(-20, 20, nrows * ncols).reshape(nrows, ncols).astype(np.float32)
    vel_path = ts_dir / "velocity.tif"
    with rio.open(vel_path, "w", **profile) as dst:
        dst.write(vel, 1)

    # Amplitude dispersion
    amp = np.full((nrows, ncols), 0.3, dtype=np.float32)
    amp_path = ifg_dir / "amp_dispersion_looked.tif"
    with rio.open(amp_path, "w", **profile) as dst:
        dst.write(amp, 1)

    # Time series: n_dates rasters with linear trend
    from datetime import date, timedelta

    start = date(2020, 1, 1)
    for i in range(n_dates):
        d = start + timedelta(days=i * 12)
        date_str = d.strftime("%Y%m%d")
        ts_data = (vel * (i + 1) / 365.25).astype(np.float32)
        ts_path = ts_dir / f"{date_str}.tif"
        with rio.open(ts_path, "w", **profile) as dst:
            dst.write(ts_data, 1)

    return work_dir


def test_convert_dolphin_basic(tmp_path):
    """Test that converter produces valid GeoParquet files and manifest."""
    n_dates = 5
    work_dir = _make_synthetic_dolphin_dir(tmp_path, n_dates=n_dates)
    output_dir = tmp_path / "output"

    manifest_path = convert_dolphin(
        work_dir=str(work_dir),
        output_dir=str(output_dir),
        coherence_threshold=0.5,
    )

    # Check output files exist
    assert manifest_path.exists()
    assert (output_dir / "points.parquet").exists()
    assert (output_dir / "timeseries.parquet").exists()

    # Check manifest
    with open(manifest_path) as f:
        manifest = json.load(f)
    assert "ps_points" in manifest["layers"]
    assert manifest["layers"]["ps_points"]["type"] == "points"
    assert manifest["bounds"] is not None

    # Check points table
    points_gdf = gpd.read_parquet(output_dir / "points.parquet")
    # Only top 5 rows (coherence > 0.5) should survive: 5 rows * 10 cols = 50 points
    assert len(points_gdf) == 50
    assert "point_id" in points_gdf.columns
    assert "velocity" in points_gdf.columns
    assert "temporal_coherence" in points_gdf.columns
    assert "amplitude_dispersion" in points_gdf.columns
    assert points_gdf.crs.to_epsg() == 4326

    # Check all temporal coherence values are > threshold
    assert (points_gdf["temporal_coherence"] > 0.5).all()

    # Check timeseries table
    ts_table = pq.read_table(output_dir / "timeseries.parquet")
    ts_df = ts_table.to_pandas()
    assert len(ts_df) == 50 * n_dates  # 50 points * 5 dates
    assert set(ts_df.columns) == {"point_id", "date", "displacement"}

    # Check that each point has exactly n_dates entries
    counts = ts_df.groupby("point_id").size()
    assert (counts == n_dates).all()

    # Check column metadata for units
    displacement_field = ts_table.schema.field("displacement")
    assert displacement_field.metadata is not None
    assert displacement_field.metadata[b"units"] == b"mm"


def test_convert_dolphin_amplitude_filter(tmp_path):
    """Test that amplitude dispersion filter works."""
    work_dir = _make_synthetic_dolphin_dir(tmp_path)
    output_dir = tmp_path / "output"

    # Use amplitude threshold that should reject all points (threshold < 0.3)
    convert_dolphin(
        work_dir=str(work_dir),
        output_dir=str(output_dir),
        coherence_threshold=0.5,
        amplitude_dispersion_threshold=0.1,
    )

    points_gdf = gpd.read_parquet(output_dir / "points.parquet")
    # All points have amp_disp=0.3, threshold is 0.1 → none pass
    assert len(points_gdf) == 0
