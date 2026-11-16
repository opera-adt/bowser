"""Bounded WGS84 vector outlines for GIF display, never raster masks."""

import math
from typing import Any

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

_DEPTH = {
    "Point": 0,
    "MultiPoint": 1,
    "LineString": 1,
    "MultiLineString": 2,
    "Polygon": 2,
    "MultiPolygon": 3,
}


def _geometry(geometry):
    if (
        set(geometry) != {"type", "coordinates"}
        or not isinstance(geometry.get("type"), str)
        or geometry["type"] not in _DEPTH
    ):
        raise ValueError(
            "Outline needs a supported geometry with WGS84 coordinates only"
        )
    count, longitudes = 0, []

    def visit(values, depth):
        nonlocal count
        if not isinstance(values, (list, tuple)) or not values:
            raise ValueError("Outline coordinates cannot be empty")
        if depth:
            return [visit(v, depth - 1) for v in values]
        if len(values) not in (2, 3) or any(
            type(v) not in (int, float) or not math.isfinite(v) for v in values
        ):
            raise ValueError("Outline vertices need finite longitude/latitude")
        lon, lat = values[:2]
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("Outline coordinates must be WGS84 longitude/latitude")
        count += 1
        if count > 5000:
            raise ValueError("Outline exceeds the 5000-vertex budget")
        longitudes.append(lon)
        return [float(lon), float(lat)]

    kind = geometry["type"]
    coords = visit(geometry["coordinates"], _DEPTH[kind])
    if max(longitudes) - min(longitudes) > 180:
        raise ValueError("Antimeridian-spanning outlines are not supported")
    polygons = (
        [coords] if kind == "Polygon" else coords if kind == "MultiPolygon" else []
    )
    if any(
        len(ring) < 4 or ring[0] != ring[-1] for polygon in polygons for ring in polygon
    ):
        raise ValueError("Outline polygon rings must be closed")
    return {"type": kind, "coordinates": coords}, count


class AnimationOutline(BaseModel):
    """One named layer of geometry-only outlines; no feature properties or URLs."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    name: str = Field(default="Outline", max_length=80)
    geometries: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    _vertices: int = PrivateAttr(default=0)

    @model_validator(mode="after")
    def bounded_geometry(self):
        """Reject malformed shapes instead of repairing or silently skipping them."""
        from shapely.errors import ShapelyError
        from shapely.geometry import shape

        normalized = []
        total = 0
        for geometry in self.geometries:
            item, count = _geometry(geometry)
            total += count
            if total > 5000:
                raise ValueError("Outline exceeds the 5000-vertex budget")
            try:
                geom = shape(item)
                valid = not geom.is_empty and geom.is_valid
            except (ShapelyError, ValueError, TypeError) as exc:
                raise ValueError("Invalid outline geometry") from exc
            if not valid:
                raise ValueError("Invalid outline geometry")
            normalized.append(item)
        self.geometries = normalized
        self._vertices = total
        return self

    @property
    def vertex_count(self):
        """Return normalized vertices for the whole-request work budget."""
        return self._vertices


def prepare_outlines(da, outlines, size):
    """Project and clip real boundaries once, without creating viewport edges."""
    from pyproj import Transformer
    from shapely import transform
    from shapely.geometry import box, shape

    transformer = Transformer.from_crs(4326, da.rio.crs, always_xy=True)
    footprint = box(*da.rio.bounds())
    inverse = ~da.rio.transform()
    paths = []

    def pixel(x, y):
        col, row = inverse * (x, y)
        return (
            round(col / da.sizes["x"] * size[0]),
            round(row / da.sizes["y"] * size[1]),
        )

    def collect(geom, points):
        if geom.is_empty:
            return
        if geom.geom_type == "Point":
            if points:
                paths.append(("point", [pixel(geom.x, geom.y)]))
        elif geom.geom_type in ("LineString", "LinearRing"):
            paths.append(("line", [pixel(*xy) for xy in geom.coords]))
        elif hasattr(geom, "geoms"):
            for part in geom.geoms:
                collect(part, points)

    for outline in outlines:
        for geometry in outline.geometries:
            geom = shape(geometry)
            points = geom.geom_type in ("Point", "MultiPoint")
            if geom.geom_type in ("Polygon", "MultiPolygon"):
                geom = geom.boundary  # clip boundaries, not filled polygons
            try:
                projected = transform(
                    geom,
                    lambda xy: np.column_stack(
                        transformer.transform(xy[:, 0], xy[:, 1], errcheck=True)
                    ),
                    include_z=False,
                )
                clipped = projected.intersection(footprint)
            except Exception as exc:
                raise ValueError(
                    "Outline cannot be projected/clipped to the source grid"
                ) from exc
            collect(clipped, points)
    return paths


def draw_outlines(image, paths):
    """Black boundaries with a white halo; no polygon fill or data modification."""
    from PIL import ImageDraw

    draw = ImageDraw.Draw(image)
    for kind, coords in paths:
        if kind == "point":
            x, y = coords[0]
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=254)
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=255)
        else:
            draw.line(coords, fill=254, width=4)
            draw.line(coords, fill=255, width=2)
