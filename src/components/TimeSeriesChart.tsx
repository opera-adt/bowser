import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDraggableResizable } from '../hooks/useDraggableResizable.tsx';
import { Chart as ChartJS, TimeScale, LinearScale, CategoryScale, PointElement, LineElement, Title, Tooltip, Legend, Filler, InteractionItem } from 'chart.js';
import { Line } from 'react-chartjs-2';
import 'chartjs-adapter-date-fns';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { MultiPointTimeSeriesData } from '../types';
import { downloadChartAsPng } from '../utils/screenshot';
import { addChartLayer, chartLayerFor, timeSeriesLayers } from '../utils/chartLayers';
import { LayerOptions } from './panel/controls';
import ModelCard, { type PickKind } from './ModelCard';
import SeriesStylePopover from './SeriesStylePopover';
import { seriesStyle } from '../map/seriesStyle';
import { describeFit, fitSeries, modelCurve, modelLabel, rSquared } from '../map/fitSettings';
import type { FitResult } from '../map/fit';
import { displayUnit } from '../utils/units';
import { saveFile } from '../utils/saveFile';
import { activeRefTime, refDateLabel, refDateMarker, relativeChartData, relativeTo } from '../utils/refDate';
import ChartAreaButton from './ChartAreaButton';
import { AREA_BAND_LABELS, areaChartDatasets, areaStatsKey, type AreaBand } from '../utils/polygonSeries';
import { useAreaReference } from '../hooks/useAreaReference';
import { useAreaStatsFetch } from '../hooks/useAreaStatsFetch';
import { readChartDisplayOpen, saveChartDisplayOpen } from '../utils/chartDisplayPref';
import { refIndexOf, toIsoDate } from '../utils/areaStats';
import { registerChart, type ChartSnapshot, type LayerDisplay, type SeriesTag } from '../assistant/chartView';

// Chart.js plugin to wire legend-click visibility to all related datasets (raw, trend,
// residual, samples, median) that share the same base label.
const linkedLegendPlugin = {
  id: 'linkedLegend',
  afterInit(chart: ChartJS) {
    if ((chart as any)._linkedLegendPatched) return;
    (chart as any)._linkedLegendPatched = true;
    const origClick = (chart.options.plugins?.legend as any)?.onClick;
    (chart.options.plugins!.legend as any).onClick = function(
      e: any, legendItem: any, legend: any
    ) {
      // Run default toggle on the clicked dataset first
      if (origClick) origClick.call(this, e, legendItem, legend);
      else ChartJS.defaults.plugins.legend.onClick.call(this, e, legendItem, legend);

      // Then sync visibility of all datasets that share the same base label
      const clickedDs = chart.data.datasets[legendItem.datasetIndex];
      if (!clickedDs) return;
      const baseLabel = (clickedDs as any)._baseLabel as string | undefined;
      if (!baseLabel) return;
      const hidden = !chart.isDatasetVisible(legendItem.datasetIndex);
      chart.data.datasets.forEach((ds: any, i: number) => {
        if (i === legendItem.datasetIndex) return;
        if (ds._baseLabel === baseLabel) {
          const meta = chart.getDatasetMeta(i);
          meta.hidden = hidden;
        }
      });
      chart.update();
    };
  },
};

ChartJS.register(linkedLegendPlugin);

ChartJS.register(TimeScale, LinearScale, CategoryScale, PointElement, LineElement, Title, Tooltip, Legend, Filler, zoomPlugin);

/** Read a CSS variable from the document root at call time. */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Returns a counter that increments whenever data-theme attribute changes on <html>. */
function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setV(n => n + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return v;
}

/** Which part of an area a dataset of areaChartDatasets draws. */
function areaRole(d: Record<string, unknown>): SeriesTag['role'] {
  const label = String(d.label ?? '');
  if (d.fill === '+1') return 'band_upper';
  if (label.endsWith(' median')) return 'area_median';
  if (label.endsWith(' mean')) return 'area_mean';
  return 'band_lower';
}

interface BufferResult {
  labels: string[];
  median: Array<{ x: string; y: number }>;
  samples: Array<Array<{ x: string; y: number }>>;
  n_pixels: number;
}

