"""Finding GeoZarr cubes under a folder (bowser.scan)."""

import json
import os

import pytest

from bowser.scan import find_cubes


def _store(path, title=None, v3=False):
    path.mkdir(parents=True)
    if v3:
        (path / "zarr.json").write_text(
            json.dumps(
                {"zarr_format": 3, "attributes": {"title": title} if title else {}}
            )
        )
    else:
        (path / ".zgroup").write_text("{}")
        if title:
            (path / ".zattrs").write_text(json.dumps({"title": title}))
    (path / "displacement").mkdir()  # an array inside: must not be listed or searched


def test_finds_stores_with_titles_and_not_their_insides(tmp_path):
    _store(tmp_path / "dams" / "prado" / "asc.zarr", "Prado Dam ASC")
    _store(tmp_path / "dams" / "arkabutla.zarr", "Arkabutla", v3=True)
    _store(tmp_path / "plain_store")  # no .zarr suffix, but a zarr group
    (tmp_path / "notes").mkdir()
    _store(tmp_path / ".hidden" / "x.zarr")
    out = find_cubes(tmp_path)
    assert [(c["name"], c["title"]) for c in out["cubes"]] == [
        ("arkabutla", "Arkabutla"),
        ("asc", "Prado Dam ASC"),
        ("plain_store", None),
    ]
    assert out["truncated"] is False


def test_depth_and_count_limits(tmp_path):
    _store(tmp_path / "a" / "b" / "c" / "d" / "deep.zarr")
    assert find_cubes(tmp_path, max_depth=3)["cubes"] == []
    assert len(find_cubes(tmp_path, max_depth=5)["cubes"]) == 1
    for i in range(3):
        _store(tmp_path / f"s{i}.zarr")
    limited = find_cubes(tmp_path, limit=2)
    assert len(limited["cubes"]) == 2 and limited["truncated"] is True


def test_refuses_a_file_or_missing_folder(tmp_path):
    (tmp_path / "f.txt").write_text("x")
    with pytest.raises(NotADirectoryError):
        find_cubes(tmp_path / "f.txt")
    with pytest.raises(NotADirectoryError):
        find_cubes(tmp_path / "missing")


# --- list_folder: Overlays › Load file › Browse ------------------------------------


def _addable():
    pytest.importorskip("rasterio")
    from bowser.convert import addable_kind

    return addable_kind


def _folder(root):
    """A folder as a user has it: data, sidecars, notes, hidden files."""
    (root / "zeta").mkdir(parents=True)
    (root / "Alpha").mkdir()
    (root / ".git").mkdir()
    for name, size in (
        ("dem.tif", 300),
        ("B.TIFF", 10),
        ("wells.shp", 7),
        ("wells.dbf", 7),
        ("wells.prj", 7),
        ("parcels.gpkg", 5),
        ("lines.fgb", 5),
        ("sites.kml", 5),
        ("sites.kmz", 5),
        ("track.gpx", 5),
        ("pts.csv", 5),
        ("pts.tsv", 5),
        ("pts.txt", 5),
        ("aoi.geojson", 5),
        ("aoi.json", 5),
        ("notes.pdf", 5),
        ("run.py", 5),
        (".hidden.tif", 5),
    ):
        (root / name).write_bytes(b"x" * size)
    return root


def test_lists_folders_first_then_only_files_the_page_adds(tmp_path):
    from bowser.scan import list_folder

    out = list_folder(_folder(tmp_path), _addable())
    rows = [(e["name"], e["type"], e["size"], e["kind"]) for e in out["entries"]]
    assert rows[:2] == [("Alpha", "dir", None, None), ("zeta", "dir", None, None)]
    names = [r[0] for r in rows[2:]]
    # Case-insensitive order; the Shapefile's sidecars, other files and hidden
    # ones are left out.
    assert names == [
        "aoi.geojson",
        "aoi.json",
        "B.TIFF",
        "dem.tif",
        "lines.fgb",
        "parcels.gpkg",
        "pts.csv",
        "pts.tsv",
        "pts.txt",
        "sites.kml",
        "sites.kmz",
        "track.gpx",
        "wells.shp",
    ]
    by_name = {r[0]: r for r in rows}
    assert by_name["dem.tif"][2:] == (300, "raster")
    assert by_name["B.TIFF"][3] == "raster"
    assert by_name["wells.shp"][2:] == (7, "vector")
    assert out["entries"][2]["path"] == str(tmp_path.resolve() / "aoi.geojson")
    assert out["dir"] == str(tmp_path.resolve())
    assert out["parent"] == str(tmp_path.resolve().parent)
    assert out["truncated"] is False and out["skipped"] == 0
    # Hidden ones on request.
    shown = list_folder(tmp_path, _addable(), hidden=True)["entries"]
    assert {".git", ".hidden.tif"} <= {e["name"] for e in shown}


