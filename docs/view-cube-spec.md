# View cube format, version 1

A **view cube** is a display copy of a bowser GeoZarr cube, resampled onto the global Web Mercator tile grid. The analysis cube stays on its native grid (UTM for DISP); the view cube is a derived product for viewers.

On this grid, serving the map needs only array slicing:
- a map tile at the cube's zoom is exactly one chunk;
- a lon/lat becomes a pixel through a closed-form formula.

So a server needs no GDAL, no pyproj and no reprojection at request time. This is what lets the desktop app (bowser-lite) stay small; see `desktop-app-plan.md`.

Write one with `bowser view-cube SOURCE OUTPUT` (`src/bowser/view_cube.py`). Today's bowser also opens view cubes, like any other cube.

## Grid

- **CRS:** EPSG:3857. Web Mercator square world of half-width `ORIGIN = π · 6378137` m. 256-pixel tiles, rows counted from the north.
- **Zoom** `z` (`view:zoom`): pixel size is `res = 2·ORIGIN / (256 · 2^z)` m.
- **Native zoom:** the default `z` is the coarsest zoom whose pixels are no larger *on the ground* than the source pixels:

  `z = ceil(log2(2·ORIGIN·cos(lat_c) / (256 · source_res)))`

  `lat_c` is the latitude of the cube centre. A Mercator pixel covers `res · cos(lat)` m of ground.
  - For 10 m data at 34° N (Prado) that is zoom 14: 9.55 m Mercator, 7.9 m on the ground.
  - Because the view pixels are finer than the source pixels, every source pixel is kept.
- **Extent:** whole tiles. The array starts at global tile `view:tile_origin = [col0, row0]` and spans `view:tile_count = [nx, ny]` tiles. It is `ny·256 × nx·256` pixels, padded with NaN outside the source footprint.
- **Coordinates:** `x` and `y` are pixel *centres*. `spatial:transform = [res, 0, x0, 0, -res, y0]`, where `(x0, y0)` is the north-west corner:
  - `x0 = -ORIGIN + col0·256·res`
  - `y0 = ORIGIN - row0·256·res`

## Values

- **Resampling:** nearest neighbour. Each view pixel holds the source value at the source pixel containing its centre, so no value is invented or averaged.
- **dtypes:** float variables keep their dtype (float32 for DISP). Integer layers become float32, so the padding can be NaN. NaN means outside, padding or source nodata.
- **Variables:** every `(…, y, x)` variable is resampled. Variables without `y, x` (e.g. `reference_time`) and non-spatial coordinates (`time`) are copied unchanged.
- **`spatial_ref`:** the CF grid mapping for EPSG:3857 (`crs_wkt` included). Every resampled variable has `grid_mapping = "spatial_ref"`.

## Chunks and storage

- **Chunks:** `(1, …, 256, 256)`, one per time step and tile, aligned to the tile grid.
- **Format:** Zarr v3 with consolidated metadata, and xarray's default compression.
- **Datetimes** (`time`, `reference_time`): int64 nanoseconds since 1970-01-01, which is exact.
- **Writing:** static layers and the first time step first, then one step per append. Memory stays at one slice per variable: a 101-date, 1792×1792 stack peaks at 1.5 GB.

## Root attributes

All source root attributes are copied: `title`, `reference_lonlat`, `reference_method`, the LOS attributes (`heading_angle_deg`, `incidence_angle_deg`, `los_enu_ground_to_satellite`, `look_direction`), and the rest. Then these are set:

| Attribute | Value |
|---|---|
| `proj:code` | `"EPSG:3857"` |
| `spatial:transform`, `spatial:shape`, `spatial:bbox`, `spatial:dimensions`, `spatial:registration` | the view grid (`pixel` registration) |
| `view:version` | `"1"` |
| `view:zoom` | native (or chosen) zoom |
| `view:tile_origin` | `[col0, row0]`, global tile indices of the first chunk |
| `view:tile_count` | `[nx, ny]` |
| `view:source_cube` | file name of the source cube |
| `view:source_res_m` | source pixel size (m) |
| `reference_row`, `reference_col` | recomputed on the view grid from `reference_lonlat` |

## Reading it (for bowser-lite)

Native zoom `n`; map tile `(z, tx, ty)`.

- **`z == n`:** the chunk at `(ty - row0, tx - col0)`. Outside the cube means an empty tile.
- **`z < n`:** decimate. Let `k = 2^(n-z)`. The tile covers `k × k` chunks starting at `(ty·k - row0, tx·k - col0)`; take every `k`-th pixel of that block, i.e. nearest-neighbour.
- **`z > n`:** magnify. Let `k = 2^(z-n)`. Read `256/k` pixels per side from chunk `(⌊ty/k⌋ - row0, ⌊tx/k⌋ - col0)`, at offset `((ty mod k)·256/k, (tx mod k)·256/k)`, and repeat each pixel `k` times.
- **Point (lon, lat):**
  - `x = R·lon_rad`
  - `y = R·ln(tan(π/4 + lat_rad/2))`
  - `row = ⌊(y0 - y)/res⌋`
  - `col = ⌊(x - x0)/res⌋`

## Validation (2026-10-13)

All 10 dams cubes (7 NISAR, 2 S1, 1 S1 stripmap): `00_tools/dams/view/`.

| | Result |
|---|---|
| Native zoom | 14 for all (Prado 34° N, Oahe 44° N, Baldhill 47° N) |
| Time series at 20 random view pixels per cube | identical to the UTM cube (xarray nearest lookup), 10/10 cubes |
| Valid source pixels present | 100% in every cube |
| Reference pixel | holds the source reference value in every cube |
| Size | 5.30 GB against 4.48 GB in UTM (×1.18); ×1.05 at Prado, up to ×1.45 for the Baldhill stripmap stack |

Prado (NISAR ASC 034_A_019) in more detail:


- Time series at 20 random view pixels are identical to the UTM cube, looked up independently with xarray's nearest-neighbour selection.
- All 1,011,124 valid source pixels are present in the view cube.
- Through today's bowser server, `/chart_point` returns the same series from both cubes. A zoom-14 tile matches the UTM cube's tile on 99.8% of pixels. Both are nearest-neighbour; the 0.2% that differ are pixels where the two resamplers picked a different neighbour.
- `tests/test_view_cube.py` pins these properties on a synthetic cube.

## Not in version 1 (decided by measurement)

- **Size:** view cubes are *not* smaller than the UTM cubes (×1.18 over the dams set). The finer native grid has 2.3–3× as many pixels, and compression recovers most of that. The plan's "3–5× smaller" was wrong. The gain is no GDAL, not size.
- **float16:** would roughly halve the size, but it rounds displacement at the 0.1–1 mm level. Left out until we decide which layers can afford it (coherence and similarity in [0, 1] can).
- **A second, time-series-chunked copy of `displacement`:** deferred until bowser-lite shows point reads are too slow. A point read today is one 256×256 chunk per time step, from local disk.
