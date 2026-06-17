export interface LosMetadata {
  // Satellite ground-track heading, degrees clockwise from north
  heading_deg: number;
  // Center-swath incidence angle (degrees). Near/far give the swath extent.
  incidence_deg: number;
  incidence_deg_near?: number;
  incidence_deg_far?: number;
  // Ground -> satellite ENU unit vectors. Center is the main LOS; near/far
  // trace the swath and are optional.
  los_enu_ground_to_sat?: { east: number; north: number; up: number };
  los_enu_ground_to_sat_near?: { east: number; north: number; up: number };
  los_enu_ground_to_sat_far?: { east: number; north: number; up: number };
}

export interface RasterGroup {
  name: string;
  file_list: string[];
  mask_file_list: string[];
  mask_min_value: number;
  nodata: number | null;
  uses_spatial_ref: boolean;
  algorithm: string | null;
  latlon_bounds: [number, number, number, number];
  x_values: Array<number | string>;
  available_mask_vars: string[];
  label?: string;
  unit?: string;
  reference_date?: string | null;
  los_metadata?: LosMetadata;
}

export interface TimeSeriesPoint {
  id: string;
  name: string;
  position: [number, number]; // [lat, lng]
  color: string;
  visible: boolean;
  data?: { [dataset: string]: number[] };
  trendData?: { [dataset: string]: { slope: number; intercept: number; rSquared: number; mmPerYear: number } };
}

export interface MultiPointTimeSeriesData {
  labels: string[];
  datasets: {
    label: string;
    pointId: string;
    data: Array<{ x: string; y: number }>;
    borderColor: string;
    backgroundColor: string;
    trend?: {
      slope: number;
      intercept: number;
      rSquared: number;
      mmPerYear: number;
    };
  }[];
}

export interface MapAnnotation {
  id: string;
  position: [number, number];
  text: string;
  color: string;
  fontSize: number;
}

export interface BaseMapItem {
  url: string;
  attribution: string;
  label?: string;
}

export interface LayerMask {
  id: string;
  dataset: string;
  threshold: number;
  mode: 'min' | 'max';  // 'min' = keep pixels >= threshold; 'max' = keep pixels <= threshold
}

export interface ChartWindow {
  id: string;
  dsNames: string[];  // datasets shown in this window; empty = follow currentDataset
}

export interface AppState {
  datasetInfo: { [key: string]: RasterGroup };
  timeSeriesPoints: TimeSeriesPoint[];
  chartWindows: ChartWindow[];
  refMarkerPosition: [number, number];
  currentDataset: string;
  currentTimeIndex: number;
  refValues: { [key: string]: number[] };
  selectedBasemap: string;
  secondaryBasemap: string | null;
  basemapOpacity: number;
  secondaryBasemapOpacity: number;
  basemapSwapped: boolean;
  dataMode: string;
  colormap: string;
  vmin: number;
  vmax: number;
  opacity: number;
  showChart: boolean;
  selectedPointId: string | null;
  showTrends: boolean;
  showResiduals: boolean;
  layerMasks: LayerMask[];
  customMaskPath: string | null;
  bufferEnabled: boolean;
  bufferRadius: number;
  bufferSamples: number;
  refEnabled: boolean;
  refMarkerVisible: boolean;
  refBufferEnabled: boolean;
  refBufferRadius: number;
  showRefChart: boolean;
  markerSize: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  viewBounds: [number, number, number, number] | null; // [south, west, north, east]
  // Incremented each time the user explicitly applies bounds (sidebar Apply /
  // Dataset buttons). The map's flyTo effect watches this, not viewBounds
  // itself — otherwise moveend → SET_VIEW_BOUNDS → effect → setView forms a
  // loop whose setView re-centers on bounds.getCenter() (arithmetic midpoint
  // in lat), not the Mercator center, drifting the map toward the equator.
  viewBoundsApplySeq: number;
  showColorbar: boolean;
  showLosIndicator: boolean;
  graticuleMode: 'off' | 'plain' | 'zebra';
  wrapEnabled: boolean;
  wrapWavelength: number | null;
  wrapPeriod: number;
  complexMode: 'phase' | 'amplitude';
  pointPickingEnabled: boolean;
  annotationMode: boolean;
  annotations: MapAnnotation[];
  pixelInspectEnabled: boolean;
  splitScreen: boolean;
  splitDataset: string | null;
  splitPosition: number;
  splitColormap: string;
  splitVmin: number;
  splitVmax: number;
  splitOpacity: number;
  splitTimeIndex: number;
}

