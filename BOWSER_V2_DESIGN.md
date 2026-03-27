# Bowser V2: Design Document

> **Status:** Draft
> **Date:** 2026-03-22
> **Authors:** Scott Staniewicz + Claude

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Competitive Landscape](#2-competitive-landscape)
3. [V2 Vision & Principles](#3-v2-vision--principles)
4. [Data Model](#4-data-model)
5. [Architecture Overview](#5-architecture-overview)
6. [Backend Design](#6-backend-design)
7. [Frontend Design](#7-frontend-design)
8. [UX Design](#8-ux-design)
9. [Technology Choices](#9-technology-choices)
10. [Migration from V1](#10-migration-from-v1)
11. [Implementation Phases](#11-implementation-phases)
12. [Open Questions](#12-open-questions)

---

## 1. Motivation

Bowser V1 is a raster-first tool: every pixel on the map is a tile rendered from COGs or xarray datasets. This works well for continuous fields (unwrapped phase, coherence maps, displacement grids), but InSAR increasingly produces **point-based outputs** that don't fit the raster model:

- **Persistent Scatterer (PS) points** — sparse, irregularly-spaced measurement points with per-point time series and attributes (velocity, coherence, height, etc.)
- **Distributed Scatterer (DS) points** — similar to PS but from different processing pipelines
- **SBAS pixel subsets** — not every pixel survives temporal coherence thresholds; the result is a sparse point cloud, not a full grid
- **GPS/GNSS stations** — ground truth reference points with their own time series
- **OPERA DISP-S1 post-processed results** — velocity, amplitude dispersion, etc. that are per-point

Commercial platforms (IRIS, TRE-MAPS) already handle this well. TRE-MAPS in particular is entirely point-based — users filter, color, select, and export individual measurement points. IRIS offers raster views with point-level inspection. Neither is open source, and both are tightly coupled to their respective processing pipelines.

**Bowser V2 should be the open-source answer**: a viewer that handles both rasters AND points natively, leveraging the huge recent improvements in cloud-native vector data (GeoParquet, DuckDB, deck.gl, PMTiles).

---

## 2. Competitive Landscape

### IRIS (EarthDaily Analytics)

**Strengths:**
- Multi-panel map comparison (reference image / InSAR overlay / amplitude)
- Processing sandbox — users can trigger re-processing from the UI
- Anomaly detection layer
- Clean dark-themed UI with well-integrated time series chart
- GPS ground monitoring overlay

**Weaknesses:**
- Raster-only visualization — no point-level attribute filtering
- Three-panel layout wastes screen space when you only need one view
- Heavy, proprietary platform tied to EarthDaily's processing pipeline
- No export capabilities visible in the UI

**Key takeaway:** The multi-panel comparison and anomaly detection are powerful ideas. The tight integration between spatial view and time series chart is table-stakes.

### TRE-MAPS (TRE-ALTAMIRA)

**Strengths:**
- Point-based data model with rich per-point attributes (velocity, height, displacement, effective area, perimeter)
- Three-tier filtering: by attribute, by date range, by symbology
- Cross-section / profile tool — draw a transect line, see displacement along it
- Polygon selection for area averaging (up to 10k points)
- Multi-format export (CSV, Geodatabase, Shapefile, KMZ)
- Multiple time series in one chart (shift+click)

**Weaknesses:**
- Dated UI (ArcGIS/ESRI-era design)
- Limited to 1,000 points per export
- Data archived after 3 months of inactivity
- Only Chrome/Firefox supported
- No raster layer support — can't overlay coherence or amplitude maps

**Key takeaway:** The attribute filtering, symbology control, and cross-section tool are essential for point data. The 300-column CSV problem (like EGMS) shows the need for a clean, opinionated data model.

### EGMS (European Ground Motion Service)

**Relevant context:** EGMS distributes PS/DS point data as massive CSVs with ~300 columns (one per acquisition date for displacement values, plus metadata columns). This is the "data model anti-pattern" we want to avoid.

---

## 3. V2 Vision & Principles

### Vision

Bowser V2 is a **dual-mode InSAR viewer** that treats rasters and point clouds as first-class citizens. A researcher should be able to:

1. Load a displacement raster stack AND a set of PS points over the same AOI
2. See both layers simultaneously on the map
3. Click a PS point to see its time series, or click the raster to sample pixel values
4. Filter points by velocity, coherence, or any attribute
5. Draw a transect and see a cross-section profile
6. Export selected points with their full time series

### Design Principles

1. **Rasters + Vectors, unified** — One app, one map, both data types. No mode switching.
2. **GeoParquet as the canonical point format** — Columnar, cloud-native, typed, self-describing. No 300-column CSVs.
3. **Server does the heavy lifting, client does the rendering** — DuckDB handles filtering/aggregation on the server; the browser renders the result via WebGL.
4. **Progressive disclosure** — Simple view by default (map + time series). Power features (filtering, cross-sections, export) available but not in your face.
5. **URL-driven state** — Every view should be shareable via URL. Dataset, viewport, active filters, selected points — all encoded in the URL.
6. **Open formats, open source** — No vendor lock-in. Standard formats in, standard formats out.

---

## 4. Data Model

### 4.1 The Problem with Wide CSVs

EGMS and similar services distribute point data as wide-format CSVs:

```
lon, lat, velocity, coherence, 2016-01-01, 2016-01-13, 2016-01-25, ...
-118.25, 34.05, -12.3, 0.85, 0.0, -1.2, -2.1, ...
```

Problems: hundreds of date columns, no type information, no metadata, can't efficiently query a subset of dates, enormous file sizes, hard to extend with new attributes.

### 4.2 Bowser V2 Point Data Model

We adopt a **normalized, long-form model** stored as GeoParquet. The data is split into two logical tables that can live in one or two files:

#### Points Table (`points.parquet`)

One row per measurement point. Stores spatial location and static attributes.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `point_id` | `uint64` | yes | Unique identifier |
| `geometry` | `POINT` | yes | WGS84 lon/lat (GeoParquet native) |
| `velocity` | `float32` | no | Mean velocity (mm/yr), LOS |
| `velocity_std` | `float32` | no | Velocity uncertainty |
| `temporal_coherence` | `float32` | no | Temporal coherence [0, 1] |
| `height` | `float32` | no | Estimated height (m) above reference DEM |
| `amplitude_dispersion` | `float32` | no | Amplitude dispersion index |
| `reference_point_id` | `uint64` | no | Which point is the spatial reference |

Design choices:
- **`point_id` as uint64** rather than a compound key. Simple, fast joins, small index.
- **Static attributes only** in this table. Anything that varies per date goes in the time series table.
- **Optional columns are truly optional** — GeoParquet handles missing columns gracefully. A PS dataset might have `amplitude_dispersion`; a SBAS dataset might not. The frontend dynamically discovers available columns via the `/points/{layer}/attributes` endpoint.
- **No CRS column** — GeoParquet metadata carries the CRS (EPSG:4326 by default). Projections happen at query/render time.
- **Units stored in Parquet column metadata** — Each column carries a `units` key in its Parquet metadata (e.g., `{"units": "mm/yr"}` for velocity). The backend reads these and passes them to the frontend for axis labels and tooltips.

#### Time Series Table (`timeseries.parquet`)

One row per (point, date) pair. Long-form — the number of columns is fixed regardless of how many dates exist.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `point_id` | `uint64` | yes | FK to points table |
| `date` | `date32` | yes | Acquisition date |
| `displacement` | `float32` | yes | Cumulative displacement (mm), LOS |
| `displacement_std` | `float32` | no | Per-epoch uncertainty |

Design choices:
- **Long-form is non-negotiable.** Adding a new acquisition date is appending rows, not adding columns. Queries like "all displacements between 2020-01-01 and 2021-01-01" are a simple `WHERE` clause, not selecting 50 columns by name.
- **`date32`** not a string. Enables native date arithmetic, range queries, sorting.
- **Row group layout is critical for performance.** See section 4.5.

#### Why Two Tables?

Joining is cheap (especially in DuckDB). The alternative — embedding the full time series as a nested array column — makes point-level metadata queries fast but time-range queries slow, and prevents columnar compression of the displacement values.

For datasets where separate files are inconvenient, both tables can be stored in a single GeoParquet file using row groups or a single Parquet file with a `table` discriminator column. But logically, they are two relations.

### 4.3 Dataset Manifest

A Bowser V2 dataset is described by a JSON manifest that references both raster and vector sources:

```json
{
  "name": "LA Basin PS Analysis",
  "description": "Sentinel-1 descending, 2016-2023",
  "satellite": "Sentinel-1",
  "orbit": "descending",
  "track": 71,
  "reference_date": "2016-07-01",

  "layers": {
    "displacement": {
      "type": "raster",
      "source": "s3://bucket/displacement_stack.zarr",
      "colormap": "RdBu_r",
      "units": "mm",
      "vmin": -50,
      "vmax": 50
    },
    "coherence": {
      "type": "raster",
      "source": "s3://bucket/temporal_coherence.tif",
      "colormap": "inferno",
      "units": "",
      "vmin": 0,
      "vmax": 1
    },
    "ps_points": {
      "type": "points",
      "points_source": "s3://bucket/ps_points.parquet",
      "timeseries_source": "s3://bucket/ps_timeseries.parquet",
      "default_color_by": "velocity",
      "default_colormap": "RdBu_r",
      "default_vmin": -30,
      "default_vmax": 30
    },
    "gps_stations": {
      "type": "points",
      "points_source": "s3://bucket/gps_stations.parquet",
      "timeseries_source": "s3://bucket/gps_timeseries.parquet",
      "default_color_by": "velocity",
      "marker_style": "triangle"
    }
  },

  "bounds": [-118.8, 33.5, -117.5, 34.3]
}
```

This is deliberately simple:
- **Flat, no nesting beyond `layers`** — easy to hand-write, easy to generate programmatically
- **Each layer declares its type** — `raster` or `points` — so the frontend knows how to render it
- **Defaults are suggestions** — the user can change colormap/range in the UI
- **Sources can be local paths or S3 URIs** — the backend resolves them

### 4.4 Conversion Utilities

Converters are prioritized by what we can test immediately:

#### Priority 1: Dolphin raster → point cloud (`bowser convert dolphin`)

This is the primary early use case. A dolphin workflow directory contains:
- `timeseries/YYYYMMDD.tif` — displacement rasters (one per date)
- `timeseries/velocity.tif` — velocity map
- `timeseries/velocity_stderr.tif` — velocity uncertainty
- `interferograms/temporal_coherence_*.tif` — temporal coherence
- `interferograms/amp_dispersion_looked*.tif` — amplitude dispersion
- `interferograms/similarity_*.tif` — phase similarity
- `interferograms/ps_mask_looked*.tif` — PS mask

The converter:
1. Reads the quality rasters (temporal coherence, amplitude dispersion, etc.)
2. Applies a mask to select "good" pixels (e.g., `temporal_coherence > threshold`)
3. Extracts lon/lat for surviving pixels
4. Reads displacement values at those pixel locations across all dates
5. Writes `points.parquet` (point_id, geometry, velocity, temporal_coherence, amplitude_dispersion, ...) and `timeseries.parquet` (point_id, date, displacement)
6. Generates a `bowser_manifest.json` referencing both the original rasters and the new point layers

```bash
bowser convert dolphin /path/to/dolphin_work_dir \
  --coherence-threshold 0.5 \
  --output-dir ./dolphin_points/
```

#### Priority 2: MintPy HDF5

```bash
bowser convert mintpy --input timeseries.h5 --output-dir ./mintpy_points/
```

#### Priority 3 (future): Generic CSV, EGMS, StaMPS

```bash
# Generic long-form CSV
bowser convert csv --input points.csv \
  --lon-col longitude --lat-col latitude \
  --date-col date --displacement-col disp_mm \
  --output-dir ./custom/

# EGMS wide-format CSV (someday)
bowser convert egms --input egms_l3.csv --output-dir ./la_basin/
```

Each converter produces `points.parquet` + `timeseries.parquet` + a `bowser_manifest.json`.

### 4.5 Parquet Row Group Strategy

Row groups are the unit of I/O in Parquet — each row group is read independently, and column chunks within a row group are contiguous on disk. Row group layout has a major impact on query performance.

#### Points table

Row groups of ~50,000-100,000 points each. Since the points table is relatively small (one row per point, ~10 columns), a single row group often suffices for datasets under 1M points. For larger datasets, row groups sorted by a spatial key (e.g., H3 cell index or Hilbert curve) cluster nearby points together, improving bbox query performance.

```python
# Write with spatial sorting for bbox query efficiency
import h3
points["h3_cell"] = points.geometry.apply(lambda g: h3.latlng_to_cell(g.y, g.x, 6))
points = points.sort_values("h3_cell").drop(columns=["h3_cell"])
points.to_parquet("points.parquet", row_group_size=100_000)
```

#### Time series table

This is where row groups matter most. The time series table can be enormous (1M points × 200 dates = 200M rows). Two layout strategies:

**Option A: Group by point_id (point-access pattern)**
Each row group contains all dates for a contiguous range of point IDs. This makes "fetch one point's full time series" a single row group read.

```python
# Sort by point_id, then date within each point
ts = ts.sort_values(["point_id", "date"])
# Row group size = num_dates × points_per_group
# For 200 dates and ~500 points per group: row_group_size = 100_000
ts.to_parquet("timeseries.parquet", row_group_size=num_dates * 500)
```

**Option B: Group by date (spatial-access pattern)**
Each row group contains all points for one or a few dates. This makes "fetch displacement at date X for all points in bbox" fast, which is what the map view needs.

For our use case, **Option A (group by point_id) is the default** because:
- The most common query is "give me the time series for these N clicked points"
- DuckDB can still efficiently filter by date within a row group (columnar scan)
- The map view fetches static attributes (velocity) from the points table, not from the time series table

We may revisit this or support both layouts if the date-access pattern becomes a bottleneck.

---

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (React + TypeScript)                 │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  MapLibre GL  │  │  deck.gl     │  │  Chart.js / Plotly    │ │
│  │  (basemaps,   │  │  (point      │  │  (time series,        │ │
│  │   raster      │  │   cloud      │  │   cross-sections,     │ │
│  │   tiles)      │  │   rendering) │  │   histograms)         │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘ │
│         │                  │                       │             │
│         └──────────────────┼───────────────────────┘             │
│                            │ HTTP / WebSocket                    │
└────────────────────────────┼────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────┐
│                    Backend (FastAPI)                             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Raster       │  │  Vector      │  │  Analysis             │ │
│  │  Server       │  │  Server      │  │  Engine               │ │
│  │  (titiler)    │  │  (DuckDB +   │  │  (trend fitting,      │ │
│  │              │  │   GeoParquet) │  │   cross-sections,     │ │
│  │  COGs, Zarr   │  │              │  │   area averaging)     │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────────┤
│  │  Data Layer                                                  │
│  │  - Cloud Optimized GeoTIFFs          (existing V1)           │
│  │  - Zarr / NetCDF xarray datasets     (existing V1)           │
│  │  - GeoParquet point files            (NEW)                   │
│  │  - Local filesystem first, S3 later                          │
│  └──────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
```

### What stays from V1

- **titiler** for raster tile serving (COGs, Zarr, xarray) — battle-tested, no reason to replace
- **FastAPI** as the web framework
- **React + TypeScript** frontend
- **CLI for dataset setup** (`bowser run`, `bowser setup-*`)

### What's new in V2

- **DuckDB** as an embedded analytical query engine for point data
- **GeoParquet** as the canonical point data format
- **deck.gl** (via `@deck.gl/maplibre`) for WebGL point rendering on the client
- **MapLibre GL JS** replacing Leaflet for the map (WebGL-native, vector tile support, smoother interaction)
- **Analysis engine** for cross-sections, area statistics, and trend analysis on point data

---

## 6. Backend Design

### 6.1 Vector Server (New)

The vector server is the centerpiece of V2. It uses DuckDB to query GeoParquet files and returns results as GeoJSON or binary Arrow IPC for large responses.

#### Endpoints

```
GET  /points/{layer_name}
     ?bbox=-118.5,33.8,-117.8,34.2     # viewport bounding box
     &color_by=velocity                  # attribute for coloring
     &filter=temporal_coherence>0.7      # attribute filter expression
     &max_points=50000                   # client-requested limit
     → Returns: GeoJSON or Arrow IPC (based on Accept header)
       Point geometries + requested attribute columns only

GET  /points/{layer_name}/{point_id}/timeseries
     ?start_date=2020-01-01
     &end_date=2023-12-31
     → Returns: JSON array of {date, displacement, displacement_std}

POST /points/{layer_name}/timeseries
     Body: {"point_ids": [123, 456, 789]}
     → Returns: Multi-point time series for charting

GET  /points/{layer_name}/stats
     ?bbox=...&filter=...
     → Returns: {count, velocity_mean, velocity_std, velocity_min, velocity_max, ...}
       Summary statistics for filtered points in viewport

POST /points/{layer_name}/cross_section
     Body: {
       "line": [[lon1, lat1], [lon2, lat2]],
       "width_m": 200,
       "attribute": "velocity"
     }
     → Returns: Array of {distance_along_profile, attribute_value, point_id}

POST /points/{layer_name}/area_average
     Body: {
       "polygon": [[lon1, lat1], ...],
       "max_points": 10000
     }
     → Returns: Averaged time series + individual point count

GET  /points/{layer_name}/attributes
     → Returns: List of available columns with types and value ranges
       Used by the frontend to build filter UI dynamically

POST /export
     Body: {
       "layer_name": "ps_points",
       "format": "csv" | "geojson" | "geoparquet",
       "bbox": [...],
       "filter": "...",
       "include_timeseries": true
     }
     → Returns: File download
```

#### DuckDB Query Engine

DuckDB runs **in-process** (no separate database server). On startup, the backend registers GeoParquet files as DuckDB views:

```python
import duckdb

conn = duckdb.connect()
conn.install_extension("spatial")
conn.load_extension("spatial")

# Register point sources as views
conn.execute("""
    CREATE VIEW ps_points AS
    SELECT * FROM read_parquet('s3://bucket/ps_points.parquet', spatial=true)
""")
conn.execute("""
    CREATE VIEW ps_timeseries AS
    SELECT * FROM read_parquet('s3://bucket/ps_timeseries.parquet')
""")
```

Filtering translates directly to SQL:

```python
def query_points(
    layer: str,
    bbox: tuple[float, float, float, float],
    color_by: str,
    filters: list[str],
    max_points: int,
) -> pa.Table:
    where_clauses = [
        f"ST_Within(geometry, ST_MakeEnvelope({bbox[0]}, {bbox[1]}, {bbox[2]}, {bbox[3]}))"
    ]
    for f in filters:
        where_clauses.append(sanitize_filter(f))  # parameterized to prevent injection

    sql = f"""
        SELECT point_id, ST_X(geometry) as lon, ST_Y(geometry) as lat, {color_by}
        FROM {layer}
        WHERE {' AND '.join(where_clauses)}
        LIMIT {max_points}
    """
    return conn.execute(sql).fetch_arrow_table()
```

#### Progressive Loading Strategy

For datasets with millions of points, we can't send them all to the browser at once. Strategy:

1. **Viewport-based loading**: Only query points within the current map bbox + a small buffer
2. **Zoom-dependent density**: At low zoom, use DuckDB `SAMPLE` or spatial grid aggregation. At high zoom, send individual points.
3. **Attribute-aware thinning**: When zoomed out, prioritize high-|velocity| points (they're what the user cares about)
4. **Client-side budget**: The frontend requests at most N points (e.g., 100k). The backend respects this and downsamples if needed.

```
Zoom level    Strategy               Approx points sent
────────────────────────────────────────────────────────
< 10          Grid aggregation       ~1,000 cells
10-14         Sampled points         ~10,000-50,000
> 14          All points in bbox     Up to 100,000
```

### 6.2 Raster Server (Enhanced V1)

The existing titiler-based raster server stays largely unchanged. Enhancements:

- **Unified dataset registry**: Both raster and vector layers registered through the manifest
- **Raster point sampling**: `GET /raster/{layer_name}/point?lon=...&lat=...` for clicking on raster pixels (existing V1 behavior, new URL prefix)
- **COG + Zarr**: Continue supporting both modes

### 6.3 Analysis Engine (New)

Server-side computations that operate on point data:

- **Trend fitting**: Linear, piecewise-linear, seasonal decomposition
- **Cross-section profiles**: Query points within a buffer of a transect line, project onto the line, return distance-vs-attribute
- **Area averaging**: Mean time series within a polygon, with uncertainty propagation
- **Spatial reference adjustment**: Subtract a reference point's time series from all others
- **Anomaly detection**: Flag points with velocity significantly different from neighbors (future)

These are exposed as POST endpoints (see 6.1) and computed on-demand via DuckDB queries + NumPy/SciPy.

---

## 7. Frontend Design

### 7.1 Map Engine: MapLibre GL JS + deck.gl

**Why replace Leaflet with MapLibre:**
- WebGL-native rendering (Leaflet is DOM-based, struggles past ~10k markers)
- Native vector tile support
- Smooth fractional zooming, 3D tilt, rotation
- deck.gl integrates directly as a MapLibre custom layer

**deck.gl for point rendering:**
- `ScatterplotLayer` renders 1M+ points at 60fps via WebGL
- Built-in picking (hover/click identification without spatial index on client)
- GPU-accelerated color mapping — send attribute values + colormap, GPU does the rest
- Binary data transport (Arrow IPC → GPU buffer) avoids JSON parsing overhead

```typescript
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';

const pointLayer = new ScatterplotLayer({
  id: 'ps-points',
  data: arrowTable,  // binary Arrow from backend
  getPosition: d => [d.lon, d.lat],
  getFillColor: d => colorScale(d.velocity),
  getRadius: 3,
  radiusMinPixels: 2,
  radiusMaxPixels: 8,
  pickable: true,
  onClick: info => selectPoint(info.object.point_id),
});

map.addControl(new MapboxOverlay({ layers: [pointLayer] }));
```

### 7.2 Charting: Plotly.js

**Why switch from Chart.js to Plotly:**
- Better for scientific data: error bars, subplots, annotations built-in
- Linked brushing (select time range on chart → highlight on map)
- Better zoom/pan within charts
- WebGL renderer for large time series (`scattergl` trace type)
- Export to PNG/SVG built-in
- Widely used in scientific Python (familiar to our users)

### 7.3 State Management

V1 uses React Context + useReducer. For V2, keep this pattern but formalize URL-driven state:

```typescript
interface AppState {
  // Dataset
  datasetManifest: DatasetManifest;
  activeLayers: string[];

  // Map viewport
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;

  // Point layer state
  colorBy: string;
  colormap: string;
  vmin: number;
  vmax: number;
  filters: Filter[];

  // Selection
  selectedPointIds: number[];
  referencePointId: number | null;
  hoveredPointId: number | null;

  // Raster layer state
  rasterTimeIndex: number;
  rasterColormap: string;
  rasterVmin: number;
  rasterVmax: number;
  rasterOpacity: number;

  // Analysis
  crossSectionLine: [number, number][] | null;
  areaSelectionPolygon: [number, number][] | null;

  // UI
  chartVisible: boolean;
  panelVisible: boolean;
  activeTab: 'layers' | 'filter' | 'export';
}
```

All of this serializes to URL search params, so `https://bowser.app/?dataset=la_basin&color_by=velocity&filter=coherence>0.7&zoom=12&center=-118.2,34.0` is a shareable, reproducible view.

### 7.4 Component Architecture

```
App
├── MapView
│   ├── MapLibreMap (basemap, raster tile layers)
│   ├── DeckGLOverlay (point cloud layers)
│   ├── CrossSectionTool (draw transect line)
│   ├── AreaSelectTool (draw polygon)
│   └── MapControls (zoom, basemap picker, 3D tilt)
│
├── Sidebar
│   ├── LayerPanel
│   │   ├── LayerToggle (per-layer visibility, opacity)
│   │   ├── RasterControls (time slider, colormap, vmin/vmax)
│   │   └── PointControls (color-by dropdown, colormap, vmin/vmax)
│   ├── FilterPanel
│   │   ├── AttributeFilter (field + operator + value)
│   │   ├── DateRangeFilter (start/end date pickers)
│   │   └── ActiveFilters (chips showing current filters)
│   └── ExportPanel
│       ├── FormatPicker (CSV, GeoJSON, GeoParquet)
│       ├── ScopeToggle (viewport / selection / all)
│       └── ExportButton
│
├── BottomPanel (resizable)
│   ├── TimeSeriesChart (selected points' displacement vs time)
│   ├── CrossSectionChart (displacement vs distance along profile)
│   ├── HistogramChart (attribute distribution in viewport)
│   └── StatsBar (point count, mean velocity, etc.)
│
└── Toolbar
    ├── SelectTool (click to select points)
    ├── MultiSelectTool (shift+click or box select)
    ├── CrossSectionTool (draw line)
    ├── AreaAverageTool (draw polygon)
    ├── ReferenceTool (set reference point)
    └── MeasureTool (distance/area)
```

---

## 8. UX Design

### 8.1 What We Take from IRIS

- **Tight spatial-temporal coupling**: Clicking the map immediately updates the time series chart. This is non-negotiable.
- **Multiple basemap options**: Satellite, terrain, dark, and OSM.
- **Colorbar always visible**: Anchored to the map, not buried in a menu.

### 8.2 What We Take from TRE-MAPS

- **Attribute filtering** is the killer feature for point data. Users need to quickly filter to "show me only points with velocity < -10 mm/yr and coherence > 0.7."
- **Cross-section profiles**: Draw a line, see displacement along it. Essential for visualizing subsidence bowls, fault offsets, etc.
- **Multi-point time series**: Shift+click to add more points to the chart. Compare trends across locations.
- **Area averaging**: Select a polygon, get the mean time series with uncertainty. Critical for comparing against GPS.
- **Export with time series**: Not just point locations — include the full displacement history.

### 8.3 What We Do Differently

**Progressive disclosure instead of modal dialogs:**
TRE-MAPS uses modal dialog boxes for filtering and symbology. We use an inline sidebar panel that stays open while you interact with the map. No context switches.

**Unified raster + point view:**
Neither IRIS nor TRE-MAPS does this well. IRIS is raster-only; TRE-MAPS is point-only. Bowser V2 overlays both. Use case: view the displacement raster for spatial context, with PS points on top colored by velocity, to see where the raster and point estimates agree/disagree.

**URL-driven state for collaboration:**
"Look at this" should be a link, not a screenshot. Every filter, selection, and viewport state encoded in the URL.

**Smart defaults, explicit overrides:**
- Auto-detect colormap range from data percentiles (not hardcoded)
- Auto-detect which attribute to color by (velocity if available, else first float column)
- Auto-detect time series mode (single-ref vs multi-ref, carrying forward V1's hybrid approach)
- Everything overridable in the manifest or the UI

**Keyboard-driven power user workflow:**
- `F` — toggle filter panel
- `T` — toggle time series chart
- `R` — set reference point mode
- `C` — cross-section tool
- `Escape` — clear selection
- Number keys — switch between layers

### 8.4 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  [Bowser]  dataset-name   |  tools: [🔍] [📏] [📐] [📌]     │
├────────────┬─────────────────────────────────────────────────┤
│            │                                                 │
│  Sidebar   │                                                 │
│  (280px)   │              Map View                           │
│            │              (MapLibre + deck.gl)                │
│  Layers    │                                                 │
│  ├ Disp.   │                       ┌─────────┐              │
│  ├ Coh.    │                       │ Colorbar│              │
│  └ PS Pts  │                       └─────────┘              │
│            │                                                 │
│  Filters   │                                                 │
│  ┌────────┐│                                                 │
│  │vel<-10 ││                                                 │
│  │coh>0.7 ││                                                 │
│  └────────┘│                                                 │
│            │                                                 │
│  Stats     ├─────────────────────────────────────────────────┤
│  N: 42,301 │  Time Series Chart                  [minimize] │
│  v̄: -8.2   │  ╭─────────────────────────────╮                │
│            │  │  •   •                       │  ← Point 1   │
│            │  │    •   •  •                  │  ← Point 2   │
│            │  │         •   •  •             │               │
│            │  ╰─────────────────────────────╯                │
│            │  2016    2018    2020    2022                    │
└────────────┴─────────────────────────────────────────────────┘
```

Key layout decisions:
- **Sidebar on the left** (not right) — matches file-browser mental model, keeps the most-used controls close to the eye's starting position
- **Bottom panel for charts** — resizable, can be minimized. Charts expand horizontally (time axis benefits from width).
- **No floating panels** — everything docked. Prevents the "lost dialog box" problem.
- **Stats summary always visible** in the sidebar — point count and mean velocity update live as you filter/pan.

---

## 9. Technology Choices

### 9.1 Strict Choices (High Conviction)

| Component | Choice | Why |
|-----------|--------|-----|
| Point data format | **GeoParquet** | Columnar, cloud-native, typed, self-describing. Industry momentum (Overture, STAC, Planetary Computer). Parquet ecosystem (DuckDB, Polars, Arrow) is mature. |
| Server query engine | **DuckDB** | In-process (no infra), reads Parquet natively, spatial extension for bbox queries, fast analytical queries, Arrow output for zero-copy to client. |
| Map renderer | **MapLibre GL JS** | WebGL-native, open-source (no Mapbox token), vector tile support, smooth interaction, active community. |
| Point renderer | **deck.gl** | 1M+ points via WebGL, binary Arrow data path, picking built-in, MapLibre integration via `@deck.gl/mapbox`. |
| Backend framework | **FastAPI** | Already used in V1, async, OpenAPI docs, Pydantic integration. |
| Raster tiles | **titiler** | Already used in V1, COG + Zarr support, battle-tested. |

### 9.2 Flexible Choices (Open to Alternatives)

| Component | Current Pick | Alternative | Decision Criteria |
|-----------|-------------|-------------|-------------------|
| Charting | Plotly.js | Chart.js (V1), Apache ECharts, Observable Plot | Plotly if we need error bars + linked brushing. Chart.js if we want minimal bundle size. |
| State management | React Context + URL params | Zustand, Jotai | Upgrade only if Context becomes painful with many consumers. Zustand is lightweight and would be a natural step up. |
| CSS | Tailwind CSS | CSS Modules (V1), Styled Components | Tailwind for rapid iteration and consistent design tokens. |
| Bundler | Vite | (keep from V1) | No change needed. |
| Data transport | Arrow IPC for large responses, JSON for small | All JSON, All Arrow | Arrow IPC for >1k points (avoid JSON parse cost). JSON for metadata endpoints. |

### 9.3 Future Considerations (Not for V2.0)

| Technology | When | Why wait |
|------------|------|----------|
| **PMTiles** (pre-tiled vector) | V2.1+ | Useful for static datasets (e.g., EGMS). But V2.0 focuses on dynamic DuckDB-served data. Add PMTiles as an alternative source type later. |
| **DuckDB-WASM** (client-side queries) | V2.2+ | Run DuckDB in the browser for offline/local analysis. Exciting but adds complexity. Start server-side, move to hybrid later. |
| **WebGPU** (next-gen rendering) | When browser support is >90% | deck.gl already has WebGPU support. MapLibre is working on it. |
| **GeoArrow** | When spec stabilizes | Native Arrow geometry type. Currently GeoParquet uses WKB in Arrow, which requires a decode step. GeoArrow would eliminate this. |
| **3D visualization** | V2.1+ | PS points have estimated heights. 3D view (deck.gl supports this) would let users see the point cloud in 3D. Nice to have, not essential. |

---

## 10. Migration from V1

### What Breaks

Nothing. V2 is a **superset** of V1.

- V1 raster-only datasets (`bowser_rasters.json` or `--stack-file`) continue to work exactly as before
- V1 URLs continue to work
- V1 CLI commands (`bowser run`, `bowser setup-*`) are unchanged

### What Changes

- Leaflet → MapLibre GL JS (visual change, same tile sources)
- Chart.js → Plotly.js (visual change, same data)
- New `bowser_manifest.json` format for V2 datasets (V1 JSON config still supported via auto-upgrade)
- New CLI commands: `bowser convert`, `bowser setup-points`
- New `/points/` endpoints for vector data

### Upgrade Path

1. Existing V1 users: `pip install --upgrade bowser-insar` → everything works, map looks slightly different (MapLibre vs Leaflet)
2. Users with point data: create a `bowser_manifest.json`, run `bowser convert` to get GeoParquet, `bowser run --manifest bowser_manifest.json`
3. No data migration required for raster datasets

---

## 11. Implementation Phases

### Phase 1: Foundation

**Goal:** MapLibre + deck.gl rendering a GeoParquet point cloud from a dolphin export, with point click → time series.

- [ ] **Converter:** `bowser convert dolphin` — read dolphin raster stack, mask by quality, export to GeoParquet
- [ ] **Backend:** DuckDB reads GeoParquet, serves points via `/points/` endpoint
- [ ] **Backend:** Single-point and multi-point time series endpoints
- [ ] **Backend:** Point attributes endpoint (discover available columns)
- [ ] **Frontend:** Replace Leaflet with MapLibre GL JS
- [ ] **Frontend:** Add deck.gl overlay for point rendering (ScatterplotLayer, colored by velocity)
- [ ] **Frontend:** Click point → fetch + display time series in Plotly chart
- [ ] **Data model:** Define `bowser_manifest.json` schema (Pydantic model)
- [ ] **Data model:** Implement row-group-aware Parquet writing in converter

**Demo:** Run `bowser convert dolphin /path/to/work_dir`, then `bowser run --manifest bowser_manifest.json`. See 1M+ points on map colored by velocity, click one, see its displacement time series.

### Phase 2: Filtering & Interaction (Weeks 4-6)

**Goal:** Attribute filtering, multi-point selection, reference point.

- [ ] Sidebar filter panel (attribute + operator + value)
- [ ] Backend: Filter expressions in DuckDB queries
- [ ] Multi-point selection (shift+click, box select)
- [ ] Multi-point time series chart
- [ ] Reference point subtraction (spatial referencing)
- [ ] Dynamic colormap + vmin/vmax controls for point layer
- [ ] Stats bar (point count, mean velocity in viewport)
- [ ] URL-driven state (serialize filters, viewport, selection to URL params)

**Demo:** Filter to high-velocity points, select several, compare their time series, set a reference point.

### Phase 3: Analysis Tools (Weeks 7-9)

**Goal:** Cross-sections, area averaging, trend analysis, export.

- [ ] Cross-section tool: draw line on map, server computes profile, display in chart
- [ ] Area averaging tool: draw polygon, server computes mean time series
- [ ] Trend fitting (linear + seasonal) on selected point time series
- [ ] Export panel: CSV, GeoJSON, GeoParquet download with time series
- [ ] Histogram of attribute values in viewport
- [ ] Date range filter (restrict time series to a window)

**Demo:** Draw a transect across a subsidence bowl, see the displacement profile. Select an area near a GPS station, compare averaged InSAR time series to GPS.

### Phase 4: Raster + Vector Unification (Weeks 10-12)

**Goal:** Both rasters and points in one view, polish, converters.

- [ ] Unified layer panel (raster + point layers togglable independently)
- [ ] Raster opacity / point opacity independent controls
- [ ] Click behavior: if point layer active, click selects point. If only raster, click samples raster.
- [ ] CLI converter: `bowser convert mintpy`
- [ ] `bowser setup-points` — interactive CLI for creating point layer config
- [ ] Performance testing with 1M+ point datasets
- [ ] Polish: keyboard shortcuts, responsive layout, loading states, error handling

**Demo:** Load a full OPERA DISP-S1 raster stack + PS points from the same area. Toggle between raster and point views. Export a subset of points with time series as GeoParquet.

### Phase 5: Stretch Goals (Post-V2.0)

- [ ] PMTiles support for pre-tiled static point datasets
- [ ] DuckDB-WASM for client-side queries (offline mode)
- [ ] 3D point cloud view (deck.gl PointCloudLayer with estimated heights)
- [ ] Anomaly detection layer (flag outlier points)
- [ ] GPS time series overlay on InSAR time series chart
- [ ] Multi-dataset comparison (two PS datasets from different orbits/processors)
- [ ] Temporal animation (play through time steps)
- [ ] Collaborative annotations (pin a comment to a location)

---

## 12. Design Decisions (Resolved)

1. **Two-table format** for points + timeseries. Revisit if single-file convenience becomes a pain point.
2. **Flexible schema** — `velocity`, `temporal_coherence`, etc. are recommended but not enforced. Frontend dynamically discovers available columns. Datasets with recognized columns get better defaults. Early testing will mostly have temporal_coherence; other quality metrics will vary.
3. **Points only** — no polygon footprints for DS data. Everything renders as points.
4. **Units in Parquet column metadata** — each column carries `{"units": "mm/yr"}` etc. in its Parquet metadata.
5. **Local-first for early development** — DuckDB reads local Parquet files. S3 access will be tested later; if cold-start latency is bad, we'll add caching then.
6. **Client-side point budget** — needs empirical testing with deck.gl. Start without a hard cap, observe performance with 1-10M point datasets.
7. **Default to Arrow IPC** for point data responses — we'll almost always have >1k points (typically 1-10M from raster export). JSON only for metadata/timeseries endpoints.
8. **Click prefers points** — when both raster and point layers are visible, clicks prefer nearby points (pixel-distance threshold). Falls back to raster sampling if no point is close.
9. **No mobile** — desktop-first, no effort on responsive mobile layout.
10. **Dark mode default** — support both light and dark themes if not a huge lift. Default to dark (satellite basemaps look better on dark backgrounds).

---

## Appendix A: Example DuckDB Queries

```sql
-- Points in viewport with velocity filter
SELECT point_id, ST_X(geometry) as lon, ST_Y(geometry) as lat, velocity
FROM ps_points
WHERE ST_Within(geometry, ST_MakeEnvelope(-118.5, 33.8, -117.8, 34.2))
  AND temporal_coherence > 0.7
  AND velocity < -10
LIMIT 50000;

-- Time series for selected points
SELECT t.point_id, t.date, t.displacement
FROM ps_timeseries t
WHERE t.point_id IN (123, 456, 789)
ORDER BY t.point_id, t.date;

-- Cross-section: points within 200m of a transect line
SELECT
    point_id,
    velocity,
    ST_Distance(
        geometry,
        ST_Point(-118.3, 34.0)  -- start of line
    ) as distance_along,
FROM ps_points
WHERE ST_DWithin(
    geometry,
    ST_MakeLine(ST_Point(-118.3, 34.0), ST_Point(-118.1, 34.1)),
    0.002  -- ~200m in degrees at this latitude
)
ORDER BY distance_along;

-- Area average time series
SELECT t.date, AVG(t.displacement) as mean_disp, STDDEV(t.displacement) as std_disp, COUNT(*) as n
FROM ps_timeseries t
JOIN ps_points p ON t.point_id = p.point_id
WHERE ST_Within(p.geometry, ST_GeomFromText('POLYGON((...))'))
GROUP BY t.date
ORDER BY t.date;

-- Attribute statistics for filter panel
SELECT
    MIN(velocity) as vel_min, MAX(velocity) as vel_max,
    PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY velocity) as vel_p05,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY velocity) as vel_p95,
    MIN(temporal_coherence) as coh_min, MAX(temporal_coherence) as coh_max,
    COUNT(*) as total_points
FROM ps_points;
```

## Appendix B: GeoParquet File Example

```python
import geopandas as gpd
import pandas as pd
import numpy as np

# Create points table
n_points = 100_000
points = gpd.GeoDataFrame({
    'point_id': np.arange(n_points, dtype=np.uint64),
    'velocity': np.random.normal(-5, 15, n_points).astype(np.float32),
    'velocity_std': np.random.uniform(0.5, 3.0, n_points).astype(np.float32),
    'temporal_coherence': np.random.uniform(0.3, 1.0, n_points).astype(np.float32),
    'height': np.random.normal(0, 5, n_points).astype(np.float32),
    'amplitude_dispersion': np.random.uniform(0.1, 0.4, n_points).astype(np.float32),
}, geometry=gpd.points_from_xy(
    np.random.uniform(-118.5, -117.8, n_points),
    np.random.uniform(33.8, 34.2, n_points),
), crs="EPSG:4326")

points.to_parquet("ps_points.parquet")

# Create time series table
dates = pd.date_range("2016-01-01", "2023-12-31", freq="12D")
ts_rows = []
for pid in range(n_points):
    vel = points.loc[pid, 'velocity']
    days = (dates - dates[0]).days.values
    disp = vel / 365.25 * days + np.random.normal(0, 2, len(dates))
    for d, v in zip(dates, disp):
        ts_rows.append({'point_id': np.uint64(pid), 'date': d, 'displacement': np.float32(v)})

ts = pd.DataFrame(ts_rows)
ts.to_parquet("ps_timeseries.parquet", row_group_size=len(dates))  # one row group per point
```

## Appendix C: Technology Reference Links

- GeoParquet spec: https://geoparquet.org/
- DuckDB spatial: https://duckdb.org/docs/extensions/spatial
- MapLibre GL JS: https://maplibre.org/maplibre-gl-js/docs/
- deck.gl: https://deck.gl/
- deck.gl + MapLibre: https://deck.gl/docs/get-started/using-with-maplibre
- Arrow IPC: https://arrow.apache.org/docs/format/Columnar.html#ipc-streaming-format
- Plotly.js: https://plotly.com/javascript/
- titiler: https://developmentseed.org/titiler/
- Lonboard (reference for Arrow→deck.gl pattern): https://developmentseed.org/lonboard/
- PMTiles: https://protomaps.com/docs/pmtiles
