"""Pydantic models for the Bowser V2 dataset manifest.

A manifest describes a collection of raster and point layers for a single
InSAR analysis area. It is the entry point for Bowser V2's unified
raster + vector viewing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal, Union

from pydantic import BaseModel, Field


class RasterLayerConfig(BaseModel):
    """Configuration for a raster tile layer (COG or Zarr)."""

    type: Literal["raster"] = "raster"
    source: str = Field(description="Path or URI to raster file/stack (COG, Zarr, VRT)")
    colormap: str = "RdBu_r"
    units: str = ""
    vmin: float | None = None
    vmax: float | None = None


class PointLayerConfig(BaseModel):
    """Configuration for a vector point layer backed by GeoParquet."""

    type: Literal["points"] = "points"
    points_source: str = Field(description="Path or URI to points GeoParquet file")
    timeseries_source: str = Field(
        description="Path or URI to timeseries GeoParquet file"
    )
    default_color_by: str = "velocity"
    default_colormap: str = "RdBu_r"
    default_vmin: float | None = None
    default_vmax: float | None = None


LayerConfig = Union[RasterLayerConfig, PointLayerConfig]


class DatasetManifest(BaseModel):
    """Top-level manifest describing a Bowser V2 dataset.

    Parameters
    ----------
    name : str
        Human-readable dataset name.
    layers : dict[str, LayerConfig]
        Named layers, each either a raster or point layer.
    description : str
        Optional description of the dataset.
    satellite : str
        Satellite name (e.g., "Sentinel-1").
    orbit : str
        Orbit direction (e.g., "descending").
    track : int
        Relative orbit / track number.
    reference_date : str
        Reference date for displacement time series.
    bounds : list[float]
        Spatial bounds [west, south, east, north] in EPSG:4326.
    """

    name: str
    layers: dict[str, LayerConfig] = Field(
        description="Named layers (raster or points)"
    )
    description: str = ""
    satellite: str = ""
    orbit: str = ""
    track: int | None = None
    reference_date: str | None = None
    bounds: list[float] | None = None

    def get_point_layers(self) -> dict[str, PointLayerConfig]:
        """Return only the point layers from the manifest."""
        return {
            name: layer
            for name, layer in self.layers.items()
            if isinstance(layer, PointLayerConfig)
        }

    def get_raster_layers(self) -> dict[str, RasterLayerConfig]:
        """Return only the raster layers from the manifest."""
        return {
            name: layer
            for name, layer in self.layers.items()
            if isinstance(layer, RasterLayerConfig)
        }

    @classmethod
    def load(cls, path: str | Path) -> DatasetManifest:
        """Load a manifest from a JSON file."""
        import json

        with open(path) as f:
            return cls.model_validate(json.load(f))

    def save(self, path: str | Path) -> None:
        """Write the manifest to a JSON file."""
        import json

        with open(path, "w") as f:
            json.dump(self.model_dump(), f, indent=2)
