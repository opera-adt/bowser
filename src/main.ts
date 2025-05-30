import './style.css'
import Chart from 'chart.js/auto';
import * as L from "leaflet";
import { BaseMapItem, baseMaps } from "./basemap"
import { mousePosition } from './mouse';

interface State {
  datasetInfo: { [key: string]: RasterGroup };
  markerTs: L.Marker;
  markerRef: L.Marker;
  // Current variable name to display
  name: string;
  // Current time index for the variable
  tileIdx: number;
  tile: L.TileLayer | null;
  // The shifts from the reference point for all time indices
  refValues: { [key: string]: number[] };
  // Background tiles
  basemap: BaseMapItem
}

interface RasterGroup {
  name: string;
  file_list: string[];
  mask_file_list: string[];
  mask_min_value: number;
  nodata: number | null;
  uses_spatial_ref: boolean;
  algorithm: string | null;
  latlon_bounds: [number, number, number, number];
  x_values: Array<number | string>;
}

var map = L.map('map', {
  doubleClickZoom: false,
})

mousePosition().addTo(map);

const fontAwesomeIcon = L.divIcon({
  html: '<i class="fa-solid fa-location-dot fa-3x"></i>',
  iconSize: [20, 20],
  className: 'myDivIcon'
});

var state: State = {
  datasetInfo: {},
  markerTs: L.marker([0, -0.], { draggable: true, title: 'Time Series Point' }),
  markerRef: L.marker([0, -0.], { icon: fontAwesomeIcon, draggable: true, title: 'Reference Location' }),
  name: 'displacement', // Default to displacement variable
  tile: null,
  tileIdx: 0,
  refValues: {},
  basemap: baseMaps.esriSatellite,
};

const curUsesRef = () => state.datasetInfo[state.name].uses_spatial_ref

// Add the satellite layer
let baseMapTile = L.tileLayer(state.basemap.url, {
  maxZoom: 19,
  attribution: state.basemap.attribution
})
baseMapTile.addTo(map);

// Basemap selector setup (unchanged)
const basemapSelector = document.getElementById('basemap-selector') as HTMLInputElement
basemapSelector.addEventListener('change', (event) => {
  const target = (event.target as HTMLSelectElement)
  const newUrl = target.value
  const newBasemapName: string = target.options[target.selectedIndex].innerText
  const newBasemap = baseMaps[newBasemapName]

  map.attributionControl.removeAttribution(state.basemap.attribution)
  state.basemap = newBasemap
  baseMapTile.setUrl(newUrl)
  map.attributionControl.addAttribution(state.basemap.attribution)
})

// Add basemap options
for (const [name, basemap] of Object.entries(baseMaps)) {
  const option = document.createElement('option');
  option.textContent = name;
  option.value = basemap.url;
  basemapSelector.appendChild(option);
}

map.on('click', function (e) {
  console.log('click', e.latlng)
  let lat = e.latlng.lat
  let lon = e.latlng.lng
  state.markerTs.setLatLng([lat, lon])
  chartContainer.style.display !== 'none' && updateChart()
});

const setRefValues = (datasetName: string) => {
  const { lat, lng } = state.markerRef.getLatLng()
  console.log('shifting', lat, lng)
  getPointTimeSeries(lng, lat, datasetName)
    .then((values) => {
      console.log('getPointTimeSeries', values)
      if (values !== undefined) {
        state.refValues[datasetName] = values
        curUsesRef() && updateRasterTile()
      }
    }, (error) => {
      console.log('setRefValues error:', error)
    })
}

// Marker event handlers
state.markerTs.on('moveend', function () {
  console.log('moveend', state.markerTs.getLatLng())
  chartContainer.style.display !== 'none' && updateChart()
});

state.markerRef.on('moveend', function () {
  chartContainer.style.display !== 'none' && updateChart()
  setRefValues(state.name)
});

// Popup for coordinates
const showLatLngPopup = (event: L.LeafletMouseEvent) => {
  const { lat, lng } = event.latlng
  L.popup()
    .setLatLng(event.latlng)
    .setContent(`Marker (lon, lat):\n(${lng.toFixed(6)}, ${lat.toFixed(6)})`)
    .addTo(map)
}
state.markerRef.addEventListener('click', showLatLngPopup)
state.markerTs.addEventListener('click', showLatLngPopup)

// UI elements
const cmapNameSelect = document.getElementById('colormap-selector') as HTMLInputElement
const colormapImg = document.getElementById('colormap-img') as HTMLImageElement
const vminSelect = document.getElementById('vmin') as HTMLInputElement
const vmaxSelect = document.getElementById('vmax') as HTMLInputElement

