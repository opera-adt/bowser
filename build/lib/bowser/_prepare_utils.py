import logging
from functools import partial
from pathlib import Path
from typing import Sequence

import h5py
from opera_utils import get_dates
from opera_utils.credentials import ASFCredentialEndpoints, AWSCredentials
from opera_utils.disp import open_h5
from osgeo import gdal
from tqdm.contrib.concurrent import process_map

from bowser.add_overviews import add_overviews

logger = logging.getLogger("bowser")


def process_netcdf_files(
    netcdf_files: Sequence[Path | str],
    output_dir: Path,
    datasets: list[str],
    max_workers: int = 5,
    strip_group_path: bool = False,
) -> None:
    """Process NetCDF files in the input directory, create VRT files, build overviews.

    Parameters
    ----------
    netcdf_files : Sequence[Path]
        Paths to input NetCDF files.
    output_dir : Path
        Path to the directory where output VRT files will be saved.
    datasets : list[str]
        list of dataset names to process from each NetCDF file.
    max_workers : int
        Number of parallel files to process.
        Default is 5.
    strip_group_path : bool
        If True, the output directory for the VRTs is only one level deep.
        Otherwise, uses the full HDF5 path as VRT path.
        Default is False.

    Returns
    -------
    None

    Notes
    -----
    This function processes all NetCDF files in the input directory, creates VRT files
    for each specified dataset, and builds overviews for the created VRT files.

    """
    # Ensure output directory exists
    out_path = Path(output_dir)
    out_path.mkdir(exist_ok=True, parents=True)

    if any(str(f).startswith("s3://") for f in netcdf_files):
        aws_credentials = AWSCredentials.from_asf(endpoint=ASFCredentialEndpoints.OPERA)
    else:
        aws_credentials = None

    func = partial(
        process_single_file,
        output_dir=output_dir,
        datasets=datasets,
        aws_credentials=aws_credentials,
        strip_group_path=strip_group_path,
    )

    process_map(
        func,
        netcdf_files,
        max_workers=max_workers,
    )


def process_single_file(
    netcdf_file: str,
    output_dir: Path,
    datasets: list[str],
    aws_credentials: AWSCredentials | None,
    strip_group_path: bool = False,
) -> None:
    """Create VRT files from subdatasets and build overviews.

    Parameters
    ----------
    netcdf_file : str
        Path to the input NetCDF file.
    output_dir : Path
        Path to the directory where output VRT files will be saved.
    datasets : list[str]
        list of dataset names to process from the NetCDF file.
    aws_credentials : AWSCredentials, optional
        Object containing temporary S3 credentials for remote datasets.
        Only usable on in-region EC2 instances.
    strip_group_path : bool
        If True, the output directory for the VRTs is only one level deep.
        Otherwise, uses the full HDF5 path as VRT path.
        Default is False.

    Returns
    -------
    None

    """
    # Extract date information from the filename

    try:
        fmt = "%Y%m%d"
        # TODO: NISAR ifgs may have 4 dates in them
        # Rethink how to make this filename here for multiple products
        dates = get_dates(netcdf_file, fmt=fmt)[:2]
        vrt_filename = f"{dates[0].strftime(fmt)}_{dates[1].strftime(fmt)}.vrt"
    except IndexError:
        # Date parsing failed: just use stem
        # TODO: NISAR holds ref/secondary as
        # /science/LSAR/identification/secondaryZeroDopplerEndTime
        vrt_filename = f"{str(netcdf_file).replace('/', '_')}.vrt"

    if str(netcdf_file).startswith("s3://"):
        hf = open_h5(netcdf_file, aws_credentials=aws_credentials)
        logger.debug(f"Read remote {netcdf_file}")
    else:
        hf = h5py.File(netcdf_file)

    for in_dataset in datasets:
        if in_dataset not in hf:
            continue
        out_dataset = in_dataset if not strip_group_path else in_dataset.split("/")[-1]
        cur_output_dir = output_dir / out_dataset
        cur_output_dir.mkdir(exist_ok=True, parents=True)

        vrt_path = cur_output_dir / vrt_filename

        # Create VRT file
        gdal.Translate(
            str(vrt_path),
            f"netcdf:{netcdf_file.replace('s3://', '/vsis3/')}:{in_dataset}",
            callback=gdal.TermProgress_nocb,
        )

        # Build overviews using GDAL function with compression
        add_overviews(vrt_path, external=True)
