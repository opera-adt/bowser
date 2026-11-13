# LOS geometry availability

The LOS indicator distinguishes geometry supplied with the selected layer from
an explicitly selected manual illustration. Missing or incomplete source
geometry does not trigger an assumed satellite look direction.

Heading and incidence must be finite, incidence angles must be between 0 and
90 degrees, and the ground-to-satellite ENU vector must have finite components,
a positive up component and a nonzero horizontal direction for these diagrams.
Missing optional near/far incidence angles, including serialized nulls, use the
center incidence. These are basic display checks, not orbit/geometry validation.

Incomplete metadata is reported as unavailable rather than crashing the viewer,
including when the indicator is closed. **Enter manually** allows an approximate
illustration; it is labeled as such and resets when the selected layer changes.
It does not write geometry to the dataset or change any measurements or exports.
Valid supplied left/right-looking displays retain the existing calculations.

This repair does not establish whether a particular layer measures LOS motion
or its positive/negative sign convention. Re-referencing capability alone does
not prove that a layer is LOS: ENU, map-grid offsets and downslope products need
their own quantity/sign interpretation. That broader metadata/polarity audit
remains separate work.


## Geometry is independent of what a layer measures

The same viewing geometry can accompany LOS motion, east/north/up components,
derived downslope motion and quality layers. `uses_spatial_ref` only says the
layer can be re-referenced; it does not establish a direction or sign.

The LOS widget uses the existing backend `measurement.kind` and
`measurement.positive_direction`. It shows plus/minus labels only for
`line_of_sight` with the documented canonical sign “towards the satellite” or
“away from the satellite”. Positive-away data reverses the labels; values are
never negated or converted. Unknown sign hides labels, rather than assuming a
sensor convention. Geometry remains available as context for other/unknown
quantities. Legacy responses without measurement metadata retain the geometry
but omit unverified sign labels. Sign metadata is independent of whether the
moving reference is enabled. Manual geometry stays explicitly illustrative and
does not establish a layer's quantity/sign.
