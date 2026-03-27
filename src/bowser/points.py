"""FastAPI router for vector point data, backed by DuckDB + GeoParquet.

Provides endpoints for querying, filtering, and retrieving time series
from GeoParquet point cloud datasets.
"""

from __future__ import annotations

import io
import logging
from typing import TYPE_CHECKING

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

if TYPE_CHECKING:
    from .manifest import PointLayerConfig

logger = logging.getLogger("bowser.points")

router = APIRouter(prefix="/points", tags=["Vector Points"])

# Module-level DuckDB connection, initialized by `init_point_layers`
_conn: duckdb.DuckDBPyConnection | None = None
_layers: dict[str, PointLayerConfig] = {}


def init_point_layers(layers: dict[str, PointLayerConfig]) -> None:
    """Initialize DuckDB connection and register GeoParquet files as views.

    Parameters
    ----------
    layers : dict[str, PointLayerConfig]
        Mapping of layer name to point layer config from the manifest.
    """
    global _conn, _layers
    _conn = duckdb.connect()
    _conn.install_extension("spatial")
    _conn.load_extension("spatial")
    _layers = layers

    for name, layer in layers.items():
        safe_name = _safe_identifier(name)
        _conn.execute(
            f"""
            CREATE VIEW {safe_name}_points AS
            SELECT * FROM read_parquet('{layer.points_source}')
        """
        )
        _conn.execute(
            f"""
            CREATE VIEW {safe_name}_timeseries AS
            SELECT * FROM read_parquet('{layer.timeseries_source}')
        """
        )
        logger.info(f"Registered point layer '{name}' from {layer.points_source}")


def _safe_identifier(name: str) -> str:
    """Convert a layer name to a safe SQL identifier."""
    return name.replace(" ", "_").replace("-", "_").lower()


def _get_conn() -> duckdb.DuckDBPyConnection:
    assert (
        _conn is not None
    ), "Point layers not initialized. Call init_point_layers first."
    return _conn


def _require_layer(layer_name: str) -> PointLayerConfig:
    if layer_name not in _layers:
        raise HTTPException(
            status_code=404, detail=f"Point layer '{layer_name}' not found"
        )
    return _layers[layer_name]


# --- Request/Response Models ---


class TimeseriesRequest(BaseModel):
    """Request body for multi-point time series."""

    point_ids: list[int]


class CrossSectionRequest(BaseModel):
    """Request body for cross-section profile."""

    line: list[list[float]]  # [[lon1, lat1], [lon2, lat2]]
    width_m: float = 200.0
    attribute: str = "velocity"


class AreaAverageRequest(BaseModel):
    """Request body for area averaging."""

    polygon: list[list[float]]  # [[lon1, lat1], [lon2, lat2], ...]
    max_points: int = 10000


# --- Endpoints ---


@router.get("/layers")
async def list_layers() -> dict:
    """List available point layers and their configuration."""
    return {
        name: {
            "default_color_by": layer.default_color_by,
            "default_colormap": layer.default_colormap,
            "default_vmin": layer.default_vmin,
            "default_vmax": layer.default_vmax,
        }
        for name, layer in _layers.items()
    }


@router.get("/{layer_name}/attributes")
async def get_attributes(layer_name: str) -> dict:
    """Get available columns with types and value ranges for a point layer.

    Used by the frontend to dynamically build filter UI and color-by dropdown.
    """
    _require_layer(layer_name)
    conn = _get_conn()
    safe = _safe_identifier(layer_name)

    # Get column info
    cols = conn.execute(f"DESCRIBE {safe}_points").fetchall()

    attributes = {}
    for col_name, col_type, *_ in cols:
        if col_name == "geometry":
            continue

        attr_info: dict = {"type": col_type}

        # Get value range for numeric columns
        if (
            "FLOAT" in col_type.upper()
            or "INT" in col_type.upper()
            or "DOUBLE" in col_type.upper()
        ):
            try:
                stats = conn.execute(
                    f"""
                    SELECT
                        MIN({col_name}) as min_val,
                        MAX({col_name}) as max_val,
                        AVG({col_name}) as mean_val,
                        COUNT({col_name}) as count
                    FROM {safe}_points
                """
                ).fetchone()
                attr_info["min"] = stats[0]
                attr_info["max"] = stats[1]
                attr_info["mean"] = stats[2]
                attr_info["count"] = stats[3]
            except duckdb.Error:
                pass

        attributes[col_name] = attr_info

    return {"layer": layer_name, "attributes": attributes}


