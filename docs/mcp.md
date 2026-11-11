# MCP server

`bowser mcp` lets an AI assistant such as Claude Desktop or Claude Code read a
Bowser cube through the [Model Context Protocol](https://modelcontextprotocol.io).
Its tools call a running Bowser server, full (`bowser run`) or lite
(`bowser lite`), through the same [HTTP API](rest-api.md) the web page uses, so
the assistant gets the numbers the page shows. The MCP server reads no data
itself.

Each answer is compact JSON: dates and values, the unit, and a `reference` note
saying what the values are relative to. Lengths stored in metres are given in
millimetres and rates in mm/yr. The server also gives the assistant
instructions: displacement is line-of-sight motion relative to a reference
point and date, and a curve should not be interpreted without knowing what is
on the ground and how good the data are there.

## Install

The MCP SDK is an optional extra:

```bash
pip install 'bowser-insar[mcp]'
```

## Run

Start Bowser on a cube, then point `bowser mcp` at it:

```bash
bowser lite --stack-file cube.zarr --port 8000     # or: bowser run -s cube.zarr
bowser mcp --url http://127.0.0.1:8000
```

`bowser mcp` talks MCP over stdio, which is what Claude Desktop and Claude Code
expect. To serve it over streamable HTTP instead, at `http://<host>:<port>/mcp`:

```bash
bowser mcp --url http://127.0.0.1:8000 --http --host 127.0.0.1 --port 8765
```

For a single cube without a separate server, `--stack-file` opens the cube with
bowser-lite inside the MCP process:

```bash
bowser mcp --stack-file cube.zarr
```

bowser-lite has no GDAL, so polygon statistics and GeoTIFF export need the full
server: run `bowser run` and use `--url`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--url` | `http://127.0.0.1:8000` | Bowser server to call |
| `--stack-file`, `-s` | | Open this cube with bowser-lite in-process instead of calling `--url` |
| `--http` | off (stdio) | Serve streamable HTTP at `/mcp` |
| `--host` | `127.0.0.1` | Interface for `--http` |
| `--port`, `-p` | `8765` | Port for `--http` |
| `--token` | read from the server's token file | The server's page token for the page tools (env `BOWSER_PAGE_TOKEN`); see [Acting on the page](#acting-on-the-page) |

## Add it to an assistant

Claude Code:

```bash
claude mcp add bowser -- bowser mcp --url http://127.0.0.1:8000
# or, one cube without a separate server:
claude mcp add bowser -- bowser mcp --stack-file /path/to/cube.zarr
```

Claude Desktop, in `claude_desktop_config.json` (Settings, Developer, Edit
Config). Use the full path to `bowser` if it is not on the app's `PATH`, for
example the output of `which bowser`:

```json
{
  "mcpServers": {
    "bowser": {
      "command": "bowser",
      "args": ["mcp", "--url", "http://127.0.0.1:8000"]
    }
  }
}
```

An assistant that speaks streamable HTTP can connect to a `bowser mcp --http`
server at `http://127.0.0.1:8765/mcp`:

```bash
claude mcp add --transport http bowser http://127.0.0.1:8765/mcp
```

## Tools

Every tool takes an optional `dataset`, the catalog id of a server started with
a catalog (`server_info` lists them). Points are WGS84 longitude and latitude;
a point outside the cube is refused rather than read at the nearest edge pixel.

| Tool | What it returns | HTTP API |
| --- | --- | --- |
| `server_info` | Title, full or lite, data mode, whether polygon statistics and GeoTIFF export work, the catalog | `GET /config`, `/mode`, `/catalog` |
| `list_layers` | Each layer's label, unit, number of dates, first and last date, whether it is re-referenced to a point, description; the cube's area, reference point and date, and look geometry | `GET /datasets` |
| `point_timeseries` | Dates and values at a point, relative to a reference point (yours, or the cube's) and date; optional median reference circle | `GET /chart_point`, `POST /multi_point` |
| `multi_point_timeseries` | Several points on shared dates against one reference, each with a linear rate; optional layer masks | `POST /multi_point` |
| `trend_at_point` | Linear rate per year at a point, its standard error and R² | `GET /trend_analysis/{layer}`, `POST /multi_point` |
| `value_at_point` | One value: a layer without dates (velocity, coherence) or one date | `GET /point` |
| `polygon_statistics` | Per-date count, median, mean, spatial std, min, max and percentiles inside a GeoJSON polygon (full server) | `POST /polygon_timeseries` |
| `profile` | Values along a line at one date by distance, with an optional strip median | `POST /profile` |
| `layer_statistics` | Min, max, percentiles and a histogram of a layer at one date | `GET /histogram/{layer}` |
| `export_geotiff` | A GeoTIFF of one date: its download URL, or the file saved where you say (full server) | `GET /export/geotiff` |
| `find_reference_candidates` | Stable places for the reference point: the recommended one and up to `n` spaced candidates with coherence, phase similarity, scatter, velocity and a reason | `GET /reference_candidates` |
| `geocode` | Candidates for a place name or address, with lon/lat and a bounding box (OpenStreetMap Nominatim; no page needed) | `GET /geocode` |

On bowser-lite, `polygon_statistics` and `export_geotiff` return a tool error
that says the full server is needed; `server_info` lists them under
`unsupported_tools`.

`point_timeseries`, `multi_point_timeseries` and `trend_at_point` apply the
open page's layer masks by default (`use_page_masks`), so their answers match
the map and the chart; each result's `masks` says what was applied. Without a
connected page the values are unmasked.

Values follow the API: `point_timeseries`, `multi_point_timeseries`,
`trend_at_point`, `value_at_point` and `export_geotiff` can subtract a
reference point, while `polygon_statistics`, `profile` and `layer_statistics`
report the stored values. Each result's `reference.note` says which.

## Acting on the page

The page tools act on the Bowser page the user has open: they move the map,
set the reference, masks and colours, and use any toolbar or panel control.
They work when Bowser runs on your own computer (`bowser run`, `bowser lite`
or the desktop app, which set `BOWSER_ASSISTANT=1` and
`BOWSER_ASSISTANT_PAGE_KEYS=1`), from `bowser mcp` in Claude Code or Claude
Desktop, from "Sign in with Claude" in the Assistant tab and from the
Assistant's own chat. With no page open they say so: "No Bowser page is open
— open http://127.0.0.1:8000/".

| Tool | What it does |
| --- | --- |
| `get_view` | Center, zoom, bearing, pitch and bounds of the map; split screen and 3D terrain |
| `fly_to` | Move to `lon`, `lat`, keeping the zoom unless `zoom` (0–22) is given |
| `fit_bounds` | Fit `west`, `south`, `east`, `north` (with `padding` in pixels) |
| `pan` | Move `north`, `south`, `east` or `west` by a `fraction` of the view or `distance_m` |
| `zoom` | Zoom to a `level`, or in or out by a `delta` |
| `go_to` | Geocode a place name or address and fit its extent (or fly to it at `zoom`) |
| `set_terrain` | 3D terrain on or off, its exaggeration (1–10) and the camera pitch (MapLibre map) |
| `set_split_screen` | Split screen on or off, with the left (main) and right layers |
| `add_point` | A time-series point on the map and in the chart |
| `get_reference`, `set_reference_point`, `reset_reference`, `set_reference_date` | The reference point (with an optional sampling circle `radius_m`) and date |
| `switch_layer`, `open_chart` | The layer shown, the chart |
| `get_masks`, `set_masks`, `clear_masks`, `set_recommended_mask` | Layer masks: `min` keeps pixels ≥ the threshold, `max` keeps pixels ≤ it |
| `get_display`, `set_colormap`, `set_color_range`, `set_opacity` | Colormap, range (or a preset: `2-98%`, `1sigma`, `2sigma`, `full`, `symmetric`) and opacity, per side in split screen |
| `list_commands`, `run_command` | Every other toolbar and panel control (draw tools, identify, measure, basemap, grid, chart options, time playback, theme, panel tabs...); toggles take `{"on": true}` |

Layer and colormap names are checked, with close matches suggested
("temporal coherence" → `temporal_coherence`). Commands that delete work are
marked destructive, and the assistant is told to ask first.

How it works: the page listens on `GET /page/events` (server-sent events) and
answers each command with `POST /page/result`; a tool sends a command with
`POST /page/command` and waits up to 10 s. With several tabs open, the tab
focused most recently gets the commands. The channel answers only requests
from the computer that runs Bowser and only with
`BOWSER_ASSISTANT_PAGE_KEYS`; only Bowser's own page may listen, and commands
are refused from any browser, so a web page cannot drive the map. Commands,
answers and their rate are bounded.

Commands also need the server's page token. When it starts, the Bowser server
makes a random token and writes it to a file only you can read (mode 0600, in
`$XDG_RUNTIME_DIR/bowser/` or `~/.cache/bowser/`, named `page-token-<port>`),
and removes it when it stops. `bowser mcp --url http://127.0.0.1:PORT` reads
that file when it runs on the same computer as the server, so nothing needs
setting up; the Assistant and "Sign in with Claude" get the token from the
server itself. For an unusual setup (another user, a container) pass it with
`--token` or `BOWSER_PAGE_TOKEN`. Without it the data tools still work, and
the page tools say to start `bowser mcp` on the same computer as the server.
The token is never sent to the page, logged, or put in an answer.

## Places

`geocode` and `go_to` use OpenStreetMap's
[Nominatim](https://nominatim.org) through the Bowser server, following its
[usage policy](https://operations.osmfoundation.org/policies/nominatim/): at
most one request per second from the server, results cached, and a
User-Agent naming Bowser (`bowser-insar/<version>
(+https://github.com/opera-adt/bowser)`), never a person. Results carry
OpenStreetMap's attribution. An administrator can use another
Nominatim-compatible service (their own, for heavy use) with
`BOWSER_GEOCODER_URL=https://.../search`, or turn geocoding off with
`BOWSER_GEOCODER_URL=off`.