// Preference management (unchanged)
const loadPreferences = (name: string) => {
  const colormap_name = localStorage.getItem(`${name}-colormap_name`)
  const vmin = localStorage.getItem(`${name}-vmin`)
  const vmax = localStorage.getItem(`${name}-vmax`)
  if (vmin === null || vmax === null || colormap_name === null) {
    return { colormap_name: null, vmin: null, vmax: null };
  }

  cmapNameSelect.value = colormap_name;
  colormapImg.src = `/colorbar/${colormap_name}`
  vminSelect.value = vmin
  vmaxSelect.value = vmax
  return { colormap_name: colormap_name, vmin: parseFloat(vmin), vmax: parseFloat(vmax) }
}

const savePreferences = (name: string) => {
  const vmin = parseFloat(vminSelect.value);
  const vmax = parseFloat(vmaxSelect.value);
  const colormap_name = cmapNameSelect.value;
  localStorage.setItem(`${name}-colormap_name`, colormap_name)
  localStorage.setItem(`${name}-vmin`, vmin.toString())
  localStorage.setItem(`${name}-vmax`, vmax.toString())
}

// Updated raster tile function for Xarray
const updateRasterTile = () => {
  const { name, tileIdx } = state
  const curDataset = state.datasetInfo[name];

  let { colormap_name, vmin, vmax } = loadPreferences(name)
  if (colormap_name === null) colormap_name = cmapNameSelect.value;
  if (vmin === null) vmin = parseFloat(vminSelect.value);
  if (vmax === null) vmax = parseFloat(vmaxSelect.value);
  setChartYLimits(vmin, vmax)

  colormapImg.src = `/colorbar/${colormap_name}`

  // Ensure tileIdx is within bounds
  const maxIdx = curDataset.x_values.length - 1
  const curTileIdx = Math.max(0, Math.min(tileIdx, maxIdx))
  state.tileIdx = curTileIdx

  // Build parameters for Xarray tiler using standard titiler pattern
  let params: { [key: string]: string } = {
    variable: name,
    time_idx: curTileIdx.toString(),
    rescale: `${vmin},${vmax}`,
    colormap_name: colormap_name,
  }

  // Add algorithm if needed
  if (curDataset.algorithm !== null) {
    params.algorithm = curDataset.algorithm
  }

  // Add shift for reference point if available
  if (state.refValues[name] !== undefined && curDataset.algorithm === 'shift') {
    const shift = state.refValues[name][curTileIdx]
    if (shift !== undefined) {
      params.algorithm_params = JSON.stringify({ "shift": shift })
    }
  }
  // TODO: make the mask a dropdown as well? with a slider for the level
  // const maskUrl = curDataset.mask_file_list[curTileIdx];
  // const maskMinValue = curDataset.mask_min_value;
  // if (maskUrl !== undefined) params.mask = encodeURIComponent(maskUrl)
  // if (maskMinValue !== undefined) params.mask_min_value = maskMinValue.toString()

  const url_params = Object.keys(params).map(i => `${i}=${encodeURIComponent(params[i])}`).join('&')
  console.log('Standard titiler url_params', url_params)

  // Use the standard WebMercatorQuad endpoint
  fetch(`/WebMercatorQuad/tilejson.json?${url_params}`)
    .then(response => response.json())
    .then((tileInfo) => {
      // Create new tile layer
      let newTile = L.tileLayer(tileInfo.tiles[0], {
        maxZoom: 19,
      })
      if (state.tile !== null) {
        map.removeLayer(state.tile)
      }
      newTile.addTo(map)
      state.tile = newTile
    })
    .catch(error => {
      console.error('Error in getting standard titiler tile info:', error)
    });
}

// Dataset selector
const datasetSelector = document.getElementById('dataset-selector') as HTMLSelectElement;
datasetSelector.addEventListener('change', (event: Event) => {
  savePreferences(state.name)
  const datasetName = (event.target as HTMLSelectElement).value;
  console.log('Changing variable to:', datasetName)
  setupDataset(datasetName)
  loadPreferences(datasetName);
});

// Layer slider for time dimension
const layerSlider = document.getElementById('layer-slider') as HTMLInputElement;
const layerSliderText = document.getElementById('layer-slider-value') as HTMLSpanElement;

layerSlider.addEventListener('input', (event: Event) => {
  const { name } = state
  const target = event.target as HTMLInputElement;
  let newIdx: number = parseInt(target.value);

  // Update display text with time value
  const timeValue = state.datasetInfo[name].x_values[newIdx];
  layerSliderText.textContent = timeValue.toString();
})

layerSlider.addEventListener('change', (event: Event) => {
  const { name } = state
  const target = event.target as HTMLInputElement;
  let newIdx: number = parseInt(target.value);
  state.tileIdx = newIdx;
  state.name = name;
  updateRasterTile()
})

// Colormap and scale controls
cmapNameSelect.addEventListener('change', () => { savePreferences(state.name); updateRasterTile() })
vminSelect.addEventListener('change', () => { savePreferences(state.name); updateRasterTile() })
vmaxSelect.addEventListener('change', () => { savePreferences(state.name); updateRasterTile() })