@router.get("/{layer_name}")
async def get_points(
    layer_name: str,
    bbox: str | None = Query(None, description="Bounding box: west,south,east,north"),
    color_by: str = Query("velocity", description="Attribute to include for coloring"),
    point_filter: str | None = Query(
        None, alias="filter", description="Filter expression, e.g. 'velocity<-10'"
    ),
    max_points: int = Query(100_000, description="Maximum number of points to return"),
) -> Response:
    """Get points within a bounding box, returned as Arrow IPC.

    The response contains columns: point_id, lon, lat, and the color_by attribute.
    """
    _require_layer(layer_name)
    conn = _get_conn()
    safe = _safe_identifier(layer_name)

    # Build WHERE clause
    where_parts: list[str] = []

    if bbox:
        parts = [float(x) for x in bbox.split(",")]
        assert len(parts) == 4, f"bbox must have 4 values, got {len(parts)}"
        west, south, east, north = parts
        where_parts.append(
            f"ST_X(geometry) BETWEEN {west} AND {east} "
            f"AND ST_Y(geometry) BETWEEN {south} AND {north}"
        )

    if point_filter:
        # Sanitize: only allow simple expressions on known columns
        sanitized = _sanitize_filter(point_filter, safe, conn)
        where_parts.append(sanitized)

    where_clause = " AND ".join(where_parts) if where_parts else "TRUE"

    # Validate color_by column exists
    valid_cols = {
        row[0]
        for row in conn.execute(f"DESCRIBE {safe}_points").fetchall()
        if row[0] != "geometry"
    }
    if color_by not in valid_cols:
        color_by = "point_id"  # fallback

    sql = f"""
        SELECT
            point_id,
            ST_X(geometry) as lon,
            ST_Y(geometry) as lat,
            {color_by}
        FROM {safe}_points
        WHERE {where_clause}
        LIMIT {max_points}
    """

    try:
        arrow_table = conn.execute(sql).arrow().read_all()
    except duckdb.Error as e:
        raise HTTPException(status_code=400, detail=f"Query error: {e}")

    # Serialize as Arrow IPC
    sink = pa.BufferOutputStream()
    writer = ipc.new_stream(sink, arrow_table.schema)
    writer.write_table(arrow_table)
    writer.close()

    return Response(
        content=sink.getvalue().to_pybytes(),
        media_type="application/vnd.apache.arrow.stream",
        headers={"X-Point-Count": str(len(arrow_table))},
    )


