"""Generate synthetic GeoParquet test data for Bowser V2.

Creates realistic-looking point cloud datasets with clustered spatial
patterns and linear velocity trends, suitable for both automated testing
and manual UI exploration.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import geopandas as gpd
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import Point

from .manifest import DatasetManifest, PointLayerConfig


def generate_testdata(
    output_dir: str | Path,
    n_points: int = 50_000,
    n_dates: int = 20,
    center_lon: float = -99.13,
    center_lat: float = 19.43,
    spread_deg: float = 0.15,
    layer_name: str = "synthetic",
    seed: int = 42,
) -> Path:
    """Generate synthetic point cloud + timeseries GeoParquet files.

    Parameters
    ----------
    output_dir
        Directory to write output files.
    n_points
        Number of measurement points to generate.
    n_dates
        Number of SAR acquisition dates.
    center_lon, center_lat
        Center of the synthetic AOI.
    spread_deg
        Approximate radius of the AOI in degrees.
    layer_name
        Name for the point layer in the manifest.
    seed
        Random seed for reproducibility.

    Returns
    -------
    Path
        Path to the generated bowser_manifest.json.
    """
    rng = np.random.default_rng(seed)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    print(f"Generating {n_points:,} points x {n_dates} dates...")

    # --- Spatial distribution: clustered, not uniform random ---
    # Create 5-10 clusters to simulate urban areas / subsidence bowls
    n_clusters = rng.integers(5, 11)
    cluster_centers = rng.normal(
        loc=[[center_lon, center_lat]],
        scale=spread_deg * 0.5,
        size=(n_clusters, 2),
    )
    cluster_sizes = rng.dirichlet(np.ones(n_clusters)) * n_points
    cluster_sizes = cluster_sizes.astype(int)
    cluster_sizes[-1] = n_points - cluster_sizes[:-1].sum()  # fix rounding

    lons = np.empty(n_points, dtype=np.float64)
    lats = np.empty(n_points, dtype=np.float64)
    cluster_ids = np.empty(n_points, dtype=np.int32)
    idx = 0
    for c_idx, (center, size) in enumerate(zip(cluster_centers, cluster_sizes)):
        cluster_spread = rng.uniform(0.005, 0.03)
        lons[idx : idx + size] = rng.normal(center[0], cluster_spread, size)
        lats[idx : idx + size] = rng.normal(center[1], cluster_spread, size)
        cluster_ids[idx : idx + size] = c_idx
        idx += size

    # --- Static attributes ---
    # Velocity: clusters have different mean velocities (some subsiding)
    cluster_velocities = rng.normal(0, 8, n_clusters)
    # Make one cluster a clear subsidence bowl
    cluster_velocities[0] = rng.uniform(-25, -15)
    velocity = np.empty(n_points, dtype=np.float32)
    for c_idx in range(n_clusters):
        mask = cluster_ids == c_idx
        velocity[mask] = rng.normal(cluster_velocities[c_idx], 2.0, mask.sum()).astype(
            np.float32
        )

    temporal_coherence = rng.uniform(0.3, 1.0, n_points).astype(np.float32)
    amplitude_dispersion = rng.uniform(0.05, 0.5, n_points).astype(np.float32)

    # --- Points GeoParquet ---
    geometry = [Point(lon, lat) for lon, lat in zip(lons, lats)]
    gdf = gpd.GeoDataFrame(
        {
            "point_id": np.arange(n_points, dtype=np.uint64),
            "velocity": velocity,
            "temporal_coherence": temporal_coherence,
            "amplitude_dispersion": amplitude_dispersion,
            "longitude": lons.astype(np.float64),
            "latitude": lats.astype(np.float64),
        },
        geometry=geometry,
        crs="EPSG:4326",
    )

    points_path = out / "points.parquet"
    gdf.to_parquet(points_path, row_group_size=min(100_000, n_points))
    print(f"  Wrote {points_path} ({n_points:,} points)")

    # --- Timeseries ---
    start_date = date(2020, 1, 1)
    dates = [start_date + timedelta(days=i * 12) for i in range(n_dates)]
    date_strings = [d.isoformat() for d in dates]

    total_rows = n_points * n_dates
    ts_point_ids = np.repeat(np.arange(n_points, dtype=np.uint64), n_dates)

    # Compute displacement: linear velocity * time + noise
    days_from_start = np.array([(d - start_date).days for d in dates], dtype=np.float32)
    disp = np.outer(velocity / 365.25, days_from_start)
    noise = rng.normal(0, 1.5, (n_points, n_dates)).astype(np.float32)
    disp = (disp + noise).astype(np.float32).ravel()

    ts_dates_repeated = np.tile(date_strings, n_points)

    ts_table = pa.table(
        {
            "point_id": pa.array(ts_point_ids, type=pa.uint64()),
            "date": pa.array(ts_dates_repeated, type=pa.string()),
            "displacement": pa.array(disp, type=pa.float32()),
        }
    )

    ts_path = out / "timeseries.parquet"
    row_group_size = min(n_points, 500) * n_dates
    pq.write_table(ts_table, ts_path, row_group_size=row_group_size)
    print(f"  Wrote {ts_path} ({total_rows:,} rows)")

    # --- Manifest ---
    manifest = DatasetManifest(
        name=f"synthetic_{n_points // 1000}k",
        description=f"Synthetic test data: {n_points:,} points, {n_dates} dates",
        layers={
            layer_name: PointLayerConfig(
                points_source=str(points_path.resolve()),
                timeseries_source=str(ts_path.resolve()),
                default_color_by="velocity",
            ),
        },
        bounds=[
            float(lons.min()),
            float(lats.min()),
            float(lons.max()),
            float(lats.max()),
        ],
    )

    manifest_path = out / "bowser_manifest.json"
    manifest.save(manifest_path)
    print(f"  Wrote {manifest_path}")
    print(f"\nTo view:\n  bowser run --manifest {manifest_path}")
    return manifest_path
