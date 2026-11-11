"""What a layer's values measure, from the cube's own metadata.

Bowser opens stacks from many producers (OPERA DISP-S1, NISAR, Capella, vertical
land motion, calibration products, a user's own processing), so nothing here
assumes a sensor. The direction a value is measured in, its sign, how sensitive
it is to east, north and up motion, and the size of an unwrapping jump are read
from the cube's attributes; a small table of producer-documented facts fills in
what a recognised product leaves out. Anything not found is reported as unknown.

Standard library only, so the full and lite servers share it (like
:mod:`bowser.layer_info`).

Direction and sign are per layer: a cube can hold line-of-sight displacement next
to a derived vertical layer, and quality layers measure no motion at all. The
look geometry and the radar wavelength are per cube (one acquisition geometry per
stack), so every layer of a cube reports the same ones.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any, Literal, TypedDict

Kind = Literal["line_of_sight", "vertical", "east_west", "north_south", "unknown"]


class Measurement(TypedDict):
    """What a layer's values measure; unknown parts are None (or "unknown")."""

    kind: Kind
    kind_source: str | None
    positive_direction: str | None
    sign_source: str | None
    sensitivity: dict[str, float] | None
    sensitivity_note: str
    radar_wavelength_m: float | None
    half_wavelength_mm: float | None
    wavelength_source: str | None
    product: str | None
    summary: str


#: Facts producers document for their products. Only add an entry with a source,
#: and only for facts the source states. Attributes in the file always win.
KNOWN_PRODUCTS: tuple[dict[str, Any], ...] = (
    {
        # OPERA L3 DISP-S1 product specification, JPL D-108772
        # (https://doi.org/10.5067/SNWG/OPL3DISPS1-V1), and the product's own
        # metadata: metadata/ceos_product_measurement_projection = "line of
        # sight"; the displacement layer's description "Positive values indicate
        # apparent motion towards the platform"; identification/radar_wavelength
        # = 0.05546576 (m, Sentinel-1 C band, 5.405 GHz).
        "name": "OPERA DISP-S1",
        "pattern": r"(?<![a-z0-9])disp[-_ ]?s1(?![a-z0-9])",
        "kind": "line_of_sight",
        "positive_direction": "towards the satellite",
        "radar_wavelength_m": 0.05546576,
    },
)

#: Attributes that name a product (cube level).
_PRODUCT_KEYS = (
    "product",
    "product_type",
    "product_name",
    "short_name",
    "title",
    "source",
    "mission_name",
)
#: Attributes that state the measured direction outright.
_KIND_KEYS = (
    "measurement_direction",
    "displacement_direction",
    "measurement_projection",
    "ceos_product_measurement_projection",
    "displacement_convention",
)
#: Attributes that state the sign outright.
_SIGN_KEYS = ("sign_convention", "positive_direction", "displacement_convention")
#: Of those, the ones whose value is only a direction ("towards the satellite").
_STATED = ("sign_convention", "positive_direction")
#: Free text a producer may explain a layer with.
_TEXT_KEYS = ("standard_name", "long_name", "description", "comment")

_KIND_PATTERNS: dict[Kind, str] = {
    "line_of_sight": r"line[- ]of[- ]sight|\blos\b|slant[- ]range",
    "vertical": r"\bvertical\b|\bvlm\b",
    "east_west": r"east[- ]west|\beastward\b",
    "north_south": r"north[- ]south|\bnorthward\b",
}
_TARGET = r"(?:the )?(?:satellite|platform|sensor|radar|spacecraft)"
_SIGN_PATTERNS: tuple[tuple[str, str], ...] = (
    (rf"\baway from {_TARGET}", "away from the satellite"),
    (rf"\btowards? {_TARGET}", "towards the satellite"),
    (r"\b(?:up|upward|upwards|uplift)\b", "up"),
    (r"\b(?:down|downward|downwards|subsidence)\b", "down"),
    (r"\beast(?:ward)?\b", "east"),
    (r"\bwest(?:ward)?\b", "west"),
    (r"\bnorth(?:ward)?\b", "north"),
    (r"\bsouth(?:ward)?\b", "south"),
)
_LENGTH_UNITS = {
    "m",
    "meter",
    "metre",
    "mm",
    "millimeter",
    "millimetre",
    "cm",
    "centimeter",
    "centimetre",
    "km",
}
_MOTION_NAMES = re.compile(
    r"^(?:los_)?(?:displacement|velocity|time_series|short_wavelength_displacement)$"
)
_NOT_MOTION = re.compile(r"stderr|std|sigma|error|uncertaint|crlb|residual")
_AXIS_WORDS = {"up": "vertical", "east": "east-west", "north": "north-south"}


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _kind_in(text: str) -> Kind | None:
    """Return the one direction ``text`` names, or None for none or several."""
    low = text.casefold()
    found: list[Kind] = [k for k, p in _KIND_PATTERNS.items() if re.search(p, low)]
    return found[0] if len(found) == 1 else None


