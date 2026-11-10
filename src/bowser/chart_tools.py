"""The chart tools: what an AI assistant can read and change in the time-series chart.

Read exactly what the chart shows and the fitted model's terms with their errors,
fit a model and add steps as the chart's Model card does, rename and restyle the
points and areas, choose the chart's layers, Display options and date range,
export it, and check a series for steps, outliers and unwrapping errors.

They are page tools: each runs on the user's open page (src/assistant/chartTools.ts),
through the Assistant's answer or the page channel (``bowser mcp``). Defined once
here and registered by :func:`bowser.tools.build_tools`, so the MCP server and the
Assistant offer them alike. Arguments are checked here (dates, styles, ranges)
before the page sees them; the page checks what needs the data (a date inside the
series, a point's name).
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

#: The chart tools ``bowser mcp`` sends through the page channel.
CHART_COMMANDS = frozenset(
    {
        "get_chart_data",
        "get_fit_results",
        "set_fit",
        "add_step",
        "remove_step",
        "set_residuals",
        "list_points",
        "rename_point",
        "remove_point",
        "set_point_style",
        "list_areas",
        "rename_area",
        "set_area_style",
        "set_area_band",
        "set_chart_layers",
        "set_layer_display",
        "set_date_range",
        "export_chart",
        "check_series",
    }
)

#: What the model is told about the chart tools (part of bowser.tools.INSTRUCTIONS).
CHART_INSTRUCTIONS = """\
The chart tools act on the page's time-series chart:
- To fit a model or add a step, use set_fit and add_step (remove_step to undo);
  they return the fitted terms. Read numbers with get_chart_data (the values as
  drawn) and get_fit_results (rates, seasonal terms and step sizes, each with its
  1-sigma error) instead of fetching the series again with the data tools.
- Run check_series before suggesting a step: it flags likely steps, outliers and
  jumps of about half the radar wavelength (unwrapping errors). Suggest add_step
  at a flagged date and ask the user before adding it.
- Points and areas: list_points, rename_point, set_point_style, remove_point (ask
  first); list_areas, rename_area, set_area_style, set_area_band. The chart's
  view: set_chart_layers, set_layer_display, set_date_range, set_residuals,
  export_chart.
