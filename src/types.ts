import type { FitSettings } from './map/fitSettings';
import type { IdentifyResult } from './map/identify';
import type { GnssStation } from './map/gnss';
import type { UnitSystem } from './utils/units';
import type { AreaStyle, LineStyle, MarkerShape } from './map/seriesStyle';
import type { PointMarker } from './map/markers';
import type { AreaBand, PolygonTimeSeries } from './utils/polygonSeries';

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
  /** Conservative native chart radius budget; GeoTIFF layers only. */
  chart_buffer_max_m?: number;
  name: string;
  // COG mode: one file (and optional mask file) per time step.
  file_list?: string[];
  mask_file_list?: string[];
  // MD mode: steps along the layer's non-spatial dim (1 for a 2D layer).
  n_time_steps?: number;
  mask_min_value: number;
  nodata: number | null;
  uses_spatial_ref: boolean;
  algorithm: string | null;
  latlon_bounds: [number, number, number, number];
  x_values: Array<number | string>;
  available_mask_vars: string[];
  label?: string;
  unit?: string;
  description?: string;
  description_source?: 'bowser' | 'source' | 'unknown';
  // Bowser's general text when the producer's own description leads (absent otherwise).
  guidance?: string;
  source_description?: string | null;
  source_flags?: Array<{ value: string; label: string }>;
  unit_status?: 'provided' | 'missing' | 'mixed';
  metadata_notes?: string[];
  reference_date?: string | null;
  los_metadata?: LosMetadata;
  // Shared backend measurement metadata is independent of reference support.
  measurement?: {
    kind: string;
    positive_direction: string | null;
  };
  // Default spatial reference point [lon, lat] recorded in the cube (DISP-S1
  // reference_point / tifs-to-geozarr --reference-point). Seeds the moving
  // reference marker; null when the cube carries none.
  reference_lonlat?: [number, number] | null;
  // The radar wavelength (m) when the cube records it: unwrapping errors are multiples of half of it.
  radar_wavelength_m?: number | null;
}

export interface TimeSeriesPoint {
  id: string;
  name: string;
  position: [number, number]; // [lat, lng]
  color: string;
  visible: boolean;
  /** How it is drawn in the chart (default circle markers joined by a line). */
  marker?: MarkerShape;
  line?: LineStyle;
  data?: { [dataset: string]: number[] };
  /** The vector layer feature it came from (Zonal stats); absent for a point clicked on the map. */
  source?: { overlayId: string; layer: string; index: number };
  // mmPerYear is in rateUnit/yr (mm in metric, in in imperial); the name is kept for saved projects.
  trendData?: { [dataset: string]: { slope: number; intercept: number; rSquared: number; mmPerYear: number; stdMmPerYear?: number; rateUnit?: string } };
}

/** A polygon summarised in the chart (POST /polygon_timeseries): median, mean and a band. */
export interface ChartArea extends Partial<AreaStyle> {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  /** GeoJSON Polygon or MultiPolygon in WGS84. */
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  /** The vector layer feature it came from; absent for an area drawn on the map. */
  source?: { overlayId: string; layer: string; index: number };
}

/** One area's statistics for one layer: waiting, the answer, or why there is none. */
export interface AreaStats {
  /** Identifies the request allowed to fill this cache entry. Not persisted. */
  requestId?: number;
  pending?: boolean;
  data?: PolygonTimeSeries;
  error?: string;
}

