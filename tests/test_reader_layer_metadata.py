"""Reuse existing raster header reads for source text and units."""

import numpy as np
import rasterio
from rasterio.transform import from_origin

from bowser.readers import RasterReader


def test_raster_reader_retains_band_metadata_without_modifying_source(tmp_path):
    path = tmp_path / "source.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs="EPSG:32611",
        transform=from_origin(500000, 4000000, 10, 10),
    ) as dst:
        dst.write(np.zeros((1, 2, 2), dtype="float32"))
        dst.set_band_unit(1, "cm/year")
        dst.set_band_description(1, "Source band name")
        dst.update_tags(
            description="Dataset description", units="incorrect_dataset_unit"
        )
        dst.update_tags(
            1,
            description="Band-specific description",
            flag_values="[0, 1]",
            flag_meanings="retain reject",
        )
    original = path.read_bytes()
    reader = RasterReader.from_file(path)
    assert reader.layer_attrs["description"] == "Band-specific description"
    assert reader.layer_attrs["long_name"] == "Source band name"
    assert reader.layer_attrs["units"] == "cm/year"
    assert reader.layer_attrs["flag_values"] == "[0, 1]"
    assert path.read_bytes() == original


def test_no_units_are_assigned_to_an_undocumented_raster(tmp_path):
    path = tmp_path / "velocity.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs="EPSG:32611",
        transform=from_origin(500000, 4000000, 10, 10),
    ) as dst:
        dst.write(np.zeros((1, 2, 2), dtype="float32"))
    attrs = RasterReader.from_file(path).layer_attrs
    # GDAL can legitimately add AREA_OR_POINT; it does not supply measurement units.
    assert "units" not in attrs
    assert "unit" not in attrs
    assert "description" not in attrs


def test_gdal_header_fallback_preserves_metadata(monkeypatch, tmp_path):
    import sys
    from types import SimpleNamespace

    from rasterio.crs import CRS

    band = SimpleNamespace(
        GetNoDataValue=lambda: -9999,
        GetMetadata=lambda: {"description": "Fallback band description"},
        GetUnitType=lambda: "radians",
        GetDescription=lambda: "Unwrapped phase",
    )
    source = SimpleNamespace(
        RasterYSize=2,
        RasterXSize=2,
        GetGeoTransform=lambda: (500000, 10, 0, 4000000, 0, -10),
        GetProjection=lambda: CRS.from_epsg(32611).to_wkt(),
        GetRasterBand=lambda _: band,
        GetMetadata=lambda: {"description": "Dataset description"},
    )
    gdal = SimpleNamespace(UseExceptions=lambda: None, Open=lambda _: source)
    monkeypatch.setitem(sys.modules, "osgeo", SimpleNamespace(gdal=gdal))

    def unsupported_type(*_args, **_kwargs):
        raise KeyError("Float16 GDAL type")

    monkeypatch.setattr(rasterio, "open", unsupported_type)
    reader = RasterReader.from_file(tmp_path / "float16.tif")
    assert reader.layer_attrs["description"] == "Fallback band description"
    assert reader.layer_attrs["units"] == "radians"
    assert reader.layer_attrs["long_name"] == "Unwrapped phase"
    assert reader.dtype == np.dtype("float32")
