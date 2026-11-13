# Changelog

All notable changes to bowser are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Scientific colour maps (Crameri): `batlow`, `lajolla`, `oslo`, `vik`, `roma`,
  `berlin`, `broc`, `bam` and the cyclic `romaO`, each with its reverse, as
  `cmc_*` in the colormap picker, on the full server, bowser-lite (and so the
  desktop app) and the GPU renderer, with identical colours on all three. The
  tables are vendored from cmcrameri at a pinned revision (MIT), checked by
  SHA-256.
- GeoTIFF export in bowser-lite and the desktop app: `GET /export/geotiff`
  (the Export button, the `export_geotiff` tool) now works without GDAL, with
  the full server's parameters, masks, reference handling, provenance tags and
  filename. The file is written by a small built-in writer (Deflate, tiled
  past 512 pixels, BigTIFF past 4 GB) and holds the same values, type, nodata,
  CRS and tags as the full server's when read with GDAL. `GET /config` reports
  `geotiff_export: true`; a custom mask GeoTIFF is still refused (501). See
  [docs/geotiff-export-provenance.md](docs/geotiff-export-provenance.md#bowser-lite).
- Area statistics in bowser-lite and the desktop app: `POST
  /polygon_timeseries` (the chart's "+ Area", the Stats tab, the
  `polygon_statistics` tool) now works without GDAL, with the full server's
  request, limits and response. The polygon is burned with numpy by GDAL's own
  rule (pixel centres inside, holes out), so both servers select the same
  pixels and return the same numbers; only the polygon's window is read, in a
  worker thread. `GET /config` reports `polygon_stats: true`. See
  [docs/polygon-statistics.md](docs/polygon-statistics.md#bowser-lite).
- GNSS tab › *Load local GNSS file*: load station time series from your own CSV
  files (picked on your computer, or a server path with `BOWSER_ALLOW_OPEN`).
  Dates as ISO, YYYYMMDD, decimal year or MJD; east, north and up in m, mm or
  cm (from the header, a `# units:` line, a Units choice, or guessed and said
  so); station and lon/lat as columns or `# key: value` lines; NGL `.tenv3`
  and EarthScope CSVs too. Unreadable rows are skipped and counted. The
  stations show on the map as amber squares with their own legend entry, and
  compare with InSAR along the line of sight like UNR's. Kept for the server
  session (`POST/GET/DELETE /gnss/custom`), on the full server and
  bowser-lite. See [docs/gnss.md](docs/gnss.md).
- MCP and Assistant tools `load_gnss_csv`, `list_gnss_stations` (files and
  UNR) and `convert_to_cog` (a raster on the server to a Cloud-Optimized
  GeoTIFF in the conversion cache; full server). Server paths are read only
  where the page could (`BOWSER_ALLOW_OPEN`). `GET /data/{id}` gives a ready
  raster's `cog_bytes`.
- `bowser add-histograms CUBE.zarr` stores every date's colour histogram in an
  existing GeoZarr cube (`bowser_histogram`, the attribute the converter
  writes), computed in one pass over the stack from a coarse pyramid level
  (`--level auto|N`, `--variables`, `--force`). See docs/rest-api.md.

- Find a stable reference point: `GET /reference_candidates` (full server and
  bowser-lite, same answers) ranks places by the whole-stack median and
  standard deviation of temporal coherence and phase similarity, how much of
  the surrounding circle is coherent, and how much the displacement inside the
  circle scatters. Main › Reference Point gains *Find a stable reference*: the
  candidates are numbered on the map and listed, and choosing one (or *Use
  recommended*) moves the reference there with *Sample around ref marker* at
  the same radius. See docs/rest-api.md for what the scores mean and their
  limits.
- The reference finder keeps its per-pixel statistics on disk
  (`~/.cache/bowser/refstats`; `BOWSER_REFSTATS_*` settings), so a restarted
  server answers at once; both servers prepare them in the background when they
  open a cube (after an idle delay, pausing while any request is in flight, so
  the map stays responsive), `GET /reference_candidates/status` reports the
  progress and
  the page shows *Preparing… 40%*. Very large cubes can be screened on a subset
  of dates (`screen_stride`), with the shortlist rechecked on every date.
- `bowser mcp`, an MCP server for AI assistants such as Claude Desktop and
  Claude Code. Its tools call a running Bowser server (full or lite) for time
  series, trends, profiles, histograms, polygon statistics and GeoTIFF export,
  and say what each value is relative to. Over stdio by default, `--http` for
  streamable HTTP; `--stack-file` opens one cube with bowser-lite in-process.
  Needs the new `mcp` extra (`pip install 'bowser-insar[mcp]'`). See
  [docs/mcp.md](docs/mcp.md).
- An Assistant tab in the side panel: a chat with your own AI provider
  (Anthropic, OpenAI, Google Gemini or OpenRouter with an API key, or Ollama
  when it is installed on the computer that runs Bowser, which starts it in
  the background when needed) that answers with the same data tools as
  `bowser mcp` and acts on the page: it flies the map, adds time-series
  points, sets the reference point and date, switches layers, opens the chart
  and adds overlays. API keys are checked with the provider and kept on the
  server (system keychain or a private file), never in the browser; the chat
  goes through the server (`POST /assistant/chat`). The model picker offers
  the provider's own model list (`GET /assistant/models`, asked for with the
  saved key and kept for ten minutes) and any model id can be typed. On for
  `bowser run`, `bowser lite` and the desktop app on your own computer
  (`--assistant/--no-assistant`); off on a shared server unless
  `BOWSER_ASSISTANT` is set, with the server's own key (`BOWSER_AI_PROVIDER`,
  `BOWSER_AI_KEY`). `GET /config` says whether it is on. Needs the new
  `assistant` extra (`pip install 'bowser-insar[assistant]'`).