export default function TimeSeriesChart({ windowId }: { windowId: string }) {
  const { state, dispatch } = useAppContext();
  const window_ = state.chartWindows.find(w => w.id === windowId);
  const { fetchMultiPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const themeVersion = useThemeVersion();
  // chartData keyed by dataset name
  const [fetchedDataMap, setChartDataMap] = useState<{ [ds: string]: MultiPointTimeSeriesData }>({});
  const [fetchedBuffer, setBufferData] = useState<{ [key: string]: BufferResult }>({});
  // Layers shown relative to another date (Main › Layers › ref): that step's label, per layer.
  const refX = useMemo(() => {
    const out: { [ds: string]: string | number } = {};
    for (const [ds, chosen] of Object.entries(state.refTimeIndex)) {
      const info = state.datasetInfo[ds];
      const i = activeRefTime(info, chosen, state.dataMode);
      if (i !== null) out[ds] = info.x_values[i];
    }
    return out;
  }, [state.refTimeIndex, state.datasetInfo, state.dataMode]);
  // Each series minus its own value at that date, as the map's tiles.
  // Each series under its point's name as it is now: renaming a point in the Points panel
  // relabels the chart and the CSV without fetching the series again.
  const pointNames = JSON.stringify(state.timeSeriesPoints.map(p => [p.id, p.name]));
  const chartDataMap = useMemo(() => {
    const names = new Map<string, string>(JSON.parse(pointNames));
    return Object.fromEntries(Object.entries(relativeChartData(fetchedDataMap, refX)).map(([ds, cd]) => [ds, {
      ...cd, datasets: cd.datasets.map(d => ({ ...d, label: names.get(d.pointId) ?? d.label })),
    }]));
  }, [fetchedDataMap, refX, pointNames]);
  const bufferData = useMemo(() => Object.fromEntries(Object.entries(fetchedBuffer).map(([key, b]) => {
    const ds = key.split('::')[0];
    return [key, ds in refX
      ? { ...b, median: relativeTo(b.median, refX[ds]), samples: b.samples.map(s => relativeTo(s, refX[ds])) }
      : b];
  })), [fetchedBuffer, refX]);
  const [isLoading, setIsLoading] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  // Per-dataset vertical offset (in data units) for separating overlapping layers
  const [dsOffsets, setDsOffsets] = useState<{ [ds: string]: number }>({});
  // Per-dataset color overrides (keyed by dsName, overrides all points in that dataset)
  const [dsColorOverrides, setDsColorOverrides] = useState<{ [ds: string]: string }>({});
  // Per-dataset y-axis limits; empty string = auto
  const [dsYLimits, setDsYLimits] = useState<{ [ds: string]: { min: string; max: string } }>({});
  // Marker size, date range and the y rows: folded unless this viewer opened them.
  const [displayOpen, setDisplayOpen] = useState(readChartDisplayOpen);
  const toggleDisplay = () => setDisplayOpen(o => { saveChartDisplayOpen(!o); return !o; });
  const chartRef = useRef<ChartJS<'line'>>(null);
  // What the chart draws and its export buttons, for the Assistant's chart tools (assistant/chartView.ts).
  const snapRef = useRef<ChartSnapshot | null>(null);
  const exportRef = useRef<{ csv: () => boolean; png: () => boolean }>({ csv: () => false, png: () => false });
  useEffect(() => registerChart({
    windowId,
    snapshot: () => snapRef.current,
    setLayerDisplay: (ds: string, patch: Partial<LayerDisplay>) => {
      // As the layer's Display options row: the offset, y min/max (empty = auto) and colour.
      if (patch.offset !== undefined) setDsOffsets(prev => ({ ...prev, [ds]: patch.offset as number }));
      if (patch.ymin !== undefined || patch.ymax !== undefined) {
        setDsYLimits(prev => {
          const lim = prev[ds] ?? { min: '', max: '' };
          const text = (v: number | null | undefined, old: string) => (v === undefined ? old : v === null ? '' : String(v));
          return { ...prev, [ds]: { min: text(patch.ymin, lim.min), max: text(patch.ymax, lim.max) } };
        });
      }
      if (patch.color !== undefined) {
        setDsColorOverrides(prev => {
          const next = { ...prev };
          if (patch.color === null) delete next[ds];
          else next[ds] = patch.color as string;
          return next;
        });
      }
    },
    exportCsv: () => exportRef.current.csv(),
    exportPng: () => exportRef.current.png(),
  }), [windowId]);
  const { panelRef, panelStyle, onDragMouseDown, resizeGrip } = useDraggableResizable({
    defaultWidth: Math.min(560, window.innerWidth * 0.38),
    defaultHeight: 420,
    fitContent: true,
  });

  // Only layers with a time axis can be charted (velocity and other 2-D layers can't).
  const allDsNames = timeSeriesLayers(state.datasetInfo);
  // Datasets for this window: window's dsNames if set, else follow currentDataset
  const winDsNames = (window_?.dsNames ?? []).filter(ds => allDsNames.includes(ds));
  const followedDs = chartLayerFor(state.currentDataset, state.datasetInfo);
  const activeDatasetsForChart: string[] = winDsNames.length > 0
    ? winDsNames
    : (followedDs ? [followedDs] : []);

  const pointRequest = useRef(0);
  const updateChart = useCallback(async () => {
    const request = ++pointRequest.current;
    setChartDataMap({});
    if (!state.showChart || !state.currentDataset || state.timeSeriesPoints.length === 0) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const visiblePoints = state.timeSeriesPoints.filter(p => p.visible);
    if (visiblePoints.length === 0) {
      setChartDataMap({});
      setIsLoading(false);
      return;
    }
    if (activeDatasetsForChart.length === 0) {
      setChartDataMap({});
      setIsLoading(false);
      return;
    }
    const apiPoints = visiblePoints.map(point => ({
      id: point.id,
      lat: point.position[0],
      lon: point.position[1],
      color: point.color,
      name: point.name,
    }));
    try {
      const results = await Promise.all(
        activeDatasetsForChart.map(async dsName => {
          const dsInfo = state.datasetInfo[dsName];
          let refLon: number | undefined, refLat: number | undefined;
          if (dsInfo?.uses_spatial_ref && state.refEnabled) {
            [refLat, refLon] = state.refMarkerPosition;
          }
          // Trends come from the model fitted below (fitSeries), not the server.
          const tsData = await fetchMultiPointTimeSeries(
            apiPoints, dsName, refLon, refLat, false,
            state.layerMasks,
            state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : 0,
          );
          return { dsName, tsData };
        })
      );
      const newMap: { [ds: string]: MultiPointTimeSeriesData } = {};
      results.forEach(({ dsName, tsData }) => {
        if (tsData) newMap[dsName] = tsData;
      });
      if (pointRequest.current === request) setChartDataMap(newMap);
    } catch (error) {
      console.error('Error updating chart:', error);
    } finally {
      if (pointRequest.current === request) setIsLoading(false);
    }
  }, [
    state.showChart,
    state.currentDataset,
    JSON.stringify(activeDatasetsForChart),
    JSON.stringify(state.timeSeriesPoints.map(p => ({ id: p.id, position: p.position, visible: p.visible }))),
    state.refMarkerPosition,
    state.refEnabled,
    state.refBufferEnabled,
    state.refBufferRadius,
    state.datasetInfo,
    state.layerMasks,
    fetchMultiPointTimeSeries,
  ]);

  useEffect(() => {
    void updateChart();
    return () => { pointRequest.current += 1; };
  }, [updateChart]);

  // Fetch buffer data for each visible point × each active dataset
  useEffect(() => {
    let current = true;
    setBufferData({});
    if (!state.bufferEnabled || !state.showChart || !state.currentDataset) return;
    const visiblePoints = state.timeSeriesPoints.filter(p => p.visible);
    if (visiblePoints.length === 0) return;

    if (activeDatasetsForChart.length === 0) return;
    Promise.all(
      activeDatasetsForChart.flatMap(dsName => {
        const dsInfo = state.datasetInfo[dsName];
        let refLon: number | undefined, refLat: number | undefined;
        if (dsInfo?.uses_spatial_ref && state.refEnabled) {
          [refLat, refLon] = state.refMarkerPosition;
        }
        return visiblePoints.map(async p => {
          const result = await fetchBufferTimeSeries(
            p.position[1], p.position[0],
            dsName,
            state.bufferRadius,
            state.bufferSamples,
            refLon, refLat,
            state.layerMasks,
            state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : 0,
          );
          return { key: `${dsName}::${p.id}`, result };
        });
      })
    ).then(results => {
      if (!current) return;
      const newData: { [key: string]: any } = {};
      results.forEach(({ key, result }) => { if (result) newData[key] = result; });
      setBufferData(newData);
    }).catch(error => {
      if (current) console.error('Error updating buffer chart:', error);
    });
    return () => { current = false; };
  }, [
    state.bufferEnabled,
    state.showChart,
    state.currentDataset,
    JSON.stringify(activeDatasetsForChart),
    state.bufferRadius,
    state.bufferSamples,
    state.refEnabled,
    state.refBufferEnabled,
    state.refBufferRadius,
    state.layerMasks,
    state.datasetInfo,
    JSON.stringify(state.timeSeriesPoints.map(p => ({ id: p.id, position: p.position, visible: p.visible }))),
    state.refMarkerPosition,
    fetchBufferTimeSeries,
  ]);

  // ── Areas (+ Area): native summaries shared with Stats, refreshed when masks change ──
  const visibleAreas = state.chartAreas.filter(a => a.visible);
  // Kept in AppState (the Stats tab lists them too); Zonal stats may have asked already.
  const areaResults = state.areaStats;
  useAreaStatsFetch(activeDatasetsForChart, visibleAreas, state.showChart);

  // The viewer's reference taken off each area (useAreaReference).
  const areaReference = useAreaReference(activeDatasetsForChart, state.showChart && visibleAreas.length > 0);

  // Derive a single merged chartData view from chartDataMap for click/export
  // Use the first available dataset as the canonical labels source
  const firstDs = Object.values(chartDataMap)[0] ?? null;

  // ── Trend model (the portal's fit): one fit per series over the shown date range ──
  const [picking, setPicking] = useState<PickKind | null>(null);
  const fits = useMemo(() => {
    const out: Record<string, { fit: FitResult | null; points: { x: string; y: number }[] }> = {};
    if (!state.showTrends) return out;
    const from = state.dateRangeStart ?? '';
    const to = state.dateRangeEnd ?? '9999';
    for (const [ds, cd] of Object.entries(chartDataMap)) {
      const k = displayUnit(state.datasetInfo[ds]?.unit, state.units).factor;
      for (const d of cd.datasets) {
        const points = d.data.map(p => ({ x: toIsoDate(p.x as string), y: p.y * k }))
          .filter(p => p.x.slice(0, 10) >= from && p.x.slice(0, 10) <= to);
        out[`${ds}::${d.pointId}`] = { fit: fitSeries(points, state.fitSettings), points };
      }
    }
    return out;
  }, [chartDataMap, state.showTrends, state.fitSettings, state.dateRangeStart, state.dateRangeEnd, state.units, state.datasetInfo]);

  // The fitted rate is what the Points panel and the CSV report.
  useEffect(() => {
    for (const [key, { fit, points }] of Object.entries(fits)) {
      if (!fit || fit.model.polyOrder < 1) continue;
      const [dataset, pointId] = key.split('::');
      const unit = displayUnit(state.datasetInfo[dataset]?.unit, state.units);
      const k = unit.rate?.factor ?? 1;
      dispatch({ type: 'SET_POINT_TREND_DATA', payload: { pointId, dataset, trend: {
        slope: 0, intercept: 0, rSquared: rSquared(points, fit), mmPerYear: fit.rate * k, stdMmPerYear: fit.rateStd * k,
        rateUnit: unit.rate?.label ?? unit.label,
      } } });
    }
  }, [fits]);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleChartClick = useCallback((event: any, elements: InteractionItem[]) => {
    if (picking) {
      const t = chartRef.current?.scales.x?.getValueForPixel(event.x);
      if (typeof t === 'number' && Number.isFinite(t)) {
        const iso = new Date(t).toISOString().slice(0, 10);
        const key = picking === 'step' ? 'steps' : 'breaks';
        dispatch({ type: 'SET_FIT_SETTINGS', payload: { [key]: [...new Set([...state.fitSettings[key], iso])].sort().slice(0, 20) } });
      }
      setPicking(null);
      return;
    }
    if (elements.length === 0 || !firstDs) return;
    const dataIndex = elements[0].index;
    if (dataIndex !== undefined && dataIndex < firstDs.labels.length) {
      dispatch({ type: 'SET_TIME_INDEX', payload: dataIndex });
    }
  }, [firstDs, dispatch, picking, state.fitSettings]);

  const handleExportToCSV = useCallback(() => {
    if (!firstDs) return;
    // Exclude the fitted-trend line series (label "… trend") — keep real data series.
    // Each series under its point's name now (a point renamed after its data came keeps it).
    const nameOf = Object.fromEntries(state.timeSeriesPoints.map(p => [p.id, p.name]));
    const allDatasets = Object.entries(chartDataMap).flatMap(([dsName, cd]) =>
      cd.datasets.filter(d => !d.label.endsWith(' trend')).map(d => ({ ...d, label: nameOf[d.pointId] ?? d.label, _dsName: dsName }))
    );
    if (allDatasets.length === 0) return;
    const multiDs = activeDatasetsForChart.length > 1;
    const colName = (d: typeof allDatasets[number]) => multiDs ? `${d._dsName} — ${d.label}` : d.label;

    // ── Metadata header (per series): point lat/lon and trend velocity ± std ──
    const ptById = Object.fromEntries(state.timeSeriesPoints.map(p => [p.id, p]));
    const num = (v: number | undefined, dp = 5) => (v === undefined || isNaN(v) ? '' : v.toFixed(dp));
    // x/y are the point's coordinates in the cube's native CRS (e.g. UTM
    // easting/northing) — useful when the data isn't geographic; blank when the
    // backend couldn't supply them.
    const metaHeader = '# series,lat,lon,x,y,dataset,velocity_mm_per_yr,velocity_std_mm_per_yr,model';
    const metaRows = allDatasets.map(d => {
      const p = ptById[d.pointId];
      const fit = fits[`${d._dsName}::${d.pointId}`]?.fit;
      // The fit is in the displayed units; the CSV is always metric (data units, mm/yr).
      const unit = state.datasetInfo[d._dsName]?.unit;
      const k = (displayUnit(unit, 'metric').rate?.factor ?? 1) / displayUnit(unit, state.units).factor;
      const rate = fit && fit.model.polyOrder >= 1 ? fit.rate * k : undefined;
      const std = fit && fit.model.polyOrder >= 1 ? fit.rateStd * k : undefined;
      return `# ${colName(d)},${p ? num(p.position[0], 6) : ''},${p ? num(p.position[1], 6) : ''},` +
        `${num(d.x ?? undefined, 3)},${num(d.y ?? undefined, 3)},` +
        `${d._dsName},${num(rate, 3)},${num(std, 3)},${fit ? modelLabel(state.fitSettings) : ''}`;
    });

    // ── Time × series value matrix ──
    const headers = ['Time', ...allDatasets.map(colName)];
    const byLabel: Record<string, Record<string, number>> = {};
    allDatasets.forEach(d => {
      const key = `${d._dsName}::${d.pointId}`;
      d.data.forEach(pt => { (byLabel[pt.x as string] ??= {})[key] = pt.y; });
    });
    const allTimes = [...new Set(allDatasets.flatMap(d => d.data.map(pt => pt.x as string)))].sort();
    const rows = allTimes.map(t => [t, ...allDatasets.map(d => {
      const key = `${d._dsName}::${d.pointId}`;
      return byLabel[t]?.[key]?.toString() ?? '';
    })]);

    const csvContent = [
      ...metaRows, '',                       // metadata (commented), then a blank line
      [headers, ...rows].map(r => r.join(',')).join('\n'),
    ].join('\n');
    // Prepend the metadata column header before the metadata rows.
    const out = [metaHeader, csvContent].join('\n');
    const blob = new Blob([out], { type: 'text/csv;charset=utf-8;' });
    void saveFile(blob, `time-series-${activeDatasetsForChart[0]}-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}.csv`);
  }, [chartDataMap, firstDs, activeDatasetsForChart, state.timeSeriesPoints, fits, state.fitSettings, state.datasetInfo, state.units]);
  const exportPng = () => {
    const canvas = chartRef.current?.canvas;
    if (canvas) downloadChartAsPng(canvas, `timeseries-${activeDatasetsForChart[0]}-${Date.now()}.png`);
    return !!canvas;
  };
  exportRef.current = { csv: () => { if (!firstDs) return false; handleExportToCSV(); return true; }, png: exportPng };

  // Layers with an area answer (they may have no point data).
  const areaDsNames = activeDatasetsForChart.filter(ds => visibleAreas.some(a => areaResults[areaStatsKey(ds, a.id)]?.data));
  const firstAreaLabel = areaDsNames.flatMap(ds => visibleAreas.map(a => areaResults[areaStatsKey(ds, a.id)]?.data?.labels?.[0]))
    .find(l => l !== undefined);
  // Ordered list of dataset names in the chart (one y axis each)
  const activeChartDs = [...new Set([...Object.keys(chartDataMap), ...areaDsNames])];

  const chartOptions = useMemo(() => {
    const textColor  = cssVar('--sb-text',   '#dde0f0');
    const mutedColor = cssVar('--sb-muted',  '#7880a8');
    const gridColor  = cssVar('--sb-border', '#2c2f4a');

    const referenceDate = activeChartDs.length === 0 ? null
      : activeChartDs[0] in refX ? refDateLabel(refX[activeChartDs[0]])
      : state.datasetInfo[activeChartDs[0]]?.reference_date;

    // Determine x-axis scale type from label format of the first active dataset:
    // - integer → linear; "YYYY-MM-DD_YYYY-MM-DD" → category; ISO date → time
    const firstLabel = (activeChartDs.length > 0
      ? chartDataMap[activeChartDs[0]]?.labels?.[0]
      : undefined) ?? firstAreaLabel;
    const labelType: 'time' | 'category' | 'linear' =
      typeof firstLabel === 'number' ? 'linear'
      : typeof firstLabel === 'string' && firstLabel.includes('_') ? 'category'
      : 'time';

    const xScale: any = labelType === 'time'
      ? {
          type: 'time' as const,
          time: { displayFormats: { month: 'MMM yyyy', day: 'MMM d', year: 'yyyy' } },
          title: {
            display: true,
            text: referenceDate ? `Date (ref: ${referenceDate})` : 'Date',
            color: mutedColor,
          },
          grid: { color: gridColor },
          ticks: { color: mutedColor },
        }
      : labelType === 'category'
      ? {
          type: 'category' as const,
          title: { display: true, text: 'Date pair (reference_secondary)', color: mutedColor },
          grid: { color: gridColor },
          ticks: { color: mutedColor, maxRotation: 45, autoSkip: true },
        }
      : {
          type: 'linear' as const,
          title: { display: true, text: 'Image index', color: mutedColor },
          grid: { color: gridColor },
          ticks: { color: mutedColor, stepSize: 1 },
        };

    // Per-dataset y-axes: first on left, extras on right
    const scales: any = { x: xScale };

    activeChartDs.forEach((ds, i) => {
      const info = state.datasetInfo[ds];
      const shownUnit = displayUnit(info?.unit, state.units).label;
      const baseYLabel = info?.label && shownUnit
        ? `${info.label} (${shownUnit})`
        : info?.label || shownUnit || ds;
      const yLabel = ds in refX ? `${baseYLabel} relative to ${refDateLabel(refX[ds])}` : baseYLabel;
      const axisColor = dsColorOverrides[ds] ?? (i === 0 ? mutedColor : mutedColor);
      const offset = dsOffsets[ds] ?? 0;
      const lim = dsYLimits[ds];
      const userMin = lim?.min !== '' && lim?.min !== undefined ? parseFloat(lim.min) : NaN;
      const userMax = lim?.max !== '' && lim?.max !== undefined ? parseFloat(lim.max) : NaN;

      const axisScale: any = {
        position: i === 0 ? 'left' as const : 'right' as const,
        title: { display: true, text: yLabel, color: axisColor, font: { size: 10 } },
        grid: { color: i === 0 ? gridColor : 'transparent' },
        ticks: { color: axisColor, font: { size: 10 } },
      };
      // Only fix bounds when user has explicitly set them; otherwise let Chart.js autoscale
      if (!isNaN(userMin)) axisScale.min = userMin + offset;
      if (!isNaN(userMax)) axisScale.max = userMax + offset;
      // When offset is non-zero but no explicit limits, use suggestedMin/Max to shift axis without clipping
      if (isNaN(userMin) && offset !== 0) axisScale.suggestedMin = undefined;
      if (isNaN(userMax) && offset !== 0) axisScale.suggestedMax = undefined;

      scales[`y${i}`] = axisScale;
    });

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index' as const, intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top' as const,
          labels: {
            usePointStyle: true,
            padding: 16,
            color: textColor,
            generateLabels: (chart: any) => {
              const isBuffer = chart.data.datasets.some((ds: any) => !ds._area && ds.label?.endsWith(' median'));
              return chart.data.datasets
                .map((ds: any, index: number) => ({ ds, index }))
                .filter(({ ds }: any) => {
                  // An area: one entry each for its median, mean and band.
                  if (ds._area) return !!ds._legend;
                  if (ds.label.includes(' sample ')) return false;
                  if (ds.label.endsWith(' trend')) return false;
                  if (ds.label.endsWith(' residual')) return false;
                  if (isBuffer) return ds.label.endsWith(' median');
                  return !ds.label.endsWith(' median');
                })
                .map(({ ds, index }: any) => {
                  const baseLabel = (ds as any)._legend || (ds as any)._baseLabel || ds.label;
                  const trendMmPerYear = (ds as any)._trendMmPerYear;
                  const rateUnit = (ds as any)._rateUnit ?? 'mm';
                  const displayText = baseLabel + (trendMmPerYear !== undefined && state.showTrends
                    ? ` (${trendMmPerYear.toFixed(rateUnit === 'in' ? 2 : 1)} ${rateUnit}/yr)` : '');
                  return {
                    text: displayText,
                    pointStyle: (ds._area ? (ds.fill ? 'rect' : 'line') : (ds.pointStyle ?? 'circle')) as any,
                    fillStyle: ds._area && ds.fill ? ds.backgroundColor : ds.borderColor,
                    lineDash: ds._area ? ds.borderDash : undefined,
                    strokeStyle: ds.borderColor,
                    fontColor: textColor,
                    lineWidth: 2,
                    datasetIndex: index,
                    hidden: !chart.isDatasetVisible(index),
                  };
                });
            },
          },
        },
        tooltip: {
          callbacks: {
            title: (context: any) => `${context[0]?.label || ''}`,
            label: (context: any) => {
              const ds = context.chart.data.datasets[context.datasetIndex];
              if (!ds) return '';
              const unit = (ds as any)._unit || 'm';
              let label = `${(ds as any)._baseLabel || ds.label}: ${context.parsed.y.toFixed(4)} ${unit}`;
              if ((ds as any)._area) label = `${ds.label}: ${context.parsed.y.toFixed(4)} ${unit}`;
              const mmPy = (ds as any)._trendMmPerYear;
              const rateUnit = (ds as any)._rateUnit ?? 'mm';
              if (mmPy !== undefined && state.showTrends) label += ` (${mmPy.toFixed(rateUnit === 'in' ? 2 : 1)} ${rateUnit}/yr)`;
              if ((ds as any)._note) label += `, ${(ds as any)._note}`;
              return label;
            },
          },
        },
        zoom: {
          pan: { enabled: true, mode: 'x' as const, onPanComplete: () => setIsZoomed(true) },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x' as const,
            onZoomComplete: () => setIsZoomed(true),
          },
        },
      },
      scales,
      onClick: handleChartClick,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion, refX, state.units, state.showTrends, state.vmin, state.vmax, state.datasetInfo, state.bufferEnabled, handleChartClick, JSON.stringify(activeChartDs), JSON.stringify(dsOffsets), JSON.stringify(dsColorOverrides), JSON.stringify(dsYLimits), firstAreaLabel, JSON.stringify(Object.fromEntries(Object.entries(chartDataMap).map(([k, v]) => [k, v.datasets.flatMap(d => d.data.map(pt => pt.y))]))) ]);

  /** What the chart shows now, for the chart tools: ``datasets`` exactly as handed to <Line>. */
  const snapshot = (status: ChartSnapshot['status'], datasets: ChartSnapshot['datasets'] = [], message?: string, dates: string[] = []): ChartSnapshot => ({
    status, message, layers: activeChartDs, datasets, fits,
    fitSettings: state.fitSettings, showTrends: state.showTrends, showResiduals: state.showResiduals,
    dateRange: { start: state.dateRangeStart, end: state.dateRangeEnd, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null },
    referenceDates: Object.fromEntries(activeChartDs.map(ds => [ds,
      ds in refX ? refDateLabel(refX[ds]) : state.datasetInfo[ds]?.reference_date ?? null])),
    units: Object.fromEntries(activeChartDs.map(ds => [ds, displayUnit(state.datasetInfo[ds]?.unit, state.units)])),
    display: Object.fromEntries(activeChartDs.map(ds => {
      const lim = dsYLimits[ds];
      const num = (v: string | undefined) => (v === undefined || v === '' || Number.isNaN(parseFloat(v)) ? null : parseFloat(v));
      return [ds, { offset: dsOffsets[ds] ?? 0, ymin: num(lim?.min), ymax: num(lim?.max), color: dsColorOverrides[ds] ?? null }];
    })),
  });

  if (!state.showChart) {
    snapRef.current = null;
    return null;
  }

  // Dataset selector helpers
  const setWinDs = (dsNames: string[]) =>
    dispatch({ type: 'SET_CHART_WINDOW_DS', payload: { id: windowId, dsNames } });
  const addWinDs = (ds: string) => setWinDs(addChartLayer(winDsNames, followedDs, ds));
  const removeWinDs = (ds: string) => setWinDs(winDsNames.filter(d => d !== ds));
  const spawnNewChart = () => dispatch({
    type: 'ADD_CHART_WINDOW',
    payload: { id: `chart_${Date.now()}`, dsNames: [] },
  });
  const closeThis = () => dispatch({ type: 'REMOVE_CHART_WINDOW', payload: windowId });

  const multiDs = activeDatasetsForChart.length > 1;
  // A failed area (bad or too-large polygon, no valid pixels, lite server): one short line.
  const areaErrors = activeDatasetsForChart.flatMap(ds => visibleAreas.flatMap(a => {
    const error = areaResults[areaStatsKey(ds, a.id)]?.error;
    return error ? [`${multiDs ? `${a.name} [${ds}]` : a.name}: ${error}`] : [];
  }));
  const areaPending = activeDatasetsForChart.some(ds => visibleAreas.some(a => {
    const r = areaResults[areaStatsKey(ds, a.id)];
    return !r || !!r.pending || (!!r.data && areaReference(ds) === undefined);
  }));

  const headerContent = (
    <>
      <div className="chart-header" onMouseDown={onDragMouseDown} style={{ cursor: 'grab' }}>
        <h4 style={{ margin: 0, fontSize: '0.9em' }}>Time Series</h4>
        <div className="chart-controls">
          <button className={`chart-btn${state.showTrends ? ' active' : ''}`} onClick={() => dispatch({ type: 'TOGGLE_TRENDS' })}
            aria-pressed={state.showTrends} aria-label="Model"
            title={state.showTrends ? `Model: ${modelLabel(state.fitSettings)}` : 'Fit a model: polynomial, seasonal terms, steps and segments (as in the OPERA DISP portal)'}>
            <i className={`fa-solid ${state.showTrends ? 'fa-chart-line' : 'fa-chart-simple'}`}></i>
          </button>
          {state.showTrends && (
            <button className={`chart-btn${state.showResiduals ? ' active' : ''}`} onClick={() => dispatch({ type: 'TOGGLE_RESIDUALS' })}
              aria-pressed={state.showResiduals} aria-label="Residuals"
              title={state.showResiduals ? 'Hide residuals' : 'Show residuals'}>
              <i className="fa-solid fa-wave-square"></i>
            </button>
          )}
          {isZoomed && (
            <button className="chart-btn" onClick={() => { chartRef.current?.resetZoom(); setIsZoomed(false); }} title="Reset zoom">
              <i className="fa-solid fa-magnifying-glass-minus"></i>
            </button>
          )}
          <ChartAreaButton />
          <SeriesStylePopover />
          <button className="chart-btn" onClick={handleExportToCSV} title="Export CSV">
            <i className="fa-solid fa-download"></i>
          </button>
          <button className="chart-btn" title="Save as PNG (transparent background)" onClick={exportPng}>
            <i className="fa-solid fa-camera"></i>
          </button>
          <button className="chart-btn" title="New chart window" onClick={spawnNewChart}>
            <i className="fa-solid fa-plus"></i>
          </button>
          <button className="chart-btn" style={{ color: 'var(--sb-red)' }} title="Close this chart" onClick={closeThis}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
      <div className="chart-sliders" style={{ marginBottom: 4, paddingBottom: 4, flexWrap: 'wrap' }}>
        {winDsNames.length === 0 ? (
          followedDs ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px',
              background: 'var(--sb-surface2)', border: '1px solid var(--sb-border)',
              borderRadius: 10, fontSize: '0.72em', color: 'var(--sb-text)', flexShrink: 0,
            }}>
              {followedDs}
              {allDsNames.length > 1 && (
                <button onClick={() => setWinDs(allDsNames.filter(d => d !== followedDs))} style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  color: 'var(--sb-muted)', fontSize: '0.9em', lineHeight: 1,
                }} title={`Remove ${followedDs}`}>✕</button>
              )}
            </span>
          ) : (
            <span style={{ fontSize: '0.75em', color: 'var(--sb-muted)' }}>No time-series layer</span>
          )
        ) : (
          winDsNames.map(ds => (
            <span key={ds} style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px',
              background: 'var(--sb-surface2)', border: '1px solid var(--sb-border)',
              borderRadius: 10, fontSize: '0.72em', color: 'var(--sb-text)', flexShrink: 0,
            }}>
              {ds}
              <button onClick={() => removeWinDs(ds)} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: 'var(--sb-muted)', fontSize: '0.9em', lineHeight: 1,
              }} title={`Remove ${ds}`}>✕</button>
            </span>
          ))
        )}
        {(() => {
          const available = allDsNames.filter((ds: string) => !activeDatasetsForChart.includes(ds));
          return available.length > 0 ? (
            <select className="sidebar-select"
              style={{ fontSize: '0.72em', padding: '1px 4px', height: 22, flex: '0 0 auto', maxWidth: 130 }}
              value="" onChange={e => { if (e.target.value) { addWinDs(e.target.value); e.currentTarget.value = ''; } }}
            >
              <option value="">＋ layer…</option>
              <LayerOptions names={available} />
            </select>
          ) : null;
        })()}
        {winDsNames.length > 0 && (
          <button className="chart-btn" style={{ fontSize: '0.7em', padding: '1px 5px' }}
            onClick={() => setWinDs([])} title="Reset to map layer">↺ reset</button>
        )}
      </div>
      {(state.chartAreas.length > 0 || state.areaDrawing) && (
        <div className="chart-sliders chart-areas">
          {state.chartAreas.map(a => (
            <span key={a.id} className={`chart-area-chip${a.visible ? '' : ' area-hidden'}`} title={a.name}>
              <span className="chart-area-swatch" style={{ background: a.color }} />
              {a.name}
              <button onClick={() => dispatch({ type: 'REMOVE_CHART_AREA', payload: a.id })} title={`Remove ${a.name}`}>✕</button>
            </span>
          ))}
          {state.chartAreas.length > 0 && (
            <label className="chart-area-note chart-area-band">
              Band
              <select className="sidebar-select" aria-label="Area band" value={state.areaBand}
                onChange={e => dispatch({ type: 'SET_AREA_BAND', payload: e.target.value as AreaBand })}>
                {(Object.keys(AREA_BAND_LABELS) as AreaBand[]).map(b => <option key={b} value={b}>{AREA_BAND_LABELS[b]}</option>)}
              </select>
            </label>
          )}
          {state.areaDrawing && <span className="chart-area-note">Draw the area on the map: click the first point to finish.</span>}
        </div>
      )}
      {areaErrors.length > 0 && (
        <div className="chart-area-error" role="alert">{areaErrors.join(' · ')}</div>
      )}
      {state.showTrends && (
        <ModelCard settings={state.fitSettings} picking={picking} onPick={setPicking}
          onChange={patch => dispatch({ type: 'SET_FIT_SETTINGS', payload: patch })} />
      )}
    </>
  );

  if (state.timeSeriesPoints.length === 0 && visibleAreas.length === 0) {
    snapRef.current = snapshot('empty', [], 'No points or areas in the chart.');
    return (
      <div id="chart-container" ref={panelRef} style={panelStyle}>
        {headerContent}
        <div className="chart-placeholder">
          <p>No points selected.</p><p><small>Click on the map to add points, or add an area with + Area.</small></p>
        </div>
        {resizeGrip}
      </div>
    );
  }

  if (isLoading) {
    snapRef.current = snapshot('loading');
    return (
      <div id="chart-container" ref={panelRef} style={panelStyle}>
        {headerContent}
        <div className="chart-placeholder"><p>Loading…</p></div>
        {resizeGrip}
      </div>
    );
  }

  // ── Area series: median, dashed mean and p10–p90 band per area, in the area's colour ──
  const dateStart = state.dateRangeStart ? new Date(state.dateRangeStart).getTime() : -Infinity;
  const dateEnd   = state.dateRangeEnd   ? new Date(state.dateRangeEnd).getTime()   : Infinity;
  const inRange = (x: string) => { const t = new Date(x).getTime(); return t >= dateStart && t <= dateEnd; };
  const areaDatasets = activeChartDs.flatMap(dsName => {
    const reference = areaReference(dsName);
    if (reference === undefined) return [];
    const shown = displayUnit(state.datasetInfo[dsName]?.unit, state.units);
    return visibleAreas.flatMap(area => {
      const result = areaResults[areaStatsKey(dsName, area.id)]?.data;
      if (!result) return [];
      return areaChartDatasets({
        result, name: multiDs ? `${area.name} [${dsName}]` : area.name, color: dsColorOverrides[dsName] ?? area.color,
        factor: shown.factor, unit: shown.label, yAxisID: `y${activeChartDs.indexOf(dsName)}`,
        reference, toX: toIsoDate, inRange, band: state.areaBand, style: area,
        refIndex: dsName in refX ? refIndexOf(result, refX[dsName]) : null,
      }).map(d => ({ ...d, _series: { kind: 'area', id: area.id, name: area.name, layer: dsName, role: areaRole(d) } as SeriesTag }) as Record<string, unknown>);
    });
  });
  const hasAreaData = areaDatasets.some(d => (d.data as unknown[]).length > 0);

  // A masked point comes back as a dataset with no points: that is no data too.
  if (!hasAreaData && areaPending && !Object.values(chartDataMap).some(d => d.datasets.some(series => series.data.length > 0))) {
    snapRef.current = snapshot('loading');
    return (
      <div id="chart-container" ref={panelRef} style={panelStyle}>
        {headerContent}
        <div className="chart-placeholder"><p>Loading…</p></div>
        {resizeGrip}
      </div>
    );
  }
  if (!hasAreaData && !Object.values(chartDataMap).some(d => d.datasets.some(series => series.data.length > 0))) {
    snapRef.current = snapshot('empty', [], activeDatasetsForChart.length === 0 ? 'No layer here has a time dimension.'
      : state.layerMasks.length > 0 ? `Masking hides every date at the selected points (masks on: ${state.layerMasks.map(m => m.dataset).join(', ')}).`
      : 'No data at the selected points or areas.');
    return (
      <div id="chart-container" ref={panelRef} style={panelStyle}>
        {headerContent}
        <div className="chart-placeholder">
          {activeDatasetsForChart.length === 0
            ? <p>No layer here has a time dimension.</p>
            : areaErrors.length > 0 && visibleAreas.length > 0
              ? <p>No valid area summary is available. See the area message above.</p>
            : state.layerMasks.length > 0
              ? (
                <>
                  <p>Masking hides every date at the selected points.</p>
                  <p><small>Masks on: {state.layerMasks.map(m => m.dataset).join(', ')} (Main › Masking).</small></p>
                  <button type="button" className="hist-btn" style={{ flex: 'none', marginTop: 6 }}
                    onClick={() => state.layerMasks.forEach(m => dispatch({ type: 'REMOVE_LAYER_MASK', payload: m.id }))}>
                    Remove the masks
                  </button>
                </>
              )
              : <p>No data for {state.timeSeriesPoints.length > 0 ? 'selected points' : 'the selected areas'}.</p>
          }
        </div>
        {resizeGrip}
      </div>
    );
  }

  // ── Build unified dataset list from all active chart datasets ─────────────
  // Collect all ISO dates across all datasets (points and areas) for the x-axis
  const allIsoLabels = [...new Set([
    ...Object.values(chartDataMap).flatMap(cd => cd.labels.map(toIsoDate)),
    ...areaDsNames.flatMap(ds => visibleAreas.flatMap(a => areaResults[areaStatsKey(ds, a.id)]?.data?.labels.map(toIsoDate) ?? [])),
  ])].sort();

  const isoLabels = allIsoLabels.filter(d => {
    const t = new Date(d).getTime();
    return t >= dateStart && t <= dateEnd;
  });

  const ms = state.markerSize;

  const datasetList: any[] = [];
  /** The fitted rate for the legend (mm/yr or in/yr), when the data is a length. */
  const trendRate = (dsName: string, pointId: string): number | undefined => {
    const fit = fits[`${dsName}::${pointId}`]?.fit;
    const rate = displayUnit(state.datasetInfo[dsName]?.unit, state.units).rate;
    return fit && rate && fit.model.polyOrder >= 1 ? fit.rate * rate.factor : undefined;
  };

  Object.entries(chartDataMap).forEach(([dsName, cd]) => {
    const dsInfo = state.datasetInfo[dsName];
    // Values are drawn in the chosen units (inches in imperial); the data stays in its own.
    const shown = displayUnit(dsInfo?.unit, state.units);
    const unit = shown.label;
    const rateUnit = shown.rate?.label;
    const k = shown.factor;
    const axisIdx = activeChartDs.indexOf(dsName);
    const yAxisID = `y${axisIdx}`;
    // The date the series is relative to (chosen, or as stored), marked on each series.
    const refAt = refX[dsName] ?? dsInfo?.reference_date;
    const refIso = refAt === undefined || refAt === null ? null : toIsoDate(refAt);

    cd.datasets.forEach(dataset => {
      // The point's own name, colour and style (Points panel, Style button), as on the map; a layer's
      // colour (Display options) wins for that layer's series, so layers sharing the chart tell apart.
      const point = state.timeSeriesPoints.find(p => p.id === dataset.pointId);
      const name = point?.name ?? dataset.label;
      const baseLabel = multiDs ? `${name} [${dsName}]` : name;
      const borderColor = dsColorOverrides[dsName] ?? point?.color ?? dataset.borderColor;
      const backgroundColor = `${borderColor}33`;
      const look = seriesStyle(point?.marker, point?.line, ms);
      const tag = (role: SeriesTag['role']): SeriesTag => ({ kind: 'point', id: dataset.pointId, name, layer: dsName, role });

      if (state.bufferEnabled) {
        const buf = bufferData[`${dsName}::${dataset.pointId}`];
        if (!buf) return;

        buf.samples.forEach((sample: Array<{ x: string; y: number }>, i: number) => {
          datasetList.push({
            label: `${baseLabel} sample ${i}`,
            _series: tag('sample'),
            _baseLabel: baseLabel,
            _unit: unit,
            yAxisID,
            data: sample
              .map(pt => ({ x: toIsoDate(pt.x), y: pt.y * k }))
              .filter(pt => { const t = new Date(pt.x).getTime(); return t >= dateStart && t <= dateEnd; }),
            borderColor: borderColor + '28',
            backgroundColor: 'transparent',
            borderWidth: 1, pointRadius: 0, pointHoverRadius: 0, tension: 0.1, fill: false,
          });
        });

        const medianData = buf.median
          .map((pt: { x: string; y: number }) => ({ x: toIsoDate(pt.x), y: pt.y * k }))
          .filter((pt: { x: string; y: number }) => { const t = new Date(pt.x).getTime(); return t >= dateStart && t <= dateEnd; });
        datasetList.push({
          label: `${baseLabel} median`,
          _series: tag('median'),
          _baseLabel: baseLabel,
          _unit: unit,
          yAxisID,
          data: medianData,
          borderColor, backgroundColor: borderColor,
          borderWidth: 0, fill: false,
          ...look, showLine: false, pointRadius: look.pointRadius || ms,
          ...refDateMarker(medianData, refIso, borderColor, borderColor, look.pointRadius || ms),
        });
      } else {
        const isoData = dataset.data
          .map(pt => ({ x: toIsoDate(pt.x as string), y: pt.y * k }))
          .filter(pt => { const t = new Date(pt.x).getTime(); return t >= dateStart && t <= dateEnd; });

        datasetList.push({
          label: baseLabel,
          _series: tag('data'),
          _baseLabel: baseLabel,
          _unit: unit,
          _trendMmPerYear: trendRate(dsName, dataset.pointId),
          _rateUnit: rateUnit,
          yAxisID,
          data: isoData,
          borderColor,
          backgroundColor,
          borderWidth: 2, tension: 0.1, fill: false,
          ...look,
          ...refDateMarker(isoData, refIso, borderColor, backgroundColor, look.pointRadius),
        });

        const fit = fits[`${dsName}::${dataset.pointId}`]?.fit;
        if (state.showTrends && fit && isoData.length > 1) {
          datasetList.push({
            label: `${baseLabel} trend`,
            _series: tag('model'),
            _baseLabel: baseLabel,
            _unit: unit,
            _trendMmPerYear: trendRate(dsName, dataset.pointId),
            yAxisID,
            data: modelCurve(fit),
            spanGaps: false,
            // Drawn in front of the points (Chart.js draws the lowest order last), in the point's colour
            // so each model reads with its point; thick and dashed so it stands out from the markers.
            order: -1,
            borderColor,
            backgroundColor: 'transparent',
            borderWidth: 2.5, borderDash: [8, 4], pointRadius: 0, pointHoverRadius: 0, tension: 0, fill: false,
          });

          if (state.showResiduals) {
            datasetList.push({
              label: `${baseLabel} residual`,
              _series: tag('residual'),
              _baseLabel: baseLabel,
              _unit: unit,
              yAxisID,
              data: isoData.map(pt => ({ x: pt.x, y: pt.y - fit.predict(Date.parse(`${pt.x.slice(0, 10)}T00:00:00Z`)) })),
              borderColor, backgroundColor,
              borderWidth: 1, borderDash: [2, 3],
              pointRadius: ms > 2 ? ms - 1 : 2, pointHoverRadius: ms + 1, tension: 0, fill: false,
            });
          }
        }
      }
    });
  });

  const formattedChartData = { labels: isoLabels, datasets: [...datasetList, ...areaDatasets] };
  const minDate = allIsoLabels[0] ?? '';
  const maxDate = allIsoLabels[allIsoLabels.length - 1] ?? '';
  const sliderStart = state.dateRangeStart ?? minDate;
  const sliderEnd   = state.dateRangeEnd   ?? maxDate;
  snapRef.current = snapshot('ready', formattedChartData.datasets, undefined, isoLabels);

  return (
    <div id="chart-container" ref={panelRef} style={panelStyle}>
      {headerContent}

      {/* Display options, folded: what they set still applies, and "(custom)" says so. */}
      {(() => {
        const custom = !!(state.dateRangeStart || state.dateRangeEnd)
          || activeChartDs.some(ds => (dsOffsets[ds] ?? 0) !== 0 || !!dsYLimits[ds]?.min || !!dsYLimits[ds]?.max);
        return (
          <button type="button" className="chart-fold" data-command="chart.display_options" aria-expanded={displayOpen} onClick={toggleDisplay}
            title={custom ? 'Display options (a custom date range, offset or y limits applies)' : 'Display options'}>
            <span className={`disclosure-chevron${displayOpen ? ' open' : ''}`} aria-hidden="true" />
            Display options
            {custom && <span className="chart-fold-custom">(custom)</span>}
          </button>
        );
      })()}
      {displayOpen && <>
      {/* Marker size + date range sliders */}
      <div className="chart-sliders">
        <label className="chart-slider-label">
          <span>Marker</span>
          <input type="range" min={1} max={12} step={1} value={state.markerSize}
            onChange={e => dispatch({ type: 'SET_MARKER_SIZE', payload: Number(e.target.value) })} />
          <span>{state.markerSize}px</span>
        </label>
        {allIsoLabels.length > 1 && (
          <>
            <label className="chart-slider-label">
              <span>From</span>
              <input type="date" min={minDate} max={sliderEnd || maxDate} value={sliderStart}
                onChange={e => dispatch({ type: 'SET_DATE_RANGE_START', payload: e.target.value || null })} />
            </label>
            <label className="chart-slider-label">
              <span>To</span>
              <input type="date" min={sliderStart || minDate} max={maxDate} value={sliderEnd}
                onChange={e => dispatch({ type: 'SET_DATE_RANGE_END', payload: e.target.value || null })} />
            </label>
            {(state.dateRangeStart || state.dateRangeEnd) && (
              <button className="chart-btn" title="Reset date range"
                onClick={() => { dispatch({ type: 'SET_DATE_RANGE_START', payload: null }); dispatch({ type: 'SET_DATE_RANGE_END', payload: null }); }}>
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </>
        )}
      </div>

      {/* Per-dataset controls (offset + colour of the layer's series and y axis) — shown for ALL datasets when multiple */}
      {activeChartDs.map((ds, i) => {
        const off = dsOffsets[ds] ?? 0;
        const baseColor = chartDataMap[ds]?.datasets[0]?.borderColor
          ?? visibleAreas.find(a => areaResults[`${ds}::${a.id}`]?.data)?.color ?? '#7880a8';
        const color = dsColorOverrides[ds] ?? baseColor;
        const info = state.datasetInfo[ds];
        const unit = displayUnit(info?.unit, state.units).label;
        const allY = chartDataMap[ds]?.datasets.flatMap(d => d.data.map(pt => pt.y * displayUnit(info?.unit, state.units).factor)) ?? [];
        const dataSpan = allY.length > 1 ? Math.max(...allY) - Math.min(...allY) : 1;
        const sliderRange = Math.max(dataSpan * 2, 0.001);
        const step = parseFloat((sliderRange / 500).toPrecision(2));
        const lim = dsYLimits[ds] ?? { min: '', max: '' };
        const hasLimit = lim.min !== '' || lim.max !== '';
        const inputStyle: React.CSSProperties = { width: 58, fontSize: '0.72em', background: 'var(--sb-surface2)', border: '1px solid var(--sb-border)', borderRadius: 4, color: 'var(--sb-text)', padding: '1px 4px', textAlign: 'right', flexShrink: 0 };
        return (
          <div key={ds} className="chart-sliders" style={{ borderTop: i === 0 ? undefined : 'none', paddingTop: i === 0 ? undefined : 0, flexWrap: 'wrap', rowGap: 2 }}>
            {/* Row 1: color + name + offset slider — only when multiple datasets */}
            {multiDs && (
              <label className="chart-slider-label" style={{ flex: '1 1 100%' }}>
                <input type="color" value={color.length === 7 ? color : baseColor}
                  style={{ width: 20, height: 20, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                  title="Colour of this layer's series and y axis"
                  onChange={e => setDsColorOverrides(prev => ({ ...prev, [ds]: e.target.value }))}
                />
                <span style={{ color, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80 }} title={ds}>{ds}</span>
                <span style={{ fontSize: '0.72em', color: 'var(--sb-muted)', flexShrink: 0 }}>y{i} off</span>
                <input type="range" min={-sliderRange} max={sliderRange} step={step}
                  value={off} style={{ flex: 1 }}
                  onChange={e => setDsOffsets(prev => ({ ...prev, [ds]: Number(e.target.value) }))}
                />
                <input type="number" step={step} value={parseFloat(off.toPrecision(4))}
                  style={{ ...inputStyle }}
                  onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setDsOffsets(prev => ({ ...prev, [ds]: v })); }}
                />
                {off !== 0 && (
                  <button className="chart-btn" style={{ padding: '1px 6px', flexShrink: 0 }}
                    onClick={() => setDsOffsets(prev => ({ ...prev, [ds]: 0 }))} title="Reset offset">✕</button>
                )}
              </label>
            )}
            {/* Row 2: y-axis min/max limits */}
            <label className="chart-slider-label" style={{ flex: '1 1 100%', gap: 4 }}>
              <span style={{ fontSize: '0.72em', color: 'var(--sb-muted)', flexShrink: 0 }}>y{i} min</span>
              <input type="number" placeholder="auto" value={lim.min} style={{ ...inputStyle, flex: 1 }}
                onChange={e => setDsYLimits(prev => ({ ...prev, [ds]: { ...lim, min: e.target.value } }))}
              />
              <span style={{ fontSize: '0.72em', color: 'var(--sb-muted)', flexShrink: 0 }}>max</span>
              <input type="number" placeholder="auto" value={lim.max} style={{ ...inputStyle, flex: 1 }}
                onChange={e => setDsYLimits(prev => ({ ...prev, [ds]: { ...lim, max: e.target.value } }))}
              />
              <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', flexShrink: 0 }}>{unit}</span>
              {hasLimit && (
                <button className="chart-btn" style={{ padding: '1px 6px', flexShrink: 0 }}
                  onClick={() => setDsYLimits(prev => ({ ...prev, [ds]: { min: '', max: '' } }))} title="Reset y limits">✕</button>
              )}
            </label>
          </div>
        );
      })}
      </>}

      <div className="chart-content">
        <Line ref={chartRef} data={formattedChartData} options={chartOptions as any} />
      </div>
      {state.showTrends && Object.keys(fits).length > 0 && (
        <div className="model-summary">
          {Object.entries(fits).map(([key, { fit }]) => {
            const [dsName, pointId] = key.split('::');
            const name = state.timeSeriesPoints.find(p => p.id === pointId)?.name ?? pointId;
            const shown = displayUnit(state.datasetInfo[dsName]?.unit, state.units);
            return <div key={key}><b>{multiDs ? `${name} [${dsName}]` : name}</b>: {describeFit(fit, shown.rate?.factor ?? null, shown.rate?.label ?? shown.label)}</div>;
          })}
        </div>
      )}
      <div className="chart-help">
        <small>
          {picking ? `Click the chart where the ${picking} goes · ` : ''}Scroll to zoom · Drag to pan · Click points to sync map time
          {visibleAreas.length > 0 && <> · Areas use common valid pixels</>}
          {visibleAreas.some(a => activeDatasetsForChart.some(ds => areaResults[areaStatsKey(ds, a.id)]?.data?.optional_masks_applied)) && <> · Area quality masks applied</>}
          {state.bufferEnabled && Object.keys(bufferData).length > 0 && (
            <> · Buffer: {Object.values(bufferData).map((b: any) => b.n_pixels).join(', ')} px</>
          )}
        </small>
      </div>
      {resizeGrip}
    </div>
  );
}
