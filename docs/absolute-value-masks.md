# Absolute-value layer masks

Use an absolute-value comparison when both large negative and large positive
values should be screened the same way. For example, a signed scaling factor
of −20 should not pass a magnitude limit of 5 simply because −20 is less than 5.

In **Main → Masking**:

1. Add a layer mask and choose the layer to use, such as a signed scaling factor.
2. Choose **`|value| ≤`** and enter a nonnegative limit, such as **5**.
3. Pixels with mask values from **−5 through +5**, inclusive, are retained.
   NaN, infinity and declared mask nodata remain excluded.
4. Clear the mask to return to the original source support.

**`|value| ≥`** keeps magnitudes at or above the limit, also inclusively.
Zero is a valid threshold. Negative and nonfinite absolute thresholds are
rejected. These controls compare magnitude only: negative displacement,
velocity or scaling-factor samples remain negative on the map and in exports.
The masking layer can mask itself. No capped or absolute-valued data product
is created, and the source raster/cube is never rewritten.

Absolute controls use a nonnegative slider range based on both ends of the
mask layer's available range. Signed controls retain their existing percentile
limits. Switching operators is a user action; it does not change the initial
mask choices, processing defaults or stored values. Numerical threshold input
can exceed the suggested slider range when needed. The existing signed histogram
and kept-share preview remain available for signed comparisons only; they are
not shown for absolute comparisons because those need a magnitude histogram.

The request representation is shared by map tiles, native point/radius/polygon
analysis and GeoTIFF export:

```json
{"dataset": "signed_factor", "mode": "abs_max", "threshold": 5}
```

`abs_min` represents `|value| ≥`. Saved projects retain the mode and threshold.
Exports and polygon details describe the actual comparison as `|value| <=` or
`|value| >=` with the threshold and source layer. Export filenames remain short;
the detailed mask provenance is in metadata.

The existing `min` and `max` modes are unchanged. In particular, legacy COG
`min` remains strict `>` while GeoZarr `min` is inclusive `>=`. Both new
absolute modes use inclusive boundaries in all supported paths. Multiple masks
combine with AND and cannot restore invalid source pixels or missing dates.

The full server supports these modes for GeoZarr and direct GeoTIFF inputs.
Lite supports them for GeoZarr tiles, point/radius charts, native polygon
summaries and native GeoTIFF exports. Absolute masks use server-rendered tiles;
the GPU path explicitly falls back rather than treating them as signed limits.
Existing native-grid/date alignment and reference policies remain as documented
in [the alignment guide](geozarr-mask-alignment.md). Configured/uploaded polygon
masks remain unsupported. These are display/analysis
masks, not new scientific processing or a substitute for checking displacement
quality and observation geometry.