export type AppAction =
  | { type: 'SET_DATASETS'; payload: { [key: string]: RasterGroup } }
  | { type: 'ADD_TIME_SERIES_POINT'; payload: { position: [number, number]; name?: string } }
  | { type: 'REMOVE_TIME_SERIES_POINT'; payload: string }
  | { type: 'UPDATE_TIME_SERIES_POINT'; payload: { id: string; updates: Partial<TimeSeriesPoint> } }
  | { type: 'SET_POINT_DATA'; payload: { pointId: string; dataset: string; data: number[] } }
  | { type: 'SET_POINT_TREND_DATA'; payload: { pointId: string; dataset: string; trend: { slope: number; intercept: number; rSquared: number; mmPerYear: number } } }
  | { type: 'SET_REF_MARKER_POSITION'; payload: [number, number] }
  | { type: 'SET_CURRENT_DATASET'; payload: string }
  | { type: 'SET_TIME_INDEX'; payload: number }
  | { type: 'SET_REF_VALUES'; payload: { dataset: string; values: number[] } }
  | { type: 'SET_BASEMAP'; payload: string }
  | { type: 'SET_SECONDARY_BASEMAP'; payload: string | null }
  | { type: 'SET_BASEMAP_OPACITY'; payload: number }
  | { type: 'SET_SECONDARY_BASEMAP_OPACITY'; payload: number }
  | { type: 'TOGGLE_BASEMAP_SWAP' }
  | { type: 'SET_DATA_MODE'; payload: string }
  | { type: 'SET_COLORMAP'; payload: string }
  | { type: 'SET_VMIN'; payload: number }
  | { type: 'SET_VMAX'; payload: number }
  | { type: 'SET_OPACITY'; payload: number }
  | { type: 'TOGGLE_CHART' }
  | { type: 'SET_SELECTED_POINT'; payload: string | null }
  | { type: 'TOGGLE_TRENDS' }
  | { type: 'TOGGLE_RESIDUALS' }
  | { type: 'ADD_LAYER_MASK'; payload: LayerMask }
  | { type: 'REMOVE_LAYER_MASK'; payload: string }
  | { type: 'UPDATE_LAYER_MASK'; payload: { id: string; updates: Partial<LayerMask> } }
  | { type: 'SET_CUSTOM_MASK_PATH'; payload: string | null }
  | { type: 'TOGGLE_BUFFER' }
  | { type: 'SET_BUFFER_RADIUS'; payload: number }
  | { type: 'SET_BUFFER_SAMPLES'; payload: number }
  | { type: 'TOGGLE_REF_ENABLED' }
  | { type: 'TOGGLE_REF_MARKER_VISIBLE' }
  | { type: 'TOGGLE_REF_BUFFER' }
  | { type: 'SET_REF_BUFFER_RADIUS'; payload: number }
  | { type: 'TOGGLE_REF_CHART' }
  | { type: 'SET_MARKER_SIZE'; payload: number }
  | { type: 'SET_DATE_RANGE_START'; payload: string | null }
  | { type: 'SET_DATE_RANGE_END'; payload: string | null }
  | { type: 'SET_VIEW_BOUNDS'; payload: [number, number, number, number] | null }
  | { type: 'APPLY_VIEW_BOUNDS'; payload: [number, number, number, number] }
  | { type: 'TOGGLE_COLORBAR' }
  | { type: 'TOGGLE_LOS_INDICATOR' }
  | { type: 'CYCLE_GRATICULE' }
  | { type: 'TOGGLE_WRAP' }
  | { type: 'SET_WRAP_WAVELENGTH'; payload: number | null }
  | { type: 'SET_WRAP_PERIOD'; payload: number }
  | { type: 'SET_COMPLEX_MODE'; payload: 'phase' | 'amplitude' }
  | { type: 'TOGGLE_POINT_PICKING' }
  | { type: 'TOGGLE_ANNOTATION_MODE' }
  | { type: 'ADD_ANNOTATION'; payload: MapAnnotation }
  | { type: 'REMOVE_ANNOTATION'; payload: string }
  | { type: 'UPDATE_ANNOTATION'; payload: { id: string; updates: Partial<Omit<MapAnnotation, 'id' | 'position'>> } }
  | { type: 'ADD_CHART_WINDOW'; payload: ChartWindow }
  | { type: 'REMOVE_CHART_WINDOW'; payload: string }
  | { type: 'SET_CHART_WINDOW_DS'; payload: { id: string; dsNames: string[] } }
  | { type: 'TOGGLE_PIXEL_INSPECT' }
  | { type: 'TOGGLE_SPLIT_SCREEN' }
  | { type: 'SET_SPLIT_DATASET'; payload: string | null }
  | { type: 'SET_SPLIT_POSITION'; payload: number }
  | { type: 'SET_SPLIT_COLORMAP'; payload: string }
  | { type: 'SET_SPLIT_VMIN'; payload: number }
  | { type: 'SET_SPLIT_VMAX'; payload: number }
  | { type: 'SET_SPLIT_OPACITY'; payload: number }
  | { type: 'SET_SPLIT_TIME_INDEX'; payload: number };

// Backward compatibility
export type LegacyAppAction = { type: 'SET_TS_MARKER_POSITION'; payload: [number, number] };
