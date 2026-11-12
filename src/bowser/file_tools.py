"""Tools that read the user's own files on the server: GNSS series and rasters.

``load_gnss_csv`` and ``list_gnss_stations`` work on both servers (the GNSS file
reader is pure Python); ``convert_to_cog`` needs GDAL, so on bowser-lite it says
the full server is needed. Each calls the HTTP API the page uses (``POST
/gnss/custom``, ``GET /gnss/custom``, ``GET /gnss/stations``, ``POST /data``), so
a tool reads only what the page could: a path on the server only where the
server lets the page open files (``BOWSER_ALLOW_OPEN``). Registered by
:func:`bowser.tools.build_tools`, so ``bowser mcp`` and the Assistant offer them
alike.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import Field

if TYPE_CHECKING:
    from .tools import BowserAPI

#: Seconds convert_to_cog waits between looks at a conversion.
POLL_S = 0.5

ServerPath = Annotated[
    str,
    Field(
        min_length=1,
        max_length=4096,
        description="Path of the file on the computer the Bowser server runs on.",
    ),
]


def register_file_tools(tool: Callable, api: BowserAPI) -> None:
    """Add the file tools to a registry through its ``tool`` decorator."""
    from .tools import BowserError  # noqa: PLC0415

    @tool(read_only=False, status="Reading the GNSS file")
    async def load_gnss_csv(
        path: ServerPath,
        units: Annotated[
            Literal["auto", "m", "mm", "cm"],
            Field(
                description="Units of east, north and up. auto reads them from "
                "the header ('up (mm)', 'east_m') or a '# units: mm' line, else "
                "guesses from the size of the values and says so."
            ),
        ] = "auto",
        station: Annotated[
            str | None,
            Field(max_length=80, description="Station name, over the file's."),
        ] = None,
        lon: Annotated[
            float | None,
            Field(ge=-180, le=360, description="Station longitude, over the file's."),
        ] = None,
        lat: Annotated[
            float | None,
            Field(ge=-90, le=90, description="Station latitude, over the file's."),
        ] = None,
    ) -> dict[str, Any]:
        """Load a GNSS station time series from a CSV file on the server.

        Reads dates (ISO, YYYYMMDD, decimal year or MJD) and east, north and up
        displacements (m, mm or cm), with the station's name and lon/lat from
        columns or '# key: value' lines; also NGL .tenv3 and EarthScope position
        CSVs. Returns each station with its rows read and skipped, units (and
        where they came from), time span and a straight-line rate per component
        in mm/yr. The stations are kept for this server session and appear in
        the page's GNSS tab, on the map and in its GNSS-vs-InSAR comparison.
        Needs the server to allow opening files (BOWSER_ALLOW_OPEN, on for
        `bowser run` on your own computer).
        """
        body: dict[str, Any] = {"path": path, "units": units}
        body |= {
            k: v
            for k, v in (("station", station), ("lon", lon), ("lat", lat))
            if v is not None
        }
        res = await api.post("/gnss/custom", body)
        return {
            **res,
            "note": "Kept until the server stops. Rates are a least-squares line "
            "through the whole record (mm/yr), not MIDAS; east/north/up are mm "
            "from the first date. Open the page's GNSS tab to see the stations "
            "and compare them with InSAR along the line of sight.",
        }

    @tool(open_world=True, status="Listing the GNSS stations")
    async def list_gnss_stations(
        bbox: Annotated[
            list[float] | None,
            Field(
                min_length=4,
                max_length=4,
                description="[west, south, east, north] lon/lat: also list the "
                "public UNR stations in it (from the Nevada Geodetic Laboratory). "
                "Omit for the stations loaded from files only.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """List GNSS stations: those loaded from the user's files, and public ones.

        `custom` are the stations read with load_gnss_csv or the GNSS tab, with
        their rows, time span and straight-line rates (mm/yr). With a `bbox`,
        `unr` adds the public UNR stations in it, nearest the centre first, with
        MIDAS velocities (North America fixed, mm/yr).
        """
        custom = (await api.get("/gnss/custom"))["stations"]
        out: dict[str, Any] = {"custom": custom}
        if bbox is not None:
            west, south, east, north = bbox
            unr = await api.get(
                "/gnss/stations", west=west, south=south, east=east, north=north
            )
            out["unr"] = unr["stations"]
            out["unr_source"] = unr["source"]
        out["note"] = (
            "Custom rates are a straight line through the file's record; UNR rates "
            "are MIDAS, North America fixed."
            if custom or bbox is not None
            else "No stations loaded from files yet (load_gnss_csv); give a bbox "
            "to list public UNR stations."
        )
        return out

    @tool(read_only=False, status="Converting to a COG")
    async def convert_to_cog(
        path: Annotated[
            str,
            Field(
                min_length=1,
                max_length=4096,
                description="Path on the server's computer of a GeoTIFF or another "
                "raster GDAL reads.",
            ),
        ],
        wait_s: Annotated[
            float,
            Field(
                ge=0,
                le=3600,
                description="Seconds to wait for the conversion; it goes on in the "
                "background after, and calling again with the same path picks up "
                "its result.",
            ),
        ] = 600,
    ) -> dict[str, Any]:
        """Make a Cloud-Optimized GeoTIFF of a raster on the server (full server).

        A file that is already a COG is used as it is (`already_cog`); anything
        else is converted once, as Load file does, into the server's conversion
        cache (never next to the file), and a repeated call gives the cached
        COG. Returns the COG's path and size in bytes. Needs the server to allow
        opening files (BOWSER_ALLOW_OPEN) and GDAL: bowser-lite says it cannot.
        """
        config = await api.get("/config")
        if not config.get("geotiff_export"):
            raise BowserError(
                "This server cannot convert rasters (it is bowser-lite, which has "
                "no GDAL). Run the full server (`bowser run`) to make a COG."
            )
        job = await api.post("/data", {"path": path})
        if job.get("kind") != "raster":
            raise BowserError(
                f"{path} is a vector file, not a raster: convert_to_cog takes "
                "GeoTIFFs and other rasters."
            )
        deadline = time.monotonic() + wait_s
        while job.get("status") == "converting" and time.monotonic() < deadline:
            await asyncio.sleep(POLL_S)
            job = await api.get(f"/data/{job['id']}")
        if job.get("status") == "failed":
            raise BowserError(f"Could not convert {path}: {job.get('error')}")
        if job.get("status") != "ready":
            return {
                "source": path,
                "status": "converting",
                "elapsed_s": job.get("elapsed_s"),
                "note": "Still converting in the background; call convert_to_cog "
                "again with the same path for the result.",
            }
        already = job.get("converted") is False
        return {
            "source": path,
            "status": "ready",
            "output": job.get("cog"),
            "size_bytes": job.get("cog_bytes"),
            "already_cog": already,
            "band_count": job.get("band_count"),
            "bounds": job.get("bounds"),
            "note": "Already a COG: used as it is, nothing was written."
            if already
            else "Written to the server's conversion cache (kept while used; "
            "least recently used files are removed first).",
        }
