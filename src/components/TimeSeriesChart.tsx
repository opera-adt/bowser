import { useMemo, useState, useCallback } from 'react';
import Plot from 'react-plotly.js';
import { useAppContext } from '../context/AppContext';

const COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
];

// Client-side linear regression on date strings → displacement values
function linearFit(dates: string[], values: number[]): { slope: number; intercept: number; r2: number; mmPerYear: number } | null {
  if (dates.length < 2) return null;

  // Convert dates to days since first date
  const t0 = new Date(dates[0]).getTime();
  const x = dates.map(d => (new Date(d).getTime() - t0) / 86_400_000); // days
  const y = values;
  const n = x.length;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, xi, i) => a + xi * y[i], 0);
  const sumXX = x.reduce((a, xi) => a + xi * xi, 0);

  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R²
  const meanY = sumY / n;
  const ssRes = y.reduce((a, yi, i) => a + (yi - (slope * x[i] + intercept)) ** 2, 0);
  const ssTot = y.reduce((a, yi) => a + (yi - meanY) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // mm/year: slope is mm/day
  const mmPerYear = slope * 365.25;

  return { slope, intercept, r2, mmPerYear };
}

export default function TimeSeriesChart() {
  const { state, dispatch } = useAppContext();
  const hasMultipleClicked = state.clickedPoints.length > 1;
  const [showTrends, setShowTrends] = useState(false);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const isLight = state.chartTheme === 'light';

  const exportScreenshot = useCallback(async () => {
    // Capture map canvas
    const mapCanvas = document.querySelector('.map-container canvas') as HTMLCanvasElement | null;
    // Capture Plotly chart
    const plotDiv = document.querySelector('.js-plotly-plot') as HTMLElement | null;

    const combinedCanvas = document.createElement('canvas');
    const ctx = combinedCanvas.getContext('2d');
    if (!ctx) return;

    const mapW = mapCanvas?.width || 1400;
    const mapH = mapCanvas?.height || 600;
    const chartH = 300;
    const scale = 2; // High-res export

    combinedCanvas.width = mapW;
    combinedCanvas.height = mapH + chartH;
    ctx.fillStyle = isLight ? '#ffffff' : '#1a1a2e';
    ctx.fillRect(0, 0, combinedCanvas.width, combinedCanvas.height);

    // Draw map
    if (mapCanvas) {
      ctx.drawImage(mapCanvas, 0, 0, mapW, mapH);
    }

    // Draw chart
    if (plotDiv) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const PlotlyLib = (window as any).Plotly || (await import('plotly.js-dist-min')).default;
      const imgData = await PlotlyLib.toImage(plotDiv, {
        format: 'png', width: mapW, height: chartH, scale,
      });
      const img = new Image();
      await new Promise<void>((resolve) => {
        img.onload = () => {
          ctx.drawImage(img, 0, mapH, mapW, chartH);
          resolve();
        };
        img.src = imgData;
      });
    }

    // Download
    const link = document.createElement('a');
    link.download = `bowser_export_${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.png`;
    link.href = combinedCanvas.toDataURL('image/png');
    link.click();
  }, [isLight]);

  // Build a lookup from date → displacement for the reference point
  const refLookup = useMemo(() => {
    if (state.referenceTimeseries.length === 0) return null;
    const map = new Map<string, number>();
    for (const entry of state.referenceTimeseries) {
      map.set(entry.date, entry.displacement);
    }
    return map;
  }, [state.referenceTimeseries]);

  const traces = useMemo(() => {
    const result: Array<Record<string, unknown>> = [];

    // V2 point layer mode: show clicked points
    if (state.clickedPoints.length > 0) {
      for (let i = 0; i < state.clickedPoints.length; i++) {
        const cp = state.clickedPoints[i];
        // Apply client-side date range filter
        const filtered = cp.timeseries.filter(t => {
          if (dateStart && t.date < dateStart) return false;
          if (dateEnd && t.date > dateEnd) return false;
          return true;
        });
        const x = filtered.map(t => t.date);
        const y = filtered.map(t => {
          if (refLookup) {
            const refVal = refLookup.get(t.date) ?? 0;
            return t.displacement - refVal;
          }
          return t.displacement;
        });
        const color = COLORS[i % COLORS.length];

        // Data trace
        result.push({
          x, y,
          type: 'scattergl',
          mode: 'lines+markers',
          name: `Point ${cp.pointId}`,
          marker: { color, size: 5 },
          line: { color, width: 1.5 },
        });

        // Trend line trace
        if (showTrends) {
          const fit = linearFit(x, y);
          if (fit) {
            const t0 = new Date(x[0]).getTime();
            const trendY = x.map(d => {
              const days = (new Date(d).getTime() - t0) / 86_400_000;
              return fit.slope * days + fit.intercept;
            });
            result.push({
              x, y: trendY,
              type: 'scattergl',
              mode: 'lines',
              name: `${fit.mmPerYear >= 0 ? '+' : ''}${fit.mmPerYear.toFixed(1)} mm/yr (R²=${fit.r2.toFixed(2)})`,
              line: { color, width: 1, dash: 'dash' },
              showlegend: true,
            });
          }
        }
      }
      return result;
    }

    // V1 raster mode: show time series points (existing behavior)
    if (state.timeSeriesPoints.length > 0 && state.currentDataset) {
      for (const p of state.timeSeriesPoints) {
        if (!p.visible || !p.data?.[state.currentDataset]) continue;
        const data = p.data![state.currentDataset];
        const info = state.datasetInfo[state.currentDataset];
        const xValues = info?.x_values || data.map((_, i) => i);
        result.push({
          x: xValues,
          y: data,
          type: 'scattergl',
          mode: 'lines+markers',
          name: p.name,
          marker: { color: p.color, size: 5 },
          line: { color: p.color, width: 1.5 },
        });
      }
    }

    return result;
  }, [state.clickedPoints, state.timeSeriesPoints, state.currentDataset, state.datasetInfo, refLookup, showTrends, dateStart, dateEnd]);

  if (traces.length === 0) return null;

  return (
    <div style={{
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: '250px',
      zIndex: 1000,
      background: isLight ? '#ffffff' : '#1a1a2e',
      borderTop: isLight ? '1px solid #ccc' : '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Reference indicator + Selection bar */}
      {(hasMultipleClicked || state.referencePointId != null) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '3px 10px', background: isLight ? '#f0f0f0' : '#12122a',
          borderBottom: isLight ? '1px solid #ddd' : '1px solid #2a2a4a', fontSize: 11,
          flexShrink: 0,
        }}>
          {state.referencePointId != null && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              background: '#1a3a2a', padding: '1px 6px', borderRadius: 3,
              color: '#0f8', fontSize: 11,
            }}>
              ref: {state.referencePointId}
              <button
                onClick={() => dispatch({ type: 'CLEAR_REFERENCE_POINT' })}
                style={{
                  background: 'none', border: 'none', color: '#888',
                  cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1,
                }}
              >
                x
              </button>
            </span>
          )}
          {hasMultipleClicked && (
            <span style={{ color: '#999' }}>
              {state.clickedPoints.length} pts
            </span>
          )}
          {state.clickedPoints.map((cp, i) => (
            <span
              key={cp.pointId}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: '#1a2a3a', padding: '1px 6px', borderRadius: 3,
                color: COLORS[i % COLORS.length],
              }}
            >
              {cp.pointId}
              <button
                onClick={() => dispatch({ type: 'REMOVE_CLICKED_POINT', payload: cp.pointId })}
                style={{
                  background: 'none', border: 'none', color: '#888',
                  cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1,
                }}
              >
                x
              </button>
            </span>
          ))}
          <button
            onClick={() => dispatch({ type: 'CLEAR_CLICKED_POINTS' })}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none',
              color: '#888', cursor: 'pointer', fontSize: 10,
            }}
          >
            Clear all
          </button>
        </div>
      )}

      {/* Toolbar row: date range + trend toggle + close */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 10px', background: isLight ? '#f0f0f0' : '#12122a',
        borderBottom: isLight ? '1px solid #ddd' : '1px solid #2a2a4a', fontSize: 11,
        flexShrink: 0,
      }}>
        {state.clickedPoints.length > 0 && (
          <>
            <span style={{ color: '#888', fontSize: 10 }}>Date range:</span>
            <input
              type="date"
              value={dateStart}
              onChange={e => setDateStart(e.target.value)}
              style={{
                background: '#2a2a4a', color: '#ccc', border: '1px solid #444',
                borderRadius: 3, fontSize: 10, padding: '1px 4px', width: 110,
              }}
            />
            <span style={{ color: '#666' }}>to</span>
            <input
              type="date"
              value={dateEnd}
              onChange={e => setDateEnd(e.target.value)}
              style={{
                background: '#2a2a4a', color: '#ccc', border: '1px solid #444',
                borderRadius: 3, fontSize: 10, padding: '1px 4px', width: 110,
              }}
            />
            {(dateStart || dateEnd) && (
              <button
                onClick={() => { setDateStart(''); setDateEnd(''); }}
                style={{
                  background: 'none', border: 'none', color: '#888',
                  cursor: 'pointer', fontSize: 10, padding: 0,
                }}
              >
                reset
              </button>
            )}
            <button
              onClick={() => setShowTrends(!showTrends)}
              style={{
                background: showTrends ? '#3a4a6a' : '#2a2a4a',
                border: showTrends ? '1px solid #5566cc' : '1px solid #444',
                color: showTrends ? '#aaf' : '#ccc',
                cursor: 'pointer', fontSize: 11, padding: '2px 6px', borderRadius: 3,
              }}
            >
              Trend
            </button>
          </>
        )}
        <button
          onClick={exportScreenshot}
          style={{
            background: isLight ? '#e8e8e8' : '#2a2a4a',
            border: isLight ? '1px solid #ccc' : '1px solid #444',
            color: isLight ? '#333' : '#ccc',
            cursor: 'pointer', fontSize: 11, padding: '2px 6px', borderRadius: 3,
          }}
          title="Export map + chart as PNG"
        >
          Save PNG
        </button>
        <button
          onClick={() => dispatch({ type: 'SET_CHART_THEME', payload: isLight ? 'dark' : 'light' })}
          style={{
            background: isLight ? '#e8e8e8' : '#2a2a4a',
            border: isLight ? '1px solid #ccc' : '1px solid #444',
            color: isLight ? '#333' : '#ccc',
            cursor: 'pointer', fontSize: 11, padding: '2px 6px', borderRadius: 3,
          }}
          title="Toggle dark/light theme for publication"
        >
          {isLight ? 'Dark' : 'Light'}
        </button>
        <button
          onClick={() => {
            dispatch({ type: 'TOGGLE_CHART' });
            dispatch({ type: 'CLEAR_CLICKED_POINTS' });
          }}
          style={{
            marginLeft: 'auto',
            background: 'transparent', border: 'none', color: '#888',
            cursor: 'pointer', fontSize: 14,
          }}
        >
          x
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <Plot
          data={traces}
          layout={{
            autosize: true,
            margin: { l: 55, r: 15, t: 10, b: 40 },
            paper_bgcolor: isLight ? '#ffffff' : '#1a1a2e',
            plot_bgcolor: isLight ? '#f8f8f8' : '#16213e',
            font: {
              color: isLight ? '#333' : '#ccc',
              size: 11,
              family: isLight ? 'Georgia, "Times New Roman", serif' : 'system-ui, sans-serif',
            },
            xaxis: {
              gridcolor: isLight ? '#ddd' : '#2a3a5e',
              linecolor: isLight ? '#999' : undefined,
              title: { text: 'Date' },
            },
            yaxis: {
              gridcolor: isLight ? '#ddd' : '#2a3a5e',
              linecolor: isLight ? '#999' : undefined,
              title: { text: refLookup ? 'Relative Displacement (mm)' : 'Displacement (mm)' },
            },
            legend: {
              bgcolor: isLight ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.3)',
              font: { size: 10 },
            },
            showlegend: traces.length > 1,
          }}
          config={{
            displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d'],
            displaylogo: false,
            responsive: true,
          }}
          style={{ width: '100%', height: '100%' }}
          useResizeHandler
        />
      </div>
    </div>
  );
}
