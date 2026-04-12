from pathlib import Path

from .titiler import Algorithm

# Define NISAR GUNW datasets to extract
NISAR_BASE_PATH = "/science/LSAR/GUNW/grids"
NISAR_FREQ_A_PATH = f"{NISAR_BASE_PATH}/frequencyA"
NISAR_GUNW_A_HH_PATH = f"{NISAR_FREQ_A_PATH}/unwrappedInterferogram/HH"
NISAR_IFGW_A_HH_PATH = f"{NISAR_FREQ_A_PATH}/wrappedInterferogram/HH"
NISAR_GOFF_A_HH_PATH = f"{NISAR_FREQ_A_PATH}/pixelOffsets/HH"
NISAR_GUNW_DATASETS = [
    f"{NISAR_GUNW_A_HH_PATH}/unwrappedPhase",
    f"{NISAR_GUNW_A_HH_PATH}/coherenceMagnitude",
    f"{NISAR_GUNW_A_HH_PATH}/connectedComponents",
    f"{NISAR_GUNW_A_HH_PATH}/ionospherePhaseScreen",
    f"{NISAR_GUNW_A_HH_PATH}/ionospherePhaseScreenUncertainty",
    f"{NISAR_IFGW_A_HH_PATH}/wrappedInterferogram",
    f"{NISAR_IFGW_A_HH_PATH}/coherenceMagnitude",
    f"{NISAR_GOFF_A_HH_PATH}/alongTrackOffset",
    f"{NISAR_GOFF_A_HH_PATH}/slantRangeOffset",
    f"{NISAR_GOFF_A_HH_PATH}/correlationSurfacePeak",
]


def get_nisar_outputs(nisar_dir: Path | str):
    def _glob(pattern: str, subdir: str) -> list[str]:
        return [str(p) for p in sorted((Path(nisar_dir) / subdir).glob(pattern))]

    return [
        {
            "name": "Unwrapped Phase",
            "file_list": _glob("*.vrt", subdir="unwrappedPhase"),
            "uses_spatial_ref": True,
            "algorithm": Algorithm.SHIFT.value,
            "mask_file_list": _glob("*.vrt", subdir="connectedComponents"),
        },
        {
            "name": "Coherence Magnitude",
            "file_list": _glob("*.vrt", subdir="coherenceMagnitude"),
        },
        {
            "name": "Connected Components",
            "file_list": _glob("*.vrt", subdir="connectedComponents"),
        },
        {
            "name": "Ionosphere Phase Screen",
            "file_list": _glob("*.vrt", subdir="ionospherePhaseScreen"),
            "uses_spatial_ref": True,
            "algorithm": Algorithm.SHIFT.value,
        },
        {
            "name": "Ionosphere Phase Uncertainty",
            "file_list": _glob("*.vrt", subdir="ionospherePhaseScreenUncertainty"),
        },
        {
            "name": "Wrapped Interferogram",
            "file_list": _glob("*.vrt", subdir="wrappedInterferogram"),
            "algorithm": Algorithm.PHASE.value,
        },
        {
            "name": "Wrapped Coherence",
            "file_list": _glob("*.vrt", subdir="coherenceMagnitude"),
        },
        {
            "name": "Re-wrapped Phase",
            "file_list": _glob("*.vrt", subdir="unwrappedPhase"),
            "algorithm": Algorithm.REWRAP.value,
        },
        {
            "name": "Along-Track Offset",
            "file_list": _glob("*.vrt", subdir="alongTrackOffset"),
        },
        {
            "name": "Slant Range Offset",
            "file_list": _glob("*.vrt", subdir="slantRangeOffset"),
        },
        {
            "name": "Correlation Surface Peak",
            "file_list": _glob("*.vrt", subdir="correlationSurfacePeak"),
        },
    ]
