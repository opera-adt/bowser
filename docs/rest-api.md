# REST API

The web page talks to the server only through an HTTP API, so scripts and other
tools can use the same calls. Both servers describe it with OpenAPI:

- the full server, `bowser run` (`bowser.main:app`), for GeoZarr cubes and
  GeoTIFF stacks;
- bowser-lite (`bowser.lite.main:app`), for GeoZarr cubes without GDAL. It
  returns the same JSON for the routes it shares with the full server.

With the server running (the examples use `http://localhost:8000`):

- `/api.html` is the interactive documentation (Swagger UI), where each call
  can be tried from the browser;
- `/api` is the OpenAPI 3.1 schema as JSON.

```bash
curl -s http://localhost:8000/api | jq '.paths | keys'
```

Both are at these paths rather than FastAPI's usual `/docs` and
`/openapi.json`. The page itself is served at `/`.

Every route has a summary, a description and a tag, and its parameters have
descriptions and examples. Routes that return JSON describe it with a response
model; the models are in `src/bowser/api_models.py`, and
`tests/test_api_schema.py` checks real responses against them and that the
routes the two servers share are described the same way.

An MCP server, `bowser mcp`, wraps these calls as tools for AI assistants; see
[mcp.md](mcp.md).

## Choosing the dataset

A server started on one cube serves it to every call. A server started with a
catalog (`BOWSER_CATALOG_FILE`) serves the entry named by `?dataset=<id>` on any
call; `GET /catalog` lists the ids. Layers are named by the keys of
`GET /datasets` (for example `displacement`, `velocity`,
`temporal_coherence`). Coordinates are WGS84 longitude and latitude. Time steps
are indexes into a layer's `x_values`.

## Endpoints

| Group | Endpoint | What it returns |
| --- | --- | --- |
| Config | `GET /config` | Page title, logo flag, whether GeoTIFF export works |
| | `GET /mode` | `md` (GeoZarr) or `cog` (GeoTIFF stack) |
| Data | `GET /datasets` | Every layer: dates, bounds, reference point, units, description |
| | `GET /variables` | Dimensions, shape, dtype and attributes of each variable |
| | `GET /datasets/{name}/time_bounds` | First and last date, number of steps |
| | `GET /catalog` | Catalog entries; whether opening is allowed |
| | `POST /catalog/scan` | Cubes under a server folder (`BOWSER_ALLOW_OPEN`) |
| | `POST /catalog/open` | Open a cube by path or URL (`BOWSER_ALLOW_OPEN`) |
| Time series | `GET /point` | Values at a point (all steps, or one) |
| | `GET /chart_point` | Series at a point minus a reference point |
| | `POST /multi_point` | Series and trends for several points |
| | `GET /trend_analysis/{name}` | Linear rate (mm/yr) at a point |
| | `POST /buffer_timeseries` | Median and sample series within a circle |
| Statistics | `GET /dataset_range/{name}` | Min, max and percentiles of the first step |
| | `GET /histogram/{name}` | Histogram of one step |
| | `POST /polygon_timeseries` | Per-date statistics inside a polygon |
| | `POST /profile` | Values along a line |
| Tiles | `GET /md/{tms}/tilejson.json` | TileJSON with the tile URL template |
| | `GET /md/tiles/{tms}/{z}/{x}/{y}` | A map tile |
| | `GET /colorbar/{cmap}` | A colormap gradient image |
| | `/md/*` (full only) | TiTiler's other routes: info, statistics, preview, ... |
| COG tiles | `/cog/*` (full only) | TiTiler routes for GeoTIFF stacks |
| Export | `GET /export/geotiff` | One step of a layer as a GeoTIFF |
| Files | `POST /upload_mask` | Store a GeoTIFF mask; returns its server path |
| | `POST /upload_raster` | Store a GeoTIFF overlay; returns path and band stats |
| | `/overlay/*` (full only) | TiTiler routes for uploaded overlays |
| Context | `GET /gnss/stations` | UNR GNSS stations in a box, with velocities |
| | `GET /gnss/series/{station}` | A station's daily positions |
| | `GET /wms_capabilities` | Named layers of a WMS |

## Examples

A point's displacement series, relative to a reference point, as chart data:

```bash
curl -s "http://localhost:8000/chart_point?dataset_name=displacement\
&lon=-90.1350&lat=34.7480&ref_lon=-90.1200&ref_lat=34.7600"
```

The same series with a linear trend, for several points at once:

```bash
curl -s -X POST http://localhost:8000/multi_point \
  -H 'Content-Type: application/json' \
  -d '{"dataset_name": "displacement",
       "points": [{"id": "p1", "lon": -90.1350, "lat": 34.7480}],
       "ref_lon": -90.1200, "ref_lat": 34.7600, "calculate_trends": true}'
```

The median series of the pixels within 200 m of a point:

```bash
curl -s -X POST http://localhost:8000/buffer_timeseries \
  -H 'Content-Type: application/json' \
  -d '{"dataset_name": "displacement", "lon": -90.1350, "lat": 34.7480,
       "buffer_m": 200, "n_samples": 0}'
```

Statistics of the stored values inside a polygon (full server; see
[polygon-statistics.md](polygon-statistics.md)):

```bash
curl -s -X POST http://localhost:8000/polygon_timeseries \
  -H 'Content-Type: application/json' \
  -d '{"variable": "displacement",
       "geometry": {"type": "Polygon", "coordinates": [[[-90.14, 34.74],
         [-90.13, 34.74], [-90.13, 34.75], [-90.14, 34.75], [-90.14, 34.74]]]}}'
```

Time step 10 of the displacement as a GeoTIFF, with the temporal coherence
mask and re-referenced to a point (full server; see
[geotiff-export-provenance.md](geotiff-export-provenance.md)):

```bash
curl -s -OJ "http://localhost:8000/export/geotiff?variable=displacement\
&time_idx=10&ref_lon=-90.1200&ref_lat=34.7600\
&layer_masks=%5B%7B%22dataset%22%3A%22temporal_coherence%22%2C\
%22threshold%22%3A0.7%2C%22mode%22%3A%22min%22%7D%5D"
```

`layer_masks` is the URL-encoded JSON
`[{"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"}]`.

The TileJSON of a layer, whose `tiles` entry is the URL template to give a map
library:

```bash
curl -s "http://localhost:8000/md/WebMercatorQuad/tilejson.json?variable=displacement\
&time_idx=10&rescale=-0.05,0.05&colormap_name=rdbu_r&tilesize=256"
```

## What bowser-lite does not do

bowser-lite needs no GDAL, so it leaves out what needs it:

- `POST /upload_mask`, `POST /upload_raster`, `GET /export/geotiff` and
  `POST /polygon_timeseries` answer HTTP 501 with a `detail` message, and
  `GET /config` reports `"geotiff_export": false`;
- GeoTIFF stacks (COG mode, `GET /mode` is always `md`) and the `/cog` and
  `/overlay` tilers (501);
- of TiTiler's `/md` routes, only the TileJSON and the tiles; tiles are PNG in
  the WebMercatorQuad grid only, and TiTiler's other tile options (`bidx`,
  `expression`, `nodata`, `resampling`, ...) are not taken;
- `custom_mask_path` is accepted on tiles but ignored.

Its colorbars are PNG; the full server's are WEBP.
