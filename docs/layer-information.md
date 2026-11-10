# Layer information

The main and split-view layer controls show brief explanations for recognized
movement, phase, coherence, scatterer, neighbor-support, residual, mask and
terrain layers. This is presentation metadata: opening a layer does not compute
new measurements, select a mask, change a reference, or modify the source.

Bowser's general guidance is kept separate from **Source information**, which
retains the producer's description and explicitly supplied category meanings.
Producer text is authoritative for the particular product. A familiar name
alone does not establish a sign convention, radar geometry, mask encoding,
processing window, filtering method, temporal baseline or velocity estimator.

For unrecognized layers, a source explanation is used when available. Otherwise
the panel says that the interpretation is undocumented. A variable name copied
into a band label is preserved as source metadata but is not treated as an
explanation. Source text is rendered as text, never executable HTML.

## Units and categories

Units come from source attributes or raster band metadata. No catalog entry
assigns meters, radians or unitless values to an undocumented layer. The panel
reports missing units explicitly. For raster groups, conflicting or missing
units between files are flagged and no common unit is assigned; values are
not converted to make the group consistent.

Category labels use matching `flag_values` and `flag_meanings` metadata. A zero
category is retained. The viewer does not invent water/land codes or interpret
`flag_masks` as categorical values. If category meanings differ between rasters,
no shared category dictionary is displayed. Producer text for a raster group
is identified as coming from its first raster.

## Input modes

- GeoZarr and other xarray inputs: variable attributes supply descriptions,
  units and category meanings. Full and lite servers use the same helper.
- Direct raster groups: metadata is captured during the existing header read,
  including the GDAL fallback for unsupported rasterio dtypes. Band metadata
  overrides dataset tags; an explicit band unit takes precedence over tags.
  The layer-info request does not reopen files just to retrieve those fields.

`/datasets` retains its existing identifiers and fields and adds `description`,
`description_source`, `source_description`, `source_flags` and `unit_status`.
Raster groups can also have explanatory `metadata_notes`. New fields are
optional on the frontend for compatibility with older dataset responses.

The catalog deliberately stays general. Product-specific scientific policies,
recommended thresholds, region-specific reference choices and acquisition
exclusions belong in processing configuration and source metadata.

Definitions were cross-checked against the [Dolphin documentation](https://dolphin-insar.readthedocs.io/)
and [OPERA DISP-S1 product specification](https://d2pn8kiwq2w21t.cloudfront.net/documents/OPERA_DISP_S1_Final_Product_Spec.pdf).
Different product versions can use different conventions, so source metadata
and the applicable version's documentation take precedence over general guidance.