def _sign_in(text: str, stated: bool) -> str | None:
    """Return the positive direction ``text`` states, or None.

    Free text must say "positive ..." and the direction in the same clause; a
    sign attribute (``stated``) may just name the direction ("towards satellite").
    """
    low = text.casefold()
    clauses = re.findall(r"positive[^.;]*", low)
    if not clauses and stated:
        clauses = [low]
    for clause in clauses:
        for pattern, direction in _SIGN_PATTERNS:
            if re.search(pattern, clause):
                return direction
    return None


def _measures_motion(name: str, attrs: Mapping[str, Any]) -> bool:
    key = re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_")
    if _NOT_MOTION.search(key):
        return False
    if _MOTION_NAMES.match(key):
        return True
    if any(_text(attrs.get(k)) for k in (*_KIND_KEYS, *_SIGN_KEYS)):
        return True
    unit = _text(attrs.get("units")) or _text(attrs.get("unit")) or ""
    base = unit.split("/")[0].split(" ")[0].strip().casefold().rstrip("s")
    return base in _LENGTH_UNITS


def known_product(cube_attrs: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the :data:`KNOWN_PRODUCTS` entry the cube's attributes name, or None."""
    names = " ".join(t for k in _PRODUCT_KEYS if (t := _text(cube_attrs.get(k))))
    for entry in KNOWN_PRODUCTS:
        if names and re.search(entry["pattern"], names.casefold()):
            return entry
    return None


def _find_kind(layer: Mapping, cube: Mapping) -> tuple[Kind | None, str | None]:
    for where, attrs, keys in (
        ("layer", layer, _KIND_KEYS),
        ("layer", layer, _TEXT_KEYS),
        ("cube", cube, _KIND_KEYS),
    ):
        for key in keys:
            if (text := _text(attrs.get(key))) and (kind := _kind_in(text)):
                return kind, f"{where} attribute {key!r}"
    return None, None


def _find_sign(layer: Mapping, cube: Mapping) -> tuple[str | None, str | None]:
    for where, attrs, keys, stated in (
        ("layer", layer, _SIGN_KEYS, True),
        ("layer", layer, _TEXT_KEYS, False),
        ("cube", cube, _SIGN_KEYS, True),
    ):
        for key in keys:
            text = _text(attrs.get(key))
            if text and (sign := _sign_in(text, stated and key in _STATED)):
                return sign, f"{where} attribute {key!r}"
    return None, None


def _enu(los: Mapping[str, Any] | None) -> tuple[float, float, float] | None:
    vec = (los or {}).get("los_enu_ground_to_sat")
    if not isinstance(vec, Mapping):
        return None
    try:
        e, n, u = (float(vec[k]) for k in ("east", "north", "up"))
    except (TypeError, KeyError, ValueError):
        return None
    norm = math.sqrt(e * e + n * n + u * u)
    if not math.isfinite(norm) or norm == 0:
        return None
    return e / norm, n / norm, u / norm


def sensitivity_sentence(sens: Mapping[str, float]) -> str:
    """Say in words which directions a measurement sees, from |ENU| shares."""
    order = sorted(("up", "east", "north"), key=lambda k: -sens[k])
    strong = [k for k in order if sens[k] >= 0.3]
    weak = [k for k in order if sens[k] < 0.3]
    words = [f"{_AXIS_WORDS[k]} ({sens[k]:.2f})" for k in strong]
    text = "Sensitive mainly to " if weak else "Sensitive to "
    text += words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]
    text += " motion"
    if weak:
        text += "; " + " and ".join(
            f"{_AXIS_WORDS[k]} sensitivity {sens[k]:.2f}" for k in weak
        )
    return text + "."