// Opacity slider
const opacitySlider = document.getElementById('opacity-slider') as HTMLInputElement
const opacitySliderText = document.getElementById('opacity-slider-value') as HTMLSpanElement
opacitySlider.addEventListener('input', (event: Event) => {
  const opacity = (event.target as HTMLInputElement).value
  opacitySliderText.textContent = opacity
  if (state.tile !== null) {
    state.tile.setOpacity(parseFloat(opacity))
  }
});

const setupDataset = (name: string) => {
  const curDataset = state.datasetInfo[name]

  // Set up the time slider
  layerSlider.max = (curDataset.x_values.length - 1).toString()
  layerSliderText.textContent = curDataset.x_values[0].toString();

  state.name = name;

  if (curDataset.uses_spatial_ref && state.refValues[name] === undefined) {
    setRefValues(name)
  }

  updateRasterTile();
}

const computeCenter = (name: string) => {
  const curDataset = state.datasetInfo[name]
  let bounds = curDataset.latlon_bounds;
  const centerLat = (bounds[1] + bounds[3]) / 2;
  const centerLng = (bounds[0] + bounds[2]) / 2;
  return { centerLat: centerLat, centerLng: centerLng }
}

// Initialize datasets from new endpoint
const initializeDatasets = () => {
  fetch('/datasets')
    .then(response => response.json())
    .then((data) => {
      state.datasetInfo = data;
      console.log('datasetInfo', state.datasetInfo);

      // Use first available variable
      const name0: string = Object.keys(state.datasetInfo)[0];

      // Set the view
      const { centerLat, centerLng } = computeCenter(name0)
      map.setView([centerLat, centerLng], 9);
      for (let marker of [state.markerTs, state.markerRef]) {
        marker.setLatLng([centerLat, centerLng])
      }

      setupDataset(name0);

      // Update dropdown with variables
      datasetSelector.innerHTML = '';
      Object.keys(state.datasetInfo).forEach((varName) => {
        const option = document.createElement('option');
        option.value = varName;
        option.textContent = varName;
        datasetSelector.appendChild(option);
      });
    })
}

// Chart setup (mostly unchanged)
const chartElem = document.querySelector<HTMLCanvasElement>('#chart')!
const chartContainer = document.querySelector<HTMLCanvasElement>('#chart-container')!
const hideChartBtn = document.querySelector<HTMLButtonElement>("#hide-chart")!;

var chart = new Chart(chartElem, {
  options: {
    animation: false,
    plugins: {
      legend: { display: false }
    },
    scales: { y: {} },
    // scales: { xAxes: [{ type: 'time' }], yAxes: [{ type: 'linear' }] }
  },
  type: 'line',
  data: { datasets: [] }
})

function setChartYLimits(min: number, max: number) {
  const scales = chart.options.scales || {}
  const yAxis = scales.y || {}
  yAxis.suggestedMin = min
  yAxis.suggestedMax = max
  chart.update()
}

async function getPointTimeSeries(lon: number, lat: number, name: string) {
  const params: { [key: string]: any } = {
    dataset_name: name,
    lon: lon,
    lat: lat,
  }
  const url_params = Object.keys(params).map(i => `${i}=${params[i]}`).join('&')
  const endpoint = `/point?${url_params}`
  console.log(endpoint)

  try {
    const response = await fetch(endpoint);
    return await response.json();
  } catch (error) {
    console.log(error);
    return undefined;
  }
}

async function getChartTimeSeries(lon: number, lat: number, ref_lon: number | null = null, ref_lat: number | null = null) {
  let params: { [key: string]: any } = {
    lon: lon,
    lat: lat,
    dataset_name: state.name,
  }
  if (ref_lon !== null && ref_lat !== null) {
    params.ref_lat = ref_lat
    params.ref_lon = ref_lon
  }

  const url_params = Object.keys(params).map(i => `${i}=${params[i]}`).join('&')
  const endpoint = `/chart_point?${url_params}`
  console.log(endpoint)

  try {
    const response = await fetch(endpoint);
    return await response.json();
  } catch (error) {
    console.log(error);
    return undefined;
  }
}

function updateChart() {
  const { lat, lng } = state.markerTs.getLatLng();
  let tsPromise

  if (curUsesRef()) {
    const refLatlng = state.markerRef.getLatLng();
    tsPromise = getChartTimeSeries(lng, lat, refLatlng.lng, refLatlng.lat)
  } else {
    tsPromise = getChartTimeSeries(lng, lat)
  }

  tsPromise.then((data) => {
    if (data) {
      chart.data = data
      chart.update()
    }
  })
}

// Chart visibility controls
state.markerRef.addTo(map);
hideChartBtn.addEventListener('click', () => {
  if (chartContainer.style.display !== 'none') {
    chartContainer.style.display = 'none';
    hideChartBtn.textContent = 'Show time series';
    state.markerTs.remove();
  } else {
    chartContainer.style.display = 'block';
    hideChartBtn.textContent = 'Hide time series';
    state.markerTs.addTo(map);
  }
});

// Initialize the application
console.log('Initializing Xarray-based app...')
initializeDatasets();
console.log('datasets loaded?', state.datasetInfo);
