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

On bowser-lite, `polygon_statistics` and `export_geotiff` return a tool error
that says the full server is needed; `server_info` lists them under
`unsupported_tools`.

Values follow the API: `point_timeseries`, `multi_point_timeseries`,
`trend_at_point`, `value_at_point` and `export_geotiff` can subtract a
reference point, while `polygon_statistics`, `profile` and `layer_statistics`
report the stored values. Each result's `reference.note` says which.
