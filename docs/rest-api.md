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
| Config | `GET /config` | Page title, logo flag, whether GeoTIFF export works, what added files are converted to |
| | `GET /mode` | `md` (GeoZarr) or `cog` (GeoTIFF stack) |
| Data | `GET /datasets` | Every layer: dates, bounds, reference point, units, description, what it measures |
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
| | `GET /reference_candidates` | Stable places to put the reference point |
| | `GET /reference_candidates/status` | Whether the reference finder's statistics are ready |
| Tiles | `GET /md/{tms}/tilejson.json` | TileJSON with the tile URL template |
| | `GET /md/tiles/{tms}/{z}/{x}/{y}` | A map tile |
| | `GET /colorbar/{cmap}` | A colormap gradient image |
| | `GET /zarr/{path}` | A file of the cube's zarr store, for the GPU renderer (experimental; [gpu-render.md](gpu-render.md)) |
| | `/md/*` (full only) | TiTiler's other routes: info, statistics, preview, ... |
| COG tiles | `/cog/*` (full only) | TiTiler routes for GeoTIFF stacks |
| Export | `GET /export/geotiff` | One step of a layer as a GeoTIFF |
| Files | `POST /upload_mask` | Store a GeoTIFF mask; returns its server path |
| | `POST /upload_raster` | Store a GeoTIFF overlay; returns path and band stats |
| | `POST /upload_data` | Store a file (or a Shapefile's parts) to add with `POST /data` |
| | `POST /data` | Add a raster or vector file; converts it once in the background |
| | `GET /data/{id}` | Its conversion status: converting, ready or failed |
| | `GET /data/{id}.{fmt}` | A converted vector: PMTiles (HTTP Range) or GeoJSON |
| | `GET /files` | A server folder's sub-folders and addable files (`BOWSER_ALLOW_OPEN`) |
| | `/overlay/*` (full only) | TiTiler routes for uploaded overlays |
| Context | `GET /gnss/stations` | UNR GNSS stations in a box, with velocities |
| | `GET /gnss/series/{station}` | A station's daily positions |
| | `POST /gnss/custom` | Read a GNSS station series from your file (text, or a server path with `BOWSER_ALLOW_OPEN`); see [gnss.md](gnss.md) |
| | `GET /gnss/custom` | The stations read from files this session |
| | `GET /gnss/custom/{station_id}` | One of them: east, north, up from its first date |
| | `DELETE /gnss/custom/{station_id}` | Forget one |
| | `GET /wms_capabilities` | Named layers of a WMS |

## Added files

`POST /data` with `{"path": ...}` makes a file ready to draw. Uploads
(`POST /upload_data`), `BOWSER_OVERLAY_FILES` (`bowser run --overlay`) and,
with `BOWSER_ALLOW_OPEN`, any server path are allowed; other paths get 403.

- A raster is tiled by `/overlay` from a Cloud-Optimized GeoTIFF: one already
  is used where it is, anything else is converted once. A single-band raster of
  heights comes back with `"dem": true` and is drawn as a hillshade.
- A vector over 20 MB or 50 000 features is converted to a PMTiles archive of
  vector tiles (GDAL's PMTiles driver, zooms up to 14, every attribute kept),
  read by the page with HTTP Range requests from `GET /data/{id}.pmtiles`. A
  smaller one becomes a GeoJSON in WGS84 that the page holds whole. The page
  reads vector files under the threshold itself and never sends them.
- Conversions run in a background thread; poll `GET /data/{id}` while `status`
  is `converting`. A ready raster gives its COG's path (`cog`), size
  (`cog_bytes`) and whether it was converted (`converted: false` when the file
  already was a COG). `/config` says what the server converts:
  `data_conversion: {cog, pmtiles, pmtiles_min_mb}`.
- `GET /files?dir=<folder>` lists one server folder for Overlays › Load file ›
  Browse: its sub-folders, then the files `POST /data` adds, with sizes
  (`{dir, parent, entries, truncated, skipped}`). Without `dir` it starts in the
  folder of the cube being viewed, else the server user's home. It is gated
  like server paths in `POST /data` (403 without `BOWSER_ALLOW_OPEN`) and, like
  `POST /catalog/scan`, has no root folder of its own: it lists any folder the
  server's user can read. bowser-lite answers 501.

Conversions of server paths are cached in `BOWSER_CONVERT_CACHE_DIR` (default
`~/.cache/bowser/convert`), keyed by path, size and mtime, and kept within
`BOWSER_CONVERT_CACHE_MAX_GB` (default 20) and `BOWSER_CONVERT_CACHE_MAX_DAYS`
(default 30; 0 turns a limit off): the least recently used go first. An
upload's conversion sits next to it and is swept with it after
`BOWSER_UPLOAD_RETENTION_H` hours.

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

## Finding a stable reference point

`GET /reference_candidates` ranks places to put the reference point, in one
call (Main › Reference Point › *Find a stable reference* on the page):

```bash
curl -s "http://localhost:8000/reference_candidates?radius_m=100&n=5" \
  | jq '.recommended | {lon, lat, radius_m, reason}'
```

How it scores, with the parameters that change each step:

1. **Per pixel, over the whole stack:** the median and standard deviation
   through time of `temporal_coherence` and of `phase_similarity`. Water
   (`water_mask` = 0) is left out; with `use_masks=true`, so are pixels outside
   the `recommended_mask` on most dates.
2. **Viable pixels:** both medians at least the thresholds, by default the
   `quantile` (0.95, the top 5 %) of the cube's own medians, so the rule adapts
   to the cube; `coherence_min` and `similarity_min` set them instead. The
   **pixel score** is `((med_coh - k std_coh) + (med_sim - k std_sim)) / 2`
   with `k = k_std` (1): a pixel whose quality swings through time loses to a
   steady one.
3. **Neighbourhood:** around each viable pixel, the circle of `radius_m`
   (100 m; the same pixels *Sample around ref marker* averages). Its
   `viable_fraction` (pixels off the grid or masked count as not viable) times
   the circle's `mean_score` is the `neighbourhood_score`, so a lone bright
   pixel in noise loses to a coherent patch.
4. **Spacing and displacement check:** the best centres at least
   `min_separation_m` apart (3 x radius) are shortlisted, and for each the
   `displacement_scatter_m` is measured: the median over the circle of each
   pixel's standard deviation through time about the circle's median. Low
   means the circle moves as one, which a circle-averaged reference needs. The
   final `score` is `neighbourhood_score x 5 mm / (5 mm + scatter)`.

Each candidate carries the `lon`, `lat` and `radius_m` to set as the
reference; `recommended` is the first. The response also gives the thresholds
used, percentiles of both medians over the cube (`distribution`) and, per
candidate, the medians, standard deviations, velocity and a one-line `reason`.

The per-pixel reductions do not depend on the reference or the parameters, so
they are computed once per cube and layer and kept, in memory and on disk
(`~/.cache/bowser/refstats`, or `BOWSER_REFSTATS_CACHE_DIR`; `.npz` files keyed
by the store, pyramid level, layer, date stride and a fingerprint of the
layer's files, so a rewritten layer is recomputed). A restarted server reuses
them. The disk cache drops files older than `BOWSER_REFSTATS_CACHE_MAX_AGE_DAYS`
(30) and the least recently used beyond `BOWSER_REFSTATS_CACHE_MAX_MB` (2048);
`BOWSER_REFSTATS_CACHE=0` turns it off. `BOWSER_REFSTATS_WORKERS` (2) threads
read the stack.

Both servers start computing them in the background when they open a cube (at
startup, on a catalog entry's first request, on *Open*), and keep out of the
way while doing so:

- they start 10 s after the cube opened (`BOWSER_REFSTATS_WARMUP_DELAY_S`), once
  no request came for 2 s (`BOWSER_REFSTATS_WARMUP_IDLE_S`);
- before each read they pause while any request is in flight (tiles, series,
  histograms, ...; not the status route), and resume 0.5 s after the last one
  (`BOWSER_REFSTATS_WARMUP_RESUME_S`);
- they run at low CPU priority, and bowser-lite, the desktop app's server, reads
  with one thread (`BOWSER_REFSTATS_WARMUP_WORKERS`).

A search that arrives meanwhile is not held back: it takes the computation
over, keeping the blocks already read, and finishes it at full speed.
`GET /reference_candidates/status` says whether the statistics are `ready`,
`running` (with `progress`) or `idle`, and the page shows *Preparing… 40%*
while they run. `BOWSER_REFSTATS_WARMUP=0` turns the warm-up off.

A cube larger than 16 million pixels per date is screened on its coarsest
pyramid level below that size; a screening read above 4 billion values per
layer also uses every n-th time chunk of dates (`screen_stride` sets it). In
both cases the shortlisted candidates are recomputed at full resolution with
every date before ranking, and the thresholds and `distribution` describe the
screening read. On Arkabutla, screening every 2nd, 3rd or 4th chunk gave the
same five places as every date (one moved by 30 m), so every date stays the
default where it is affordable.

**Limits.** Coherence says the phase is consistent, not that the ground is
still: a coherent building can sit on compacting ground, and a dam or a
quarry face can be coherent and moving. Before using a candidate, look at its
`velocity` and its time series, and at what is on the ground there (geology,
pumping, construction). The thresholds are relative to the cube, so in a cube
that is poor everywhere the "top 5 %" can still be poor: check the
`distribution` and the medians. The displacement check compares pixels inside
the circle with each other; motion of the whole circle is not seen by it.

## Histograms

`GET /histogram/{name}?time_index=t` gives the colour scale's histogram and
percentiles (2/98, 16/84, 2.275/97.725) of one date. Cubes made by `bowser`
store every date's histogram in the layer (`bowser_histogram`), and both
servers return it as is. For other cubes, add them once:

```bash
bowser add-histograms cube.zarr            # every numeric layer, in place
bowser add-histograms cube.zarr -v displacement --level 1 --force
```

Without them, the servers compute the date on demand from the finest pyramid
level holding at most `BOWSER_HISTOGRAM_MAX_PIXELS` (4 million) valid pixels
(`level` in the answer; 0 is full resolution), one request at a time in a worker
thread, and cache it. Pyramid levels are 2x2 averages, so the percentiles are a
little narrower than at full resolution: on a DISP-S1 frame (level 1 of a
7733 x 9464 grid, all 269 dates), p2/p98 within 4.7 mm and p16/p84 within
6.4 mm (1.3 and 1.8 mm on average). The first
request for a layer also starts computing every date in the background, in one
pass over the stack, with the reference finder's precautions (it waits for an
idle server, pauses while requests are in flight, one reader thread on
bowser-lite) and its disk cache, so a restarted server has them at once.
`BOWSER_HISTOGRAM_WARMUP=0` turns that off. While the page plays through the
dates it does not ask for histograms; it asks for the date it stops on.

`GET /dataset_range/{name}` is the first date's histogram reduced to `min`,
`max`, `p2`, `p98`, `p5` and `p95`, so it costs what that histogram costs:
nothing when the cube stores it. `p5` and `p95` are read off the histogram's
counts, within one bin (1 % of the range) of the exact percentiles.

## What a layer measures

Each layer of `GET /datasets` has a `measurement` (null for layers that measure
no motion: coherence, masks, uncertainties). Bowser serves stacks from many
producers, so it is built from the cube's own metadata and nothing is assumed
for a cube that does not say:

| Field | Meaning |
| --- | --- |
| `kind` | `line_of_sight`, `vertical`, `east_west`, `north_south` or `unknown` |
| `positive_direction` | What a positive value means (`towards the satellite`, `up`, ...), or null |
| `kind_source`, `sign_source` | The attribute each came from, or `known product ...` |
| `sensitivity` | How much of 1 mm of east, north or up motion shows in a value: the absolute east, north and up parts of the look vector (`los_enu_ground_to_satellite`) for line-of-sight values; null when unknown |
| `sensitivity_note` | The same in words, e.g. "Sensitive mainly to vertical (0.78) and east-west (0.62) motion; north-south sensitivity 0.11." |
| `radar_wavelength_m`, `half_wavelength_mm` | The radar wavelength and half of it, the size of a line-of-sight unwrapping jump; null when not recorded |
| `product`, `summary` | The recognised product, and all of the above in a sentence |

Direction and sign come from the layer's attributes (`measurement_direction`,
`sign_convention`, `positive_direction`, or its `long_name` / `description`
when they name one direction, or say "positive ... towards the satellite"), then
the cube's (`displacement_convention`, `ceos_product_measurement_projection`,
...), then a short table of facts producers document (`KNOWN_PRODUCTS` in
`src/bowser/measurement.py`, matched on the cube's `title`, `product` or
`source`; today only OPERA DISP-S1). A cube whose product name says vertical
land motion (`title`, `product`, `short_name`... containing "VLM" or "vertical
land motion") is vertical. The file always wins over the table. The look
geometry and the wavelength are the cube's, the same for every layer. The
wavelength is read from `radar_wavelength` (or `wavelength`, metres), or
computed from a centre frequency in hertz (`centerFrequency`, as NISAR
products record it, or `center_frequency`, `radar_frequency`). A vertical or
east-west product, derived from several tracks, gets no wavelength sentence.

## What bowser-lite does not do

bowser-lite needs no GDAL, so it leaves out what needs it:

- `POST /upload_mask`, `POST /upload_raster`, `GET /export/geotiff`,
  `POST /polygon_timeseries` and the added-file routes (`/upload_data`,
  `/data`) answer HTTP 501 with a `detail` message, and `GET /config` reports
  `"geotiff_export": false` and `data_conversion` all off (small vector files
  are still read in the browser);
- GeoTIFF stacks (COG mode, `GET /mode` is always `md`) and the `/cog` and
  `/overlay` tilers (501);
- of TiTiler's `/md` routes, only the TileJSON and the tiles; tiles are PNG in
  the WebMercatorQuad grid only, and TiTiler's other tile options (`bidx`,
  `expression`, `nodata`, `resampling`, ...) are not taken;
- `custom_mask_path` is accepted on tiles but ignored.

Its colorbars are PNG; the full server's are WEBP.
