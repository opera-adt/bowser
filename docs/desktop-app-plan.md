# Bowser Desktop: plan

*Draft, 2026-10-10.*

**Goal:** a double-click app for Windows, macOS and Linux that opens DISP GeoZarr cubes in the bowser UI.
- The user never touches a terminal.
- Target download: 40–60 MB.

## Why a new build is needed

The bowser environment is about 1.3 GB installed. A straight PyInstaller package of it would be 400–500 MB. Most of that is never used when viewing a cube:

| Dependency group | Installed | Needed by the viewer? |
|---|---|---|
| botocore, awscli, s3fs | ~150 MB | Only for S3 data. obstore (~10 MB) can replace them |
| GDAL via rasterio / titiler / pyproj | ~120 MB | Only for on-the-fly UTM → Web Mercator reprojection |
| pandas, pyarrow | ~105 MB | No. They come in via xarray and opera-utils |
| scipy, dask, distributed, bokeh | ~135 MB | No, never imported by bowser |
| matplotlib, fontTools | ~40 MB | Only for colormaps. Small lookup tables can replace them |
| opera-utils[all] (geopandas, shapely, …) | ~100 MB | No, used only by the `prepare-*` commands |
| numpy, zarr, FastAPI, uvicorn, pydantic | ~70 MB | **Yes**, this is the core |
| React front end (`dist/`) | 2 MB | **Yes** |

**The key change** is to store a *view cube* already on the Web Mercator grid.
- Converting a lon/lat to a pixel is then a closed-form formula.
- So the app needs no GDAL, no pyproj and no reprojection at request time.
- The UTM cubes stay as the analysis product. View cubes are only for display.

## What the user sees

1. Download and install: `Bowser.exe`, `Bowser.dmg` or `Bowser.AppImage`.
2. Double-click. A start screen offers:
   - **Open folder…**, using the native dialog;
   - **Open link…**, an `s3://` or `https://` cube or folder;
   - **Recent**.
3. A picker lists every cube by its title, e.g. *Prado Dam (CA) · NISAR DSC 013_D_071 · 2025-11-23 – 2026-09-19*.
4. The usual bowser view: map, layers, time slider, point time series, reference point, LOS indicator, masks, amplitude layers.

## Architecture

```
Bowser.app  (one process, no terminal)
├─ window: pywebview → system web engine (Edge WebView2 / macOS WebKit / GTK WebKit)
│    └─ bowser React UI (unchanged, 2 MB)
└─ bowser-lite: FastAPI on 127.0.0.1:<random free port>
     ├─ catalog: built in memory from the chosen folder (cube `title` attrs)
     ├─ tiles: slice + nearest resample in numpy, PNG via zlib (no GDAL, no Pillow)
     ├─ point / chart / multi-point / reference / masks / trend / profile: numpy only
     └─ data: local folders; S3/https through an optional obstore plugin
```

## Map engine: MapLibre GL (decided 2026-10-10)

The map moves from Leaflet to **MapLibre GL**: GPU rendering, smooth zoom and rotation, vector basemaps, and later client-side colouring of data tiles.
- The system web engines support WebGL: WebView2, WKWebView and WebKitGTK.
- Leaflet code today is about 2,300 lines in six files: `MapContainer.tsx` (1,284), `ProfileTool.tsx`, `Graticule.tsx`, `MeasureTool.tsx`, `mouse.ts` and `basemap.ts`.

The migration goes in steps that each keep the regression suite green:
1. **Map-independent logic out of the components.** The tile request is done (`utils/tileParams.ts`). Next: the click, marker-drag and profile-line handlers, as hooks that take lon/lat and know nothing of the map library.
2. **A small `MapAdapter` interface:**
   - raster source;
   - markers;
   - click, drag and hover events;
   - fit bounds;
   - overlays.

   Leaflet implements it first. Component tests run against a mock adapter.
3. **A MapLibre implementation of the adapter**, swapped in with no change to the tests.
4. Remove Leaflet once MapLibre passes everything and a manual check in a real browser.

## Regression safety net (in place)

| Layer | What it pins | Where |
|---|---|---|
| Backend goldens | The response to every request the UI makes, in single and catalog mode | `tests/regression/` (pytest) |
| Request contract | URL, method and body of every `useApi` call | `src/hooks/useApi.test.ts` (Vitest) |
| Tile requests | The tilejson URL for 15 UI states (algorithms, reference shift, rewrap, masks, catalog) | `src/utils/tileParams.test.ts` |
| Interactions (next) | Click → point/chart, reference drag → reference values, profile line → `/profile`, through the mock adapter | to come with step 1 |
| End to end (CI) | Real browser with software WebGL (Chromium + SwiftShader) on a GitHub runner | phase 3; WebGL doesn't run on the current dev host |

**How to update on purpose:**
- `BOWSER_UPDATE_GOLDENS=1 pytest tests/regression`
- `npx vitest run -u`

Then review the diff before committing.

## Recommendation

1. Do **phases 0–2 first**: the view-cube format, bowser-lite and the desktop shell.
   - We then try the app here on the dams cubes before investing in release packaging.
2. Keep **one UI**. Desktop and hosted bowser share the same React build.
3. Treat **view cubes as derived products**, written by the processing side (`to_geozarr`), never on the user's machine.
4. Postpone code signing until people outside the team use the app.
5. Revisit the **Python-free variant** after bowser-lite has settled which features matter: Tauri plus zarr read in the browser, about 10–15 MB, and it doubles as a static website.

