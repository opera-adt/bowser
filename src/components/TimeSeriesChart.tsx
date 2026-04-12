import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Chart as ChartJS, TimeScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, InteractionItem } from 'chart.js';
import { Line } from 'react-chartjs-2';
import 'chartjs-adapter-date-fns';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { MultiPointTimeSeriesData } from '../types';

ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, zoomPlugin);

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

/** Convert "YYYYMMDD_YYYYMMDD" or "YYYYMMDD" → "YYYY-MM-DD" (secondary/only date). */
function toIsoDate(xVal: string): string {
  const dateStr = xVal.includes('_') ? xVal.split('_').pop()! : xVal;
  if (/^\d{8}$/.test(dateStr)) {
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  return xVal;
}

interface BufferResult {
  labels: string[];
  median: Array<{ x: string; y: number }>;
  samples: Array<Array<{ x: string; y: number }>>;
  n_pixels: number;
}

export default function TimeSeriesChart() {
  const { state, dispatch } = useAppContext();
  const { fetchMultiPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const themeVersion = useThemeVersion();
  const [chartData, setChartData] = useState<MultiPointTimeSeriesData | null>(null);
  const [bufferData, setBufferData] = useState<{ [pointId: string]: BufferResult }>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const chartRef = useRef<ChartJS<'line'>>(null);

  const updateChart = useCallback(async () => {
    if (!state.showChart || !state.currentDataset || state.timeSeriesPoints.length === 0) {
      setChartData(null);
      return;
    }
    setIsLoading(true);
    const currentDatasetInfo = state.datasetInfo[state.currentDataset];
    const visiblePoints = state.timeSeriesPoints.filter(p => p.visible);
    if (visiblePoints.length === 0) {
      setChartData(null);
      setIsLoading(false);
      return;
    }
    try {
      const apiPoints = visiblePoints.map(point => ({
        id: point.id,
        lat: point.position[0],
        lon: point.position[1],
        color: point.color,
        name: point.name,
      }));
      let refLon, refLat;
      if (currentDatasetInfo?.uses_spatial_ref && state.refEnabled) {
        [refLat, refLon] = state.refMarkerPosition;
      }
      const tsData = await fetchMultiPointTimeSeries(
        apiPoints, state.currentDataset, refLon, refLat, state.showTrends,
        state.layerMasks,
        state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : 0,
      );
      if (tsData) {
        setChartData(tsData);
        if (state.showTrends && tsData.datasets) {
          setTimeout(() => {
            tsData.datasets.forEach(dataset => {
              if (dataset.trend) {
                dispatch({
                  type: 'SET_POINT_TREND_DATA',
                  payload: {
                    pointId: dataset.pointId,
                    dataset: state.currentDataset,
                    trend: {
                      slope: dataset.trend.slope,
                      intercept: dataset.trend.intercept,
                      rSquared: dataset.trend.rSquared,
                      mmPerYear: dataset.trend.mmPerYear,
                    },
                  },
                });
              }
            });
          }, 0);
        }
      }
    } catch (error) {
      console.error('Error updating chart:', error);
    } finally {
      setIsLoading(false);
    }
  }, [
    state.showChart,
    state.currentDataset,
    JSON.stringify(state.timeSeriesPoints.map(p => ({ id: p.id, position: p.position, visible: p.visible }))),
    state.refMarkerPosition,
    state.refEnabled,
    state.datasetInfo,
    state.showTrends,
    state.layerMasks,
    fetchMultiPointTimeSeries,
  ]);

  useEffect(() => { updateChart(); }, [updateChart]);

  // Fetch buffer data for each visible point when buffer mode is enabled
  useEffect(() => {
    if (!state.bufferEnabled || !state.showChart || !state.currentDataset) {
      setBufferData({});
      return;
    }
    const visiblePoints = state.timeSeriesPoints.filter(p => p.visible);
    if (visiblePoints.length === 0) { setBufferData({}); return; }

    const currentDatasetInfo = state.datasetInfo[state.currentDataset];
    let refLon: number | undefined, refLat: number | undefined;
    if (currentDatasetInfo?.uses_spatial_ref && state.refEnabled) {
      [refLat, refLon] = state.refMarkerPosition;
    }

    Promise.all(
      visiblePoints.map(async p => {
        const result = await fetchBufferTimeSeries(
          p.position[1], p.position[0],
          state.currentDataset,
          state.bufferRadius,
          state.bufferSamples,
          refLon, refLat,
          state.layerMasks,
          state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : 0,
        );
        return { id: p.id, result };
      })
    ).then(results => {
      const newData: { [id: string]: any } = {};
      results.forEach(({ id, result }) => { if (result) newData[id] = result; });
      setBufferData(newData);
    });
  }, [
    state.bufferEnabled,
    state.showChart,
    state.currentDataset,
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

  const handleChartClick = useCallback((_event: any, elements: InteractionItem[]) => {
    if (elements.length === 0 || !chartData) return;
    const dataIndex = elements[0].index;
    if (dataIndex !== undefined && dataIndex < chartData.labels.length) {
      dispatch({ type: 'SET_TIME_INDEX', payload: dataIndex });
    }
  }, [chartData, dispatch]);

  const handleExportToCSV = useCallback(() => {
    if (!chartData || !chartData.datasets || chartData.datasets.length === 0) return;
    const headers = ['Time', ...chartData.datasets.map(d => d.label)];
    const rows: string[][] = [];
    chartData.labels.forEach((label, idx) => {
      const row = [label];
      chartData.datasets.forEach(dataset => {
        const dataPoint = dataset.data[idx];
        row.push(dataPoint ? dataPoint.y.toString() : '');
      });
      rows.push(row);
    });
    const trendRows: string[][] = [];
    if (state.showTrends && chartData.datasets.some(d => d.trend)) {
      trendRows.push(['']);
      trendRows.push(['Point', 'Rate (mm/year)', 'R²', 'Slope', 'Intercept']);
      chartData.datasets.forEach(dataset => {
        if (dataset.trend) {
          trendRows.push([
            dataset.label,
            dataset.trend.mmPerYear.toFixed(6),
            dataset.trend.rSquared.toFixed(6),
            dataset.trend.slope.toFixed(6),
            dataset.trend.intercept.toFixed(6),
          ]);
        }
      });
    }
    const csvContent = [headers, ...rows, ...trendRows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    link.setAttribute('href', url);
    link.setAttribute('download', `time-series-${state.currentDataset}-${timestamp}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [chartData, state.showTrends, state.currentDataset]);

  const chartOptions = useMemo(() => {
    const textColor  = cssVar('--sb-text',   '#dde0f0');
    const mutedColor = cssVar('--sb-muted',  '#7880a8');
    const gridColor  = cssVar('--sb-border', '#2c2f4a');
    const dsInfo = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;
    const yLabel = dsInfo?.label && dsInfo?.unit
      ? `${dsInfo.label} (${dsInfo.unit})`
      : dsInfo?.label || dsInfo?.unit || 'Displacement (m)';
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
              if (!chartData?.datasets) return [];
              return chart.data.datasets
                .map((ds: any, index: number) => ({ ds, index }))
                .filter(({ ds }: any) =>
                  !ds.label.endsWith(' trend') &&
                  !ds.label.endsWith(' residual') &&
                  !ds.label.includes(' sample ') &&
                  !ds.label.endsWith(' median')
                )
                .map(({ ds, index }: any) => ({
                  text: ds.label + (ds.label && chartData.datasets.find(d => d.label === ds.label)?.trend?.mmPerYear !== undefined
                    ? ` (${chartData.datasets.find(d => d.label === ds.label)!.trend!.mmPerYear.toFixed(1)} mm/yr)`
                    : ''),
                  pointStyle: 'circle' as const,
                  fillStyle: ds.borderColor,
                  strokeStyle: ds.borderColor,
                  fontColor: textColor,
                  lineWidth: 2,
                  datasetIndex: index,
                }));
            },
          },
        },
        tooltip: {
          callbacks: {
            title: (context: any) => `${context[0]?.label || ''}`,
            label: (context: any) => {
              const dataset = chartData?.datasets?.[context.datasetIndex];
              if (!dataset) return '';
              const unit = dsInfo?.unit || 'm';
              let label = `${dataset.label}: ${context.parsed.y.toFixed(4)} ${unit}`;
              if (dataset.trend?.mmPerYear !== undefined && state.showTrends) {
                label += ` (${dataset.trend.mmPerYear.toFixed(1)} mm/yr)`;
              }
              return label;
            },
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x' as const,
            onPanComplete: () => setIsZoomed(true),
          },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x' as const,
            onZoomComplete: () => setIsZoomed(true),
          },
        },
      },
      scales: {
        x: {
          type: 'time' as const,
          time: { displayFormats: { month: 'MMM yyyy', day: 'MMM d', year: 'yyyy' } },
          title: { display: true, text: 'Date', color: mutedColor },
          grid: { color: gridColor },
          ticks: { color: mutedColor },
        },
        y: {
          title: { display: true, text: yLabel, color: mutedColor },
          suggestedMin: state.vmin,
          suggestedMax: state.vmax,
          grid: { color: gridColor },
          ticks: { color: mutedColor },
        },
      },
      onClick: handleChartClick,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion, chartData, state.showTrends, state.vmin, state.vmax, state.currentDataset, state.datasetInfo, handleChartClick]);

  if (!state.showChart) return null;

  if (state.timeSeriesPoints.length === 0) {
    return (
      <div id="chart-container">
        <div className="chart-placeholder">
          <p>No points selected.</p>
          <p><small>Click on the map to add points.</small></p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div id="chart-container">
        <div className="chart-placeholder"><p>Loading…</p></div>
      </div>
    );
  }

  if (!chartData || !chartData.datasets || chartData.datasets.length === 0) {
    return (
      <div id="chart-container">
        <div className="chart-placeholder"><p>No data for selected points.</p></div>
      </div>
    );
  }

  // Transform x-values to ISO dates so Chart.js time scale can parse them
  const isoLabels = chartData.labels.map(toIsoDate);

  // Convert ISO date string to days since first label (matches backend regression basis)
  const day0 = isoLabels.length > 0 ? new Date(isoLabels[0]).getTime() / 86400000 : 0;
  const isoToDay = (iso: string) => new Date(iso).getTime() / 86400000 - day0;

  const datasetList: any[] = [];
  chartData.datasets.forEach(dataset => {
    const isoData = dataset.data.map(pt => ({ x: toIsoDate(pt.x as string), y: pt.y }));
    datasetList.push({
      label: dataset.label,
      data: isoData,
      borderColor: dataset.borderColor,
      backgroundColor: dataset.backgroundColor,
      borderWidth: 2,
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.1,
      fill: false,
    });

    // Add dashed trend line if trends are enabled and data exists
    if (state.showTrends && dataset.trend && isoData.length > 1) {
      const { slope, intercept } = dataset.trend;
      const trendData = isoData.map(pt => ({
        x: pt.x,
        y: slope * isoToDay(pt.x) + intercept,
      }));
      datasetList.push({
        label: `${dataset.label} trend`,
        data: trendData,
        borderColor: dataset.borderColor,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0,
        fill: false,
      });

      // Residuals: actual - trend
      if (state.showResiduals) {
        const residualData = isoData.map(pt => ({
          x: pt.x,
          y: pt.y - (slope * isoToDay(pt.x) + intercept),
        }));
        datasetList.push({
          label: `${dataset.label} residual`,
          data: residualData,
          borderColor: dataset.borderColor,
          backgroundColor: dataset.backgroundColor,
          borderWidth: 1,
          borderDash: [2, 3],
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0,
          fill: false,
          borderDashOffset: 0,
        });
      }
    }
  });

  // Append buffer sample + median datasets (thin lines behind points)
  if (state.bufferEnabled) {
    chartData.datasets.forEach(dataset => {
      const buf = bufferData[dataset.pointId];
      if (!buf) return;
      const color = dataset.borderColor;

      // Sample lines — thin, semi-transparent, no points, not in legend
      buf.samples.forEach((sample: Array<{ x: string; y: number }>, i: number) => {
        datasetList.push({
          label: `${dataset.label} sample ${i}`,
          data: sample.map(pt => ({ x: toIsoDate(pt.x), y: pt.y })),
          borderColor: color + '28',
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.1,
          fill: false,
        });
      });

      // Median line — same color, thick, dashed, no points
      datasetList.push({
        label: `${dataset.label} median`,
        data: buf.median.map((pt: { x: string; y: number }) => ({ x: toIsoDate(pt.x), y: pt.y })),
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 3,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.1,
        fill: false,
      });
    });
  }

  const formattedChartData = { labels: isoLabels, datasets: datasetList };

  return (
    <div id="chart-container">
      <div className="chart-header">
        <h4>Time Series</h4>
        <div className="chart-controls">
          <button
            className="chart-btn"
            onClick={() => dispatch({ type: 'TOGGLE_TRENDS' })}
            title="Toggle trend analysis"
          >
            <i className={`fa-solid ${state.showTrends ? 'fa-chart-line' : 'fa-chart-simple'}`}></i>
            {state.showTrends ? 'Hide' : 'Show'} Trends
          </button>
          {state.showTrends && (
            <button
              className="chart-btn"
              onClick={() => dispatch({ type: 'TOGGLE_RESIDUALS' })}
              title="Show residuals (data minus trend)"
            >
              <i className={`fa-solid ${state.showResiduals ? 'fa-wave-square' : 'fa-chart-scatter'}`}></i>
              {state.showResiduals ? 'Hide' : 'Show'} Residuals
            </button>
          )}
          {isZoomed && (
            <button
              className="chart-btn"
              onClick={() => { chartRef.current?.resetZoom(); setIsZoomed(false); }}
              title="Reset zoom"
            >
              <i className="fa-solid fa-magnifying-glass-minus"></i> Reset
            </button>
          )}
          <button className="chart-btn" onClick={handleExportToCSV} title="Export data to CSV">
            <i className="fa-solid fa-download"></i> CSV
          </button>
        </div>
      </div>
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
    </div>
  );
}
