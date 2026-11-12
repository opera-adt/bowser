# Point and radius chart request lifetimes

Changing masks, point coordinates, reference settings, sources or buffer radii
starts a new chart request. A slower reply from an earlier setting must not
replace the latest result. Removing a point or closing a chart also invalidates
its pending work.

Point charts use a per-window request revision. Buffer effects invalidate their
previous callbacks on cleanup. Old curves clear while new values load; only the
current request may publish data or finish its loading indicator. Failed
multi-point HTTP responses are not treated as valid chart data. A failure of
the current request cannot be followed by an old success restoring its curve.

Requests already in flight can still finish on the server; this change ignores
their obsolete replies rather than promising transport cancellation. It does
not change data values, reference arithmetic, fits, sampling, mask definitions
or scientific processing. Polygon statistics retain their separate machinery.

Deferred-response tests cover point masks, changed references, removed points,
newer failures and out-of-order buffer radii. They exercise the actual chart
component and API client with controlled responses, preserving the latest
measurement values exactly.
