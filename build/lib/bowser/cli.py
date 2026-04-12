import json
import os
from pathlib import Path
from typing import Any

import click


@click.group()
def cli_app():
    """CLI for bowser."""


@cli_app.command()
@click.option(
    "-s",
    "--stack-file",
    help="Name of zarr/netcdf stack file to load as dataset.",
)
@click.option(
    "-f",
    "--rasters-file",
    default="bowser_rasters.json",
    help="Name of JSON file from `bowser set-data`.",
)
@click.option(
    "--port",
    "-p",
    default=None,
    type=int,
    help="Port to run the web server on.",
    show_default=True,
)
@click.option(
    "--reload",
    is_flag=True,
    help="Reload the server on file change.",
)
@click.option(
    "--workers",
    "-w",
    default=1,
    type=int,
    help="Number of uvicorn workers to spawn",
    show_default=True,
)
@click.option(
    "--log-level",
    default="warning",
    type=click.Choice(["error", "warning", "info", "debug"]),
    help="Logging verbosity level",
    show_default=True,
)
@click.option(
    "--ignore-sidecar-files",
    is_flag=True,
    help=(
        "Tell GDAL to ignore extra files in the directory containing the files to"
        " read. This is useful for S3 buckets with huge number of files (but not"
        " for local reading)."
    ),
)
@click.option(
    "--no-spatial-reference",
    "--ns",
    is_flag=True,
    help="Don't add a moving spatial reference point for `displacement` ",
)
@click.option(
    "--no-recommended-mask",
    "--no-mask",
    is_flag=True,
    help="Don't use recommended mask for `displacement` ",
)
def run(
    stack_file,
    rasters_file,
    port,
    reload,
    workers,
    log_level,
    ignore_sidecar_files,
    no_spatial_reference,
    no_recommended_mask,
):
    """Run the web server."""
    import uvicorn

    if port is None:
        port = _find_available_port(8000)
    _setup_gdal_env(ignore_sidecar_files)
    if stack_file:
        os.environ["BOWSER_STACK_DATA_FILE"] = stack_file
    else:
        os.environ["BOWSER_DATASET_CONFIG_FILE"] = rasters_file
    os.environ["BOWSER_SPATIAL_REFERENCE_DISP"] = (
        "NO" if no_spatial_reference else "YES"
    )
    os.environ["BOWSER_USE_RECOMMENDED_MASK"] = "NO" if no_recommended_mask else "YES"

    print(f"Setting up on http://localhost:{port}")
    uvicorn.run(
        "bowser.main:app",
        port=port,
        reload=reload,
        workers=workers,
        log_level=log_level,
    )


def _setup_gdal_env(ignore_sidecar_files: bool = False):
    # https://developmentseed.org/titiler/advanced/performance_tuning/
    cfg = {
        "GDAL_HTTP_MULTIPLEX": "YES",
        "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
        "GDAL_CACHEMAX": "800",
        "CPL_VSIL_CURL_CACHE_SIZE": "800",
        "VSI_CACHE": "TRUE",
        "VSI_CACHE_SIZE": "5000000",
    }
    for k, v in cfg.items():
        os.environ[k] = v
    if ignore_sidecar_files:
        os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"


