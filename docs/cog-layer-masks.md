# GeoTIFF layer-mask thresholds

For direct GeoTIFF/COG **map tiles and exports**, a named layer mask supports:

| Mode | Kept mask values |
| --- | --- |
| `min` | Strictly greater than the threshold (`>`, existing behavior) |
| `max` | Less than or equal to the threshold (`<=`) |

These are signed comparisons, not absolute values. Source units, signs and
pixel values do not change. Multiple masks combine with AND. Intrinsic source
nodata and per-band masks remain invalid; valid zero data stay valid when their
quality mask passes. Legacy internal two-item extra-mask entries retain the
strict minimum comparison.

Extra-mask nodata, masked samples, NaN and infinity are excluded before either
comparison. Missing mask coverage is not treated as unmasked data. A mask tile
wholly outside coverage yields no valid pixels; other mask read errors propagate.
Malformed named-mask requests, unknown/empty layers, invalid modes and
nonfinite thresholds return 422 instead of silently dropping a requested mask.

Exports record the actual operator and threshold in their provenance metadata.
When a mask's CRS, shape **or transform** differs, it is aligned with the
existing nearest-neighbor resampling to the data grid. Same-sized but shifted
masks must not shrink the output through coordinate alignment. The source
raster's extent, transform and grid remain unchanged.

## Scope

GeoZarr date alignment is covered separately in
[the alignment guide](geozarr-mask-alignment.md).

This repair changes map-tile and native-export handling. It does **not** claim
point/radius chart parity: the current GeoTIFF point reader does not apply named
layer masks, and the broader chart-mask routing fix is separate. Do not use a
masked map as evidence that its point chart was masked identically.

With the dependent native polygon-mask API and frontend enabled, upper bounds
also apply to polygon summaries. Those masks must share the exact native grid
and temporal labels; the polygon API still rejects shifted/resampled masks.
Configured and uploaded polygon masks remain unsupported and give explicit
errors. Point/radius chart mask routing remains separate.

Time-index clamping, acquisition-label matching and reference sampling are not
changed. Tests use matching temporal inputs; they do not establish arbitrary
dynamic-mask alignment. Existing configured-primary-mask rules are also not
redefined by the extra-mask comparison repair.

## Verification

Synthetic tests compare actual numeric `.npy` tiles with exported GeoTIFF
values, validity, units, grid and mask provenance. They include signed bounds
and equality, static/dynamic masks, AND combinations, valid zeros, intrinsic
nodata, nonfinite mask values, multiple source bands, unreadable masks, partial
and absent coverage, and same-sized shifted masks. Source file hashes are
unchanged. These are software-validity checks, not validation of ground motion,
phase linking, unwrapping or time-series inversion.
