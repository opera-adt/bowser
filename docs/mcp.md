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
| `server_info` | Title, full or lite, data mode, whether polygon statistics and GeoTIFF export work, the catalog, and `measurement`: what the values measure (line of sight, vertical...), their sign, their sensitivity to east, north and up motion and half the radar wavelength, from the cube's metadata ([rest-api.md](rest-api.md#what-a-layer-measures)); unknown when the cube does not say | `GET /config`, `/mode`, `/catalog`, `/datasets` |
| `list_layers` | Each layer's label, unit, number of dates, first and last date, whether it is re-referenced to a point, description, what it measures; the cube's area, reference point and date, and look geometry | `GET /datasets` |
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
| `deformation_zones` | Connected areas where \|rate\| reaches `threshold_mm_yr` (from the velocity layer, or a rate fitted to the displacement): id (`Z1` = largest), direction, area, mean, median and peak rate, centroid, box; optional `min_area_m2`, `bbox`, `sign`, `coherence_min` | `GET /deformation_zones` |
| `infrastructure_at` | Roads, buildings, rail, bridges, pipelines, dams and levees within `radius_m` of a point: counts, length by class, building footprint and types, named features (OpenStreetMap) | `POST /infrastructure` |
| `infrastructure_in_area` | The same in a GeoJSON polygon, a bbox, a shape drawn on the page or a chart area (`area`), or a zone (`zone: "Z1"`) | `POST /infrastructure` |
| `site_context` | What is on the ground at a point: land cover, geology, wetlands, soil, slope and how much of a downslope motion the radar sees, nearby infrastructure, and the cube's coherence and phase similarity there | `GET /site_context`, `POST /infrastructure`, `GET /point` |

On bowser-lite, `polygon_statistics` and `export_geotiff` return a tool error
that says the full server is needed; `server_info` lists them under
`unsupported_tools`.

`point_timeseries`, `multi_point_timeseries` and `trend_at_point` apply the
open page's layer masks by default (`use_page_masks`), so their answers match
the map and the chart; each result's `masks` says what was applied. Without a
connected page the values are unmasked.

`deformation_zones`, `infrastructure_at` and `infrastructure_in_area` draw
what they find on the open page as a highlight layer (`show_on_map`, on by
default; without a page they say so and answer anyway).

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
| `list_context_layers`, `add_context_layer`, `remove_context_layer` | The context layers of Overlays › Services, as their toggles: `roads` (with railways), `boundaries`, `buildings`, `land_cover` (a `year`), `geology`, `soils`, `gnss`; with an optional `opacity` |
| `highlight_infrastructure`, `clear_highlights` | Draw the infrastructure of an area (`kinds`, and a polygon, bbox, `area` or `zone`) in a highlight layer, in a `color`; remove the highlights, all or one by name |
| `get_areas` | The shapes drawn on the map and the chart's areas, or one's GeoJSON geometry by `name` |
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

## The chart

The chart tools read and change the page's time-series chart. They are page
tools like those above (the chart opens if it is closed), so they need an open
page, and they work on the chart's own state: what they return is what the
chart draws, and what they set is what its controls set.