export interface MultiPointTimeSeriesData {
  warnings?: string[];
  labels: string[];
  datasets: {
    label: string;
    pointId: string;
    data: Array<{ x: string; y: number }>;
    borderColor: string;
    backgroundColor: string;
    // Point coordinates in the dataset's native CRS (e.g. UTM easting/northing);
    // null when the cube is geographic or the transform is unavailable.
    x?: number | null;
    y?: number | null;
    trend?: {
      slope: number;
      intercept: number;
      rSquared: number;
      mmPerYear: number;
      stdMmPerYear?: number;
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
  /** Deepest zoom the provider really serves; past it the map upscales these tiles.
   *  Unset: DEFAULT_BASEMAP_NATIVE_ZOOM (map/basemapStyle.ts). */
  maxNativeZoom?: number;
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

export interface OverlayBand {
  name: string;
  min: number;
  max: number;
  p2: number;
  p98: number;
  p5?: number;
  p95?: number;
}

export interface OverlayFeatures {
  type: 'FeatureCollection';
  features: unknown[];
}

/**
 * A GeoTIFF overlay used as an elevation model: drawn as hillshade and/or colour relief
 * (the relief's colormap and range are the overlay's cmap/vmin/vmax). See map/dem.ts.
 */
export interface OverlayDem {
  style: 'hillshade' | 'relief' | 'both';
  exaggeration: number;  // vertical exaggeration of the hillshade
  terrain?: boolean;     // also the 3D terrain (MapLibre)
  base?: number;         // a low height of the DEM (2nd percentile), for ground with no other terrain
}

/**
 * A file added through the server (POST /data) while the server makes it ready to draw:
 * a raster as a COG, a large vector as PMTiles, a small one as GeoJSON. Not drawn until
 * ``status`` is ready. See map/addData.ts.
 */
export interface OverlayConversion {
  status: 'converting' | 'ready' | 'failed';
  format: 'cog' | 'pmtiles' | 'geojson';
  id?: string;           // conversion id, for GET /data/{id}
  elapsedS?: number;     // seconds the conversion has run
  error?: string;
}

// A user overlay: an uploaded GeoTIFF (tiled by our /overlay titiler), an external
// WMS/WMTS service, vector features read in the browser, or an OpenFreeMap context layer. Stacking order is the
// index in AppState.overlays (first = bottom); aboveData is which side of the data
// layer it is drawn on (see overlayRows, MapLibre only).
export interface Overlay {
  id: string;
  name: string;
  type: 'geotiff' | 'wms' | 'wmts' | 'vector' | 'context' | 'pmtiles';
  visible: boolean;
  opacity: number;       // 0..1
  side?: 'left' | 'right' | 'both';  // which half to show in split-screen (default both)
  aboveData?: boolean;
  bounds?: [number, number, number, number] | null;  // WGS84 [west, south, east, north]

  // --- geotiff ---
  path?: string;         // server path of the GeoTIFF (a COG once added through POST /data)
  bandCount?: number;
  bands?: OverlayBand[];
  mode?: 'rgb' | 'cmap'; // rgb for multi-band, cmap for single-band
  cmap?: string;         // colormap_name (continuous cmap mode)
  vmin?: number;
  vmax?: number;
  // Discrete/categorical binning (single-band): split [vmin,vmax] into `nbins`
  // equal classes, each drawn with its own color (titiler interval colormap).
  discrete?: boolean;
  nbins?: number;
  binColors?: string[];  // hex per bin, length === nbins
  dem?: OverlayDem;      // drawn as an elevation model (hillshade / colour relief)
  conversion?: OverlayConversion;  // added through the server: converting, ready or failed
  featureCount?: number; // a vector converted on the server: how many features it has

  // --- external (wms / wmts / xyz) ---
  url?: string;          // WMS base URL, or WMTS/XYZ tile template with {z}/{x}/{y}
  wmsLayers?: string;    // WMS LAYERS parameter
  maxNativeZoom?: number; // highest zoom the service has tiles for; upsample past it

  // --- vector ---
  data?: OverlayFeatures;
  color?: string;
  lineWidth?: number;
  pointRadius?: number;
  marker?: PointMarker;  // point shape (circle unless set)

  // --- context (OpenFreeMap roads, buildings, boundaries) ---
  contextKey?: 'roads' | 'buildings' | 'boundaries';
  scale?: number;  // line width or building height multiplier

  // --- fixed-style tiles (land cover) ---
  landCoverYear?: number;
  legend?: [string, string][];  // [label, color]
  attribution?: string;
  serviceKey?: string;  // which Services entry added it (geology, soils)

  // --- pmtiles (a custom archive; url is the archive) ---
  pmtilesKind?: 'raster' | 'vector';
  sourceLayers?: string[];
  minzoom?: number;
  // vector colour by an attribute: text classes, or numeric classes split at `breaks`
  classColors?: { property: string; classes: [string, string][]; breaks?: number[]; other?: string };
  soilField?: string;  // soils: the attribute it is coloured by
  maxClasses?: number;
}

/** One stable reference-point candidate from GET /reference_candidates. */
export interface RefCandidate {
  rank: number;
  lon: number;
  lat: number;
  /** The circle the candidate was judged on: the reference buffer to use with it. */
  radius_m: number;
  temporal_coherence_median: number | null;
  phase_similarity_median: number | null;
  viable_fraction: number | null;
  /** Spread through time of the circle's pixels about their median, in metres. */
  displacement_scatter_m: number | null;
  velocity: number | null;
  score: number | null;
  reason: string;
}

export interface AppState {
  datasetInfo: { [key: string]: RasterGroup };
  timeSeriesPoints: TimeSeriesPoint[];
  chartAreas: ChartArea[];
  /** Area statistics per layer and area, keyed areaStatsKey(dataset, areaId). */
  areaStats: { [key: string]: AreaStats };
  /** Invalidates native summaries when masks, sources or geometries change. */
  areaStatsRevision: number;
  /** The band around each area in the chart: mean ± 1 std or p10–p90. */
  areaBand: AreaBand;
  /** The side panel's tab (Main, Overlays, Stats, GNSS, Project). */
  panelTab: string;
  /** True while the chart's "+ Area" waits for a polygon drawn on the map. */
  areaDrawing: boolean;
  /** The Draw tools were off before "+ Area" opened them: close them again once it is done. */
  areaOpenedTools: boolean;
  chartWindows: ChartWindow[];
  refMarkerPosition: [number, number];
  currentDataset: string;
  currentTimeIndex: number;
  /** True while the time stepper plays through the dates (the histogram waits until it stops). */
  playing: boolean;
  refValues: { [key: string]: number[] };
  /** Per layer: the time step it is shown relative to (Main › Layers › ref); absent = as stored. */
  refTimeIndex: { [dataset: string]: number };
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
  overlays: Overlay[];
  overlayMessage: string | null;
  drawingEnabled: boolean;
  fitSettings: FitSettings;
  identifyEnabled: boolean;
  identify: IdentifyResult | null;
  gnssChartStation: GnssStation | null;
  units: UnitSystem;
  /** The date on the map: off, the badge with its controls, or the date alone (clicking the panel's date cycles). */
  dateBadge: 'off' | 'full' | 'date';
  bufferEnabled: boolean;
  bufferRadius: number;
  bufferSamples: number;
  refEnabled: boolean;
  refMarkerVisible: boolean;
  refBufferEnabled: boolean;
  refBufferRadius: number;
  /** Stable reference candidates shown on the map and in Main › Reference Point. */
  refCandidates: RefCandidate[];
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
  | { type: 'ADD_TIME_SERIES_POINT'; payload: { position: [number, number]; name?: string; source?: TimeSeriesPoint['source'] } }
  | { type: 'REMOVE_TIME_SERIES_POINT'; payload: string }
  | { type: 'UPDATE_TIME_SERIES_POINT'; payload: { id: string; updates: Partial<TimeSeriesPoint> } }
  | { type: 'ADD_CHART_AREA'; payload: { geometry: ChartArea['geometry']; name?: string; source?: ChartArea['source'] } }
  | { type: 'ADD_CHART_AREAS'; payload: Array<Pick<ChartArea, 'id' | 'name' | 'geometry' | 'source'>> }
  | { type: 'SET_PANEL_TAB'; payload: string }
  | { type: 'SET_AREA_BAND'; payload: AreaBand }
  | { type: 'SET_AREA_STATS'; payload: { [key: string]: AreaStats } }
  | { type: 'START_AREA_STATS'; payload: { revision: number; entries: Record<string, AreaStats> } }
  | { type: 'FINISH_AREA_STATS'; payload: { revision: number; entries: Record<string, AreaStats> } }
  | { type: 'REMOVE_CHART_AREA'; payload: string }
  | { type: 'UPDATE_CHART_AREA'; payload: { id: string; updates: Partial<ChartArea> } }
  | { type: 'SET_AREA_DRAWING'; payload: boolean }
  | { type: 'SET_POINT_DATA'; payload: { pointId: string; dataset: string; data: number[] } }
  | { type: 'SET_POINT_TREND_DATA'; payload: { pointId: string; dataset: string; trend: { slope: number; intercept: number; rSquared: number; mmPerYear: number; stdMmPerYear?: number; rateUnit?: string } } }
  | { type: 'LOAD_PROJECT'; payload: Partial<AppState> }
  | { type: 'SET_REF_MARKER_POSITION'; payload: [number, number] }
  | { type: 'SET_CURRENT_DATASET'; payload: string }
  | { type: 'SET_TIME_INDEX'; payload: number }
  | { type: 'SET_PLAYING'; payload: boolean }
  | { type: 'SET_REF_VALUES'; payload: { dataset: string; values: number[] } }
  | { type: 'SET_REF_TIME_INDEX'; payload: { dataset: string; index: number | null } }
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
  | { type: 'ADD_OVERLAY'; payload: Overlay }
  | { type: 'REMOVE_OVERLAY'; payload: string }
  | { type: 'UPDATE_OVERLAY'; payload: { id: string; updates: Partial<Overlay> } }
  | { type: 'SET_OVERLAYS'; payload: Overlay[] }
  | { type: 'MOVE_OVERLAY_TO_BOTTOM'; payload: string }
  | { type: 'SET_OVERLAY_MESSAGE'; payload: string | null }
  | { type: 'SET_DRAWING_ENABLED'; payload: boolean }
  | { type: 'SET_FIT_SETTINGS'; payload: Partial<FitSettings> }
  | { type: 'TOGGLE_IDENTIFY' }
  | { type: 'SET_UNITS'; payload: UnitSystem }
  | { type: 'TOGGLE_DATE_BADGE' }
  | { type: 'SET_IDENTIFY'; payload: IdentifyResult | null }
  | { type: 'OPEN_GNSS_CHART'; payload: GnssStation | null }
  | { type: 'SET_DRAWINGS'; payload: OverlayFeatures }
  | { type: 'RENAME_DRAWING'; payload: { index: number; name: string } }
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
  | { type: 'SET_REF_BUFFER_ENABLED'; payload: boolean }
  | { type: 'SET_REF_CANDIDATES'; payload: RefCandidate[] }
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
