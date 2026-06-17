import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDraggableResizable } from '../hooks/useDraggableResizable.tsx';
import { Chart as ChartJS, TimeScale, LinearScale, CategoryScale, PointElement, LineElement, Title, Tooltip, Legend, InteractionItem } from 'chart.js';
import { Line } from 'react-chartjs-2';
import 'chartjs-adapter-date-fns';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { MultiPointTimeSeriesData } from '../types';
import { downloadChartAsPng } from '../utils/screenshot';

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

ChartJS.register(TimeScale, LinearScale, CategoryScale, PointElement, LineElement, Title, Tooltip, Legend, zoomPlugin);

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

/** Convert "YYYYMMDD_YYYYMMDD" or "YYYYMMDD" → "YYYY-MM-DD" (secondary/only date).
 *
 * Stringify defensively: some datasets surface numeric x-values (e.g.
 * integer indices when a dim has no date coord), and Chart.js hands them
 * straight to us. Without this, `.includes` throws on the numeric branch.
 */
function toIsoDate(xVal: string | number): string {
  const s = typeof xVal === 'string' ? xVal : String(xVal);
  const dateStr = s.includes('_') ? s.split('_').pop()! : s;
  if (/^\d{8}$/.test(dateStr)) {
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  return s;
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
  const [chartDataMap, setChartDataMap] = useState<{ [ds: string]: MultiPointTimeSeriesData }>({});
  const [bufferData, setBufferData] = useState<{ [key: string]: BufferResult }>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  // Per-dataset vertical offset (in data units) for separating overlapping layers
  const [dsOffsets, setDsOffsets] = useState<{ [ds: string]: number }>({});
  // Per-dataset color overrides (keyed by dsName, overrides all points in that dataset)
  const [dsColorOverrides, setDsColorOverrides] = useState<{ [ds: string]: string }>({});
  // Per-dataset y-axis limits; empty string = auto
  const [dsYLimits, setDsYLimits] = useState<{ [ds: string]: { min: string; max: string } }>({});
  const chartRef = useRef<ChartJS<'line'>>(null);
  const { panelRef, panelStyle, onDragMouseDown, resizeGrip } = useDraggableResizable({
    defaultWidth: Math.min(560, window.innerWidth * 0.38),
    defaultHeight: 420,
  });

  // Datasets for this window: window's dsNames if set, else follow currentDataset
  const winDsNames = window_?.dsNames ?? [];
  const activeDatasetsForChart: string[] = winDsNames.length > 0
    ? winDsNames
    : (state.currentDataset ? [state.currentDataset] : []);

  const updateChart = useCallback(async () => {
    if (!state.showChart || !state.currentDataset || state.timeSeriesPoints.length === 0) {
      setChartDataMap({});
      return;
    }
    setIsLoading(true);
    const visiblePoints = state.timeSeriesPoints.filter(p => p.visible);
    if (visiblePoints.length === 0) {
      setChartDataMap({});
      setIsLoading(false);
      return;
    }
    // Skip datasets that have no time dimension (e.g. velocity, coherence scalars)
    const timeDatasets = activeDatasetsForChart.filter(ds => {
      const info = state.datasetInfo[ds];
      return info && Array.isArray(info.x_values) && info.x_values.length > 0;
    });
    if (timeDatasets.length === 0) {
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
        timeDatasets.map(async dsName => {
          const dsInfo = state.datasetInfo[dsName];
          let refLon: number | undefined, refLat: number | undefined;
          if (dsInfo?.uses_spatial_ref && state.refEnabled) {
            [refLat, refLon] = state.refMarkerPosition;
          }
          const tsData = await fetchMultiPointTimeSeries(
            apiPoints, dsName, refLon, refLat, state.showTrends,
            state.layerMasks,
            state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : 0,
          );
          return { dsName, tsData };
        })
      );
      const newMap: { [ds: string]: MultiPointTimeSeriesData } = {};
      results.forEach(({ dsName, tsData }) => {
        if (tsData) {
          newMap[dsName] = tsData;
          if (state.showTrends) {
            setTimeout(() => {
              tsData.datasets.forEach(dataset => {
                if (dataset.trend) {
                  dispatch({
                    type: 'SET_POINT_TREND_DATA',
                    payload: {
                      pointId: dataset.pointId,
                      dataset: dsName,
                      trend: dataset.trend,
                    },
                  });
                }
              });
            }, 0);
          }
        }
      });
      setChartDataMap(newMap);
    } catch (error) {
      console.error('Error updating chart:', error);
    } finally {
      setIsLoading(false);
    }
  }, [
    state.showChart,
    state.currentDataset,
    JSON.stringify(activeDatasetsForChart),
    JSON.stringify(state.timeSeriesPoints.map(p => ({ id: p.id, position: p.position, visible: p.visible }))),
    state.refMarkerPosition,
    state.refEnabled,
    state.datasetInfo,
    state.showTrends,
    state.layerMasks,
    fetchMultiPointTimeSeries,
  ]);

  useEffect(() => { updateChart(); }, [updateChart]);

  // Fetch buffer data for each visible point × each active dataset
  useEffect(() => {
    if (!state.bufferEnabled || !state.showChart || !state.currentDataset) {
      setBufferData({});
      return;
    }
    const visiblePoints = state.timeSeriesPoints.filter(p => p.visible);
    if (visiblePoints.length === 0) { setBufferData({}); return; }

    const timeDatasets = activeDatasetsForChart.filter(ds => {
      const info = state.datasetInfo[ds];
      return info && Array.isArray(info.x_values) && info.x_values.length > 0;
    });
    if (timeDatasets.length === 0) { setBufferData({}); return; }
    Promise.all(
      timeDatasets.flatMap(dsName => {
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
      const newData: { [key: string]: any } = {};
      results.forEach(({ key, result }) => { if (result) newData[key] = result; });
      setBufferData(newData);
    });
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
    JSON.stringify(state.timeSeriesPoints.map(p => ({ id: p.id, position: p.position, visible: p.visible }))),
    state.refMarkerPosition,
    fetchBufferTimeSeries,
  ]);

  // Derive a single merged chartData view from chartDataMap for click/export
  // Use the first available dataset as the canonical labels source
  const firstDs = Object.values(chartDataMap)[0] ?? null;

  const handleChartClick = useCallback((_event: any, elements: InteractionItem[]) => {
    if (elements.length === 0 || !firstDs) return;
    const dataIndex = elements[0].index;
    if (dataIndex !== undefined && dataIndex < firstDs.labels.length) {
      dispatch({ type: 'SET_TIME_INDEX', payload: dataIndex });
    }
  }, [firstDs, dispatch]);

  const handleExportToCSV = useCallback(() => {
    if (!firstDs) return;
    const allDatasets = Object.entries(chartDataMap).flatMap(([dsName, cd]) =>
      cd.datasets.map(d => ({ ...d, _dsName: dsName }))
    );
    if (allDatasets.length === 0) return;
    const multiDs = activeDatasetsForChart.length > 1;
    const headers = ['Time', ...allDatasets.map(d => multiDs ? `${d._dsName} — ${d.label}` : d.label)];
    const byLabel: Record<string, Record<string, number>> = {};
    allDatasets.forEach(d => {
      const key = multiDs ? `${d._dsName}::${d.label}` : d.label;
      d.data.forEach(pt => { (byLabel[pt.x as string] ??= {})[key] = pt.y; });
    });
    const allTimes = [...new Set(allDatasets.flatMap(d => d.data.map(pt => pt.x as string)))].sort();
    const rows = allTimes.map(t => {
      const row = [t];
      allDatasets.forEach(d => {
        const key = multiDs ? `${d._dsName}::${d.label}` : d.label;
        row.push(byLabel[t]?.[key]?.toString() ?? '');
      });
      return row;
    });
    const csvContent = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.setAttribute('href', URL.createObjectURL(blob));
    link.setAttribute('download', `time-series-${state.currentDataset}-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [chartDataMap, firstDs, activeDatasetsForChart, state.currentDataset]);

  // Ordered list of dataset names currently in chartDataMap
  const activeChartDs = Object.keys(chartDataMap);

  const chartOptions = useMemo(() => {
    const textColor  = cssVar('--sb-text',   '#dde0f0');
    const mutedColor = cssVar('--sb-muted',  '#7880a8');
    const gridColor  = cssVar('--sb-border', '#2c2f4a');

    const referenceDate = state.currentDataset
      ? state.datasetInfo[state.currentDataset]?.reference_date
      : null;

    // Determine x-axis scale type from label format of the first active dataset:
    // - integer → linear; "YYYY-MM-DD_YYYY-MM-DD" → category; ISO date → time
    const firstLabel = activeChartDs.length > 0
      ? chartDataMap[activeChartDs[0]]?.labels?.[0]
      : undefined;
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
      const yLabel = info?.label && info?.unit
        ? `${info.label} (${info.unit})`
        : info?.label || info?.unit || ds;
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
              const isBuffer = chart.data.datasets.some((ds: any) => ds.label?.endsWith(' median'));
              return chart.data.datasets
                .map((ds: any, index: number) => ({ ds, index }))
                .filter(({ ds }: any) => {
                  if (ds.label.includes(' sample ')) return false;
                  if (ds.label.endsWith(' trend')) return false;
                  if (ds.label.endsWith(' residual')) return false;
                  if (isBuffer) return ds.label.endsWith(' median');
                  return !ds.label.endsWith(' median');
                })
                .map(({ ds, index }: any) => {
                  const baseLabel = (ds as any)._baseLabel || ds.label;
                  const trendMmPerYear = (ds as any)._trendMmPerYear;
                  const displayText = baseLabel + (trendMmPerYear !== undefined && state.showTrends
                    ? ` (${trendMmPerYear.toFixed(1)} mm/yr)` : '');
                  return {
                    text: displayText,
                    pointStyle: 'circle' as const,
                    fillStyle: ds.borderColor,
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
              const mmPy = (ds as any)._trendMmPerYear;
              if (mmPy !== undefined && state.showTrends) label += ` (${mmPy.toFixed(1)} mm/yr)`;
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
  }, [themeVersion, state.showTrends, state.vmin, state.vmax, state.datasetInfo, state.bufferEnabled, handleChartClick, JSON.stringify(activeChartDs), JSON.stringify(dsOffsets), JSON.stringify(dsColorOverrides), JSON.stringify(dsYLimits), JSON.stringify(Object.fromEntries(Object.entries(chartDataMap).map(([k, v]) => [k, v.datasets.flatMap(d => d.data.map(pt => pt.y))]))) ]);

  if (!state.showChart) return null;

  // Dataset selector helpers
  const allDsNames = Object.keys(state.datasetInfo);
  const setWinDs = (dsNames: string[]) =>
    dispatch({ type: 'SET_CHART_WINDOW_DS', payload: { id: windowId, dsNames } });
  const addWinDs = (ds: string) => { if (!winDsNames.includes(ds)) setWinDs([...winDsNames, ds]); };
  const removeWinDs = (ds: string) => setWinDs(winDsNames.filter(d => d !== ds));
  const spawnNewChart = () => dispatch({
    type: 'ADD_CHART_WINDOW',
    payload: { id: `chart_${Date.now()}`, dsNames: [] },
  });
  const closeThis = () => dispatch({ type: 'REMOVE_CHART_WINDOW', payload: windowId });

  const headerContent = (
    <>
      <div className="chart-header" onMouseDown={onDragMouseDown} style={{ cursor: 'grab' }}>
        <h4 style={{ margin: 0, fontSize: '0.9em' }}>Time Series</h4>
        <div className="chart-controls">
          <button className="chart-btn" onClick={() => dispatch({ type: 'TOGGLE_TRENDS' })} title="Toggle trend analysis">
            <i className={`fa-solid ${state.showTrends ? 'fa-chart-line' : 'fa-chart-simple'}`}></i>
            {state.showTrends ? 'Trends ✓' : 'Trends'}
          </button>
          {state.showTrends && (
            <button className="chart-btn" onClick={() => dispatch({ type: 'TOGGLE_RESIDUALS' })} title="Show residuals">
              <i className="fa-solid fa-wave-square"></i>
              {state.showResiduals ? 'Resid ✓' : 'Resid'}
            </button>
          )}
          {isZoomed && (
            <button className="chart-btn" onClick={() => { chartRef.current?.resetZoom(); setIsZoomed(false); }} title="Reset zoom">
              <i className="fa-solid fa-magnifying-glass-minus"></i>
            </button>
          )}
          <button className="chart-btn" onClick={handleExportToCSV} title="Export CSV">
            <i className="fa-solid fa-download"></i>
          </button>
          <button className="chart-btn" title="Save as PNG (transparent background)" onClick={() => {
            const canvas = chartRef.current?.canvas;
            if (canvas) downloadChartAsPng(canvas, `timeseries-${state.currentDataset}-${Date.now()}.png`);
          }}>
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
          state.currentDataset ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px',
              background: 'var(--sb-surface2)', border: '1px solid var(--sb-border)',
              borderRadius: 10, fontSize: '0.72em', color: 'var(--sb-text)', flexShrink: 0,
            }}>
              {state.currentDataset}
              <button onClick={() => setWinDs(allDsNames.filter(d => d !== state.currentDataset))} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: 'var(--sb-muted)', fontSize: '0.9em', lineHeight: 1,
              }} title={`Remove ${state.currentDataset}`}>✕</button>
            </span>
          ) : (
            <span style={{ fontSize: '0.75em', color: 'var(--sb-muted)' }}>No layer selected</span>
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
          const excluded = winDsNames.length === 0
            ? [...winDsNames, state.currentDataset].filter(Boolean)
            : winDsNames;
          const available = allDsNames.filter((ds: string) => !excluded.includes(ds));
          return available.length > 0 ? (
            <select className="sidebar-select"
              style={{ fontSize: '0.72em', padding: '1px 4px', height: 22, flex: '0 0 auto', maxWidth: 130 }}
              value="" onChange={e => { if (e.target.value) { addWinDs(e.target.value); e.currentTarget.value = ''; } }}
            >
              <option value="">＋ layer…</option>
              {available.map((ds: string) => (
                <option key={ds} value={ds}>{ds}</option>
              ))}
            </select>
          ) : null;
        })()}
        {winDsNames.length > 0 && (
          <button className="chart-btn" style={{ fontSize: '0.7em', padding: '1px 5px' }}
            onClick={() => setWinDs([])} title="Reset to map layer">↺ reset</button>
        )}
      </div>
    </>
  );

  if (state.timeSeriesPoints.length === 0) {
    return (
      <div id="chart-container" ref={panelRef} style={panelStyle}>
        {headerContent}
        <div className="chart-placeholder">
          <p>No points selected.</p><p><small>Click on the map to add points.</small></p>
        </div>
        {resizeGrip}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div id="chart-container" ref={panelRef} style={panelStyle}>
        {headerContent}
        <div className="chart-placeholder"><p>Loading…</p></div>
        {resizeGrip}
      </div>
    );
  }

  if (Object.keys(chartDataMap).length === 0) {
    const allNoTime = activeDatasetsForChart.every((ds: string) => {
      const info = state.datasetInfo[ds];
      return info && Array.isArray(info.x_values) && info.x_values.length === 0;
    });
    return (
      <div id="chart-container" ref={panelRef} style={panelStyle}>
        {headerContent}
        <div className="chart-placeholder">
          {allNoTime
            ? <><p>Selected layer has no time dimension.</p><p><small>Switch to a time-series dataset to view the chart.</small></p></>
            : <p>No data for selected points.</p>
          }
        </div>
        {resizeGrip}
      </div>
    );
  }

  // ── Build unified dataset list from all active chart datasets ─────────────
  const multiDs = activeDatasetsForChart.length > 1;
  const dateStart = state.dateRangeStart ? new Date(state.dateRangeStart).getTime() : -Infinity;
  const dateEnd   = state.dateRangeEnd   ? new Date(state.dateRangeEnd).getTime()   : Infinity;

  // Collect all ISO dates across all datasets for the x-axis
  const allIsoLabels = [...new Set(
    Object.values(chartDataMap).flatMap(cd => cd.labels.map(toIsoDate))
  )].sort();

  const isoLabels = allIsoLabels.filter(d => {
    const t = new Date(d).getTime();
    return t >= dateStart && t <= dateEnd;
  });

  const day0 = allIsoLabels.length > 0 ? new Date(allIsoLabels[0]).getTime() / 86400000 : 0;
  const isoToDay = (iso: string) => new Date(iso).getTime() / 86400000 - day0;
  const ms = state.markerSize;

  const datasetList: any[] = [];

  Object.entries(chartDataMap).forEach(([dsName, cd]) => {
    const dsInfo = state.datasetInfo[dsName];
    const unit = dsInfo?.unit;
    const colorOverride = dsColorOverrides[dsName] ?? null;
    const axisIdx = activeChartDs.indexOf(dsName);
    const yAxisID = `y${axisIdx}`;

    cd.datasets.forEach(dataset => {
      const baseLabel = multiDs ? `${dataset.label} [${dsName}]` : dataset.label;
      const borderColor = colorOverride ?? dataset.borderColor;
      const backgroundColor = colorOverride ? colorOverride + '20' : dataset.backgroundColor;

      if (state.bufferEnabled) {
        const buf = bufferData[`${dsName}::${dataset.pointId}`];
        if (!buf) return;

        buf.samples.forEach((sample: Array<{ x: string; y: number }>, i: number) => {
          datasetList.push({
            label: `${baseLabel} sample ${i}`,
            _baseLabel: baseLabel,
            _unit: unit,
            yAxisID,
            data: sample
              .map(pt => ({ x: toIsoDate(pt.x), y: pt.y }))
              .filter(pt => { const t = new Date(pt.x).getTime(); return t >= dateStart && t <= dateEnd; }),
            borderColor: borderColor + '28',
            backgroundColor: 'transparent',
            borderWidth: 1, pointRadius: 0, pointHoverRadius: 0, tension: 0.1, fill: false,
          });
        });

        const medianData = buf.median
          .map((pt: { x: string; y: number }) => ({ x: toIsoDate(pt.x), y: pt.y }))
          .filter((pt: { x: string; y: number }) => { const t = new Date(pt.x).getTime(); return t >= dateStart && t <= dateEnd; });
        datasetList.push({
          label: `${baseLabel} median`,
          _baseLabel: baseLabel,
          _unit: unit,
          yAxisID,
          data: medianData,
          borderColor, backgroundColor: borderColor,
          borderWidth: 0, showLine: false, pointStyle: 'circle',
          pointRadius: ms, pointHoverRadius: ms + 2, fill: false,
        });
      } else {
        const isoData = dataset.data
          .map(pt => ({ x: toIsoDate(pt.x as string), y: pt.y }))
          .filter(pt => { const t = new Date(pt.x).getTime(); return t >= dateStart && t <= dateEnd; });

        datasetList.push({
          label: baseLabel,
          _baseLabel: baseLabel,
          _unit: unit,
          _trendMmPerYear: dataset.trend?.mmPerYear,
          yAxisID,
          data: isoData,
          borderColor,
          backgroundColor,
          borderWidth: 2, pointRadius: ms, pointHoverRadius: ms + 2, tension: 0.1, fill: false,
        });

        if (state.showTrends && dataset.trend && isoData.length > 1) {
          const { slope, intercept, mmPerYear } = dataset.trend;
          datasetList.push({
            label: `${baseLabel} trend`,
            _baseLabel: baseLabel,
            _unit: unit,
            _trendMmPerYear: mmPerYear,
            yAxisID,
            data: isoData.map(pt => ({ x: pt.x, y: slope * isoToDay(pt.x) + intercept })),
            borderColor, backgroundColor: 'transparent',
            borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0, tension: 0, fill: false,
          });

          if (state.showResiduals) {
            datasetList.push({
              label: `${baseLabel} residual`,
              _baseLabel: baseLabel,
              _unit: unit,
              yAxisID,
              data: isoData.map(pt => ({ x: pt.x, y: pt.y - (slope * isoToDay(pt.x) + intercept) })),
              borderColor, backgroundColor,
              borderWidth: 1, borderDash: [2, 3],
              pointRadius: ms > 2 ? ms - 1 : 2, pointHoverRadius: ms + 1, tension: 0, fill: false,
            });
          }
        }
      }
    });
  });

  const formattedChartData = { labels: isoLabels, datasets: datasetList };
  const minDate = allIsoLabels[0] ?? '';
  const maxDate = allIsoLabels[allIsoLabels.length - 1] ?? '';
  const sliderStart = state.dateRangeStart ?? minDate;
  const sliderEnd   = state.dateRangeEnd   ?? maxDate;

  return (
    <div id="chart-container" ref={panelRef} style={panelStyle}>
      {headerContent}

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

      {/* Per-dataset controls (offset + color) — shown for ALL datasets when multiple */}
      {activeChartDs.map((ds, i) => {
        const off = dsOffsets[ds] ?? 0;
        const baseColor = chartDataMap[ds]?.datasets[0]?.borderColor ?? '#7880a8';
        const color = dsColorOverrides[ds] ?? baseColor;
        const info = state.datasetInfo[ds];
        const unit = info?.unit || '';
        const allY = chartDataMap[ds]?.datasets.flatMap(d => d.data.map(pt => pt.y)) ?? [];
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
                  title="Change layer color"
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

      <div className="chart-content">
        <Line ref={chartRef} data={formattedChartData} options={chartOptions as any} />
      </div>
      <div className="chart-help">
        <small>
          Scroll to zoom · Drag to pan · Click points to sync map time
          {state.bufferEnabled && Object.keys(bufferData).length > 0 && (
            <> · Buffer: {Object.values(bufferData).map((b: any) => b.n_pixels).join(', ')} px</>
          )}
        </small>
      </div>
      {resizeGrip}
    </div>
  );
}
