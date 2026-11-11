"""Describe exported values without inferring their scientific processing."""

from __future__ import annotations

import json
import math
import re
from datetime import date, datetime
from typing import Any, Mapping, Sequence

from pyproj import Transformer

_SOURCE_KEYS = {
    "product": ("product", "product_type", "product_name"),
    "product_id": ("product_id", "granule_id"),
    "product_version": ("product_version",),
    "processing_version": ("processing_version",),
    "sensor": ("sensor", "instrument"),
    "platform": ("platform", "satellite"),
    "track": ("track", "track_id", "relative_orbit"),
    "frame": ("frame", "frame_id"),
    "burst_id": ("burst_id",),
    "orbit_direction": ("orbit_direction", "flight_direction"),
    "polarization": ("polarization",),
    "units": ("units",),
    "sign_convention": ("sign_convention", "positive_direction"),
    "velocity_estimator": ("velocity_estimator", "rate_estimation_method"),
}


#: What an export relative to another date (``reference_step``) did to each pixel.
_STEP_OPERATION = "exported_value = value(selected) - value(reference), per pixel"


def _text(value: Any) -> str | None:
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        text = str(value).strip()
        # Provenance identifiers are not file locations. Never copy signed
        # source URLs, home directories, or arbitrary nested metadata wholesale.
        if (
            text
            and len(text) <= 1000
            and not any(
                marker in text for marker in ("://", "\\", "?", "/Users/", "/home/")
            )
        ):
            return text
    return None