@cli_app.command()
# @click.argument("name")
# @click.argument("files", nargs=-1)
@click.option(
    "-o",
    "--output",
    type=click.Path(writable=True),
    default="bowser_rasters.json",
    show_default=True,
)
@click.option("--file-date-fmt", default="%Y%m%d")
def set_data(output: Path, file_date_fmt: str):
    """Specify what raster data to use.

    Saves to `output` JSON file.
    """
    from .titiler import Algorithm, RasterGroup, _find_files

    # rg = RasterGroup(name=name, file_list=list(files))
    raster_groups = []

    # Make an interactive loop
    def add_files() -> None:
        file_list: list[str] = []
        while not file_list:
            g = click.prompt(
                "Enter the filename or a glob pattern for the files", type=str
            )
            file_list = _find_files(g.strip())
            if not file_list:
                click.echo("No files found. Try again.")

        click.echo(f"Found {len(file_list)} files.")

        name = click.prompt("Enter a name for the raster group", type=str)
        algorithm = None
        uses_spatial_ref = False
        mask_file_list = []
        mask_min_value = 0.1
        if click.confirm(
            "Does this dataset us a relative spatial reference? (e.g. unwrapped phase)"
        ):
            uses_spatial_ref = True
            algorithm = Algorithm.SHIFT.value

        if algorithm is None and click.confirm(
            "Do you want to apply `np.abs`,`np.angle`, rewrap the data?"
        ):
            algorithm = click.prompt(
                "Which algorithm?",
                type=click.Choice([a.value for a in Algorithm]),
            )
        if click.confirm(
            "Do you have *matching* .conncomp.tif files you want to mask on?"
        ):
            mask_file_list = [
                f.replace("unw.tif", "unw.conncomp.tif") for f in file_list
            ]
        if not mask_file_list and click.confirm(
            "Do you want to search for mask files?"
        ):
            g = click.prompt(
                "Enter the filename or a glob pattern for the mask files", type=str
            )
            mask_file_list = _find_files(g.strip())
            if not mask_file_list:
                click.echo("No files found. Try again.")
            elif len(mask_file_list) == 1:
                click.echo(
                    f"Found 1 mask: replicating to mask all {len(file_list)} files"
                )
                mask_file_list = len(file_list) * mask_file_list
            if mask_file_list:
                mask_min_value = click.prompt(
                    "What threshold value would you like to use on the mask values?",
                    show_default=True,
                    default=0.1,
                    type=float,
                )

        click.echo("Building raster group...")
        rg = RasterGroup(
            file_list=file_list,
            mask_file_list=mask_file_list,
            name=name,
            algorithm=algorithm,
            uses_spatial_ref=uses_spatial_ref,
            mask_min_value=mask_min_value,
            file_date_fmt=file_date_fmt,
        )
        raster_groups.append(rg)

    while True:
        add_files()
        if click.confirm("Add another dataset?", default=False):
            continue
        else:
            break

    _dump_raster_groups(raster_groups, output=output)


def _dump_raster_groups(raster_groups, output):
    out_dicts = [rg.model_dump() for rg in raster_groups]
    with open(output, "w") as f:
        json.dump(out_dicts, f, indent=2)


