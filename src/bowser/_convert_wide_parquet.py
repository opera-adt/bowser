"""Convert wide-form point cloud parquet to Bowser V2 two-table format.

Handles parquet files where displacement time series are stored as
wide-form date columns (e.g., from sarlet's export_points_to_parquet).
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from .manifest import DatasetManifest, PointLayerConfig

# Pattern for date-pair columns like "20240626_20240629"
_DATE_PAIR_RE = re.compile(r"^(\d{8})_(\d{8})$")
# Pattern for single-date columns like "20240626"
_SINGLE_DATE_RE = re.compile(r"^(\d{8})$")


def _identify_date_columns(
    columns: list[str],
) -> tuple[list[str], list[tuple[datetime, datetime | None]]]:
    """Identify which columns are date/date-pair displacement values.

    Parameters
    ----------
    columns : list[str]
        All column names in the parquet file.

    Returns
    -------
    date_cols : list[str]
        Column names that match date patterns.
    parsed_dates : list[tuple[datetime, datetime | None]]
        Parsed (reference_date, secondary_date) pairs.
        For single-date columns, secondary_date is None.
    """
    date_cols: list[str] = []
    parsed_dates: list[tuple[datetime, datetime | None]] = []

    for col in columns:
        m = _DATE_PAIR_RE.match(col)
        if m:
            ref = datetime.strptime(m.group(1), "%Y%m%d")
            sec = datetime.strptime(m.group(2), "%Y%m%d")
            date_cols.append(col)
            parsed_dates.append((ref, sec))
            continue

        m = _SINGLE_DATE_RE.match(col)
        if m:
            d = datetime.strptime(m.group(1), "%Y%m%d")
            date_cols.append(col)
            parsed_dates.append((d, None))

    return date_cols, parsed_dates


# Columns that are NOT date columns and NOT geometry/coordinate columns
# These are static point attributes to keep in the points table
_COORDINATE_COLS = {"longitude", "latitude", "geometry", "lon", "lat"}


def convert_wide_parquet(
    input_file: str,
    output_dir: str,
    layer_name: str = "ps_points",
) -> Path:
    """Convert a wide-form point cloud parquet to Bowser V2 two-table format.

    Parameters
    ----------
    input_file : str
        Path to the wide-form GeoParquet file.
    output_dir : str
        Directory to write output files.
    layer_name : str
        Name for the point layer in the manifest.

    Returns
    -------
    Path
        Path to the generated bowser_manifest.json.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"Reading {input_file}...")
    table = pq.read_table(input_file)
    all_columns = table.column_names
    n_points = len(table)
    print(f"  {n_points:,} points, {len(all_columns)} columns")

    # Identify date columns vs static attribute columns
    date_cols, parsed_dates = _identify_date_columns(all_columns)
    assert date_cols, f"No date columns found in {all_columns}"

    n_dates = len(date_cols)
    print(f"  {n_dates} date columns: {date_cols[0]} ... {date_cols[-1]}")

    # Check if all date pairs share a reference date (single-reference time series)
    ref_dates = {d[0] for d in parsed_dates}
    if len(ref_dates) == 1:
        ref_date = ref_dates.pop()
        print(f"  Single reference date: {ref_date.strftime('%Y-%m-%d')}")
        # For display, use secondary dates
        display_dates = []
        for _, sec in parsed_dates:
            display_dates.append(sec if sec is not None else _)
    else:
        ref_date = None
        # Use the first date in each pair
        display_dates = [d[0] for d in parsed_dates]

    # Separate static attributes from date columns
    static_cols = [
        c for c in all_columns if c not in date_cols and c not in _COORDINATE_COLS
    ]
    print(f"  Static attributes: {static_cols}")

    # --- Build points table ---
    # Add point_id
    point_ids = np.arange(n_points, dtype=np.uint64)

    # Extract geometry info from the GeoParquet
    # Try to get lon/lat from explicit columns first, then from geometry
    if "longitude" in all_columns and "latitude" in all_columns:
        lons = table.column("longitude").to_numpy()
        lats = table.column("latitude").to_numpy()
    elif "lon" in all_columns and "lat" in all_columns:
        lons = table.column("lon").to_numpy()
        lats = table.column("lat").to_numpy()
    else:
        # Extract from WKB geometry column
        import geopandas as gpd

        gdf = gpd.read_parquet(input_file, columns=["geometry"])
        lons = gdf.geometry.x.to_numpy()
        lats = gdf.geometry.y.to_numpy()

    # Build points Arrow table
    points_columns = {
        "point_id": pa.array(point_ids, type=pa.uint64()),
    }
    # Add static attributes, upcasting float16 to float32 for DuckDB compatibility
    for col in static_cols:
        arr = table.column(col)
        if pa.types.is_float16(arr.type):
            arr = arr.cast(pa.float32())
        points_columns[col] = arr

    # Add geometry as lon/lat (DuckDB will use these for spatial queries)
    points_columns["longitude"] = pa.array(lons, type=pa.float64())
    points_columns["latitude"] = pa.array(lats, type=pa.float64())

    # Also preserve the WKB geometry column if present
    if "geometry" in all_columns:
        points_columns["geometry"] = table.column("geometry")

    points_table = pa.table(points_columns)
    points_path = output_path / "points.parquet"

    # Preserve GeoParquet metadata if present
    geo_meta = table.schema.metadata.get(b"geo") if table.schema.metadata else None
    if geo_meta:
        existing_meta = points_table.schema.metadata or {}
        points_table = points_table.replace_schema_metadata(
            {**existing_meta, b"geo": geo_meta}
        )

    print(
        f"Writing {points_path} ({n_points:,} points, {len(static_cols)} attributes)..."
    )
    pq.write_table(points_table, points_path, row_group_size=100_000)

    # --- Build time series table ---
    # Melt wide format to long format: (point_id, date, displacement)
    print(f"Melting {n_dates} date columns to long format...")

    total_rows = n_points * n_dates
    ts_point_ids = np.repeat(point_ids, n_dates)
    ts_dates = [d.date() for d in display_dates] * n_points
    ts_displacement = np.empty(total_rows, dtype=np.float32)

    for i, col_name in enumerate(date_cols):
        arr = table.column(col_name)
        # float16 → float32 for DuckDB compatibility
        if pa.types.is_float16(arr.type):
            arr = arr.cast(pa.float32())
        col_data = arr.to_numpy()
        ts_displacement[i::n_dates] = col_data

    # Row group size: ~500 points worth of dates per group
    points_per_group = 500
    row_group_size = points_per_group * n_dates

    ts_table = pa.table(
        {
            "point_id": pa.array(ts_point_ids, type=pa.uint64()),
            "date": pa.array(ts_dates, type=pa.date32()),
            "displacement": pa.array(ts_displacement, type=pa.float32()),
        }
    )

    ts_path = output_path / "timeseries.parquet"
    print(
        f"Writing {ts_path} ({total_rows:,} rows, "
        f"~{row_group_size:,} rows/group)..."
    )
    pq.write_table(ts_table, ts_path, row_group_size=row_group_size)

    # --- Build manifest ---
    bounds = [
        float(lons.min()),
        float(lats.min()),
        float(lons.max()),
        float(lats.max()),
    ]

    default_color_by = "velocity" if "velocity" in static_cols else static_cols[0]

    manifest = DatasetManifest(
        name=Path(input_file).stem,
        description=f"Converted from {input_file}",
        reference_date=(ref_date.strftime("%Y-%m-%d") if ref_date else None),
        layers={
            layer_name: PointLayerConfig(
                points_source=str(points_path.resolve()),
                timeseries_source=str(ts_path.resolve()),
                default_color_by=default_color_by,
                default_colormap="RdBu_r",
            ),
        },
        bounds=bounds,
    )

    manifest_path = output_path / "bowser_manifest.json"
    manifest.save(manifest_path)
    print(f"Manifest written to {manifest_path}")

    return manifest_path