"""


def _real_date(value: str) -> str:
    """Refuse a date that does not exist (2021-02-30)."""
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{value!r} is not a date (YYYY-MM-DD).") from None
    return value


def _area_width(value: float | None) -> float | None:
    """Refuse a width the Style button does not offer."""
    if value is not None and value not in AREA_WIDTHS:
        raise ValueError("width is 1, 1.5, 2, 3 or 4 (px).")
    return value


#: The area line widths the chart's Style button offers (src/map/seriesStyle.ts).
AREA_WIDTHS = (1, 1.5, 2, 3, 4)

IsoDate = Annotated[
    str,
    Field(pattern=r"^\d{4}-\d{2}-\d{2}$", description="A date, YYYY-MM-DD."),
    AfterValidator(_real_date),
]
ModelDates = Annotated[list[IsoDate], Field(max_length=20)]
PointRef = Annotated[
    str,
    Field(
        min_length=1,
        max_length=80,
        description="The point's id or name (see list_points).",
    ),
]
AreaRef = Annotated[
    str, Field(min_length=1, max_length=80, description="The area's id or name.")
]
NewName = Annotated[
    str, Field(min_length=1, max_length=60, description="The new name.")
]
Color = Annotated[
    str | None,
    Field(
        pattern=r"^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[a-z]+)$",
        description="#rrggbb, or red, green, blue, orange, purple, black, white, "
        "gray, yellow, cyan, magenta, pink, brown or teal.",
    ),
]
LineStyle = Literal["solid", "dashed", "none"]
MarkerShape = Literal[
    "circle", "square", "triangle", "diamond", "star", "cross", "none"
]
ChartLayer = Annotated[
    str,
    Field(
        min_length=1, max_length=120, description="A layer with dates (list_layers)."
    ),
]
AxisValue = Annotated[
    float | None,
    Field(
        description="In the axis unit (as Display options; metres for a layer in m)."
    ),
]

PageTool = Callable[..., Any]
OnPage = Callable[..., Awaitable[dict[str, Any]]]


def register_chart_tools(page_tool: PageTool, on_page: OnPage) -> None:
    """Register the chart tools with ``build_tools``' ``page_tool`` decorator.

    Parameters
    ----------
    page_tool : callable
        ``build_tools``' decorator for a page tool (``read_only`` makes it quiet).
    on_page : callable
        Runs a page tool on the open page: ``await on_page(name, **args)``.

    """
    # --- reading the chart --------------------------------------------------------

    @page_tool(read_only=True)
    async def get_chart_data(
        include_model: Annotated[
            bool,
            Field(description="Also return the model line as drawn (when shown)."),
        ] = False,
    ) -> dict[str, Any]:
        """Return what the time-series chart shows now, exactly as drawn.

        For each series (point x layer, area x layer): name, layer, unit, the
        dates and values as drawn (relative to the reference point and date
        shown, with the masks, date range and units applied), and the model line
        with include_model. Also the layers (one y axis each, with offset, y
        limits and colour), the date range shown, the reference and the masks.
        At most 2000 values per series (4000 in all); longer series are thinned,
        and the result says so. Opens the chart if it is closed. Use it instead
        of fetching the series again with the data tools.
        """
        return await on_page("get_chart_data", include_model=include_model)

    @page_tool(read_only=True)
    async def get_fit_results() -> dict[str, Any]:
        """Return the chart's fitted model for each point series, with errors.

        Per series: the model's terms (rate, or a rate per segment; mean rate and
        acceleration for a quadratic or cubic), the annual and semi-annual
        amplitude and peak day of year, each step's size at its date, and the
        RMS of the residuals, each value with a 1-sigma error (the least-squares
        covariance scaled by the residuals, as the chart's own fit). Lengths in
        mm and rates in mm/yr (inches in imperial units). Areas are not fitted.
        """
        return await on_page("get_fit_results")

    # --- the model ----------------------------------------------------------------

    @page_tool
    async def set_fit(
        polynomial_order: Annotated[
            Literal[0, 1, 2, 3] | None,
            Field(description="0 offset, 1 linear trend, 2 quadratic, 3 cubic."),
        ] = None,
        annual: Annotated[bool | None, Field(description="An annual cycle.")] = None,
        semiannual: Annotated[
            bool | None, Field(description="A semi-annual cycle.")
        ] = None,
        steps: Annotated[
            ModelDates | None,
            Field(description="Dates of offsets (jumps); replaces the model's steps."),
        ] = None,
        segments: Annotated[
            ModelDates | None,
            Field(
                description="Dates where the polynomial breaks into separately "
                "fitted segments (a rate each); replaces the model's breaks."
            ),
        ] = None,
        reject_outliers: Annotated[
            bool | None,
            Field(description="Iteratively leave out dates beyond 3 robust sigma."),
        ] = None,
    ) -> dict[str, Any]:
        """Set the chart's model, as its Model card does, turn it on and refit.

        Terms not given keep their setting. Step and segment dates must lie
        inside the series shown; a date between acquisitions gets a note with
        the nearest acquisition (a step in a long gap takes all motion in it).
        Returns the fit results (as get_fit_results).
        """
        return await on_page(
            "set_fit",
            polynomial_order=polynomial_order,
            annual=annual,
            semiannual=semiannual,
            steps=steps,
            segments=segments,
            reject_outliers=reject_outliers,
        )

    @page_tool
    async def add_step(date: IsoDate) -> dict[str, Any]:
        """Add a step (offset) to the chart's model at a date and refit.

        Turns the model on if it is off. Returns the step's size in each series
        (with its 1-sigma error) and the fit results. Ask the user before adding
        a step they did not ask for (for example one check_series flagged).
        """
        return await on_page("add_step", date=date)

    @page_tool
    async def remove_step(date: IsoDate) -> dict[str, Any]:
        """Remove the model's step at a date and refit; returns the fit results."""
        return await on_page("remove_step", date=date)

    @page_tool
    async def set_residuals(
        on: Annotated[bool, Field(description="Show the model's residuals.")],
    ) -> dict[str, Any]:
        """Show or hide the model's residuals in the chart (on turns the model on)."""
        return await on_page("set_residuals", on=on)

    # --- points and areas ---------------------------------------------------------

    @page_tool(read_only=True)
    async def list_points() -> dict[str, Any]:
        """List the chart's points: id, name, lon, lat, colour, marker, line, shown."""
        return await on_page("list_points")

    @page_tool
    async def rename_point(point: PointRef, name: NewName) -> dict[str, Any]:
        """Rename a point (by id or name), as the Points panel does."""
        return await on_page("rename_point", point=point, name=name)

    @page_tool
    async def remove_point(point: PointRef) -> dict[str, Any]:
        """Remove a point from the map and chart. Destructive: ask the user first."""
        return await on_page("remove_point", point=point)

    @page_tool
    async def set_point_style(
        point: PointRef,
        color: Color = None,
        marker: Annotated[
            MarkerShape | None, Field(description="Marker shape.")
        ] = None,
        line: Annotated[
            LineStyle | None, Field(description="The line joining the dates.")
        ] = None,
        size: Annotated[
            int | None,
            Field(
                ge=1,
                le=12,
                description="Marker size, px; the chart has one size for all points.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Style a point as the chart's Style button does: colour, marker, line, size.

        The colour is the point's colour on the map too.
        """
        return await on_page(
            "set_point_style",
            point=point,
            color=color,
            marker=marker,
            line=line,
            size=size,
        )

    @page_tool(read_only=True)
    async def list_areas() -> dict[str, Any]:
        """List the chart's areas with their style, and the band drawn around them."""
        return await on_page("list_areas")

    @page_tool
    async def rename_area(area: AreaRef, name: NewName) -> dict[str, Any]:
        """Rename a chart area (by id or name), as the Points panel's area rows do."""
        return await on_page("rename_area", area=area, name=name)

    @page_tool
    async def set_area_style(
        area: AreaRef,
        color: Color = None,
        median_line: Annotated[
            LineStyle | None, Field(description="The median's line.")
        ] = None,
        width: Annotated[
            float | None,
            Field(description="Median and mean line width: 1, 1.5, 2, 3 or 4 px."),
            AfterValidator(_area_width),
        ] = None,
        show_mean: Annotated[bool | None, Field(description="The dashed mean.")] = None,
        show_band: Annotated[bool | None, Field(description="The band.")] = None,
        band_opacity: Annotated[
            float | None, Field(ge=0, le=0.8, description="Band fill opacity.")
        ] = None,
    ) -> dict[str, Any]:
        """Style a chart area as the Style button does (colour also on the map)."""
        return await on_page(
            "set_area_style",
            area=area,
            color=color,
            median_line=median_line,
            width=width,
            show_mean=show_mean,
            show_band=show_band,
            band_opacity=band_opacity,
        )

    @page_tool
    async def set_area_band(
        band: Annotated[
            Literal["std", "p10p90"],
            Field(description="std: mean ± 1 std; p10p90: the 10th-90th percentiles."),
        ],
    ) -> dict[str, Any]:
        """Choose the band drawn around every area's series."""
        return await on_page("set_area_band", band=band)

    # --- the chart's view ---------------------------------------------------------

    @page_tool
    async def set_chart_layers(
        layers: Annotated[
            list[ChartLayer],
            Field(
                max_length=6,
                description="Layers with dates; [] follows the map's layer.",
            ),
        ],
    ) -> dict[str, Any]:
        """Choose the chart's layers; each gets its own y axis."""
        return await on_page("set_chart_layers", layers=layers)

    @page_tool
    async def set_layer_display(
        layer: ChartLayer,
        offset: Annotated[
            float | None,
            Field(description="Shift of the layer's y axis, in its unit."),
        ] = None,
        ymin: AxisValue = None,
        ymax: AxisValue = None,
        color: Color = None,
        reset: Annotated[
            bool, Field(description="Back to no offset, auto limits, own colours.")
        ] = False,
    ) -> dict[str, Any]:
        """Set a chart layer's Display options: offset, y limits and colour."""
        return await on_page(
            "set_layer_display",
            layer=layer,
            offset=offset,
            ymin=ymin,
            ymax=ymax,
            color=color,
            reset=reset or None,
        )

    @page_tool
    async def set_date_range(
        start: Annotated[IsoDate | None, Field(description="First date shown.")] = None,
        end: Annotated[IsoDate | None, Field(description="Last date shown.")] = None,
        reset: Annotated[bool, Field(description="Show all dates again.")] = False,
    ) -> dict[str, Any]:
        """Set the chart's date range (Display options); the model fits only it."""
        if start and end and start > end:
            # tools imports this module, so not at the top.
            from .tools import BowserError  # noqa: PLC0415

            raise BowserError(f"start ({start}) must be before end ({end}).")
        return await on_page(
            "set_date_range", start=start, end=end, reset=reset or None
        )

    @page_tool
    async def export_chart(
        format: Annotated[  # noqa: A002  (the argument's name, as the model sees it)
            Literal["csv", "png"], Field(description="csv: the values; png: the image.")
        ],
    ) -> dict[str, Any]:
        """Download the chart as the Export CSV or Save as PNG button does.

        The file is saved by the user's browser.
        """
        return await on_page("export_chart", format=format)

    # --- checks -------------------------------------------------------------------

    @page_tool(read_only=True)
    async def check_series(
        point: Annotated[
            str | None,
            Field(max_length=80, description="One point (id or name); omit for all."),
        ] = None,
        wavelength_m: Annotated[
            float | None,
            Field(
                ge=0.005,
                le=1,
                description="Radar wavelength, m; omit to take the cube's.",
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Check the chart's series for likely steps, outliers and unwrapping errors.

        Per series: the dates and sizes (mm) of lasting jumps, with the date a
        model step would go at (step_date); single-date outliers; and which of
        them are about half the radar wavelength or a multiple (about 28 mm for
        Sentinel-1), the size an unwrapping error leaves. Also gaps, thin months,
        the scatter and how the trend compares with it. These are flags, not
        findings: suggest add_step at a flagged step_date and ask the user before
        adding it.
        """
        return await on_page("check_series", point=point, wavelength_m=wavelength_m)