def test_the_root_has_no_parent():
    from bowser.scan import list_folder

    assert list_folder("/", _addable(), limit=1)["parent"] is None


def test_truncates_at_the_limit(tmp_path):
    from bowser.scan import list_folder

    for i in range(4):
        (tmp_path / f"d{i}").mkdir()
        (tmp_path / f"f{i}.tif").write_bytes(b"x")
    out = list_folder(tmp_path, _addable(), limit=5)
    assert [e["name"] for e in out["entries"]] == ["d0", "d1", "d2", "d3", "f0.tif"]
    assert out["truncated"] is True
    assert list_folder(tmp_path, _addable(), limit=8)["truncated"] is False


def test_resolves_symlinks_and_skips_broken_ones(tmp_path):
    from bowser.scan import list_folder

    real = tmp_path / "real"
    real.mkdir()
    (real / "dem.tif").write_bytes(b"x" * 42)
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "link").symlink_to(real)
    (tmp_path / "data" / "dem_link.tif").symlink_to(real / "dem.tif")
    (tmp_path / "data" / "gone.tif").symlink_to(tmp_path / "missing.tif")
    out = list_folder(tmp_path / "data" / "link", _addable())
    assert out["dir"] == str(real.resolve())  # the folder as it really is
    assert out["parent"] == str(tmp_path.resolve())
    inside = list_folder(tmp_path / "data", _addable())
    rows = [(e["name"], e["type"], e["size"]) for e in inside["entries"]]
    # A link to a folder is a folder; to a file, the file's size; a broken one skipped.
    assert rows == [("link", "dir", None), ("dem_link.tif", "file", 42)]
    assert inside["skipped"] == 1


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads everything")
def test_skips_what_the_user_cannot_read(tmp_path):
    from bowser.scan import list_folder

    (tmp_path / "locked").mkdir()
    (tmp_path / "open").mkdir()
    (tmp_path / "secret.tif").write_bytes(b"x")
    (tmp_path / "dem.tif").write_bytes(b"x")
    os.chmod(tmp_path / "locked", 0)
    os.chmod(tmp_path / "secret.tif", 0)
    try:
        out = list_folder(tmp_path, _addable())
        assert [e["name"] for e in out["entries"]] == ["open", "dem.tif"]
        assert out["skipped"] == 2
        with pytest.raises(PermissionError):
            list_folder(tmp_path / "locked", _addable())
    finally:
        os.chmod(tmp_path / "locked", 0o755)


def test_refuses_a_file_to_list(tmp_path):
    from bowser.scan import list_folder

    (tmp_path / "dem.tif").write_bytes(b"x")
    with pytest.raises(NotADirectoryError):
        list_folder(tmp_path / "dem.tif", _addable())


def test_lists_the_types_the_upload_accepts():
    """The server's list and the upload's ``accept`` (useAddFiles.ts) are the same.

    Browse lists what the server says the page adds; the file picker offers ACCEPT.
    A Shapefile's sidecars are in ACCEPT only: Browse lists the ``.shp``.
    """
    import re
    from pathlib import Path

    pytest.importorskip("rasterio")
    from bowser.convert import RASTER_SUFFIXES, VECTOR_SUFFIXES

    ts = Path(__file__).resolve().parents[1] / "src" / "hooks" / "useAddFiles.ts"
    accept = re.search(r"export const ACCEPT = '([^']+)'", ts.read_text()).group(1)
    sidecars = {".dbf", ".prj", ".cpg", ".shx"}
    assert set(accept.split(",")) - sidecars == set(RASTER_SUFFIXES + VECTOR_SUFFIXES)