@router.get("/{layer_name}/{point_id}/timeseries")
async def get_point_timeseries(
    layer_name: str,
    point_id: int,
    start_date: str | None = Query(None, description="Start date filter (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="End date filter (YYYY-MM-DD)"),
) -> list[dict]:
    """Get time series for a single point."""
    _require_layer(layer_name)
    conn = _get_conn()
    safe = _safe_identifier(layer_name)

    where_parts = [f"point_id = {int(point_id)}"]
    if start_date:
        where_parts.append(f"date >= '{start_date}'")
    if end_date:
        where_parts.append(f"date <= '{end_date}'")

    sql = f"""
        SELECT date, displacement
        FROM {safe}_timeseries
        WHERE {' AND '.join(where_parts)}
        ORDER BY date
    """

    try:
        result = conn.execute(sql).fetchall()
    except duckdb.Error as e:
        raise HTTPException(status_code=400, detail=f"Query error: {e}")

    return [
        {"date": str(row[0]), "displacement": float(row[1])}
        for row in result
        if not np.isnan(row[1])
    ]


@router.post("/{layer_name}/timeseries")
async def get_multi_point_timeseries(
    layer_name: str,
    request: TimeseriesRequest,
) -> dict:
    """Get time series for multiple points at once."""
    _require_layer(layer_name)
    conn = _get_conn()
    safe = _safe_identifier(layer_name)

    point_ids = [int(p) for p in request.point_ids]
    ids_str = ",".join(str(p) for p in point_ids)

    sql = f"""
        SELECT point_id, date, displacement
        FROM {safe}_timeseries
        WHERE point_id IN ({ids_str})
        ORDER BY point_id, date
    """

    try:
        result = conn.execute(sql).fetchall()
    except duckdb.Error as e:
        raise HTTPException(status_code=400, detail=f"Query error: {e}")

    # Group by point_id
    series: dict[int, list[dict]] = {pid: [] for pid in point_ids}
    for point_id, date, displacement in result:
        if np.isnan(displacement):
            continue
        series[point_id].append(
            {
                "date": str(date),
                "displacement": float(displacement),
            }
        )

    return {"series": series}


@router.get("/{layer_name}/stats")
async def get_stats(
    layer_name: str,
    bbox: str | None = Query(None, description="Bounding box: west,south,east,north"),
    point_filter: str | None = Query(
        None, alias="filter", description="Filter expression"
    ),
) -> dict:
    """Get summary statistics for points in the current view."""
    _require_layer(layer_name)
    conn = _get_conn()
    safe = _safe_identifier(layer_name)

    where_parts: list[str] = []
    if bbox:
        parts = [float(x) for x in bbox.split(",")]
        west, south, east, north = parts
        where_parts.append(
            f"ST_X(geometry) BETWEEN {west} AND {east} "
            f"AND ST_Y(geometry) BETWEEN {south} AND {north}"
        )
    if point_filter:
        sanitized = _sanitize_filter(point_filter, safe, conn)
        where_parts.append(sanitized)

    where_clause = " AND ".join(where_parts) if where_parts else "TRUE"

    # Build dynamic stats query for all numeric columns
    cols = conn.execute(f"DESCRIBE {safe}_points").fetchall()
    numeric_cols = [
        row[0]
        for row in cols
        if row[0] != "geometry"
        and ("FLOAT" in row[1].upper() or "DOUBLE" in row[1].upper())
    ]

    agg_parts = ["COUNT(*) as count"]
    for col in numeric_cols:
        agg_parts.extend(
            [
                f"AVG({col}) as {col}_mean",
                f"STDDEV({col}) as {col}_std",
                f"MIN({col}) as {col}_min",
                f"MAX({col}) as {col}_max",
            ]
        )

    sql = f"""
        SELECT {', '.join(agg_parts)}
        FROM {safe}_points
        WHERE {where_clause}
    """

    try:
        result = conn.execute(sql).fetchone()
        col_names = [desc[0] for desc in conn.execute(sql).description]
    except duckdb.Error as e:
        raise HTTPException(status_code=400, detail=f"Query error: {e}")

    stats = {}
    for name, val in zip(col_names, result):
        if val is not None and not (isinstance(val, float) and np.isnan(val)):
            stats[name] = val

    return stats


@router.get("/{layer_name}/export")
async def export_points(
    layer_name: str,
    export_format: str = Query(
        "csv", alias="format", description="Export format: csv, geojson, parquet"
    ),
    bbox: str | None = Query(None, description="Bounding box: west,south,east,north"),
    point_filter: str | None = Query(
        None, alias="filter", description="Filter expression"
    ),
    max_points: int = Query(500_000, description="Maximum points to export"),
    include_timeseries: bool = Query(
        False, description="Include displacement time series in export"
    ),
) -> StreamingResponse:
    """Export filtered points as CSV, GeoJSON, or GeoParquet."""
    _require_layer(layer_name)
    conn = _get_conn()
    safe = _safe_identifier(layer_name)

    where_parts: list[str] = []
    if bbox:
        parts = [float(x) for x in bbox.split(",")]
        assert len(parts) == 4
        west, south, east, north = parts
        where_parts.append(
            f"ST_X(geometry) BETWEEN {west} AND {east} "
            f"AND ST_Y(geometry) BETWEEN {south} AND {north}"
        )
    if point_filter:
        sanitized = _sanitize_filter(point_filter, safe, conn)
        where_parts.append(sanitized)

    where_clause = " AND ".join(where_parts) if where_parts else "TRUE"

    # Get all non-geometry columns
    cols = conn.execute(f"DESCRIBE {safe}_points").fetchall()
    select_cols = [
        row[0]
        if row[0] != "geometry"
        else "ST_X(geometry) as longitude, ST_Y(geometry) as latitude"
        for row in cols
    ]

    sql = f"""
        SELECT {', '.join(select_cols)}
        FROM {safe}_points
        WHERE {where_clause}
        LIMIT {max_points}
    """

    try:
        result = conn.execute(sql).arrow().read_all()
    except duckdb.Error as e:
        raise HTTPException(status_code=400, detail=f"Query error: {e}")

    if include_timeseries:
        point_ids = result.column("point_id").to_pylist()
        if point_ids:
            ids_str = ",".join(str(int(p)) for p in point_ids)
            ts_sql = f"""
                SELECT point_id, date, displacement
                FROM {safe}_timeseries
                WHERE point_id IN ({ids_str})
                ORDER BY point_id, date
            """
            ts_result = conn.execute(ts_sql).arrow().read_all()
        else:
            ts_result = None
    else:
        ts_result = None

    if export_format == "csv":
        import pyarrow.csv as csv_writer

        buf = io.BytesIO()
        csv_writer.write_csv(result, buf)
        if ts_result is not None:
            buf.write(b"\n\n# Timeseries\n")
            csv_writer.write_csv(ts_result, buf)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="{layer_name}_points.csv"'
            },
        )

    elif export_format == "geojson":
        import json

        df = result.to_pandas()
        features = []
        for _, row in df.iterrows():
            props = {
                k: (float(v) if isinstance(v, (np.floating, float)) else v)
                for k, v in row.items()
                if k not in ("longitude", "latitude")
            }
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [
                            float(row["longitude"]),
                            float(row["latitude"]),
                        ],
                    },
                    "properties": props,
                }
            )

        geojson = {"type": "FeatureCollection", "features": features}
        content = json.dumps(geojson).encode()
        return StreamingResponse(
            io.BytesIO(content),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{layer_name}_points.geojson"'
                )
            },
        )

    elif export_format == "parquet":
        import pyarrow.parquet as pq

        buf = io.BytesIO()
        pq.write_table(result, buf)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{layer_name}_points.parquet"'
                )
            },
        )

    else:
        raise HTTPException(status_code=400, detail=f"Unknown format: {export_format}")


# --- Filter Sanitization ---

# Allowed operators in filter expressions
_ALLOWED_OPS = {"<", ">", "<=", ">=", "=", "!=", "<>"}


def _sanitize_filter(
    filter_expr: str,
    safe_layer: str,
    conn: duckdb.DuckDBPyConnection,
) -> str:
    """Sanitize a user-provided filter expression.

    Only allows simple `column op value` expressions joined by AND.
    Validates that column names exist in the table.
    """
    valid_cols = {
        row[0]
        for row in conn.execute(f"DESCRIBE {safe_layer}_points").fetchall()
        if row[0] != "geometry"
    }

    parts = []
    for clause in filter_expr.split(","):
        clause = clause.strip()
        if not clause:
            continue

        # Parse: column_name operator value
        found = False
        for op in sorted(_ALLOWED_OPS, key=len, reverse=True):
            if op in clause:
                col, val = clause.split(op, 1)
                col = col.strip()
                val = val.strip()

                assert col in valid_cols, f"Unknown column: {col}"
                # Validate value is numeric
                float(val)  # raises ValueError if not numeric

                parts.append(f"{col} {op} {val}")
                found = True
                break

        assert found, f"Invalid filter clause: {clause}"

    return " AND ".join(parts)
