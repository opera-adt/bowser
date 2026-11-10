"""One tile size: the pyramid's stop size and every level picker agree.

``tifs-to-geozarr --min-pyramid-size`` stops coarsening at the map tile size,
and both servers' ``dataset_for_tile_zoom`` assume that tile size when picking
a level. Both read ``bowser.constants.TILE_SIZE``, so they cannot drift apart.
"""

from __future__ import annotations

import inspect

from click.testing import CliRunner

from bowser import constants, geozarr, view_cube
from bowser.cli import cli_app
from bowser.lite import cube as lcube
from bowser.lite import geo, tiles


def _default(func, name: str):
    return inspect.signature(func).parameters[name].default


def test_tile_size_is_256():
    # The default must not change: stores and clients already assume it.
    assert constants.TILE_SIZE == 256


def test_pyramid_stop_size_and_level_pickers_share_the_tile_size():
    # Imported here: bowser.state reads the settings from the environment at import,
    # and an import at collection time would fix them before other tests set theirs.
    from bowser import state

    cmd = cli_app.commands["tifs-to-geozarr"]
    opt = next(p for p in cmd.params if p.name == "min_pyramid_size")
    assert opt.default == constants.TILE_SIZE
    assert _default(geozarr.build_pyramid, "min_size") == constants.TILE_SIZE
    assert (
        _default(state.BowserState.dataset_for_tile_zoom, "tile_size")
        == _default(lcube.Cube.dataset_for_tile_zoom, "tile_size")
        == constants.TILE_SIZE
    )
    assert view_cube.TILE == constants.TILE_SIZE
    assert _default(geo.cell_size, "tilesize") == constants.TILE_SIZE
    assert _default(tiles.render_tile, "tilesize") == constants.TILE_SIZE


def test_min_pyramid_size_help_explains_the_coupling():
    out = CliRunner().invoke(cli_app, ["tifs-to-geozarr", "--help"]).output
    help_text = " ".join(out.split())
    assert "bowser.constants.TILE_SIZE" in help_text
    assert "level picker" in help_text
    assert "[default: 256]" in help_text