## Phases and tasks

### Phase 0: view-cube format (1–2 days)

- [ ] Write a one-page spec, `docs/view-cube-spec.md`. It covers:
  - grid: EPSG:3857, square pixels, origin and size in attrs;
  - variables and dtypes: float16 where precision allows; displacement in metres;
  - chunking: `(1, 256, 256)` for tiles, plus a time-series-friendly copy of `displacement`, chunked `(all, 32, 32)`;
  - root attributes: `title`, `reference_lonlat`, LOS attrs, the colour range per variable, `source_cube`.
- [ ] Add a `view` output to `to_geozarr.py`: nearest-neighbour resampling from UTM, keeping the exact values.
- [ ] Convert the 17 dams cubes and compare sizes with the UTM cubes; we expect 3–5× smaller.
- [ ] Validate: compare the time series at 20 random points against the UTM cube, at the nearest pixel.

**Done when:** every dams cube has a view cube, and point values match the UTM cube at the nearest pixel.

### Phase 1: bowser-lite server (3–5 days)

- [ ] List the endpoints the UI calls for MD cubes:
  `/datasets`, `/variables`, `/config`, `/catalog`, tiles, `/point`, `/chart_point`, `/multi_point`, `/buffer_timeseries`, trend, profile, histogram.
- [ ] Implement them on zarr + numpy only. Reuse the per-request dataset routing from `fix/catalog-dataset-routing`.
- [ ] Ship colormaps as built-in lookup tables, generated once from matplotlib at build time.
- [ ] Encode PNG with zlib + numpy.
- [ ] Golden tests: the same requests against bowser and bowser-lite on one cube; tiles within one colour step, series identical.
- [ ] Measure the dependency footprint and keep a CI check that fails if it grows past budget.

**Done when:** the UI works unchanged against bowser-lite on all dams cubes, golden tests pass, and the core dependencies stay at about 70 MB or less.

### Phase 2: desktop shell (1–2 days)

- [ ] Add a `bowser.desktop` entry point. It starts bowser-lite in a thread on a free port and opens a pywebview window.
- [ ] Start screen: open folder, open link, recent list (stored in the user config directory).
- [ ] In-memory catalog from the folder, using the cube titles. A clear message when a folder has no cubes.
- [ ] Shut the server down with the window; one instance per user (a second launch focuses the first).
- [ ] Run from source on Linux; try it on one Windows and one macOS machine by hand.

**Done when:** a non-technical user can open the dams folder and browse every cube without a terminal.

### Phase 3: packaging and CI (2–3 days, plus iteration)

- [ ] PyInstaller specs: one folder per platform, then an installer — `.exe` with Inno Setup, `.dmg`, and AppImage.
- [ ] GitHub Actions matrix: windows-latest, macos-14 (arm64), macos-13 (Intel), ubuntu.
- [ ] Smoke test per platform: start the app headless, load a sample cube, fetch one tile and one point.
- [ ] Attach the installers to tagged releases; record the size of each.

**Done when:** each tag produces three installers of 60 MB or less that pass the smoke test.

### Phase 4: polish (optional)

- [ ] Code signing and notarization: an Apple Developer account ($99/yr) and a Windows code-signing certificate.
- [ ] An update check against GitHub releases.
- [ ] Drag-and-drop a folder onto the window.
- [ ] The S3/https plugin (obstore, ~10 MB) in the default build if hosted cubes become the main use.

## Size budget (estimates, to confirm in phase 3)

| Part | Installed |
|---|---|
| Python runtime | ~25 MB |
| numpy | ~35 MB |
| zarr + numcodecs | ~10 MB |
| FastAPI, starlette, uvicorn, pydantic | ~15 MB |
| pywebview + React UI | ~4 MB |
| **Total** | **~90 MB installed, ~40 MB download** |
| S3/https plugin (optional) | +~10 MB |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Feature parity with bowser: many endpoints | Start with what the UI uses for MD cubes; golden tests against current bowser |
| Existing UTM cubes don't open in the app | Convert to view cubes on the processing side (phase 0); bowser keeps reading UTM cubes |
| Windows needs the WebView2 runtime | It ships with Windows 10/11; link Microsoft's small installer for older systems |
| Unsigned apps trigger OS warnings | Give a one-line first-launch instruction until phase 4 |
| Untested on Windows/macOS so far | The CI matrix with smoke tests (phase 3) and manual tries in phase 2 |
| Large cube folders (~20 GB for the dams) | View cubes are smaller; S3/https links avoid copying data |

## Decisions needed

1. **Dependency:** is the view-cube copy (Web Mercator) acceptable as the app's input? It is what removes GDAL.
2. **Data source:** local folders only, or S3/https in the default build too (+10 MB)?
3. **Signing:** get the certificates now, or ship unsigned for team use first?
4. **Repository:** build the app on a branch of the `mgovorcin/bowser` fork, as proposed, or in a separate repository?

## Prerequisites

- Commit the catalog fix on `fix/catalog-dataset-routing` (per-request dataset routing, and the title in `/config`).
- Finish the 7 remaining S1 dams cubes (they need an AWS login), so phase 0 can convert the full set.
