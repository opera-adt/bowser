"""Extract acquisition dates embedded in raster filenames.

Bowser names its zarr dimensions and time-series x-values from dates parsed out
of the input filenames (``..._20160708_20160801.tif``), which is a few dozen
lines of regex. It used to come from ``opera_utils.get_dates``, but importing
``opera_utils`` pulls ``osgeo`` into ``sys.modules`` at module scope, which
makes the GDAL Python bindings a hard requirement of ``bowser run`` — and they
are not installable from PyPI. Parsing dates out of a string is not worth that.

Behavior matches ``opera_utils.get_dates``: only the file *name* is searched
(never the parent directories), GDAL subdataset strings are unwrapped first,
and a filename whose digits match the format but are not a real calendar date
raises ``ValueError`` rather than being silently skipped.
"""

from __future__ import annotations

import re
from datetime import datetime
from os import PathLike
from pathlib import Path

__all__ = ["DATE_FORMAT", "get_dates"]

DATE_FORMAT = "%Y%m%d"

# strptime directive -> regex matching the digits that directive consumes.
_DIRECTIVE_PATTERNS = {
    "%Y": r"\d{4}",
    "%y": r"\d{2}",
    "%m": r"\d{2}",
    "%d": r"\d{2}",
    "%H": r"\d{2}",
    "%M": r"\d{2}",
    "%S": r"\d{2}",
    "%j": r"\d{3}",
}


def get_dates(filename: str | PathLike[str], fmt: str = DATE_FORMAT) -> list[datetime]:
    """Search for dates in the name of ``filename`` matching ``fmt``.

    Dates appearing in parent directories are ignored, so a stack living under
    ``/data/20240101/`` does not pick up the directory's date on every file.

    Parameters
    ----------
    filename : str or os.PathLike
        Filename to search. May be a GDAL subdataset string
        (``NETCDF:"file.nc":var``), in which case the wrapped path is used.
    fmt : str
        strptime-compatible format to search for. Defaults to ``"%Y%m%d"``.

    Returns
    -------
    list of datetime.datetime
        Every match, in the order it appears in the name. Empty if none match.

    Raises
    ------
    ValueError
        If a run of digits matches ``fmt`` positionally but is not a real date
        (e.g. ``20241332``). This is deliberate: silently dropping it would
        mis-align a stack against its time coordinate.

    Examples
    --------
    >>> get_dates("/path/to/20191231.slc.tif")
    [datetime.datetime(2019, 12, 31, 0, 0)]
    >>> get_dates("unwrapped_20160708_20160801.tif")
    [datetime.datetime(2016, 7, 8, 0, 0), datetime.datetime(2016, 8, 1, 0, 0)]
    >>> get_dates("20240626T150051.tif", fmt="%Y%m%dT%H%M%S")
    [datetime.datetime(2024, 6, 26, 15, 0, 51)]
    >>> get_dates("/not/a/date_named_file.tif")
    []

    """
    name = _path_from_gdal_str(filename).name
    return [datetime.strptime(m, fmt) for m in re.findall(_format_to_regex(fmt), name)]


def _format_to_regex(fmt: str) -> str:
    """Convert a strptime format string into a regex matching the same text."""
    pattern = re.escape(fmt)
    for directive, digits in _DIRECTIVE_PATTERNS.items():
        # re.escape() escapes the '%' on some Python versions and not others,
        # so replace both spellings.
        pattern = pattern.replace(re.escape(directive), digits).replace(
            directive, digits
        )
    return pattern


def _path_from_gdal_str(name: str | PathLike[str]) -> Path:
    """Unwrap a GDAL subdataset string to the path it points at.

    ``DERIVED_SUBDATASET:AMPLITUDE:slc.tif`` and ``NETCDF:"stack.nc":var`` both
    reduce to the real file, so dates are read from that rather than from the
    variable name or the driver prefix.
    """
    s = str(name)
    if s.upper().startswith("DERIVED_SUBDATASET"):
        path = s.rsplit(":", maxsplit=1)[-1]
    elif ":" in s and s.upper().startswith(("NETCDF", "HDF")):
        path = s.rsplit(":", maxsplit=2)[1]
    else:
        return Path(s)
    return Path(path.strip('"').strip("'"))