def _first(attrs: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    return next((s for k in keys if (s := _text(attrs.get(k))) is not None), None)


def _date(value: Any) -> str | None:
    text = str(value)
    if re.fullmatch(r"\d{8}", text):
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return date.fromisoformat(text).isoformat()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+", text):
            return (
                datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
            )
    except ValueError:
        pass
    return None


def _reference(tags: Mapping[str, Any]) -> dict[str, Any]:
    if tags.get("BOWSER_REFERENCE_OPERATION") != (
        "exported_value = stored_value - reference_value"
    ):
        return {"mode": "stored", "operation": "stored values; no new spatial shift"}
    result: dict[str, Any] = {"mode": "interactive"}
    for key in (
        "METHOD",
        "LONGITUDE",
        "LATITUDE",
        "BUFFER_METERS",
        "VALUE",
        "VALID_PIXELS",
        "OPERATION",
        "SUPPORT",
    ):
        if f"BOWSER_REFERENCE_{key}" in tags:
            result[key.lower()] = str(tags[f"BOWSER_REFERENCE_{key}"])
    lon = float(result["longitude"])
    lat = float(result["latitude"])
    result["coordinate_crs"] = "EPSG:4326"
    # Standard UTM is defined between 80 S and 84 N. Do not fabricate polar UTM.
    if -80 <= lat <= 84:
        zone = max(1, min(60, int((lon + 180) // 6) + 1))
        if 56 <= lat < 64 and 3 <= lon < 12:
            zone = 32
        if 72 <= lat < 84:
            for west, east, special in (
                (0, 9, 31),
                (9, 21, 33),
                (21, 33, 35),
                (33, 42, 37),
            ):
                if west <= lon < east:
                    zone = special
        epsg = (32600 if lat >= 0 else 32700) + zone
        x, y = Transformer.from_crs(4326, epsg, always_xy=True).transform(lon, lat)
        result["utm"] = {
            "crs": f"EPSG:{epsg}",
            "easting_meters": x,
            "northing_meters": y,
        }
    else:
        result["utm"] = None
    return result


def export_provenance(
    variable: str,
    attrs: Mapping[str, Any],
    *,
    root_attrs: Mapping[str, Any] | None = None,
    selected_label: str | None = None,
    selected_index: int | None = None,
    selected_coordinate: str | None = None,
    available_labels: Sequence[str] = (),
    masks: Sequence[Mapping[str, Any]] = (),
    source_nodata: Any = None,
    export_nodata: Any = None,
    reference_step: Mapping[str, Any] | None = None,
) -> tuple[dict[str, str], str]:
    """Build GeoTIFF tags and a short filename from established export facts.

    Layer attributes take precedence over root attributes. Available dates are
    record bounds, not a velocity fit interval or a cumulative temporal datum.
    Only explicit reference/fit dates establish those meanings. Interactive
    reference tags must describe a shift already applied by the exporter; this
    function never changes raster values. Inputs are not mutated.

    ``reference_step`` (``index``, ``label``, ``coordinate``) is the step the
    exporter already subtracted from each pixel (the viewer's chosen reference
    date). It becomes the temporal reference; the stored one is kept as
    ``stored_reference_date``.

    Returns
    -------
    tags : dict[str, str]
        Versioned JSON provenance plus searchable summary tags.
    filename : str
        Sanitized layer name, established date token, and optional ``_masked``.

    """
    merged = {**(root_attrs or {}), **attrs}
    source = {name: _first(merged, keys) for name, keys in _SOURCE_KEYS.items()}
    time: dict[str, Any] = {
        "selected_index": selected_index,
        "selected_label": selected_label,
        "selected_coordinate": selected_coordinate,
    }
    dates = [d for label in available_labels if (d := _date(label)) is not None]
    time["available_record_start"] = min(dates) if dates else None
    time["available_record_end"] = max(dates) if dates else None
    time["reference_date"] = _date(merged.get("reference_date"))
    if reference_step is not None:
        time["stored_reference_date"] = time["reference_date"]
        time["reference_index"] = reference_step["index"]
        time["reference_label"] = reference_step.get("label")
        time["reference_coordinate"] = reference_step.get("coordinate")
        time["reference_date"] = _date(reference_step.get("label"))
        time["reference_operation"] = _STEP_OPERATION
    time["velocity_fit_start"] = _date(merged.get("velocity_fit_start"))
    time["velocity_fit_end"] = _date(merged.get("velocity_fit_end"))
    time["selected_date"] = _date(selected_label)
    note = "Available record bounds do not establish fit dates or the temporal datum."
    time["note"] = note

    def nodata(value: Any) -> str | int | float | None:
        if value is None:
            return None
        value = float(value)
        return value if math.isfinite(value) else str(value)

    reference = _reference(attrs)
    provenance = {
        "schema_version": 1,
        "layer": variable,
        "source": source,
        "time": time,
        "masks": {"combination": "AND", "applied": list(masks)},
        "nodata": {
            "source": nodata(source_nodata),
            "export": nodata(export_nodata),
            "note": "Source-invalid pixels remain invalid; valid zeros are retained.",
        },
        "reference": reference,
        "values": "native source units; no display colormap, rescale, or rewrap",
    }
    tags = {
        "BOWSER_EXPORT_PROVENANCE": json.dumps(
            provenance, sort_keys=True, allow_nan=False
        ),
        "BOWSER_EXPORT_LAYER": variable,
        "BOWSER_EXPORT_REFERENCE_MODE": reference["mode"],
        "BOWSER_EXPORT_MASKED": str(bool(masks)).lower(),
    }
    if reference.get("utm"):
        tags.update(
            {
                "BOWSER_REFERENCE_UTM_CRS": reference["utm"]["crs"],
                "BOWSER_REFERENCE_UTM_EASTING": str(reference["utm"]["easting_meters"]),
                "BOWSER_REFERENCE_UTM_NORTHING": str(
                    reference["utm"]["northing_meters"]
                ),
            }
        )
    for key, value in source.items():
        if value is not None:
            tags[f"BOWSER_SOURCE_{key.upper()}"] = value
    for key, value in time.items():
        if value is not None and key != "note":
            tags[f"BOWSER_TIME_{key.upper()}"] = str(value)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", variable).strip(".-_")[:80] or "layer"
    token = None
    if time["velocity_fit_start"] and time["velocity_fit_end"]:
        token = f"{time['velocity_fit_start']}_{time['velocity_fit_end']}"
    elif time["reference_date"] and time["selected_date"]:
        token = f"{time['reference_date']}_{time['selected_date']}"
    elif selected_label and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}", selected_label
    ):
        if all(_date(d) for d in selected_label.split("_")):
            token = selected_label
    elif time["selected_date"]:
        token = time["selected_date"]
    if token:
        token = token.replace("-", "").replace("_", "-")
    elif selected_index is not None:
        token = f"t{selected_index}"
    filename = (
        "_".join(p for p in (slug, token, "masked" if masks else None) if p) + ".tif"
    )
    return tags, filename
