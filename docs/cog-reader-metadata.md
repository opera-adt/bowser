# GeoTIFF map metadata

The GeoTIFF `CustomReader` exposes its underlying rio-tiler reader's `info()`.
TiTiler requests this metadata when creating TileJSON, before the browser can
request the advertised image tiles. Leaving this wrapper method unimplemented
raises an error even when direct numeric tile calls work.

The returned information describes the source raster: bounds, CRS, data type,
band descriptions, nodata and any already-stored metadata. This does not fit
motion, compute new statistics, apply a new reference or redefine mask rules.
It does not claim source metadata are statistics of a masked view. The separate
`statistics()` wrapper is unchanged.

Synthetic regressions reproduce the missing-method error, compare one/two-band
metadata with the source reader with no/primary/extra masks, and request actual
TileJSON followed by its advertised PNG tile. They check bounds, query/mask
forwarding, dtype, band labels, valid zero pixels, exact transparency and
unchanged source hashes. Masked and unmasked tiles retain existing rules.
