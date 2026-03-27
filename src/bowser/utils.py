import json
import subprocess
from datetime import datetime
from functools import cache
from typing import Sequence, TypeVar

import numpy as np
from dateutil import parser
from scipy import stats


class CredentialsError(Exception):
    """Raised when AWS credentials have expired."""


DateOrDatetimeT = TypeVar("DateOrDatetimeT", datetime, np.datetime64)


def _parse_x_values(x_values: list[str | int]) -> np.ndarray:
    """Parse x_values to get numeric time values in days.

    Parameters
    ----------
    x_values : list[str | int]
        List of x values which can be:
        - integers (no time information)
        - datetime strings in "%Y-%m-%d" format (both xarray and COG modes)

    Returns
    -------
    np.ndarray
        Numeric time values in days since first time value

    """
    if not x_values:
        return np.array([])

    # If x_values are integers, just use them as-is
    if isinstance(x_values[0], int):
        return np.array(x_values, dtype=float)

    # Otherwise, parse datetime strings
    dates = []
    for x in x_values:
        if isinstance(x, str) and "_" in x:
            # Multiple dates in the string (e.g., "20160708_20160801")
            # Use index 1 (second date) as per requirement
            parts = x.split("_")
            date_str = parts[1] if len(parts) > 1 else parts[0]
        elif isinstance(x, int):
            date_str = str(x)
        else:
            date_str = x

        try:
            date = parser.parse(date_str)
            dates.append(date)
        except ValueError as e:
            raise ValueError(f"Could not parse date string: {date_str}") from e

    return datetime_to_float(dates)


def calculate_trend(
    values: np.ndarray, x_values: list[str | int | DateOrDatetimeT]
) -> dict[str, float]:
    """Calculate linear trend for time series data.

    Parameters
    ----------
    values : np.ndarray
        Time series values (e.g., displacement in meters)
    x_values : list[str | int]
        Time values as strings (datetime format) or integers

    Returns
    -------
    dict[str, float]
        Dictionary with slope (m/day), intercept (m), r_squared, and mm_per_year

    """
    # Filter out NaN values
    valid_mask = ~np.isnan(values)
    if valid_mask.sum() < 2:
        return {
            "slope": 0.0,
            "intercept": 0.0,
            "r_squared": 0.0,
            "mm_per_year": 0.0,
        }

    valid_values = values[valid_mask]

    # Parse x_values to get numeric time values in days
    time_days = _parse_x_values(x_values)
    valid_time = time_days[valid_mask]

    # Calculate linear regression using actual time values
    slope, intercept, r_value, p_value, std_err = stats.linregress(
        valid_time, valid_values
    )

    # Convert slope to mm/year
    # slope is in meters/day, so convert to mm/year
    mm_per_year = slope * 1000 * 365.25

    return {
        "slope": float(slope),
        "intercept": float(intercept),
        "r_squared": float(r_value**2),
        "mm_per_year": float(mm_per_year),
    }


def datetime_to_float(dates: Sequence[DateOrDatetimeT]) -> np.ndarray:
    """Convert a sequence of datetime objects to a float representation.

    Output units are in days since the first item in `dates`.

    Parameters
    ----------
    dates : Sequence[DateOrDatetimeT]
        List of datetime objects to convert to floats

    Returns
    -------
    date_arr : np.array 1D
        The float representation of the datetime objects

    """
    sec_per_day = 60 * 60 * 24
    date_arr = np.asarray(dates).astype("datetime64[s]")
    # Reference the 0 to the first date
    date_arr = date_arr - date_arr[0]
    return date_arr.astype(float) / sec_per_day


def list_bucket(
    bucket: str | None = None,
    prefix: str | None = None,
    suffix: str | None = None,
    full_bucket_glob: str | None = None,
    aws_profile: str | None = None,
    num_workers: int = 10,
) -> list[str]:
    """Use `s5cmd` to quickly list items in a bucket.

    Parameters
    ----------
    bucket : str
        Name of the bucket.
    prefix : str, optional
        Prefix to filter by, by default "".
    suffix : str, optional
        Suffix to filter by, by default "".
    full_bucket_glob : str, optional
        Alternate to prefix/suffix. Full glob to filter by, by default None.
    aws_profile : str, optional
        AWS profile to use, by default None.
    num_workers : int, default = 10
        Number of workers to use for parallel downloads.

    Returns
    -------
    list[str]
        List of items in the bucket.

    """
    cmd = ["s5cmd", "--json", "--numworkers", str(num_workers)]
    if aws_profile:
        cmd += ["--profile", aws_profile]

    if full_bucket_glob:
        bucket_str = full_bucket_glob
    else:
        bucket_str = f"s3://{bucket}"
        if prefix:
            bucket_str += f"/{prefix}"
        if suffix:
            bucket_str += f"*{suffix}"
    cmd += ["ls", bucket_str.strip()]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=90)
    except subprocess.CalledProcessError as e:
        if "ExpiredToken" in e.stderr:
            raise CredentialsError(
                "Error downloading files: AWS credentials have expired."
            ) from e
        raise RuntimeError(f"Error listing bucket {bucket_str}: {e.stderr}") from e

    out: list[str] = []
    for line in p.stdout.splitlines():
        item = json.loads(line)
        if item["type"] == "directory":
            continue
        out.append(item["key"])
    return out


@cache
def generate_colorbar(cmap_name: str) -> bytes:
    """Generate a colorbar image using a specified matplotlib colormap.

    Parameters
    ----------
    cmap_name : str
        Name of the colormap to be used.

    Returns
    -------
    bytes
        WEBP image data as bytes

    """
    from io import BytesIO

    import matplotlib.pyplot as plt
    import numpy as np

    gradient = np.array([[0, 1]])
    fig, ax = plt.subplots(figsize=(9, 1.5))
    ax.imshow(gradient, cmap=cmap_name)
    ax.set_visible(False)

    # Create colorbar in a tightly fitted axis
    cax = fig.add_axes([0.05, 0.2, 0.9, 0.6])
    colorbar = plt.colorbar(
        ax.imshow(gradient, cmap=cmap_name), cax=cax, orientation="horizontal"
    )
    colorbar.set_ticks([])

    # Adjust subplot parameters and apply tight layout
    plt.subplots_adjust(left=0, right=1, top=1, bottom=0)

    buf = BytesIO()
    plt.savefig(buf, format="webp", bbox_inches="tight", pad_inches=0)
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def desensitize_mpl_case():
    """Make `cmap` case insensitive by registering repeated cmap names."""
    import matplotlib as mpl

    cmap_names = list(mpl.colormaps)
    for name in cmap_names:
        if name.lower() in mpl.colormaps:
            continue
        mpl.colormaps.register(mpl.colormaps[name], name=name.lower())
