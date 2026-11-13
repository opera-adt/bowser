"""Pinned palette values agree across CPU, lightweight and browser GPU renderers."""

import base64
import json
from pathlib import Path

import numpy as np
import pytest

from bowser.lite import colormaps
from bowser.scientific_colormaps import DIRECTORY, register, tables


def test_sources_license_and_complete_tables():
    manifest = json.loads((DIRECTORY / "SOURCES.json").read_text())
    assert manifest["revision"] == "87197e141a2c451691ec53fadc6da4d017f79a4c"
    assert "Copyright (c) 2020 Fabio Crameri" in (DIRECTORY / "LICENSE.txt").read_text()
    assert len(tables()) == 18
    for name, rgba in tables().items():
        assert rgba.shape == (256, 4) and rgba.dtype == np.uint8
        assert (rgba[:, 3] == 255).all()
        if not name.endswith("_r"):
            np.testing.assert_array_equal(tables()[name + "_r"], rgba[::-1])


def test_old_lite_tables_remain_exactly_unchanged():
    with np.load(colormaps.TABLE_FILE, allow_pickle=False) as old:
        for name, rgba in zip(old["names"], old["luts"]):
            np.testing.assert_array_equal(colormaps.get_lut(str(name)), rgba)


def test_full_lite_matplotlib_and_gpu_share_every_byte():
    import matplotlib as mpl
    from rio_tiler.colormap import cmap

    register()
    register()  # repeated app setup must remain safe
    gpu = json.loads(
        (Path(__file__).parents[1] / "src/map/gpu/colormapLuts.json").read_text()
    )
    for name, rgba in tables().items():
        np.testing.assert_array_equal(colormaps.get_lut(name.upper()), rgba)
        np.testing.assert_array_equal([cmap.get(name)[i] for i in range(256)], rgba)
        np.testing.assert_array_equal(
            np.rint(mpl.colormaps[name](np.arange(256)) * 255), rgba
        )
        np.testing.assert_array_equal(
            np.frombuffer(base64.b64decode(gpu[name]), dtype=np.uint8).reshape(256, 4),
            rgba,
        )
        np.testing.assert_array_equal(
            colormaps.colorbar_rgba(name, width=256, height=1)[0], rgba
        )


def test_changed_source_cannot_silently_change_a_palette(tmp_path, monkeypatch):
    import shutil

    import bowser.scientific_colormaps as module

    for source in DIRECTORY.iterdir():
        shutil.copy2(source, tmp_path / source.name)
    with (tmp_path / "vik.txt").open("a") as source:
        source.write("\n")
    monkeypatch.setattr(module, "DIRECTORY", tmp_path)
    tables.cache_clear()
    try:
        with pytest.raises(ValueError, match="checksum mismatch"):
            tables()
    finally:
        tables.cache_clear()


def test_a_checkout_with_converted_line_endings_gives_the_same_tables(
    tmp_path, monkeypatch
):
    import shutil

    import bowser.scientific_colormaps as module

    tables.cache_clear()
    expected = tables()
    for source in DIRECTORY.iterdir():
        shutil.copy2(source, tmp_path / source.name)
    for text in tmp_path.glob("*.txt"):
        text.write_bytes(text.read_bytes().replace(b"\n", b"\r\n"))
    monkeypatch.setattr(module, "DIRECTORY", tmp_path)
    tables.cache_clear()
    try:
        crlf = tables()
        assert crlf.keys() == expected.keys()
        assert all(np.array_equal(crlf[name], expected[name]) for name in expected)
    finally:
        tables.cache_clear()


def test_lite_keeps_its_own_tables_when_the_palette_files_are_missing(
    tmp_path, monkeypatch
):
    """A build that left the palette files out must still colour every tile."""
    import bowser.scientific_colormaps as module

    try:
        with monkeypatch.context() as patch:
            patch.setattr(module, "DIRECTORY", tmp_path / "absent")
            tables.cache_clear()
            colormaps._tables.cache_clear()
            names = colormaps.names()
            assert "viridis" in names and "rdbu" in names
            assert not any(name.startswith("cmc_") for name in names)
            assert colormaps.get_lut("viridis").shape == (256, 4)
    finally:
        tables.cache_clear()
        colormaps._tables.cache_clear()
    assert "cmc_vik" in colormaps.names()


def test_the_desktop_app_bundles_the_palette_files():
    """bowser-lite reads them at run time; the PyInstaller spec must collect them."""
    import ast

    root = Path(__file__).resolve().parents[1]
    spec = ast.parse((root / "packaging" / "bowser.spec").read_text())
    patterns = next(
        ast.literal_eval(keyword.value)
        for node in ast.walk(spec)
        if isinstance(node, ast.Call)
        and getattr(node.func, "id", "") == "collect_data_files"
        and node.args
        and ast.literal_eval(node.args[0]) == "bowser"
        for keyword in node.keywords
        if keyword.arg == "includes"
    )
    package = root / "src" / "bowser"
    collected = {path for pattern in patterns for path in package.glob(pattern)}
    assert set(DIRECTORY.iterdir()) <= collected
    assert colormaps.TABLE_FILE in collected
