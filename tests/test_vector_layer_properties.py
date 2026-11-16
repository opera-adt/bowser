"""Actual multilayer GeoPackage conversion must not overwrite source attributes."""

import hashlib
import json
from pathlib import Path

import pytest

pytest.importorskip("osgeo.gdal")
from osgeo import ogr, osr  # noqa: E402

from bowser import convert  # noqa: E402


def package(path, occupied=(), multiple=True, second_only=False):
    """Two distinct source CRSs, polygon holes and legitimate colliding columns."""
    convert._ogr()  # Explicit exception policy before fixture creation, as in conversion.
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(str(path))
    names = ["regions", "controls"] if multiple else ["regions"]
    expected = []
    for index, name in enumerate(names):
        srs = osr.SpatialReference()
        srs.ImportFromEPSG(32611 if index == 0 else 4326)
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        layer = ds.CreateLayer(name, srs=srs, geom_type=ogr.wkbPolygon)
        fields = () if second_only and index == 0 else occupied
        for field in ("label", *fields):
            layer.CreateField(ogr.FieldDefn(field, ogr.OFTString))
        layer.CreateField(ogr.FieldDefn("rate", ogr.OFTReal))
        feature = ogr.Feature(layer.GetLayerDefn())
        attributes = {
            "label": "Survey unit " + name,
            "rate": -2.5 if index == 0 else 0.0,
        }
        attributes.update(
            {field: "original " + field if index == 0 else None for field in fields}
        )
        for key, value in attributes.items():
            if value is None:
                feature.SetFieldNull(key)
            else:
                feature.SetField(key, value)
        if index == 0:
            wkt = (
                "POLYGON ((500000 4100000,500100 4100000,500100 4100100,"
                "500000 4100100,500000 4100000),(500020 4100020,500020 4100040,"
                "500040 4100040,500040 4100020,500020 4100020))"
            )
        else:
            wkt = "POLYGON ((-117 37,-116.999 37,-116.999 37.001,-117 37.001,-117 37))"
        feature.SetGeometry(ogr.CreateGeometryFromWkt(wkt))
        layer.CreateFeature(feature)
        expected.append(attributes)
        feature = None
    ds = None
    return expected


@pytest.mark.parametrize(
    "occupied,key",
    [
        ((), "layer"),
        (("layer",), "source_layer"),
        (("layer", "source_layer"), "source_layer_2"),
        (("layer", "source_layer", "source_layer_2"), "source_layer_3"),
    ],
)
def test_multilayer_attributes_and_source_layer_coexist(tmp_path, occupied, key):
    src, dst = tmp_path / "areas.gpkg", tmp_path / "areas.geojson"
    expected = package(src, occupied)
    before = src.read_bytes()
    convert.convert_to_geojson(src, dst)
    result = json.loads(dst.read_text())
    assert len(result["features"]) == 2
    for feature, attributes, name in zip(
        result["features"], expected, ["regions", "controls"]
    ):
        assert {
            field: feature["properties"][field] for field in attributes
        } == attributes
        assert feature["properties"][key] == name
        assert set(feature["properties"]) == {*attributes, key}
        assert feature["geometry"]["type"] == "Polygon"
        assert all(
            -180 <= x <= 180 and -90 <= y <= 90
            for ring in feature["geometry"]["coordinates"]
            for x, y in ring
        )
    assert len(result["features"][0]["geometry"]["coordinates"]) == 2
    assert -117.01 < result["features"][0]["geometry"]["coordinates"][0][0][0] < -116.99
    assert result["bowser_source_layer_property"] == key
    assert src.read_bytes() == before


def test_single_layer_keeps_exact_attributes_without_annotation(tmp_path):
    src, dst = tmp_path / "one.gpkg", tmp_path / "one.geojson"
    expected = package(src, ("layer", "source_layer"), multiple=False)
    convert.convert_to_geojson(src, dst)
    result = json.loads(dst.read_text())
    assert result["features"][0]["properties"] == expected[0]
    assert "bowser_source_layer_property" not in result


def legacy_key(src, fmt):
    parts = [str(src.resolve()), fmt]
    for file in convert.source_files(src):
        stat = file.stat()
        parts += [str(stat.st_size), str(stat.st_mtime_ns)]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


def test_old_geojson_cache_is_not_reused_or_deleted(tmp_path, monkeypatch):
    src = tmp_path / "areas.gpkg"
    expected = package(src, ("layer",))
    folder = tmp_path / "cache"
    folder.mkdir()
    monkeypatch.setenv("BOWSER_CONVERT_CACHE_DIR", str(folder))
    monkeypatch.setattr(convert, "_start", lambda target, args: target(*args))
    old_key = legacy_key(src, "geojson")
    old_output = folder / (old_key + ".geojson")
    old_content = '{"type":"FeatureCollection","features":[]}'
    old_output.write_text(old_content)
    (folder / (old_key + ".json")).write_text(
        json.dumps(
            {
                "kind": "vector",
                "format": "geojson",
                "name": "areas.gpkg",
            }
        )
    )
    ready = convert.prepare(src)
    assert ready["status"] == "ready", ready
    assert ready["id"] != old_key
    assert old_output.read_text() == old_content
    assert (
        json.loads(Path(ready["output"]).read_text())["features"][0]["properties"][
            "layer"
        ]
        == expected[0]["layer"]
    )
    for fmt in ("cog", "pmtiles"):
        assert convert.cache_key(src, fmt) == legacy_key(src, fmt)


def test_later_layer_collision_uses_one_field_for_every_feature(tmp_path):
    src, dst = tmp_path / "mixed.gpkg", tmp_path / "mixed.geojson"
    expected = package(src, ("layer",), second_only=True)
    convert.convert_to_geojson(src, dst)
    result = json.loads(dst.read_text())
    assert result["bowser_source_layer_property"] == "source_layer"
    for feature, attributes, name in zip(
        result["features"], expected, ["regions", "controls"]
    ):
        assert feature["properties"] == {**attributes, "source_layer": name}
