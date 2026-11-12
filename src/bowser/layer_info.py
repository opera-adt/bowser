"""Describe common layers without assigning undocumented processing conventions.

This module uses only the standard library so the full and lite servers can
share the same descriptions. Producer metadata is kept separate from Bowser's
general explanations; it never changes data, masks, units or reference choices.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, Literal, NotRequired, TypedDict


class LayerInfo(TypedDict):
    """Presentation metadata returned alongside the existing dataset fields."""

    description: str
    description_source: Literal["bowser", "source", "unknown"]
    source_description: str | None
    source_flags: list[dict[str, str]]
    unit: str
    unit_status: Literal["provided", "missing", "mixed"]
    guidance: NotRequired[str]
    metadata_notes: NotRequired[list[str]]


_GUIDANCE = {
    "displacement": (
        "Saved change relative to the source's reference. The measured direction, "
        "sign convention and starting date come from the producer; this is not "
        "automatically total 3D movement."
    ),
    "velocity": (
        "Saved rate of change over the producer's stated period. Direction, dates "
        "and estimation method come from the source; this need not be today's rate "
        "or total 3D speed."
    ),
    "short_wavelength_displacement": (
        "Supplied displacement with broad spatial patterns removed to highlight "
        "smaller patterns. Real broad movement can also be removed; compare with "
        "the original displacement and check the producer's filter settings."
    ),
    "phase_similarity": (
        "Agreement between nearby radar phase patterns. Higher values generally "
        "mean more agreement; low or negative values can indicate disagreement. "
        "This does not measure speed or establish stationary ground."
    ),
    "temporal_coherence": (
        "How consistently the radar phase observations fit the estimated history. "
        "Higher values generally mean more consistency, but do not guarantee "
        "correct displacement or rule out unwrapping errors."
    ),
    "coherence": (
        "Agreement between radar signals for a pair of dates over nearby ground. "
        "Water, vegetation, snow or surface changes can reduce it. This is a "
        "quality clue for that pair, not a measurement of ground speed."
    ),
    "persistent_scatterer_mask": (
        "Pixels selected as relatively consistent radar reflectors, often based "
        "on steady brightness. Selected pixels can still move. Check the source "
        "for the selection method and flag values."
    ),
    "recommended_mask": (
        "The producer's suggested screen for less reliable measurements. Check "
        "the supplied flag values and product documentation before selecting "
        "a threshold; this is not a map of stable ground."
    ),
    "shp_counts": (
        "Number of neighboring pixels with similar signal statistics selected "
        "to help estimate radar phase. These are supporting neighbors, not more "
        "acquisition dates or independent measurements."
    ),
    "estimated_phase_quality": (
        "A local phase-quality indicator supplied by the producer. Its definition "
        "and useful thresholds depend on the product. It is not directly a "
        "displacement error or proof of correct unwrapping."
    ),
    "connected_component_labels": (
        "Labels identify patches connected during phase unwrapping. Separate "
        "patches can have unresolved relative offsets; matching label numbers "
        "across dates do not establish a connection. Check source invalid labels."
    ),
    "water_mask": (
        "Identifies water or land using the source's convention. Check the flag "
        "meanings before choosing which values to retain; they are not inferred "
        "from the layer name."
    ),
    "layover_shadow_mask": (
        "Terrain-related radar visibility flags. Shadow hides terrain from the "
        "radar; layover mixes terrain locations in the radar image. Source flag "
        "values define the classes; a zero value need not mean missing data."
    ),
    "inversion_residuals": (
        "Mismatch remaining between input observations and the fitted history. "
        "Smaller values indicate a closer fit, not independent proof of accuracy. "
        "Units and aggregation depend on the producer and observation network."
    ),
    "crlb": (
        "A model-based precision bound under the producer's noise assumptions. "
        "It may not capture unwrapping mistakes, atmospheric effects or other "
        "systematic errors; check whether the source reports variance or error."
    ),
    "amplitude_dispersion": (
        "Variation in radar brightness relative to its average. Lower values "
        "usually mean more consistent brightness, not necessarily stationary "
        "ground. Selection thresholds come from the source."
    ),
    "amplitude": (
        "Radar image brightness, influenced by surface properties and viewing "
        "geometry. It is not displacement. Source units distinguish linear "
        "values from logarithmic brightness."
    ),
    "wrapped_phase": (
        "Radar phase displayed as repeating cycles. Colors repeat as the signal "
        "changes, so they cannot be read directly as total displacement. Useful "
        "for checking patterns before phase unwrapping."
    ),
    "unwrapped_phase": (
        "Radar phase after joining the repeating cycles into a continuous "
        "pattern. Choosing the wrong number of cycles can produce false jumps. "
        "Check units before treating phase as displacement."
    ),
    "closure_phase": (
        "Phase differences around a closed loop of acquisitions. This helps "
        "check internal consistency, but some errors can pass the check. Units "
        "and phase wrapping come from the source."
    ),
    "closure_flags": (
        "Flags from checks of agreement around closed date-pair loops. The "
        "source defines which values mean flagged, checked or unassessed. "
        "A flag alone does not identify a bad acquisition."
    ),
    "elevation": (
        "Height from the supplied elevation model. Its source and vertical "
        "datum come from the producer. This is terrain context, not displacement."
    ),
    "slope": (
        "Terrain steepness. Check the source units, terrain model and averaging "
        "scale before comparison; this does not measure movement direction."
    ),
    "aspect": (
        "Terrain orientation. The source defines angle origin, rotation "
        "direction and flat-ground flags. It does not measure actual motion."
    ),
    "hillshade": (
        "Simulated illumination of an elevation model to reveal terrain shapes. "
        "Bright and dark values represent lighting, not height or movement."
    ),
}

_ALIASES = {
    "time_series": "displacement",
    "los_displacement": "displacement",
    "los_velocity": "velocity",
    "filtered_time_series": "short_wavelength_displacement",
    "phase_cosine_similarity": "phase_similarity",
    "ps_mask": "persistent_scatterer_mask",
    "persistent_scatterers": "persistent_scatterer_mask",
    "opera_recommended_mask": "recommended_mask",
    "land_mask": "water_mask",
    "connected_components": "connected_component_labels",
    "layover_and_shadow": "layover_shadow_mask",
    "timeseries_inversion_residuals": "inversion_residuals",
    "sum_inversion_residuals": "inversion_residuals",
    "time_series_residuals": "inversion_residuals",
    "time_series_residuals_total_sum": "inversion_residuals",
    "unw_inversion_residuals": "inversion_residuals",
    "inversion_residual": "inversion_residuals",
    "crlb_displacement": "crlb",
    "crlb_rad": "crlb",
    "standard_deviation_of_estimated_crlb": "crlb",
    "stack_amplitude_dispersion": "amplitude_dispersion",
    "mean_amplitude": "amplitude",
    "mean_amplitude_db": "amplitude",
    "normalized_amplitude": "amplitude",
    "multi_looked_coherence": "coherence",
    "interferogram_coherence": "coherence",
    "pseudo_correlation": "coherence",
    "interferograms": "wrapped_phase",
    "unwrapped": "unwrapped_phase",
    "re_wrapped_phase": "wrapped_phase",
    "cumulative_closure_phase": "closure_phase",
    "terrain_elevation": "elevation",
    "dem": "elevation",
    "terrain_slope": "slope",
    "terrain_aspect": "aspect",
    "terrain_hillshade": "hillshade",
}


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _flags(attrs: Mapping[str, Any]) -> list[dict[str, str]]:
    values, meanings = attrs.get("flag_values"), attrs.get("flag_meanings")
    if isinstance(values, str):
        try:
            values = json.loads(values)
        except ValueError:
            values = values.split()
    if isinstance(meanings, str):
        meanings = meanings.split()
    if values is None or meanings is None:
        return []
    if isinstance(values, (str, Mapping)) or isinstance(meanings, Mapping):
        return []
    try:
        if len(values) != len(meanings):
            return []
        return [
            {"value": str(v), "label": str(m).replace("_", " ")}
            for v, m in zip(values, meanings)
        ]
    except TypeError:
        return []


def describe_layer(name: str, attrs: Mapping[str, Any] | None = None) -> LayerInfo:
    """Return general guidance and separately identified source metadata.

    Parameters
    ----------
    name : str
        Source variable or raster-group name. Only recognized aliases receive
        built-in guidance; arbitrary names are not guessed by substring.
    attrs : mapping, optional
        Read-only source attributes. Units, sign conventions and mask thresholds
        are never assigned from a name or from the description catalog.

    Returns
    -------
    LayerInfo
        Display text, its origin, original source description, category labels,
        and explicitly supplied units. Missing units remain an empty string.
        When the producer explains a recognized layer (``description`` or
        ``comment``), that text is the description and Bowser's general text
        is returned separately as ``guidance``.

    """
    attrs = attrs or {}
    source = next(
        (
            _text(attrs.get(key))
            for key in ("description", "comment", "long_name")
            if _text(attrs.get(key))
        ),
        None,
    )
    key = re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_")
    # Raster writers often set a band's long_name to its variable name. Keep
    # that label as source metadata, but do not present it as an explanation.
    source_explanation = source
    if (
        not _text(attrs.get("description"))
        and not _text(attrs.get("comment"))
        and source is not None
        and re.sub(r"[^a-z0-9]+", "_", source.casefold()).strip("_") == key
    ):
        source_explanation = None
    key = _ALIASES.get(key, key)
    summary = ""
    for statistic in ("average", "median", "minimum", "maximum"):
        for base in (
            "temporal_coherence",
            "phase_similarity",
            "phase_cosine_similarity",
        ):
            if key in (f"{statistic}_{base}", f"{base}_{statistic}"):
                key = _ALIASES.get(base, base)
                summary = f" Saved {statistic} summary; check its source time support."
    if key in ("phase_cosine_similarity_full", "phase_similarity_full_stack"):
        key = "phase_similarity"
        summary = " Saved whole-stack calculation; check its source time support."
    guidance = _GUIDANCE.get(key)
    if guidance:
        guidance += summary
    # A producer's own explanation (description or comment; a long_name is only
    # a label) leads, and Bowser's general guidance moves to its own field.
    producer = _text(attrs.get("description")) or _text(attrs.get("comment"))
    origin: Literal["bowser", "source", "unknown"]
    if guidance and producer:
        description, origin = producer, "source"
    elif guidance:
        description, origin = guidance, "bowser"
    elif source_explanation:
        description, origin = source_explanation, "source"
    else:
        description, origin = (
            (
                "The producer has not supplied an explanation for this layer; "
                "consult its documentation before interpretation."
            ),
            "unknown",
        )
    unit = _text(attrs.get("units")) or _text(attrs.get("unit")) or ""
    info: LayerInfo = {
        "description": description,
        "description_source": origin,
        "source_description": source,
        "source_flags": _flags(attrs),
        "unit": unit,
        "unit_status": "provided" if unit else "missing",
    }
    if guidance and producer:
        info["guidance"] = guidance
    return info


def describe_raster_group(name: str, headers: Sequence[Mapping[str, Any]]) -> LayerInfo:
    """Describe cached raster headers without implying identical units or flags.

    Producer text is from the first raster. A shared unit or category dictionary
    is only reported when all supplied headers agree, including missing values.
    Differing units are not converted or inferred to be equivalent.

    """
    items = [describe_layer(name, attrs) for attrs in headers]
    info = items[0].copy() if items else describe_layer(name)
    notes = []
    if len(items) > 1:
        notes.append("Producer text is from the first raster in this group.")
        if len({item["unit"] for item in items}) > 1:
            info["unit"] = ""
            info["unit_status"] = "mixed"
            notes.append(
                "Source units differ or are missing between rasters; "
                "no common unit is assigned."
            )
        if any(item["source_flags"] != items[0]["source_flags"] for item in items[1:]):
            info["source_flags"] = []
            notes.append(
                "Category meanings differ or are missing between rasters; "
                "consult each source."
            )
    if notes:
        info["metadata_notes"] = notes
    return info


#: Speed of light in vacuum (m/s), to turn a centre frequency into a wavelength.
SPEED_OF_LIGHT = 299_792_458.0
#: Attribute names a producer may record the radar centre frequency under (Hz).
_FREQUENCY_KEYS = (
    "center_frequency",
    "centerFrequency",
    "radar_frequency",
    "radar_center_frequency",
    "center_frequency_hz",
)
#: Attribute names a producer may record the radar wavelength under (metres).
_WAVELENGTH_KEYS = (
    "radar_wavelength_m",
    "radar_wavelength",
    "wavelength_m",
    "wavelength",
)


def radar_wavelength(*attr_maps: Mapping[str, Any]) -> float | None:
    """Return the radar wavelength (m) recorded in a cube's attributes, or None.

    Looks in each mapping in turn (the cube's own attributes first, then its
    variables'), for a value between 5 mm and 1 m: Sentinel-1's C band is
    0.0555 m, NISAR's L band 0.238 m. Unwrapping errors are multiples of half of
    it, which is what the chart's series checks look for.
    """
    for attrs in attr_maps:
        for key in _WAVELENGTH_KEYS:
            try:
                value = float(attrs[key])
            except (KeyError, TypeError, ValueError):
                continue
            if 0.005 <= value <= 1.0:
                return value
    # No wavelength, but a centre frequency in hertz (NISAR products record
    # ``centerFrequency`` per band, JPL D-102272): wavelength = c / f.
    for attrs in attr_maps:
        for key in _FREQUENCY_KEYS:
            try:
                hz = float(attrs[key])
            except (KeyError, TypeError, ValueError):
                continue
            if hz > 0 and 0.005 <= SPEED_OF_LIGHT / hz <= 1.0:
                return SPEED_OF_LIGHT / hz
    return None
