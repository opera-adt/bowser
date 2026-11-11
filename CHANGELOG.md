# Changelog

All notable changes to bowser are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
    Node.js (`npx`).
  - "Continue with ChatGPT" is OpenAI's "Sign in with ChatGPT" for
    open-source apps: OAuth with PKCE in your browser, then the chat uses your
    ChatGPT plan through the Responses API. The tokens are kept like keys,
    renewed, and revoked on Sign out.
  - New routes `POST`/`DELETE /assistant/signin`, `GET /auth/callback`,
    `POST /assistant/permission` and `POST /assistant/stop`; `GET
    /assistant/status` and `GET /config` list the sign-in methods. Signing in
    and signed-in chats answer requests from the same computer only.

### Changed

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