| Tool | What it does | As the page's |
| --- | --- | --- |
| `get_chart_data` | Each series (point × layer, area × layer): name, layer, unit, dates and values exactly as drawn, with the reference point and date, masks, date range and units applied; for an area its mean and band too; the model line as drawn with `include_model`. Also the layers (one y axis each), the date range, reference and masks. At most 2000 values per series and 4000 in all (thinned, with a note). Read-only. | chart |
| `get_fit_results` | Per point series: the rate (or a rate per segment), mean rate and acceleration (quadratic, cubic), annual and semi-annual amplitude and peak day of year, each step's size at its date, the RMS of the residuals, each with a 1-sigma error; in mm and mm/yr (inches in imperial units). Read-only. | model summary |
| `set_fit` | `polynomial_order` (0–3), `annual`, `semiannual`, `steps` and `segments` (dates), `reject_outliers`; turns the model on and returns the fit results. Terms not given are kept. | Model card |
| `add_step`, `remove_step` | One step at a date; returns the step's size ± its error after the refit | Model card's Steps |
| `set_residuals` | The model's residuals on or off | residuals button |
| `list_points`, `rename_point`, `remove_point` | Points by id or name: id, name, lon, lat, colour, marker, line, shown. `remove_point` is destructive and the model is told to ask first. | Points panel |
| `set_point_style` | `color`, `marker` (circle, square, triangle, diamond, star, cross, none), `line` (solid, dashed, none), `size` (the chart's marker size, 1–12 px); the colour is the map marker's too | Style button |
| `list_areas`, `rename_area`, `set_area_style`, `set_area_band` | An area's colour, median line, line width (1, 1.5, 2, 3, 4 px), mean and band on or off, band opacity (0–0.8); the band of all areas (`std` or `p10p90`) | Style button, Band menu |
| `set_chart_layers` | The layers in the chart, each on its own y axis (`[]` follows the map's layer) | layer chips |
| `set_layer_display` | A layer's `offset`, `ymin`, `ymax` (in its axis unit) and `color`, or `reset` | Display options |
| `set_date_range` | `start` and `end` (YYYY-MM-DD), or `reset`; the model fits only these dates | Display options |
| `export_chart` | `csv` or `png`, saved by the user's browser | Export CSV, Save as PNG |
| `check_series` | Per series (or one `point`): likely steps with their size and the date a model step goes at (`step_date`), one-date outliers, and which of them are about 1–3 half radar wavelengths (an unwrapping error); gaps, thin months, scatter, trend against noise. Read-only. | — |

The fit is the chart's own least squares (src/map/fit.ts): a polynomial
(per segment when there are breaks), annual and semi-annual sines and cosines,
and a Heaviside step per date, over the date range shown. Each ± is the formal
1-sigma error from the covariance σ² (AᵀA)⁻¹, with σ² the residual variance;
the amplitude and peak day of a seasonal term are propagated from its sine and
cosine. They assume independent noise from date to date, so with correlated
noise (atmosphere, unmodelled seasonal effects) the real uncertainty is larger.

Step and segment dates must lie inside the series shown; a date between two
acquisitions gets a note with the nearest one (a step in a long gap takes all
the motion in that gap). Dates are checked as real YYYY-MM-DD dates before the
page sees them.

`check_series` uses the checks of the OPERA DISP Portal, tested on the same
real series (tests/data/series_checks_cases.json): a lasting jump is at least
10 mm and six times the date-to-date scatter between the medians of five dates
on each side; an outlier is a single date at least 10 mm and five scatters from
the three dates on each side, with both neighbours agreeing. A jump or outlier
within 20% of one to three half wavelengths is flagged as a possible
unwrapping error. The wavelength is the cube's (`radar_wavelength_m` of
`GET /datasets`, from attributes such as `wavelength_m`), else the sensor the
layers name (Sentinel-1 C band 5.55 cm, so 27.7 mm; NISAR L band 23.8 cm), else
the `wavelength_m` argument. The model is told to suggest `add_step` at a
flagged `step_date` and to ask the user before adding it.

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

## Context and infrastructure

The context tools answer "who and what is affected by motion in X?" the way the
instructions describe: `go_to` X, `deformation_zones` (look at the velocity's
spread with `layer_statistics` first to choose a threshold), then
`infrastructure_in_area` with a zone id, then `highlight_infrastructure` for
what the user asked about. Before reading a time series, `site_context` at the
point says what the ground is.

Zones are found on the server, on the cube itself: 4-connected cells whose
|rate| reaches the threshold (a zone never mixes motion towards and away from
the satellite), outlined along the cells' edges and simplified to half a cell.
The full server and bowser-lite run the same numpy code (scipy's labelling
when installed), so they give the same zones. Rates are relative to the
producer's reference unless `ref_lon`/`ref_lat` is given to the HTTP API. The
zones and the infrastructure found are kept on the server for four hours
(`GET /context/results/{id}`), so the page can draw them and later tools can
use a zone by its id.

The outside services are used through the Bowser server, as their operators
ask, with the same rules as the geocoder: a User-Agent naming Bowser (never a
person), requests spaced per service for the whole server, answers cached for a
day, attribution with the results, and a variable to point each service
elsewhere or turn it off (read on each request). A service that cannot be
reached, or is off, is reported as "could not be looked up", which is not the
same as nothing there.

| Service | Used for | Spacing | Variable |
| --- | --- | --- | --- |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (OpenStreetMap; `overpass-api.de`, then `overpass.private.coffee` when busy) | Infrastructure | 1 s, one request at a time; buildings only in areas whose box is up to 60 km², other kinds up to 2,500 km² | `BOWSER_OVERPASS_URL` (comma-separated list) |
| Sentinel-2 10 m land cover (Impact Observatory, Microsoft, Esri) | Land cover | 0.5 s | `BOWSER_LANDCOVER_URL` |
| [Macrostrat](https://macrostrat.org) | Geology | 0.5 s | `BOWSER_MACROSTRAT_URL` |
| USFWS National Wetlands Inventory | Wetlands (US) | 0.5 s | `BOWSER_WETLANDS_URL` |
| USDA NRCS Soil Data Access (SSURGO) | Soil (US) | 0.5 s | `BOWSER_SOILS_URL` |
| AWS Terrain Tiles (Terrarium) | Elevation and slope | none (static tiles) | `BOWSER_TERRAIN_URL` |

`BOWSER_CONTEXT_SERVICES=off` turns all of them off. `POST /infrastructure`,
`GET /site_context` and `GET /context/results/{id}` answer only where the
Assistant is on (`BOWSER_ASSISTANT`), as `GET /geocode`. Being in or near a
zone says nothing about the condition of any feature, and the tools tell the
model never to call a road, building or structure damaged or at risk.
