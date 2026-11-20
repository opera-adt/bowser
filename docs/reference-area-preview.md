# Reference-area preview

The reference buffer chart shows a neighborhood's saved history before changing
its spatial reference. It is a diagnostic: a smooth or near-zero curve does not
prove that the ground is stable.

The API returns dated observations. The preview aligns each median and sampled
history to the layer's exact saved labels. Missing observations stay gaps;
measured zero is retained. It never inserts a later measurement into an earlier
gap or fabricates a zero mean when no sample curves are available.

The mean and ±1 standard deviation lines summarize the returned sample curves,
not a formal measurement uncertainty. The median is the API's area summary.
These need not be identical. This chart does not alter the reference coordinates,
reference radius, sampling, native measurements or reference-offset calculation.
The preview starts with raw-source support. Its optional **Apply current quality
masks to preview** checkbox requests a separately labeled quality-screened
diagnostic using current named/configured/uploaded masks. It sends no spatial
reference coordinates: these are stored values, not a new reference adjustment.
Unchecking restores the raw preview. Failed requests clear the curve and keep
the control available. This does not change the map/export reference sampling
policy, which remains raw-source support. Mask changes refresh the diagnostic;
late replies cannot restore an obsolete curve.

An unavailable request clears the previous curve and reports that the summary
could not be loaded. A response from an obsolete area cannot replace the chart
for a newly selected area.