@cli_app.command()
@click.argument("dolphin-work-dir", type=str)
@click.option(
    "--timeseries-mask",
    type=Path,
    help="Binary mask to use on timeseries/velocity rasters",
)
@click.option(
    "-o",
    "--output",
    type=click.Path(writable=True),
    default="bowser_rasters.json",
    show_default=True,
)
def setup_dolphin(dolphin_work_dir, timeseries_mask, output, include_ifgs: bool = True):
    """Set up output data configuration for a dolphin workflow.

    Saves to `output` JSON file.
    """
    from .titiler import Algorithm, RasterGroup, _find_files

    def _glob(g):
        try:
            return _find_files(g.replace("'", "").replace('"', ""))
        except RuntimeError:
            return []

    wd = dolphin_work_dir.rstrip("/")

    dolphin_outputs = [
        {
            "name": "time series",
            "file_list": _glob(f"{wd}/timeseries/2*[0-9].tif"),
            "uses_spatial_ref": True,
            "algorithm": Algorithm.SHIFT.value,
        },
        {
            "name": "velocity",
            "file_list": [f"{wd}/timeseries/velocity.tif"],
            "uses_spatial_ref": True,
            "algorithm": Algorithm.SHIFT.value,
        },
        {
            "name": "Filtered time series",
            "file_list": _glob(f"{wd}/filtered_timeseries*/2*[0-9].tif"),
        },
        {
            "name": "Filtered velocity",
            "file_list": [f"{wd}/filtered_timeseries*/velocity.tif"],
        },
        {
            "name": "unwrapped",
            "file_list": _glob(f"{wd}/unwrapped/2*[0-9].unw.tif"),
            "mask_file_list": _glob(f"{wd}/unwrapped/*.unw.conncomp.tif"),
            "uses_spatial_ref": True,
            "algorithm": Algorithm.SHIFT.value,
        },
        {
            "name": "Connected components",
            "file_list": _glob(f"{wd}/unwrapped/*.unw.conncomp.tif"),
        },
        {
            "name": "Nonzero connected component counts",
            "file_list": _glob(f"{wd}/timeseries/nonzero_conncomp_count_*.tif"),
        },
        {
            "name": "Re-wrapped phase",
            "file_list": _glob(f"{wd}/unwrapped/2*[0-9].unw.tif"),
            "algorithm": Algorithm.REWRAP.value,
        },
        {
            "name": "(Pseudo) correlation",
            "file_list": _glob(f"{wd}/interferograms/*.cor.tif"),
        },
        {
            "name": "PS mask",
            "file_list": _glob(f"{wd}/interferograms/ps_mask_looked*.tif"),
        },
        {
            "name": "Temporal coherence",
            "file_list": _glob(f"{wd}/interferograms/temporal_coherence_[0-9]*.tif"),
        },
        {
            "name": "Average temporal coherence",
            "file_list": _glob(f"{wd}/interferograms/temporal_coherence_average*.tif"),
        },
        {
            "name": "Phase cosine similarity",
            "file_list": _glob(f"{wd}/interferograms/similarity_[0-9]*.tif"),
        },
        {
            "name": "Phase cosine similarity (full)",
            "file_list": _glob(f"{wd}/interferograms/similarity_full*.tif"),
        },
        {
            "name": "Standard deviation of estimated CRLB",
            "file_list": _glob(f"{wd}/interferograms/crlb_2*[0-9].tif"),
        },
        {
            "name": "Closure phase",
            "file_list": _glob(f"{wd}/interferograms/closure_phase_*[0-9].tif"),
        },
        {
            "name": "Cumulative closure phase",
            "file_list": _glob(
                f"{wd}/interferograms/cumulative_closure_phase_*[0-9].tif"
            ),
        },
        {
            "name": "Amplitude dispersion",
            "file_list": _glob(f"{wd}/interferograms/amp_dispersion_looked*.tif"),
        },
        {
            "name": "SHP counts",
            "file_list": _glob(f"{wd}/interferograms/shp_counts*.tif"),
        },
        {
            "name": "Time series residuals",
            "file_list": _glob(f"{wd}/timeseries/residuals_2*[0-9].tif"),
        },
        {
            "name": "Time series residuals (total sum)",
            "file_list": _glob(f"{wd}/timeseries/unw_inversion_residuals.tif"),
        },
    ]
    if include_ifgs:
        dolphin_outputs.append(
            {
                "name": "Interferograms",
                "file_list": _glob(f"{wd}/interferograms/[0-9]*.int.tif"),
                "algorithm": Algorithm.PHASE.value,
            }
        )
    if timeseries_mask is not None:
        # Timeseries
        dolphin_outputs[0]["mask_file_list"] = timeseries_mask
        # velocity
        dolphin_outputs[1]["mask_file_list"] = timeseries_mask
    raster_groups = []
    for group in dolphin_outputs:
        try:
            rg = RasterGroup(**group)
        except Exception as e:
            print(f"Error processing {group['name']}: {e}")
            continue
        raster_groups.append(rg)

    _dump_raster_groups(raster_groups, output=output)


def _find_available_port(port_request: int = 8000):
    import socket

    port = port_request - 1
    while (result := 0) == 0:
        port += 1
        # Check if the port is open
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            result = s.connect_ex(("127.0.0.1", port))

        if result != 0:
            return port


