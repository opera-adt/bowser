# Tech-debt backlog

Staging ground for smells we've spotted but not fixed. Each entry should get
opened as a GitHub issue eventually. This file is not meant to live forever —
once an item is tracked upstream, drop it from this list.

## Open

### 0. aiobotocore ContextVar conflict when zarr opens an S3 URI

**Where:** `bowser.geozarr._multiscales_layout`, `state.BowserState.load_zarr`
(the S3 path). Works around it by passing `consolidated=False` to
`xr.open_zarr`, which avoids the `zarr.open_consolidated` sync-over-async
code path that triggers the bug.

**What's wrong:** In our pixi/linux runtime, `xr.open_zarr("s3://…")` via
the default consolidated path spawns a helper thread with a fresh event
loop to drive `aiobotocore`. aiobotocore creates a `ContextVar` token on
one event loop and tries to reset it on another → `ValueError: <Token …>
was created in a different Context`.

Known aiobotocore issue (see #918 upstream). Also forces
`deploy/ec2-bootstrap.sh` to inject IAM role credentials via env vars
instead of letting `s3fs` discover them through IMDS — the same async
credential refresh path hits the same ContextVar conflict.

**Fix options:**

1. Upgrade `aiobotocore` past the fixed version when one ships.
2. Replace `s3fs` with `obstore` (sync, no aiobotocore dep) — this is the
   path `titiler.xarray` already uses.
3. Pre-warm a single `s3fs.S3FileSystem(asynchronous=False)` instance and
   pass it in via `storage_options`.

Worth tracking: the workaround is visible in every S3-backed entrypoint;
if we add more, same treatment needed.

---


### 1. `file_list` in MD mode is a vestigial fake-URI

**Where:** `main.py` `create_xarray_dataset_info` (`file_list: ["variable:foo:time:N", ...]`).

**What's wrong:** The backend never parses these strings; only the array length
is consumed by the frontend. The frontend separately sends `variable` +
`time_idx` query params to the tile endpoint. The URI-shaped payload is
confusing and easy to break when adding new dim types.

**Fix:** Drop `file_list` from the MD dataset payload; expose `n_time_steps`
instead. Update `src/components/MapContainer.tsx` and
`src/bowser/dist/index.js` to stop using `file_list[timeIdx]`.

---

### 2. `spatial_ref` round-trips through zarr as a `data_var`, not a `coord`

**Where:** `state.load`, `create_xarray_dataset_info` (filters `ndim >= 2` to
skip it), anywhere iterating `data_vars`.

**What's wrong:** rioxarray writes `spatial_ref` as a variable, not a
coordinate. Downstream iteration has to know to skip it. Surprise factor is
high.

**Fix:** In `annotate_store` / `bowser._tifs_to_geozarr`, call
`ds = ds.set_coords("spatial_ref")` on write so readers see it as a coord. Or
promote on read in `state.load`.

---

### 3. `_apply_layer_masks_md` catches every Exception as JSON error

**Where:** `main.py` around line 1260: `except (json.JSONDecodeError, Exception)`.

**What's wrong:** The second clause subsumes the first and swallows every
runtime error into a warning log. Real bugs get masked.

**Fix:** Catch `json.JSONDecodeError` only. Let everything else raise and land
in FastAPI's normal error handler.

---

### 4. Five near-duplicate `setup_*` CLI commands

**Where:** `cli.py` — `setup-dolphin`, `setup-disp-s1`, `setup-aligned-disp-s1`,
`setup-nisar-gunw`, `setup-hyp3`. Plus `_prepare_disp_s1.py::get_disp_s1_outputs`
and `get_aligned_disp_s1_outputs` with parallel structure.

**What's wrong:** Each command is ~40 lines of hand-written `RasterGroup`
dicts. Adding a new product means copy-pasting the structure.

**Fix:** Declarative: a YAML/TOML per product family listing the groups. One
loader + one CLI entry. Target: ~400 lines deleted.

---

### 5. Source float16 GeoTIFFs from dolphin

**Where:** Not a bowser bug — dolphin writes float16 output.
`bowser._tifs_to_geozarr` upcasts to float32 on read (GDAL/rasterio can't
reproject float16). The
existing `_prepare_utils.py:146` does the same with a comment.

**Fix:** Upstream question — should dolphin write float32 to begin with? If
yes, the workaround disappears; if no, keep the upcast but document.

---

### 6. rioxarray caches stale affine on `spatial_ref.GeoTransform` after coarsening

**Where:** `build_pyramid` in `geozarr.py`.

**What's wrong:** `ds.coarsen(...).mean()` updates x/y coord spacing but
leaves `spatial_ref.attrs["GeoTransform"]` at the full-res affine. Any caller
of `ds.rio.transform()` on a coarsened level silently gets the wrong pixel
size. Our pyramid builder strips the attr explicitly; any future
coarsen-and-write path needs the same treatment.

**Fix:** Either upstream a coarsen-aware rewrite of `GeoTransform` in
rioxarray, or ship a `bowser.geozarr.coarsen_spatial` helper that does the
strip automatically.

---

### 7. Pyramid level picker assumes a single native resolution per store

**Where:** `state.BowserState.dataset_for_tile_zoom`.

**What's wrong:** Pyramid levels are a per-store concept, but which level
serves a tile is a per-*variable* question in principle. If a future store
mixes variables with different native pixel sizes (e.g. downsampled mask +
full-res displacement), the picker gives wrong answers.

**Fix:** Index levels per-variable, or enforce at converter time that all
variables share a native grid.

---

### 8. `--min-pyramid-size` is coupled to the tile size without self-documenting

**Where:** `bowser tifs-to-geozarr` (`src/bowser/_tifs_to_geozarr.py`).

**What's wrong:** Default 256 matches bowser's 256-px tiles, but the knob is a
pyramid-builder option. Changing one without the other silently degrades tile
quality.

**Fix:** Read tile size from a shared constant. Or derive the min
automatically from the expected client tile size.

---

### 9. titiler doesn't pick pyramid levels by zoom — bowser wraps it

**Where:** `src/bowser/main.py` `XarrayPathDependency` (~L1464); level
picker in `src/bowser/state.py` `BowserState.dataset_for_tile_zoom`.

**What's wrong:** titiler's xarray backend (as of v0.x, Apr 2026) accepts
a `group=<N>` parameter to open a specific zarr subgroup, but nothing in
titiler reads a GeoZarr `multiscales` root attr and picks the right
group for a given tile zoom. Bowser does it itself in a path
dependency: extracts `z` from the request path, calls
`dataset_for_tile_zoom(z)`, hands titiler the chosen level's
`xr.Dataset`. Works, but the wrapper is fragile — any endpoint that
bypasses `XarrayPathDependency` gets level-0 at every zoom.

Bowser's level picker also uses an equator-plane approximation for tile
pixel size, so it's ~6% off for mid-latitude datasets. Not enough to
cross a 2× pyramid boundary in practice, but not technically correct.

**Fix (upstream, ~150 lines in developmentseed/titiler):**

1. New path dependency `MultiscalesGroupDependency` that reads the
   `multiscales` root attr, picks a level via a CRS-aware zoom → res
   mapper (maxrjones's snippet in titiler#1071 using
   `rasterio.warp.calculate_default_transform` is the reference
   implementation), and sets `group=<chosen>` on the Reader.
2. Fixture `pyramid_geozarr.zarr` with a proper `multiscales` attr +
   tests that zoom 0 picks the coarsest and zoom 14 picks level 0.
3. File a titiler issue linking #1071 with bowser's specific GeoZarr
   use case; drop in our converter's output as a repro store.

Once that ships, bowser's `XarrayPathDependency` becomes a two-line
config change (point titiler at the new dependency, delete
`dataset_for_tile_zoom`). Until then the wrapper works fine.

Related: titiler#1071 (Jan 2025 thread, still open).

---

### 10. `src/bowser/dist/index.js` is checked into git

**Where:** `src/bowser/dist/` — built output of `npm run build` against
the `src/components/*.tsx` + CSS source.

**What's wrong:** Every frontend PR carries a ~1 MB minified-JS diff on
top of the actual `.tsx` changes, merge conflicts in `dist/` are common
on parallel frontend work, and there are two sources of truth — someone
forgetting to run `npm run build` ships stale JS. The `Rebuild frontend
bundle` commit recurs in history.

**Why it's here anyway:** pip-installable without needing Node.js on the
user's machine, simpler Docker image, one-step install. The trade-off
was pragmatic, not accidental.

**Fix options:**

1. **pixi task + CI build-and-commit.** Add nodejs as a conda-forge dep
   under a pixi feature, define `pixi run build-frontend`, gitignore
   `src/bowser/dist/`, and have a GitHub Actions workflow rebuild dist/
   and commit it on release tags.
   ```toml
   [tool.pixi.feature.frontend.dependencies]
   nodejs = ">=20"

   [tool.pixi.feature.frontend.tasks]
   build-frontend = "npm ci && npm run build"
   ```
2. **Build at wheel-packaging time.** Move dist/ out of git; use
   `hatch-jupyter-builder` or `setuptools-js-build` so `python -m build`
   runs `npm run build` before assembling the wheel. Publishes clean
   wheels, keeps source tree clean. More setup up front, but closest to
   the modern Python-frontend packaging norm.

Revisit when frontend contribution volume increases or when the next
`Rebuild frontend bundle` merge conflict costs >30 min.

---

## Done (recent sessions)

- ✅ Module-level globals (`DATA_MODE`, `XARRAY_DATASET`, `RASTER_GROUPS`,
  `transformer_from_lonlat`) replaced with a `BowserState` dataclass.
- ✅ `BOWSER_SPATIAL_REFERENCE_DISP` / `BOWSER_USE_RECOMMENDED_MASK` promoted
  from `os.getenv("YES"/"NO")` to typed `Settings` booleans.
- ✅ Hardcoded `ds.time` / `da.time` / `.isel(time=...)` replaced with
  per-variable non-spatial dim discovery (`_non_spatial_dim`, `_dim_labels`).
