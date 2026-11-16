# A displayed reference date is not another measurement

Some displacement series begin after their reference acquisition. A producer may
show the earlier reference date as a defined zero. That zero can help read the
plot, but must not silently add a sample to a regression or uncertainty estimate.

Bowser accepts an explicit response annotation on `/multi_point`,
`/buffer_timeseries` and `/polygon_timeseries` responses:

```json
"display_datum": {
  "date": "2026-01-01",
  "value": 0,
  "independent_observation": false
}
```

This declaration applies only to that uniquely labeled, earlier date. It is not
inferred from ordinary zeros, names, or the layer's reference-date attribute.
Responses without the declaration keep their existing behavior. Measured zero
displacements remain valid observations.

At the API boundary Bowser separates this date from the observation labels,
point/radius samples, polygon statistics and parallel support/reference arrays.
For a complete valid history it draws a separate hollow diamond, whose tooltip
says **Defined reference datum; not an independent observation**. Incomplete or
empty histories do not acquire fabricated support. A polygon marker requires
fixed common support. Inconsistent declarations reject the response rather than
silently using a nonzero value or misaligned support as an observation.

The marker is excluded from fitted rates, residuals, polygon trend/statistic
calculations, numerical Assistant tools and numeric CSV rows. Point CSV comments
record its date and meaning. It can extend the chart's displayed date range, but
adds no raster or slider step. Clicking it cannot select an acquisition that does
not exist in the source.

An additional temporal reference hides the old marker: Bowser does not invent the
value that annotation would have under a new temporal baseline. Polygon markers
are also omitted when an additional spatial reference is being applied in the
browser. Measurements retain the existing referencing behavior. Supporting
transformed annotations under those operations is separate work.

This is display/data-contract handling, not a new constrained fit, a new physical
observation, or a change to phase linking, inversion, rasters or uncertainty math.
It does not infer whether a supplied reference region is stable. It also cannot
identify unmarked synthetic samples supplied by other producers.

Polygon pixel histories and per-date validity counts remain aligned to observation
dates when an explicitly declared display datum is separated. Genuine measured
zeros and null gaps remain unchanged; the input response is not mutated.
