# Changelog

All notable changes to bowser are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.5.0]: https://github.com/opera-adt/bowser/compare/v0.4.0...v0.5.0
