# GNSS stations

The GNSS tab compares GNSS stations with the InSAR cube. Two kinds of station
show there and on the map:

- **Open-source GNSS stations** (*Find stations in this view*): public stations
  from UNR, the Nevada Geodetic Laboratory (University of Nevada, Reno), with
  MIDAS velocities and daily positions in the North America fixed frame (`GET /gnss/stations`, `GET /gnss/series/{station}`).
- **Load local GNSS file** (*Load GNSS files…*): station time series from your own
  CSV files, drawn as amber squares (*GNSS station (your file)* in the legend).

Choosing a station shows its rates and its record projected on the cube's line
of sight next to the InSAR series at the station, both starting at 0 on the
first InSAR date; *Use as reference point* moves the InSAR reference onto it.
With the identify (pointer) tool, clicking a station opens its east, north, up
and LOS charts. Your stations work the same way as UNR's; their rates are a
least-squares line through the file's record (labelled *linear fit*), not MIDAS.

Both servers read GNSS files (the reader is pure Python, so bowser-lite and the
desktop app do too).

## Loading your files

- **From your computer**: *Load GNSS files…* picks one or more files; the page
  sends their text to the server (`POST /gnss/custom` with `text`). Always
  allowed.
- **By a path on the server**: where the server lets the page open files
  (`BOWSER_ALLOW_OPEN`, on for `bowser run` on your own computer), a path box
  appears under the button. The `load_gnss_csv` tool of the
  [MCP server and the Assistant](mcp.md) reads a path the same way, and is
  refused (HTTP 403) where the page could not.

*Units* (auto, m, mm, cm) applies to the next files loaded. After loading, the
tab says what each file gave, for example
`custom_station.csv: DEMO, 22 rows (1 skipped) in mm, 2025-11-01 – 2026-03-28`,
and any warning (units guessed, no horizontal components). A file with nothing
usable gives a message saying why.

The stations are kept by the server until it stops (at most 200; loading a
station with the same name again replaces it), so they survive a page reload
and a station loaded by the Assistant or an MCP client appears when the GNSS
tab opens. The cross next to a station forgets it. They are not saved
elsewhere: load the file again after restarting the server. A server run with
several workers keeps them in the worker that read the file, like cubes opened
from the page.

## The file format

One station per file (or several, with a station column). Lines starting with
`#`, `%` or `//` are comments; blank lines are ignored.

```text
# station: DEMO
# lon: -117.67462
# lat: 33.95859
date,east (mm),north (mm),up (mm),sig_e (mm),sig_n (mm),sig_u (mm)
2025-11-01,0.0,0.3,0.0,0.8,0.9,2.5
2025-11-08,0.39,0.13,0.62,0.8,0.9,2.5
```

**Example files** to copy, in [docs/examples/gnss/](examples/gnss/):

| File | Shows |
| --- | --- |
| [one_station.csv](examples/gnss/one_station.csv) | The recommended layout: one station, its name and location in `#` lines, ISO dates, millimetres with 1-sigma columns. |
| [several_stations.csv](examples/gnss/several_stations.csv) | Several stations in one table, with station, lon and lat columns; decimal years; metres. |
| [minimal.csv](examples/gnss/minimal.csv) | The minimum: no header row (date, east, north, up), units from a `# units:` line. |

Each loads with no skipped rows (a test checks it).

**Columns.** A header row names them, in any order and case; the delimiter is a
comma, semicolon, tab or spaces.

| What | Header names (examples) |
| --- | --- |
| Date (required) | `date`, `time`, `datetime`, `epoch`, `decimal_year`, `yyyy.yyyy`, `mjd` |
| East, north, up (up required) | `east`, `e`, `dE`, `delta E`; `north`, `n`, `dN`; `up`, `u`, `dU`, `vertical`, `height` |
| Sigmas (optional) | `sig_e`, `sigma_north`, `std_u`, `East Std. Deviation`, `se`, `sn`, `su` |
| Station (optional) | `station`, `site`, `name`, `id` |
| Location (optional) | `lon`/`longitude`, `lat`/`latitude` |

Without a header row, the columns are date, east, north, up and, when there are
seven, their sigmas. Other columns (correlations, quality flags) are ignored.

**Dates.** Each value is read as an ISO date (`2021-03-04`, with or without a
time, or `2021/03/04`), `YYYYMMDD`, UNR's `21MAR04`, a decimal year
(`2021.1712`; the day's start or middle) or a Modified Julian Day (`59277`).
Dates must fall in 1980–2100. Rows are sorted by date.

**Displacements.** East, north and up in metres, millimetres or centimetres.
Absolute positions work too: only the changes from the first date are used, so
each component starts at 0. The units come from, in order:

1. the *Units* choice (or the tool's `units`), when not auto;
2. the header: `east (mm)`, `up [m]`, `up_mm`, `e_cm`;
3. a `# units: mm` line;
4. otherwise a guess: millimetres when a component changes by more than 3,
   else metres. The tab and the tool say the units were guessed.

A file with only an up column is read with east and north at 0, and says that
the line of sight then uses the vertical only.

**Station and location.** From the station, lon and lat columns, or from
`key: value` (or `key = value`) lines before the data: `station`, `site`, `id`
or `name`; `lon`/`longitude`; `lat`/`latitude`; also `units` and `frame`.
Without a station name the file's name is used (`ABCD.csv` gives `ABCD`).
Longitudes from 0 to 360 are turned to -180 to 180. A file without a location
is refused: add lon and lat columns or `# lon:` and `# lat:` lines.

**Bad rows.** A row without a readable date, or whose east, north or up is not
a number (empty, `n/a`, `nan`), is skipped and counted. Fewer than two usable
rows is an error.

### Other formats read as they are

- **NGL `.tenv3`** (the files behind UNR's series): positions in metres,
  station and location from the file.
- **EarthScope (UNAVCO) position CSV**: the header lines give the station
  (`4-character ID:`), its name, location (`Reference position : 41.38 North
  Latitude, -112.27 East Longitude`) and frame; columns such as `North (mm)`
  and `Vertical Std. Deviation (mm)`.

Files up to 50 MB are read (thirty years of daily rows are a few MB).

## HTTP API

| Route | What it does |
| --- | --- |
| `POST /gnss/custom` | Read a file: `{"text": ..., "name": ...}` or `{"path": ...}`, with optional `units` (`auto`, `m`, `mm`, `cm`), `station`, `lon` and `lat` over the file's. Returns `file`, `rows`, `skipped` and each station's summary. 400 for a file with nothing usable, 403 for a path when `BOWSER_ALLOW_OPEN` is off. |
| `GET /gnss/custom` | The stations loaded in this session. |
| `GET /gnss/custom/{station_id}` | A station's `dates` and `east_mm`, `north_mm`, `up_mm` from its first date (and `sigma_*_mm`), shaped as `GET /gnss/series/{station}`. |
| `DELETE /gnss/custom/{station_id}` | Forget a station. |

Each station's summary has `id`, `name`, `lon`, `lat`, `first_date`,
`last_date`, `first`/`last` (decimal years), `ve_mm_yr`, `vn_mm_yr`,
`vu_mm_yr`, `sigma_vu_mm_yr` (the formal 1-sigma of the up rate, which assumes
white noise and so understates the real uncertainty), `rows`, `skipped`,
`units`, `units_from` (`header`, `file`, `option` or `guessed`),
`date_format`, `components`, `source`, `frame` and `warnings`.

The full response models are in the server's OpenAPI description (`/api`).
