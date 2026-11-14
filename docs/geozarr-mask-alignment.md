# Date-aligned GeoZarr masks

Full-record point and buffer charts previously used only the first frame of a
dynamic layer mask. A pixel could therefore remain visible at dates when its
quality failed, or disappear at later dates when it became usable. Independently
clamping an unrelated mask axis also allowed acquisition indices to be mistaken
for a mask's own date/ministack indices.

The full and lite servers now validate complete data/mask axes before selecting
corresponding mask frames. Compatible dynamic masks follow every data date;
2-D static masks broadcast across the record. This is a data-selection repair,
not a change to stored motion, processing algorithms, references or scientific
defaults. No date, spatial coordinate or measurement is invented or interpolated.

## Support rules

- Masks require explicit, matching 1-D x/y coordinates on the selected dataset
  or pyramid level. No outer-coordinate union or automatic resampling occurs.
- Dynamic masks require the same non-spatial dimension name and identical
  coordinate values/order as the complete data variable. Matching array length
  alone is insufficient. This intentionally conservative rule rejects differently
  named axes even when they may describe the same dates; prepare an explicitly
  compatible layer before applying it through these paths.
- A one-frame dynamic mask is not silently treated as static. Supply a 2-D
  mask to declare static support explicitly.
- A static velocity/rate layer cannot use an arbitrary frame of a dynamic
  mask. Select an explicit static quality summary instead. The viewer does not
  choose or compute that summary on the user's behalf.
- Existing source-index clamping is retained for single-date requests, after
  compatibility is checked. Data and masks select the same resolved source
  index. A full-series request never substitutes the first mask frame.
- Layer `min` retains `>= threshold`, `max` retains `<= threshold`, and primary
  masks retain `> threshold`. Thresholds stay in native mask units. Intrinsic
  mask nodata, declared missing-value sentinels and nonfinite samples are
  excluded. Legitimate zero data and zero mask values remain valid when the
  selected comparison permits them.
- Multiple masks combine with AND. The existing recommended-mask startup
  selection is retained only when compatible with the initial layer. No new
  processing masks, static reductions or thresholds are introduced.

Malformed masks, unknown layers, invalid thresholds/modes and incompatible
axes return HTTP 422. Point-chart request validation failures propagate instead
of becoming a successful response with empty datasets. There is no fallback
to unmasked values. Component compatibility, stable ground and the physical
meaning of source quality metrics still require independent assessment.

## Paths and limitations

The correction covers full-server GeoZarr tiles, GeoTIFF exports, mask-aware
point charts (`/multi_point`) and buffers, plus lite's GeoZarr tiles and matching
chart routes. The existing raw `/point` route does not gain mask parameters.
Lite native GeoTIFF exports enforce the same coordinate/support checks.
Catalog resolution remains isolated.

Polygon statistics already validate dynamic coordinate support and retain their
existing endpoint contract, including its grid/CRS checks. This contribution
does not introduce a general acquisition-to-ministack mapping, a connected-
component policy or GeoTIFF point/radius masking.
The validator shares the polygon reader's CRS metadata checks; it never
reprojects or repairs incompatible masks. Full-server direct point reads now
normalize the stored CRS variable to a coordinate, like the lazy/lite readers.

Legacy chart reference samples continue to use their existing requested masks,
now aligned by date. Reference-aware exports and native polygon summaries
continue to sample raw source reference support before optional display masks.
This repair does not unify or otherwise change those reference policies.

The shared validator reads coordinate metadata, not raster arrays. Full-server
paths validate complete source axes, **then select a date/point/circle window
before** comparisons and `where`. This avoids constructing full-record masking
graphs for individual tiles. Buffer/reference window geometry is unchanged;
unrequested data are not averaged, filtered or interpolated.
Lite continues to select the requested point/window before loading values and
imports no full-server geospatial stack. No installed dependency changes.

## Viewer compatibility controls

`GET /datasets` includes a `mask_compatibility` map for each GeoZarr layer.
`null` means compatible; text explains an incompatible grid, CRS, data type or
axis. Full and lite use the same metadata-only validator. The Masking picker
only offers compatible layers. A restored or previously selected incompatible
mask remains visible as a disabled option, with a persistent explanation and
instructions to remove it or select a static summary—even when the panel is
collapsed. Adding a new mask selects from compatible options only.

When switching from displacement to velocity, a previously selected dynamic
mask can become incompatible. It is **not silently removed**: the user sees the
warning and chooses a static summary or removes it. Such explicit API requests
still return 422. This implements the review's UI option, not its alternative of
retaining legacy temporal clamping. It does not make a ministack index an
acquisition index or decide an all-record/percentile summary on the user's behalf.
Ministack quality layers remain viewable as layers. To mask acquisition dates,
they require an explicit, validated date mapping, which this PR does not invent.
Split/comparison layers are still validated separately by the server.

GPU rendering requires the server's coordinate-compatibility proof for a mask;
otherwise it falls back to server tiles. A dynamic mask uses the resolved source
index directly, with a defensive matching-axis-size check, rather than separately
clamping its own index. Static masks use frame zero. Nonfinite mask values are
rejected consistently. This does not certify every GPU/nodata convention or
unsupported pyramid layout; these paths retain their existing limitations.

`layer_masks=""` means no explicit masks, like an omitted parameter.
The shared mask validation/comparison helpers are also used by polygon statistics;
polygon endpoint support rules and references remain unchanged. Golden response
updates add only compatibility metadata: measurement values are checked unchanged.

## Validation

Synthetic HTTP tests first reproduce incorrect histories and accepted
incompatible axes on the original full/lite implementations. Corrected tests
compare map alpha and exported values/masks on an aligned grid, and check
point/buffer histories for changing and static support. They verify that
unrelated date/ministack masks and dynamic masks on static velocity return
explicit errors. Unit tests cover date and pair axes, transposed masks,
reversed/shifted/missing coordinates, signed comparisons, zeros, sentinels,
nonfinite values, malformed requests and source immutability. Lazy tests prove
that a selected date evaluates only that date's data/mask tasks, and that axis
validation itself does not read raster values.

The revision adds actual Chrome full/lite point/radius checks and UI tests for
incompatible selections and static-summary replacements. A read-only benchmark
on an existing 315-date cube compares identical masked-array byte hashes before
and after; its timing is a local example, not a remote-service guarantee. Source labels, native units, stored reference datum and scientific
processing remain unchanged.