def describe_measurement(
    name: str,
    layer_attrs: Mapping[str, Any] | None = None,
    cube_attrs: Mapping[str, Any] | None = None,
    los: Mapping[str, Any] | None = None,
    wavelength_m: float | None = None,
) -> Measurement | None:
    """Describe what a layer measures, or None for a layer that measures no motion.

    Parameters
    ----------
    name : str
        The layer's name.
    layer_attrs, cube_attrs : mapping, optional
        The layer's and the cube's attributes. The layer's own statements win
        over the cube's, and both over :data:`KNOWN_PRODUCTS`.
    los : mapping, optional
        The cube's look geometry as ``/datasets`` reports it (``los_metadata``),
        with ``los_enu_ground_to_sat``, the unit vector from ground to satellite.
    wavelength_m : float, optional
        The radar wavelength the cube records
        (:func:`bowser.layer_info.radar_wavelength`).

    Returns
    -------
    Measurement or None
        ``kind`` (line_of_sight, vertical, east_west, north_south or unknown),
        ``positive_direction``, each with the attribute it came from;
        ``sensitivity``: how much of a unit motion east, north or up changes the
        value (|component| of the look vector for line-of-sight values); the
        wavelength and half of it in mm (the size of an unwrapping jump); the
        recognised product; and a ``summary`` in plain words.

    """
    layer, cube = layer_attrs or {}, cube_attrs or {}
    if not _measures_motion(name, layer):
        return None
    kind, kind_source = _find_kind(layer, cube)
    sign, sign_source = _find_sign(layer, cube)
    entry = known_product(cube)
    product = entry["name"] if entry else None
    if entry and kind in (None, entry["kind"]):
        if kind is None:
            kind, kind_source = entry["kind"], f"known product {product}"
        if sign is None:
            sign, sign_source = entry["positive_direction"], f"known product {product}"
    kind = kind or "unknown"

    wavelength_source = "cube attributes" if wavelength_m else None
    if not wavelength_m and entry and entry.get("radar_wavelength_m"):
        wavelength_m = entry["radar_wavelength_m"]
        wavelength_source = f"known product {product}"
    half_mm = round(wavelength_m * 500, 1) if wavelength_m else None

    vec = _enu(los)
    sensitivity: dict[str, float] | None = None
    if kind == "vertical":
        sensitivity = {"east": 0.0, "north": 0.0, "up": 1.0}
    elif kind == "east_west":
        sensitivity = {"east": 1.0, "north": 0.0, "up": 0.0}
    elif kind == "north_south":
        sensitivity = {"east": 0.0, "north": 1.0, "up": 0.0}
    elif vec is not None:
        sensitivity = {
            k: round(abs(v), 2) for k, v in zip(("east", "north", "up"), vec)
        }
    if sensitivity is None:
        note = (
            "Unknown: the cube records no look direction, so which directions of "
            "motion these values see is not known."
        )
    else:
        note = sensitivity_sentence(sensitivity)
        if kind == "unknown":
            note = (
                "If these values are along the line of sight (the cube records a "
                "look direction but does not say what the values measure): " + note
            )
        note += " A sensitivity is how much of 1 mm of motion in that direction shows."

    names = {
        "line_of_sight": "along the radar line of sight",
        "vertical": "vertical",
        "east_west": "east-west",
        "north_south": "north-south",
    }
    if kind == "unknown":
        summary = (
            "The cube does not say what these values measure (line of sight, "
            "vertical, east-west...)"
        )
    else:
        summary = f"Values are {names[kind]}"
    summary += (
        f"; positive is {sign}." if sign else "; the sign convention is not recorded."
    )
    if sensitivity is not None:
        summary += " " + note.split(" A sensitivity")[0]
    if half_mm:
        summary += f" Half the radar wavelength is {half_mm} mm."
    else:
        summary += " The radar wavelength is not recorded."
    return {
        "kind": kind,
        "kind_source": kind_source,
        "positive_direction": sign,
        "sign_source": sign_source,
        "sensitivity": sensitivity,
        "sensitivity_note": note,
        "radar_wavelength_m": wavelength_m,
        "half_wavelength_mm": half_mm,
        "wavelength_source": wavelength_source,
        "product": product,
        "summary": summary,
    }