@cli_app.command()
@click.argument(
    "input_files",
    nargs=-1,
    # type=click.Path(exists=True, file_okay=True, dir_okay=False),
)
@click.option(
    "-o",
    "--output-dir",
    required=True,
    help="Path to the output directory where VRT files will be saved.",
)
@click.option(
    "--corrections/--no-corrections",
    default=False,
    help="Include corrections in addition to core datasets.",
)
def prepare_disp_s1(input_files, output_dir, corrections: bool):
    """Process NetCDF files to create VRT files with overviews.

    INPUT_FILES: Paths to input NetCDF files.
    """
    from bowser._prepare_disp_s1 import CORE_DATASETS, CORRECTION_DATASETS
    from bowser._prepare_utils import process_netcdf_files

    input_paths = list(input_files)

    datasets_to_process = (
        CORE_DATASETS + CORRECTION_DATASETS if corrections else CORE_DATASETS
    )

    click.echo(f"Processing {len(input_files)} files into VRTS in {output_dir}")
    process_netcdf_files(input_paths, Path(output_dir), datasets_to_process)


# TODO: consolidate this with disp-s1
@cli_app.command()
@click.argument(
    "input_files",
    nargs=-1,
    # type=click.Path(exists=True, file_okay=True, dir_okay=False),
)
@click.option(
    "-o",
    "--output-dir",
    required=True,
    help="Path to the output directory where VRT files will be saved.",
)
def prepare_nisar_gunw(input_files, output_dir):
    """Process NetCDF files to create VRT files with overviews.

    INPUT_FILES: Paths to input NetCDF files.
    """
    from bowser._prepare_nisar import NISAR_GUNW_DATASETS
    from bowser._prepare_utils import process_netcdf_files

    input_paths = list(input_files)

    click.echo(f"Processing {len(input_files)} files into VRTS in {output_dir}")
    process_netcdf_files(
        input_paths, Path(output_dir), NISAR_GUNW_DATASETS, strip_group_path=True
    )


@cli_app.command()
@click.argument(
    "disp_s1_dir", type=click.Path(exists=True, file_okay=False, dir_okay=True)
)
@click.option(
    "-o",
    "--output",
    type=click.Path(writable=True),
    default="bowser_rasters.json",
    show_default=True,
)
def setup_disp_s1(disp_s1_dir: str, output: str):
    """Set up output data configuration for OPERA L3 DISP-S1 products.

    Saves to `output` JSON file.
    """
    from ._prepare_disp_s1 import get_disp_s1_outputs
    from .titiler import RasterGroup

    disp_s1_outputs = get_disp_s1_outputs(disp_s1_dir)

    raster_groups = []
    for group in disp_s1_outputs:
        try:
            rg = RasterGroup(**group)
        except Exception as e:
            print(f"Error processing {group['name']}: {e}")
            continue
        raster_groups.append(rg)

    _dump_raster_groups(raster_groups, output=output)


@cli_app.command()
@click.argument(
    "disp_s1_dir", type=click.Path(exists=True, file_okay=False, dir_okay=True)
)
@click.option(
    "-o",
    "--output",
    type=click.Path(writable=True),
    default="bowser_rasters.json",
    show_default=True,
)
def setup_aligned_disp_s1(disp_s1_dir: str, output: str):
    """Set up output data configuration for OPERA L3 DISP-S1 products.

    Saves to `output` JSON file.
    """
    from ._prepare_disp_s1 import get_aligned_disp_s1_outputs
    from .titiler import RasterGroup

    disp_s1_outputs = get_aligned_disp_s1_outputs(disp_s1_dir)

    raster_groups = []
    for group in disp_s1_outputs:
        try:
            rg = RasterGroup(**group)
        except Exception as e:
            print(f"Error processing {group['name']}: {e}")
            continue
        raster_groups.append(rg)

    _dump_raster_groups(raster_groups, output=output)


