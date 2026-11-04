"""Finding GeoZarr cubes under a folder (bowser.scan)."""

import json

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
