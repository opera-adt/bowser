from __future__ import annotations

import logging
import os
import threading

import ipywidgets as widgets
import pandas as pd
import requests

## MODIFIED: Use CircleMarker for better styling and import specific bqplot items
from bqplot import Axis, DateScale, Figure, LinearScale, Lines, Scatter
from ipyleaflet import (
    DivIcon,
    LayersControl,
    Map,
    Marker,
    ScaleControl,
    TileLayer,
    basemaps,
)
from IPython.display import display
from titiler.core.models.mapbox import TileJSON

from ._server import BowserServer

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# (Constants like DEFAULT_VMIN, CMAPS, etc. remain unchanged)
DEFAULT_VMIN = -0.2
DEFAULT_VMAX = 0.2
DEFAULT_CMAP = "rdbu_r"
CMAPS = ["rdbu_r", "viridis", "plasma", "magma", "inferno", "jet", "gray"]


def make_bowser_widget(
    dataset_name: str | None = None,
    bowser_url: str = "http://localhost:8000",
    **server_kwargs,
) -> widgets.VBox:
    """Create a Jupyter widget with dataset, colormap, rescale and opacity controls."""
    os.environ["TQDM_DISABLE"] = "1"
    # Ensure a server is available (this part is unchanged)
    server = None
    try:
        requests.get(f"{bowser_url}/mode", timeout=2)
    except requests.exceptions.RequestException:
        logger.info("Starting Bowser server...")
        server = BowserServer(**server_kwargs)
        server.start()
        bowser_url = server.url

    try:
        mode = requests.get(f"{bowser_url}/mode").json()["mode"]
        datasets = requests.get(f"{bowser_url}/datasets").json()
        if not datasets:
            raise RuntimeError("Bowser returned no datasets.")
        if dataset_name is None:
            dataset_name = list(datasets.keys())[0]
        if dataset_name not in datasets:
            raise ValueError(f"Dataset '{dataset_name}' not found.")

        # --- controls (unchanged) ---
        dataset_dd = widgets.Dropdown(
            options=list(datasets.keys()), value=dataset_name, description="Layer:"
        )
        cmap_dd = widgets.Dropdown(
            options=CMAPS, value=DEFAULT_CMAP, description="Colormap:"
        )
        vmin_ft = widgets.FloatText(value=DEFAULT_VMIN, step=0.01, description="vmin:")
        vmax_ft = widgets.FloatText(value=DEFAULT_VMAX, step=0.01, description="vmax:")
        opacity_sl = widgets.FloatSlider(
            value=1.0, min=0.0, max=1.0, step=0.01, description="Opacity:"
        )
        idx_sl = widgets.IntSlider(description="Index:", continuous_update=False)
        left_controls = widgets.VBox(
            [dataset_dd, vmin_ft, vmax_ft, cmap_dd, opacity_sl, idx_sl]
        )

        title = widgets.HTML(value="")
        m = Map(center=[0, 0], zoom=2, basemap=basemaps.Esri.WorldImagery)
        m.add_control(ScaleControl(position="bottomleft"))
        m.add_control(LayersControl(position="topright"))
        cur_layer: TileLayer | None = None
        ## Cache for reference point time series data
        ref_values_cache: dict[str, dict] = {}
        # --- Markers: use Marker + DivIcon for consistent draggable behavior ---
        marker_html = (
            "<div style="
            "width:14px;height:14px;border-radius:50%;"
            "background:{color};border:2px solid white;"
            'box-shadow:0 0 2px rgba(0,0,0,.6)"></div>'
        )
        ts_icon = DivIcon(
            html=marker_html.format(color="royalblue"),
            icon_size=[14, 14],
            icon_anchor=[7, 7],
        )
        ref_icon = DivIcon(
            html=marker_html.format(color="black"),
            icon_size=[14, 14],
            icon_anchor=[7, 7],
        )
        ts_marker = Marker(
            location=m.center, draggable=True, name="Time Series Point", icon=ts_icon
        )
        ref_marker = Marker(
            location=m.center, draggable=True, name="Reference Point", icon=ref_icon
        )
        m.add_layer(ts_marker)

        ## bqplot figure (unchanged from previous version)
        plot_output = widgets.Output()
        fig_title = "Time Series (click map to select point)"
        x_sc, y_sc = DateScale(), LinearScale()
        line = Lines(x=[], y=[], scales={"x": x_sc, "y": y_sc}, colors=["steelblue"])
        current_time_marker = Scatter(
            x=[],
            y=[],
            scales={"x": x_sc, "y": y_sc},
            colors=["red"],
            default_size=100,  # Makes the marker dot bigger
        )
        x_ax = Axis(scale=x_sc, label="Date")
        y_ax = Axis(scale=y_sc, orientation="vertical", label="Value")
        fig = Figure(
            marks=[line, current_time_marker], axes=[x_ax, y_ax], title=fig_title
        )

        def fit_to_layer(_=None):
            # (Function unchanged)
            info = datasets[dataset_dd.value]
            b = info.get("latlon_bounds")
            if b:
                m.fit_bounds([[b[1], b[0]], [b[3], b[2]]])
                center = [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]
                ts_marker.location = ref_marker.location = center

        def set_dataset_controls(name: str):
            # (Function mostly unchanged, just added plot clearing)
            info = datasets[name]
            idx_sl.min, idx_sl.max = 0, max(0, len(info["x_values"]) - 1)
            idx_sl.value = min(idx_sl.value, idx_sl.max)
            title.value = f"<h2>{info['x_values'][idx_sl.value]}</h2>"
            if info.get("uses_spatial_ref"):
                if ref_marker not in m.layers:
                    m.add_layer(ref_marker)
            else:
                if ref_marker in m.layers:
                    m.remove_layer(ref_marker)
            plot_output.clear_output()

        def build_params(name: str, idx: int) -> tuple[str, dict]:
            info = datasets[name]
            params = {
                "rescale": f"{vmin_ft.value},{vmax_ft.value}",
                "colormap_name": cmap_dd.value,
            }
            ## ADDED: Inject algorithm_params for shift when reference is used
            if info.get("algorithm") == "shift" and name in ref_values_cache:
                ref_ts = ref_values_cache[name]
                if idx < len(ref_ts):
                    shift_val = ref_ts[idx]
                    if shift_val is not None and pd.notna(shift_val):
                        params["algorithm_params"] = f'{{"shift": {shift_val}}}'

            if mode == "md":
                params.update({"variable": name, "time_idx": idx})
                endpoint = "md/WebMercatorQuad/tilejson.json"
            else:
                params.update({"url": info["file_list"][idx]})
                endpoint = "cog/WebMercatorQuad/tilejson.json"
            return endpoint, params

        def refresh_tile(*_):
            nonlocal cur_layer
            name, idx = dataset_dd.value, idx_sl.value
            title.value = f"<h2>{datasets[name]['x_values'][idx]}</h2>"
            endpoint, params = build_params(name, idx)
            r = requests.get(f"{bowser_url}/{endpoint}", params=params)
            r.raise_for_status()
            tj = TileJSON(**r.json())
            new_layer = TileLayer(url=tj.tiles[0], opacity=opacity_sl.value)
            if cur_layer:
                m.remove_layer(cur_layer)
            cur_layer = new_layer
            m.add_layer(cur_layer)

        ## Function to fetch ref data AND THEN refresh the tile layer
        # Simple debounce to avoid hammering the server while dragging
        _ref_debounce_handle: dict[str, threading.Timer | None] = {"pending": None}

        def _do_fetch_ref_and_refresh(*_):
            name = dataset_dd.value
            if not datasets[name].get("uses_spatial_ref"):
                return
            lat, lon = ref_marker.location
            params = {"dataset_name": name, "lon": lon, "lat": lat}
            try:
                r = requests.get(f"{bowser_url}/point", params=params)
                r.raise_for_status()
                ref_values_cache[name] = r.json()
                logger.info(f"Updated reference values for {name}")
            except requests.RequestException as e:
                logger.error(f"Failed to fetch reference values: {e}")
                ref_values_cache.pop(name, None)
            refresh_tile()  # Refresh the map with the new shift value

        def fetch_ref_and_refresh(*_):
            # debounce ~150ms on drag
            if _ref_debounce_handle["pending"] is not None:
                _ref_debounce_handle["pending"].cancel()
            t = threading.Timer(0.15, _do_fetch_ref_and_refresh)
            _ref_debounce_handle["pending"] = t
            t.start()

        def update_plot_marker(data, *_):
            if data and "_" in data[0]["x"]:
                x_dates = pd.to_datetime([d["x"].split("_")[1] for d in data])
            else:
                x_dates = pd.to_datetime([d["x"] for d in data])
            line.x = x_dates

            line.y = y_values = [d["y"] for d in data]
            idx = idx_sl.value
            # Check if the line has data and the index is valid
            if len(line.x) > idx:
                current_time_marker.x = [line.x[idx]]
                current_time_marker.y = [line.y[idx]]
            else:
                # Hide the marker if there's no data
                current_time_marker.x = []
                current_time_marker.y = []
            return x_dates, y_values

        def update_chart(*_):
            name = dataset_dd.value
            lat, lon = ts_marker.location
            params = {"dataset_name": name, "lon": lon, "lat": lat}
            if datasets[name].get("uses_spatial_ref") and ref_marker in m.layers:
                params["ref_lat"], params["ref_lon"] = ref_marker.location
            try:
                r = requests.get(f"{bowser_url}/chart_point", params=params)
                r.raise_for_status()
                data = r.json()["datasets"][0]["data"]
                if not data:
                    line.x, line.y = [], []
                    fig.title = f"No data for point ({lat:.4f}, {lon:.4f})"
                else:
                    if data and "_" in data[0]["x"]:
                        x_dates = pd.to_datetime([d["x"].split("_")[1] for d in data])
                    else:
                        x_dates = pd.to_datetime([d["x"] for d in data])
                    ## Make y-axis limits dynamic
                    x_dates, y_values = update_plot_marker(data)
                    y_min, y_max = min(y_values), max(y_values)
                    y_sc.min = min(y_min, vmin_ft.value)
                    y_sc.max = max(y_max, vmax_ft.value)
                    fig.title = f"Time Series at ({lat:.4f}, {lon:.4f})"
                with plot_output:
                    plot_output.clear_output(wait=True)
                    display(fig)
            except (requests.RequestException, IndexError) as e:
                logger.error(f"Failed to fetch chart data: {e}")

        def on_map_click(**event):
            if event["type"] == "click":
                ts_marker.location = event["coordinates"]
                update_chart()

        ## handler for dataset changes to manage fetching reference data
        def on_dataset_change(_):
            name = dataset_dd.value
            set_dataset_controls(name)
            if datasets[name].get("uses_spatial_ref"):
                # immediate (non-debounced) fetch on dataset switch for first frame
                _do_fetch_ref_and_refresh()
            else:
                refresh_tile()

        # wiring
        dataset_dd.observe(on_dataset_change, names="value")
        idx_sl.observe(lambda _: (refresh_tile(), update_chart()), names="value")
        cmap_dd.observe(refresh_tile, names="value")
        vmin_ft.observe(lambda _: (refresh_tile(), update_chart()), names="value")
        vmax_ft.observe(lambda _: (refresh_tile(), update_chart()), names="value")
        opacity_sl.observe(
            lambda c: setattr(cur_layer, "opacity", c["new"]) if cur_layer else None,
            names="value",
        )

        m.on_interaction(on_map_click)
        # Dragging either marker updates the outputs:
        ts_marker.observe(update_chart, names="location")  # live chart follow
        ref_marker.observe(
            fetch_ref_and_refresh, names="location"
        )  # re-shift map on drag

        # init
        fit_to_layer()
        on_dataset_change(None)  # Initial load

        # layout
        container = widgets.GridBox(
            children=[left_controls, m],
            layout=widgets.Layout(
                width="100%",
                height="55vh",
                grid_template_columns="25em 1fr",
                grid_template_areas='"menu map"',
                align_items="stretch",
            ),
        )

        # In the figure definition, set a proportional height
        fig = Figure(
            marks=[line, current_time_marker],
            axes=[x_ax, y_ax],
            title=fig_title,
            layout={"height": "35vh", "width": "95%"},
        )
        ui = widgets.VBox([title, container, plot_output])
        return ui

    except Exception as e:
        if server:
            server.stop()
        raise e