@cli_app.command()
@click.argument(
    "hyp3_dir", type=click.Path(exists=True, file_okay=False, dir_okay=True)
)
@click.option(
    "-o",
    "--output",
    type=click.Path(writable=True),
    default="bowser_rasters.json",
    show_default=True,
)
def setup_hyp3(hyp3_dir: str, output: str):
    """Set up output data configuration for HyP3 Gamma InSAR products.

    Saves to `output` JSON file.

    HYP3_DIR should contain one or more directories with HyP3 Gamma InSAR products,
    where each directory contains files like *_unw_phase.tif, *_corr.tif, etc.
    """
    from pathlib import Path

    from .titiler import Algorithm, RasterGroup

    def _glob_all_products(pattern: str) -> list[str]:
        """Find all files matching pattern across all product directories."""
        p = Path(hyp3_dir)
        # Get all product directories (they should all be directories)
        product_dirs = [d for d in p.iterdir() if d.is_dir()]
        if not product_dirs:
            raise click.UsageError(
                f"No product directories found in {hyp3_dir}. "
                "Expected directories containing HyP3 Gamma products."
            )
        # For each product directory, find files matching pattern
        matching_files: list[str] = []
        for product_dir in product_dirs:
            matches = list(product_dir.glob(pattern))
            matching_files.extend(str(f) for f in matches)
        return sorted(matching_files)

    hyp3_outputs: list[dict[str, Any]] = [
        {
            "name": "Unwrapped Phase",
            "file_list": _glob_all_products("*_unw_phase.tif"),
            "uses_spatial_ref": True,
            "algorithm": Algorithm.SHIFT.value,
            "mask_file_list": _glob_all_products("*_conncomp.tif"),
        },
        {
            "name": "Connected Components",
            "file_list": _glob_all_products("*_conncomp.tif"),
        },
        {
            "name": "Wrapped phase",
            "file_list": _glob_all_products("*_wrapped_phase.tif"),
        },
        {
            "name": "Re-wrapped phase",
            "file_list": _glob_all_products("*_unw_phase.tif"),
            "algorithm": Algorithm.REWRAP.value,
        },
        {
            "name": "Correlation",
            "file_list": _glob_all_products("*_corr.tif"),
        },
        {
            "name": "Look Vector θ",
            "file_list": _glob_all_products("*_lv_theta.tif"),
        },
        {
            "name": "Look Vector φ",
            "file_list": _glob_all_products("*_lv_phi.tif"),
        },
        {
            "name": "DEM",
            "file_list": _glob_all_products("*_dem.tif"),
        },
    ]

    raster_groups = []
    for group in hyp3_outputs:
        try:
            rg = RasterGroup(**group)
        except Exception as e:
            print(f"Error processing {group['name']}: {e}")
            continue
        if not rg.file_list:
            print(f"No files found for {group['name']}, skipping.")
            continue
        raster_groups.append(rg)

    if not raster_groups:
        raise click.UsageError(
            f"No valid raster groups created from {hyp3_dir}. "
            "Check that the directory contains HyP3 Gamma products."
        )

    _dump_raster_groups(raster_groups, output=output)


@cli_app.command()
@click.argument(
    "nisar_dir", type=click.Path(exists=True, file_okay=False, dir_okay=True)
)
@click.option(
    "-o",
    "--output",
    type=click.Path(writable=True),
    default="bowser_rasters.json",
    show_default=True,
)
def setup_nisar_gunw(nisar_dir: str, output: str):
    """Set up output data configuration for NISAR L2 GUNW products.

    Saves to `output` JSON file.
    """
    from ._prepare_nisar import get_nisar_outputs
    from .titiler import RasterGroup

    groups = get_nisar_outputs(nisar_dir)

    raster_groups = []
    for group in groups:
        try:
            rg = RasterGroup(**group, file_date_fmt=None)
        except Exception as e:
            print(f"Error processing {group['name']}: {e}")
            continue
        raster_groups.append(rg)

    _dump_raster_groups(raster_groups, output=output)