- Add data converts on the server, in the background: a GeoTIFF that is not
  cloud-optimized becomes a COG once, and a vector file over 20 MB (or 50 000
  features; also GeoPackage and FlatGeobuf) becomes PMTiles vector tiles with
  every attribute, so Identify still works. The layer's row says "Converting to
  COG… 12 s" until it is drawn. Smaller vectors are still read in the browser.
  With `BOWSER_ALLOW_OPEN` set, Overlays › Layers › Load file adds a file on
  the server: type or paste its path (a folder's path opens it), or Browse a
  server folder and click a file, double-click to add it at once, or add all
  the folder's files (up to 50). Files can also be added at startup with
  `bowser run --overlay PATH` (repeatable, `BOWSER_OVERLAY_FILES`). KMZ files
  are read on the server. Server paths' conversions are cached in
  `BOWSER_CONVERT_CACHE_DIR` (`~/.cache/bowser/convert`), kept under
  `BOWSER_CONVERT_CACHE_MAX_GB` (20) and `BOWSER_CONVERT_CACHE_MAX_DAYS` (30).
  New routes `POST /upload_data`, `POST /data`, `GET /data/{data_id}`,
  `GET /data/{data_id}.{fmt}` (PMTiles over HTTP Range) and `GET /files` (a
  server folder's files to add); `/config` says
  `data_conversion` and `overlay_files` (off and empty on bowser-lite).
- DEM layers: an elevation model, such as USGS 3DEP 1 m lidar, drawn as a
  hillshade, colour relief or both, above the basemap and below the data
  (also in split screen and on the Leaflet map). A single-band raster of
  heights is recognised when added; any single-band raster has "Use as DEM".
  "Use for 3D terrain" raises the MapLibre map on the DEM, merged into the
  global terrain outside it.
- Signing in to the Assistant instead of pasting an API key, on your own
  computer (`bowser run`, `bowser lite`, the desktop app):
  - "Sign in with Claude" hands the chat to your own Claude Code through the
    Agent Client Protocol, with Bowser's MCP server as its only tools; its
    requests to run a tool show in the tab (Allow, Always allow, Deny; denied
    when not answered). If Claude Code is not signed in, Bowser starts Claude
    Code's own sign-in on Anthropic's page. Bowser never reads Claude Code's
    credentials and never calls Anthropic itself. Needs Claude Code and
    Node.js. Its ACP adapter is installed once into Bowser's cache
    (`~/.cache/bowser/acp`, without the SDK's own copy of the agent) and run
    with `node`; npx stands in, and the tab says so, when that fails. The
    agent starts when the tab opens, not at the first question, and the tab
    shows how far it got (installing, starting, ready, with the seconds;
    `POST`/`GET /assistant/agent`); one session per chat, closed after 10 idle
    minutes.
  - "Continue with ChatGPT" is OpenAI's "Sign in with ChatGPT" for
    open-source apps: OAuth with PKCE in your browser, then the chat uses your
    ChatGPT plan through the Responses API. The tokens are kept like keys,
    renewed, and revoked on Sign out.
  - One "Sign in" button with a drop-down of the services (Claude, ChatGPT);
    the button's accessible name keeps each service's own wording.
  - Signing in with Claude works when Bowser runs on another computer (a
    workstation reached over SSH with port forwarding, or Linux with no
    display): the tab opens Claude Code's own sign-in page (on claude.com,
    claude.ai or anthropic.com only) in a new tab of your browser, and you
    paste the code that page shows into the tab, which passes it to the
    waiting `claude auth login` once (`POST /assistant/signin/code`; never
    kept or logged). Where Claude Code can open the browser itself (a
    desktop), it still does, with no code to paste.
  - New routes `POST`/`DELETE /assistant/signin`, `POST
    /assistant/signin/code`, `GET /auth/callback`,
    `POST /assistant/permission` and `POST /assistant/stop`; `GET
    /assistant/status` and `GET /config` list the sign-in methods. Signing in
    and signed-in chats answer requests from the same computer only.
- The Assistant's status line says what is running and for how long: each
  tool's own label ("Reading the time series… 3 s", "Moving the map… 0 s"),
  sent by the server with each call on every path (API key, ChatGPT, Claude),
  then "Thinking…" or "Claude is thinking…"; each tool's row shows how long it
  took. The labels are part of each tool's spec (`ToolSpec.status`).
- Bowser's tools act on the page you have open, from every AI path: the
  Assistant's chat, "Sign in with Claude" (which could not act on the page
  before) and `bowser mcp` in Claude Code or Claude Desktop. New tools move the
  map (`get_view`, `fly_to`, `fit_bounds`, `pan`, `zoom`, `go_to`), set 3D
  terrain and split screen, the reference (`get_reference`,
  `set_reference_point` with a sampling circle, `reset_reference`), masks
  (`get_masks`, `set_masks`, `clear_masks`, `set_recommended_mask`) and
  colours (`get_display`, `set_colormap`, `set_color_range` with the
  histogram's presets, `set_opacity`), and run any toolbar or panel control
  (`list_commands`, `run_command`). They are defined once in `bowser.tools`
  and reach the page through a page channel (`GET /page/events`,
  `POST /page/focus`, `POST /page/result`, `POST /page/command`): the tab
  focused most recently acts; only from this computer, with
  `BOWSER_ASSISTANT_PAGE_KEYS`, and with the server's page token, which the
  server writes to a private file at start (removed at stop) and
  `bowser mcp` on the same computer reads (`--token` or `BOWSER_PAGE_TOKEN`
  otherwise). `GET /config` says whether it is on
  (`assistant.page_channel`).
- Chart tools for every AI path, run in the page like the other page tools
  (see [docs/mcp.md](docs/mcp.md#the-chart)): `get_chart_data` returns the
  chart's series exactly as drawn (reference point and date, masks, date range
  and units applied) and `get_fit_results` the fitted model's rate, seasonal
  amplitudes and peak days, step sizes, segment rates and RMS, each with a
  1-sigma error; `set_fit`, `add_step`, `remove_step` and `set_residuals` set
  the model as the Model card does and return the fit; `list_points`,
  `rename_point`, `remove_point`, `set_point_style`, `list_areas`,
  `rename_area`, `set_area_style` and `set_area_band` work as the Points panel
  and the Style button; `set_chart_layers`, `set_layer_display`,
  `set_date_range` and `export_chart` as the chart's layer chips, Display
  options and export buttons; `check_series` flags likely steps, one-date
  outliers and jumps of about half the radar wavelength (unwrapping errors),
  with checks ported from the OPERA DISP Portal. The model is told to fit with
  these tools, read numbers from the chart instead of fetching them again, and
  run `check_series` and ask before adding a step.
- The model's annual and semi-annual peak day of year has a 1-sigma error, as
  the amplitude has.
- `GET /datasets` gives a GeoZarr layer's `radar_wavelength_m` when the cube
  records it (for example a variable's `wavelength_m` attribute).
- `geocode` and `GET /geocode`: place names and addresses to coordinates
  through OpenStreetMap's Nominatim, at most one request per second, cached,
  with a User-Agent naming Bowser; `BOWSER_GEOCODER_URL` replaces or turns it
  off.
- `find_reference_candidates`, the reference finder (`GET
  /reference_candidates`) as a tool for every AI path.
- The data tools apply the page's masks by default (`use_page_masks`), so
  their answers match the map.
- Each question tells the model what the page shows (view, layer, date,
  reference, masks, points, split screen, terrain), and a question may use at
  most 8 tool calls (`BOWSER_ASSISTANT_TOOL_BUDGET`); a repeated call is
  refused. The tab says "Stopped after 8 tool calls" when they run out.
- A signed-in Claude asks less and its questions are hard to miss: Bowser's
  tools that only read or move the map never ask; "Always allow" covers a tool
  for the rest of the chat; a lock icon in the chat lets it run all of Bowser's
  tools without asking (remembered in this browser), while any other tool
  still asks. An open request is outlined, scrolled into view, counts down and
  badges the Assistant's rail icon; it waits 10 minutes
  (`BOWSER_ASSISTANT_PERMISSION_SECONDS`) instead of 2, and after a timeout
  Retry asks the question again.
- Context and infrastructure tools for the AI, on every path (the Assistant,
  Sign in with Claude, `bowser mcp`):
  - `deformation_zones` and `GET /deformation_zones` (full and lite, the same
    zones): connected areas where |velocity| (or a rate fitted to the
    displacement) reaches a threshold, with outlines, area, mean, median and
    peak rate, and ids to pass on;
  - `infrastructure_at`, `infrastructure_in_area` and `POST /infrastructure`:
    roads, buildings, rail, bridges, pipelines, dams and levees at a point or
    in an area, a drawn shape, a chart area or a zone, from OpenStreetMap
    through the Overpass API (one request per second, one at a time, cached,
    with a User-Agent naming Bowser; `BOWSER_OVERPASS_URL` moves or turns it
    off);
  - `site_context` and `GET /site_context`: land cover, geology, wetlands,
    soil, slope (and how much of a downslope motion the radar sees), nearby
    infrastructure and the cube's coherence at a point, to read before a time
    series; each service that cannot be reached says so
    (`BOWSER_CONTEXT_SERVICES=off` turns them all off);
  - page tools `list_context_layers`, `add_context_layer`,
    `remove_context_layer` (the Overlays › Services toggles),
    `highlight_infrastructure`, `clear_highlights` and `get_areas`; the tools
    above draw what they find as highlight layers when a page is connected.
- **Experimental:** GPU rendering of the data layer, off unless asked for in
  the page's address. `?render=gpu` draws the layer in the browser's GPU from
  the cube's own chunks, so dates, colormaps, ranges and reference dates change
  in a frame; `?render=auto` does so only on a capable hardware GPU;
  `?render=tiles` and no parameter keep server tiles. Views the GPU path does
  not draw yet (rewrap, phase/amplitude, several or uploaded masks, 3D terrain,
  COG stacks, remote or non-UTM cubes) use tiles, and any failure switches to
  tiles without a reload. Both servers serve the open cube's zarr files
  read-only at `GET /zarr/{path}` (`BOWSER_ZARR_FILES=false` turns it off). The
  GPU code loads only when chosen (about 4 kB more in the default bundle). See
  [docs/gpu-render.md](docs/gpu-render.md).
- GPU rendering (still experimental, `?render=gpu|auto`): chunks are fetched
  and decompressed in up to four Web Workers, so the page's main thread only
  uploads them (in a headless test on a 269-date frame, main-thread time while
  stepping through the dates fell by 30–60%, depending on how many chunks each
  step needs). Displacement is kept on the GPU as 16-bit floats where that rounds
  within 0.1 mm (half the memory); masks stay 32-bit. Chunks on the GPU stay
  within a memory budget (128–768 MB from the device's memory, 768 MB with
  8 GB or more, or `?gpu_mb=`), dropping chunks away from the view first;
  dates played past are no longer fetched. A worker that can't start switches
  to tiles, as other failures do. Opening the page with the GPU renderer
  starts flat: a 3D terrain left on from an earlier visit is turned off
  (tilting turns it on again, and the data then drapes over it with tiles).
- Project tab › *Appearance*: a bug icon turns on *Diagnostics* (off by
  default, kept in this browser; also `?debug=1`). With it, the map's label
  says which renderer draws the data and why, the GPU memory in use and how
  long the last date took to draw. The label no longer shows just because
  `?render=` is in the address.

### Changed

- Time-series chart: dragging a mask threshold, buffer radius or reference
  radius slider no longer sends a round of chart requests for every tick (each
  reads every date of every charted layer). The first change asks at once;
  after that at most one round per 250 ms, always ending on the value the
  slider stopped at.
- MapLibre map: dragging a basemap opacity slider no longer removes and re-adds
  the basemap sources on every tick, which dropped the tiles already loaded and
  fetched every visible one again (on both maps in split screen). Opacity is
  now a paint property; the sources are rebuilt only when a basemap or the
  swap changes.
- bowser-lite keeps each tile's warp index (which source pixel each tile pixel
  takes) for the tiles in view, within 64 MB, instead of working it out again
  for every date, mask and colour scale. Stepping through dates: a 512 px tile
  73 ms to 38 ms, a 256 px tile 36 ms to 27 ms; the tiles are the same.
- Tiles with an uploaded custom mask no longer warp the mask file to the whole
  pyramid level for every tile: the warped mask is kept per file and level
  (up to 256 MB). A full-resolution tile of a DISP-S1 cube with a custom mask
  went from 836 ms to 196 ms; the tiles are the same.
- Time series at a point are read without dask on the full server (`/point`,
  `/chart_point`, `/multi_point`, `/trend_analysis`), as bowser-lite reads
  them. For a 419-date DISP-S1 cube: one series 149 ms to 54 ms, five points
  and a reference 890 ms to 341 ms, the same with a layer mask 2.1 s to
  0.3 s (the mask is now applied to the pixel, not to the layer). Same values.
- The first request for a catalog entry (`?dataset=`) no longer holds up every
  other request while its cube opens (seconds for a cube on S3, on the server's
  event loop). Both servers open it in a worker thread, and once: a page
  load's burst of first requests used to open the same cube several times.
- `GET /deformation_zones` (and the Assistant's and MCP's zones tool) reads its
  layers in bands of rows instead of all at once, on both servers. Fitting a
  rate to a 419-date displacement stack over 800 x 600 pixels peaked at 5.2 GB
  and now at 1.0 GB, however large the area; without a velocity layer and a
  bbox it tried to hold the whole stack. The zones are the same.
- bowser-lite: a tile shown relative to another date (`ref_time_idx`) read both
  whole layers before cutting the tile out, since its arrays are not dask's:
  about 1 s per full-resolution tile on a DISP-S1 frame, and twice the layer
  in memory. The two steps are now subtracted on the tile's window (46 ms);
  the tiles are the same.
- Data tiles (`/md/tiles`, `/cog/tiles`, and bowser-lite's) are sent with
  `Cache-Control: private, max-age=600`, like the cube's zarr files, so going
  back to a date or view already seen is drawn from the browser's cache
  instead of rendered again. The tilers' metadata routes are not cached.
- `GET /datasets` on the full server is built once per opened cube instead of
  on every request (560 ms to 8 ms for a 419-date DISP-S1 cube): it reprojected
  a subsampled layer for the lon/lat bounds each time.
- Full-resolution tiles of a cube with stored histograms render about twice as
  fast on the full server (135 ms to 65 ms for a 419-date DISP-S1 layer). The
  layer's `bowser_histogram` attribute, about 1 MB for that many dates, was
  deep-copied by rioxarray for every tile; the server now keeps it beside the
  dataset. `GET /variables` no longer lists it among a layer's `attrs` (5 MB
  of that response).
- `GET /histogram` no longer holds the server up. Without a stored histogram
  it read the date at full resolution: on a DISP-S1 frame 5 s of CPU on the full
  server, on its event loop, so `/config` and `/datasets` waited up to 20 s
  after page load. Both servers now read the finest pyramid level with at most
  `BOWSER_HISTOGRAM_MAX_PIXELS` valid pixels (the answer's new `level`), in a
  worker thread, one at a time, cached; identical requests share one
  computation and a queued one whose page has moved on is dropped. Every date
  is then computed in the background (idle server only, pausing for requests)
  and kept in the reference finder's disk cache. The page asks for no
  histogram while playing through the dates. `GET /dataset_range` on the full
  server also left the event loop.
- `GET /dataset_range` no longer reads the layer. It read the first date at full
  resolution on every call, about 20 s on a DISP-S1 frame, and the page asks for
  it at load for the default mask's slider. Both servers now answer from that
  date's histogram: the one stored in the cube, else the cached or coarse-level
  one `GET /histogram` uses. `min`, `max`, `p2` and `p98` are the histogram's;
  `p5` and `p95` come from its counts, within one bin (1 % of the range) of the
  exact percentiles. Without a stored histogram the values are those of the
  coarse level, as for `GET /histogram`.
- **Breaking:** Bowser now requires Python 3.12 or newer (`requires-python
  = ">=3.12"`); Python 3.11 is no longer supported. The `writer` extra's
  geozarr-toolkit and rasterio 1.5 already needed 3.12, and the pixi
  environments were on 3.12.
- The server runs on TiTiler 2.0 (rio-tiler 9), as `pip install` users
  already did: the lock had kept TiTiler 0.22. Tile URLs no longer carry an
  `@1x` suffix, TileJSON reports spec 3.0.0, and the tile size is a `tilesize`
  query parameter (512 unless the page asks for 256, which it does). bowser-lite
  mirrors this. `fsspec`, `aiohttp` and `h5netcdf`, which TiTiler 2's dropped
  `minimal`/`http` extras used to bring, are now declared directly.
- TiTiler 2.4 with Starlette 1.x: the `starlette<0.49` and
  `starlette-cramjam<0.6` caps are gone. TileJSON gains TiTiler 2.4's
  `band_descriptions`, `data_type` and `raster_layers`; bowser-lite returns
  them too. Response compression (`BOWSER_COMPRESSION=1`) works again: the
  truncated compressed responses that made it opt-in no longer happen.
- Reading data no longer holds up the full server's other requests. A time
  series (`/point`, `/chart_point`, `/multi_point`, `/trend_analysis`,
  `/buffer_timeseries`), a profile (`/profile`, 4 s for a 60 km line on a
  DISP-S1 frame), the layer lists (`/datasets`, `/variables`) and
  `/catalog/open` ran on the server's event loop, so tiles and every other
  request waited for them. They are plain functions now, run in FastAPI's
  thread pool as on bowser-lite; `/upload_raster` computes its statistics in a
  worker thread. Answers are unchanged.

### Fixed

- Area (polygon) charts and the Stats tab follow the masks chosen in Main >
  Masking. They kept showing the unmasked summary when a mask was added,
  changed or removed. The masks are now sent to `/polygon_timeseries`
  (including `<=` for GeoTIFF layers), the summaries are refreshed when the
  masks, the source or the polygon change (at most once per 250 ms while a
  slider is dragged), and a late answer no longer replaces a newer one. With
  a mask, each date uses the pixels that pass on that date, and a date with
  none is an unfilled, dashed marker ("fully masked") instead of an empty
  chart. An
  uploaded mask and a GeoTIFF layer's configured mask are not applied to
  areas yet; the chart's footnote says so. The Stats tab shows the usable
  pixels of each summary.
- GNSS tab: the InSAR curve compared with a station follows the current
  settings. It was fetched only when a station was picked or the reference
  moved, so a changed mask, layer, reference switch or reference radius left
  the old curve. It is fetched again for those (at most once per 250 ms while
  a slider is dragged), a late answer no longer replaces a newer one, and
  moving the reference no longer reloads the station's GNSS record.
- Masking: a mask added, or moved to another layer, takes that layer's own
  default threshold once the layer's range is known. Before, the threshold
  stayed at 0.5 or at the previous layer's value, in the wrong units (it hid
  everything for a velocity mask, nothing for an amplitude one). Under the
  slider, a small histogram of the mask's layer shows the part the threshold
  keeps, with "Keeps N% of this layer's pixels".

- Esri basemaps (Satellite, Topo, Dark, Light, Hillshade, Relief) no longer show
  Esri's grey "Map data not yet available" tiles. How deep Esri's tiles go
  depends on the place (Satellite stops at zoom 14 offshore and on ice sheets,
  Hillshade at 14-15 at high latitudes, Relief at 11), so a fixed zoom limit
  per basemap was wrong in many areas. The tiles are now asked for with
  `blankTile=false`, and where one is missing the map shows the last real
  tiles, upscaled.

## [0.6.1] - 2026-11-05

First release with desktop installers attached.

### Added

- The desktop app opens `s3://` cubes, anonymously unless `BOWSER_S3_ANON=0`
  (#91).
- The desktop app uses the Bowser mark as its icon; `packaging/make_icons.py`
  draws `bowser.icns` and `bowser.ico` (#92).

### Fixed

- Desktop builds: macOS apps build again (the smoke-test cube installs rasterio
  from wheels, Intel builds run on `macos-15-intel`, and `hdiutil` is retried),
  and the `.dmg` opens to Bowser.app next to an Applications link (#90).
- A `v*` tag attaches the builds to a draft release instead of publishing one,
  so publishing to PyPI stays a manual step (#90).

## [0.6.0] - 2026-11-04

### Added

- `bowser desktop` runs Bowser as a desktop app (pywebview window, start screen
  to open cubes), with installer builds for Windows, macOS and Linux on `v*`
  tags (#88).
- bowser-lite (`bowser lite`): a server for GeoZarr cubes without GDAL,
  rio-tiler or matplotlib, with the same API for cubes; uploads, exports and COG
  stacks still need `bowser run` (#87).
- A tabbed side panel (Main, Overlays, GNSS, Project) with vector and raster
  overlays, drawing, context services (land cover, soils, geology, PMTiles),
  GNSS stations in the line of sight, model fits on time series, metric or
  imperial units and a light/dark theme. `--opera-logo` shows the OPERA emblem
  instead of the Bowser mark (#86).
- GNSS endpoints: `/gnss/stations` and `/gnss/series/{station}` from UNR, with
  steps and monuments (#85).
- Open and scan local cubes from the page (`POST /catalog/open`,
  `POST /catalog/scan`), gated by `BOWSER_ALLOW_OPEN`; `bowser run` turns it on
  only for a local single-worker server (#84).
- `bowser view-cube` writes a Web Mercator display copy of a cube, snapped to
  the tile grid at its native zoom, so a tile is one chunk (#83).
- Regression tests pin every API response the UI asks for (golden JSON) and
  every UI request (snapshots) (#81).
- Raster overlays: upload a GeoTIFF or add a WMS/WMTS/XYZ layer, drawn between
  the basemap and the data, with opacity, order, discrete classes and a
  split-screen side (#73).
- The time-series CSV gives each point's lat/lon, x/y, dataset and velocity
  with its standard error (#75).
- The reference marker starts at the cube's reference point, and
  `bowser tifs-to-geozarr --reference-point X,Y` stores one (#75).
- Project save and load: points, reference, annotations, masks and the
  displayed layer's appearance (#76, #78).

### Changed

- MapLibre GL is the default map, with 3D terrain, split screen, profile,
  measure, graticule, annotations and overlays. `?map=leaflet` gives the old
  map, which is also used when WebGL2 is not available (#82).
- Hover reads only the displayed time step at a point (`/point?time_idx=`),
  one chunk fetch instead of the whole series (#72).
- Response compression is off by default; `BOWSER_COMPRESSION=1` turns it back
  on (#74).
- GeoTIFF exports are named by date, `<var>_2020-06-15.tif` (#77).

### Fixed

- In catalog mode, every multi-dimensional endpoint routes by `?dataset=`, and
  an unknown id returns 404 instead of an error (#80).
- Pixel inspect, profile and mask-range requests send `?dataset=` in catalog
  mode (#82).
- The server starts without a built frontend, serving the API only (#74).
- The "Loading…" spinner no longer sticks after tile errors (#74).
- `calculate_trend` no longer divides by zero, bad project files no longer blank
  the app, and uploads are streamed with a size cap
  (`BOWSER_MAX_UPLOAD_MB`, default 500) and expire after
  `BOWSER_UPLOAD_RETENTION_H` (default 24 h) (#77).
- `pixi.lock` matches `pyproject.toml` again, so CI and the Docker build pass
  (#79).

## [0.5.1] - 2026-08-06

### Added

- Producers can now declare whether a variable takes a moving spatial reference
  point with a `bowser_uses_spatial_ref` boolean attr on the variable. It
  overrides every heuristic, and is the only way to express exceptions such as
  DISP-S1 `short_wavelength_displacement`. `bowser tifs-to-geozarr` stamps it
  from the `uses_spatial_ref` key in `bowser_rasters.json`.

### Changed

- Spatial-reference eligibility is inferred from CF `units` instead of matching
  substrings of the variable name. Length and angle quantities (`meters`,
  `radians`, `meters / year`, …) are relative measurements and get a reference
  point; unitless layers (coherence, masks, connected components) do not. The
  name list both over-matched and under-matched, and every new producer needed
  another entry — dolphin stores called their stack `time_series`, so
  re-referencing silently did nothing there until 0.5.0.
  `short_wavelength_displacement` remains excluded by name as a documented
  fallback for products written before the attr existed.
  The one behavior change on existing stores: dolphin `re_wrapped_phase`
  (radians) now offers a reference point, which it should — `Rewrap` gained a
  `shift` parameter in 0.5.0 for exactly that.
- Moved the eligibility helpers to `bowser.utils`, which has no import-time side
  effects, so they can be unit-tested without `bowser.main` loading dataset
  state at import.

### Fixed

- `bowser tifs-to-geozarr` no longer imports `osgeo.gdal`. 0.5.0 made the GDAL
  Python bindings an undeclared hard dependency of the writer; rasterio maps
  every GDAL dtype the converter handles, including `float16`, as of 1.5.0.
  The `writer` extra now pins `rasterio>=1.5.0`.
- `bowser run` no longer imports `osgeo` either, so it works on a plain
  `pip install`. Two things put it on the import path:
  - `readers.py` and `_tifs_to_geozarr.py` imported `get_dates` from
    `opera_utils`, and importing `opera_utils` loads the whole `osgeo` package
    tree at module scope. Date parsing is now `bowser._dates`, which is
    behavior-compatible (verified against `opera_utils.get_dates` over 300
    filename/format combinations, including which inputs raise).
  - `readers.py` ran `_patch_rasterio_float16()` at import, which did
    `from osgeo import gdal` inside a bare `except Exception: pass`. The patch
    now edits rasterio's dtype table directly. It was also asking the wrong
    library — rasterio links its own GDAL, so the separately installed
    bindings' version says nothing about what rasterio can read.

  `bowser prepare` still needs `opera_utils` (S3 credentials, `open_h5`) and
  `osgeo.gdal` directly, so that subcommand continues to require a conda/pixi
  environment.

## [0.5.0] - 2026-06-17

Large UI release: split-screen comparison, map annotations, phase re-wrapping,
PNG/GeoTIFF export, and anonymous S3 reads. Most of the work landed through two
squashed PRs (#59, #62), so the auto-generated release notes badly understate
the diff — see [`v0.4.0...v0.5.0`](https://github.com/opera-adt/bowser/compare/v0.4.0...v0.5.0).

### Added

**Map / viewer**

- **Split-screen layer comparison.** Toggle from the top-right toolbar to show a
  second dataset in the right half, with its own colormap, min/max, opacity, and
  time index, and a draggable divider. Implemented with two Leaflet panes
  (`splitLeft`/`splitRight`) clipped by `clip-path`.
- **Map annotations.** Annotation mode places draggable text labels with a
  per-label color and font size; double-click a label to edit or delete.
- **Pixel inspect.** Hover readout of the value under the cursor; in split-screen
  the tooltip is prefixed `L:`/`R:` depending on which side the cursor is on.
- **Basemap stacking.** A secondary basemap can be layered over the primary with
  independent opacity and a swap button. New basemaps: Esri Dark, Light,
  Hillshade, and Topo.
- **Toolbar visibility toggle** — hides both map toolbars and the point manager
  panel for a clean screenshot.
- **Point-picking toggle**, so map clicks can be made non-destructive while
  panning around.
- **Reference-marker show/hide** row in the point manager. Visibility only; it
  does not change whether the spatial reference is applied (that stays on the
  crosshair button in the left toolbar).

**Phase / complex data**

- **Re-wrap controls** in the sidebar: wrap unwrapped displacement to a chosen
  period, or enter a radar wavelength and wrap into fringes
  (`scale_factor = 4π/λ`).
- `Rewrap` titiler algorithm now accepts complex (CFloat32) input directly —
  `np.angle` is applied internally, so it no longer has to be chained after
  `phase` — and takes a `shift` parameter so reference-point correction and
  re-wrapping compose.
- **Complex display mode** toggle (phase vs amplitude) for complex layers.

**Export**

- `GET /export/geotiff` — download the active layer as a GeoTIFF with exactly the
  masking shown on the map (recommended mask, layer masks, custom mask), at
  native resolution, NaN nodata. Works in both MD and COG modes.
- PNG export (transparent background) for the time-series chart, the colorbar,
  and the LOS geometry panel, each with a white/black font toggle for the
  screenshot. Adds a runtime dependency on `html-to-image`.

**S3 / config**

- `bowser run --s3-anon/--no-s3-anon` and the `BOWSER_S3_ANON` env var.
  `s3://` stores are read **anonymously by default**; pass `--no-s3-anon` for
  private buckets to sign with the normal AWS credential chain. Public buckets
  previously failed with a `NoCredentialsError` when no keys were configured.

**GeoZarr writer (`bowser tifs-to-geozarr`)**

- Reads complex (CInt16/CInt32/CFloat32/CFloat64) and Float16 GeoTIFFs, which
  older rasterio builds could not map to a numpy dtype. Complex inputs are
  reduced with `np.angle`/`np.abs` per the group's `algorithm`.
- Rasters whose grid does not match the reference grid (e.g. a full-resolution
  PS amplitude alongside a looked stack) are reprojected with average resampling
  instead of failing an assert.
- Nodata pixels become NaN, upcasting integer layers to float32 where needed.
- Per-time-step histograms are pre-computed at conversion time and stored in the
  `bowser_histogram` zarr attr; the `/histogram` endpoint serves them directly
  instead of reading the full array.

### Changed

- Spatial re-referencing is now offered for variables named `unwrapped`,
  `timeseries`, or `time_series`, in addition to `displacement`/`velocity`.
  This is what makes dolphin-produced GeoZarr stores re-referenceable — their
  stack variable is `time_series`, which 0.4.0 did not match, so the reference
  marker had no effect on the chart. Note the check is still a substring match
  on the variable name, so it now also (wrongly) matches `time_series_residuals`
  and `time_series_residuals_total_sum`.
- Binned profile extraction is vectorized — one batched coordinate transform and
  one `sel` per bin instead of hundreds of single-point reads.
- `image/tiff` is excluded from `starlette-cramjam` response compression
  (GeoTIFF exports are already deflate-compressed).
- Coordinate grid lines are drawn visibly again; profile panel gained a close
  button.
- Basemap keys carry short display labels; the USGS `topography` basemap was
  replaced by `esriTopo`.
- CI: `actions/setup-node` v4→v6, `docker/setup-buildx-action` v3→v4,
  `akhilerm/tag-push-action` v2.2.0→v2.3.0.

### Fixed

- Opening a **local** GeoZarr store no longer fails with
  `TypeError: 'storage_options' was provided but unused` — `storage_options_for`
  returns `None` rather than `{}` for non-`s3://` paths.
- Layer masks without a time dimension are now applied as static spatial masks
  instead of being skipped, and a time index past the end of a mask variable is
  clamped rather than raising.

### Notes for packagers

- `bowser tifs-to-geozarr` now imports `osgeo.gdal` unconditionally to probe the
  band data type. GDAL Python bindings are **not** declared in
  `project.dependencies` or in the `writer` extra, and nothing else in the
  dependency tree pulls them in, so a pip-only install of the writer extra will
  fail at run time.

[Unreleased]: https://github.com/opera-adt/bowser/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/opera-adt/bowser/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/opera-adt/bowser/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/opera-adt/bowser/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/opera-adt/bowser/compare/v0.4.0...v0.5.0
