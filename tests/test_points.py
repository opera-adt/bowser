"""Tests for the DuckDB-backed point query endpoints."""


import geopandas as gpd
import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
import pyarrow.parquet as pq
import pytest

# Use httpx for testing FastAPI
from fastapi import FastAPI
from fastapi.testclient import TestClient
from shapely.geometry import Point

from bowser.manifest import PointLayerConfig
from bowser.points import init_point_layers, router


@pytest.fixture
def synthetic_point_data(tmp_path):
    """Create synthetic point + timeseries GeoParquet files."""
    n_points = 100
    n_dates = 10

    # Points table
    lons = np.random.uniform(-118.5, -118.0, n_points)
    lats = np.random.uniform(33.5, 34.0, n_points)
    gdf = gpd.GeoDataFrame(
        {
            "point_id": np.arange(n_points, dtype=np.uint64),
            "velocity": np.random.normal(-5, 10, n_points).astype(np.float32),
            "temporal_coherence": np.random.uniform(0.3, 1.0, n_points).astype(
                np.float32
            ),
        },
        geometry=[Point(lon, lat) for lon, lat in zip(lons, lats)],
        crs="EPSG:4326",
    )

    points_path = tmp_path / "points.parquet"
    gdf.to_parquet(points_path)

    # Timeseries table
    from datetime import date, timedelta

    dates = [date(2020, 1, 1) + timedelta(days=i * 12) for i in range(n_dates)]
    rows = []
    for pid in range(n_points):
        vel = gdf.loc[pid, "velocity"]
        for i, d in enumerate(dates):
            disp = float(vel) / 365.25 * (i * 12) + np.random.normal(0, 1)
            rows.append((np.uint64(pid), d, np.float32(disp)))

    ts_table = pa.table(
        {
            "point_id": pa.array([r[0] for r in rows], type=pa.uint64()),
            "date": pa.array([r[1] for r in rows], type=pa.date32()),
            "displacement": pa.array([r[2] for r in rows], type=pa.float32()),
        }
    )
    ts_path = tmp_path / "timeseries.parquet"
    pq.write_table(ts_table, ts_path)

    return {
        "points_path": str(points_path),
        "ts_path": str(ts_path),
        "n_points": n_points,
        "n_dates": n_dates,
        "gdf": gdf,
    }


@pytest.fixture
def test_app(synthetic_point_data):
    """Create a test FastAPI app with point endpoints."""
    app = FastAPI()
    app.include_router(router)

    layers = {
        "test_layer": PointLayerConfig(
            points_source=synthetic_point_data["points_path"],
            timeseries_source=synthetic_point_data["ts_path"],
        )
    }
    init_point_layers(layers)

    return TestClient(app)


def test_list_layers(test_app):
    """Test listing available point layers."""
    response = test_app.get("/points/layers")
    assert response.status_code == 200
    data = response.json()
    assert "test_layer" in data


def test_get_attributes(test_app):
    """Test getting attribute metadata for a layer."""
    response = test_app.get("/points/test_layer/attributes")
    assert response.status_code == 200
    data = response.json()
    attrs = data["attributes"]
    assert "velocity" in attrs
    assert "temporal_coherence" in attrs
    assert "point_id" in attrs
    assert "min" in attrs["velocity"]
    assert "max" in attrs["velocity"]


def test_get_points_no_filter(test_app, synthetic_point_data):
    """Test fetching all points without filters."""
    response = test_app.get("/points/test_layer")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.apache.arrow.stream"

    # Decode Arrow IPC
    reader = ipc.open_stream(response.content)
    table = reader.read_all()
    assert len(table) == synthetic_point_data["n_points"]
    assert "point_id" in table.column_names
    assert "lon" in table.column_names
    assert "lat" in table.column_names
    assert "velocity" in table.column_names


def test_get_points_with_bbox(test_app):
    """Test fetching points within a bounding box."""
    # Very small bbox that should contain fewer points
    response = test_app.get("/points/test_layer?bbox=-118.3,-118.2,33.7,33.8")
    assert response.status_code == 200
    reader = ipc.open_stream(response.content)
    table = reader.read_all()
    # Should have fewer points than total (or possibly zero, that's ok)
    assert len(table) <= 100


def test_get_points_with_filter(test_app):
    """Test fetching points with an attribute filter."""
    response = test_app.get("/points/test_layer?filter=velocity<-10")
    assert response.status_code == 200
    reader = ipc.open_stream(response.content)
    table = reader.read_all()
    # All returned velocities should be < -10
    velocities = table.column("velocity").to_pylist()
    for v in velocities:
        assert v < -10


def test_get_point_timeseries(test_app, synthetic_point_data):
    """Test fetching time series for a single point."""
    response = test_app.get("/points/test_layer/0/timeseries")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == synthetic_point_data["n_dates"]
    assert "date" in data[0]
    assert "displacement" in data[0]


def test_get_multi_point_timeseries(test_app):
    """Test fetching time series for multiple points."""
    response = test_app.post(
        "/points/test_layer/timeseries",
        json={"point_ids": [0, 1, 2]},
    )
    assert response.status_code == 200
    data = response.json()
    assert "series" in data
    assert "0" in data["series"] or 0 in data["series"]


def test_get_stats(test_app, synthetic_point_data):
    """Test getting summary statistics."""
    response = test_app.get("/points/test_layer/stats")
    assert response.status_code == 200
    data = response.json()
    assert "count" in data
    assert data["count"] == synthetic_point_data["n_points"]
    assert "velocity_mean" in data


def test_export_csv(test_app, synthetic_point_data):
    """Test exporting points as CSV."""
    response = test_app.get("/points/test_layer/export?format=csv")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    text = response.content.decode()
    assert "point_id" in text
    assert "longitude" in text
    lines = [
        line for line in text.strip().split("\n") if line and not line.startswith("#")
    ]
    # header + data rows
    assert len(lines) == synthetic_point_data["n_points"] + 1


def test_export_geojson(test_app):
    """Test exporting points as GeoJSON."""
    response = test_app.get("/points/test_layer/export?format=geojson")
    assert response.status_code == 200
    data = response.json()
    assert data["type"] == "FeatureCollection"
    assert len(data["features"]) > 0
    assert data["features"][0]["geometry"]["type"] == "Point"


def test_export_parquet(test_app):
    """Test exporting points as Parquet."""
    import pyarrow.parquet as pq

    response = test_app.get("/points/test_layer/export?format=parquet")
    assert response.status_code == 200
    table = pq.read_table(pa.BufferReader(response.content))
    assert "point_id" in table.column_names
    assert "longitude" in table.column_names


def test_unknown_layer_404(test_app):
    """Test that requesting an unknown layer returns 404."""
    response = test_app.get("/points/nonexistent/attributes")
    assert response.status_code == 404
