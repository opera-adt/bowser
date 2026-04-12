import { useEffect, useState, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import { useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';

interface BufferResult {
  labels: string[];
  median: number[];
  samples: number[][];
  n_pixels: number;
}

export default function RefPointChart() {
  const { state } = useAppContext();
  const { fetchBufferTimeSeries } = useApi();
  const [bufferData, setBufferData] = useState<BufferResult | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!state.refBufferEnabled || !state.showRefChart || !state.currentDataset) {
      setBufferData(null);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const [lat, lng] = state.refMarkerPosition;

    setLoading(true);
    fetchBufferTimeSeries(lng, lat, state.currentDataset, state.refBufferRadius, 20)
      .then(data => {
        if (!ctrl.signal.aborted && data) setBufferData(data);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });

    return () => ctrl.abort();
  }, [
    state.refBufferEnabled,
    state.showRefChart,
    state.currentDataset,
    state.refMarkerPosition,
    state.refBufferRadius,
  ]);

  if (!state.refBufferEnabled || !state.showRefChart) return null;
  if (loading) {
    return (
      <div className="profile-panel" style={{ left: '50%', transform: 'translateX(-50%)', bottom: 0, right: 'auto', width: 500 }}>
        <div className="chart-placeholder"><p>Loading reference buffer…</p></div>
      </div>
    );
  }
  if (!bufferData || bufferData.labels.length === 0) return null;

  const { median, samples } = bufferData;

  // Use dataset info x_values as the authoritative label source — identical to
  // what the main time series chart uses, guaranteeing the axes match.
  const rawLabels: string[] =
    (state.datasetInfo[state.currentDataset]?.x_values ?? bufferData.labels).map(String);
  const n = rawLabels.length;

  const toDisplay = (l: string) => {
    const parts = l.split('_');
    if (parts.length === 2 && /^\d{8}$/.test(parts[1])) {
      const d = parts[1];
      return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    }
    return l.slice(0, 10);
  };
  const displayLabels = rawLabels.map(toDisplay);

  // Compute mean and std per date from samples
  const mean: number[] = Array(n).fill(0);
  const std: number[] = Array(n).fill(0);

  if (samples.length > 0) {
    for (let t = 0; t < n; t++) {
      const vals = samples.map(s => s[t]).filter(v => isFinite(v));
      if (vals.length === 0) { mean[t] = NaN; std[t] = NaN; continue; }
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      mean[t] = m;
      std[t] = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
    }
  }

  const meanPlusStd = mean.map((m, i) => isFinite(m) ? m + std[i] : NaN);
  const meanMinusStd = mean.map((m, i) => isFinite(m) ? m - std[i] : NaN);

  const sampleDatasets = samples.slice(0, 8).map((s, i) => ({
    label: `sample ${i + 1}`,
    data: s,
    borderColor: 'rgba(150,180,220,0.18)',
    backgroundColor: 'transparent',
    borderWidth: 1,
    pointRadius: 0,
    tension: 0.15,
  }));

  // Fixed dataset order: index 0 = +1σ, index 1 = -1σ, rest are non-filled.
  // Use fill: { target: 1 } to pin the fill to dataset index 1 regardless of sample count.
  const chartData = {
    labels: displayLabels,
    datasets: [
      // +1σ bound — fills toward -1σ (dataset index 1)
      {
        label: '+1σ',
        data: meanPlusStd,
        borderColor: 'rgba(77,157,224,0.4)',
        backgroundColor: 'rgba(77,157,224,0.12)',
        borderWidth: 1,
        borderDash: [3, 3],
        pointRadius: 0,
        fill: { target: 1, above: 'rgba(77,157,224,0.12)' },
        tension: 0.2,
      },
      // -1σ bound
      {
        label: '-1σ',
        data: meanMinusStd,
        borderColor: 'rgba(77,157,224,0.4)',
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderDash: [3, 3],
        pointRadius: 0,
        fill: false,
        tension: 0.2,
      },
      // Mean
      {
        label: 'Mean',
        data: mean,
        borderColor: '#4d9de0',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
      },
      // Median
      {
        label: 'Median',
        data: median,
        borderColor: '#3ec97a',
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        fill: false,
        tension: 0.2,
      },
      // Individual samples (faint, behind main lines)
      ...sampleDatasets,
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: '#aaa',
          filter: (item: any) => ['Mean', 'Median', '+1σ'].includes(item.text),
          boxWidth: 20,
          font: { size: 11 },
        },
      },
      tooltip: { mode: 'index' as const, intersect: false },
    },
    scales: {
      x: {
        ticks: { color: '#aaa', maxTicksLimit: 8, maxRotation: 45 },
        grid: { color: 'rgba(255,255,255,0.08)' },
      },
      y: {
        title: { display: true, text: state.currentDataset, color: '#aaa' },
        ticks: { color: '#aaa' },
        grid: { color: 'rgba(255,255,255,0.08)' },
      },
    },
  };

  return (
    <div className="profile-panel" style={{ right: 16, left: 'auto', width: 520 }}>
      <div className="chart-header">
        <h4>
          Ref Buffer — {bufferData.n_pixels} px, r={state.refBufferRadius} m
        </h4>
      </div>
      <div style={{ height: 200, position: 'relative' }}>
        <Line data={chartData as any} options={options as any} />
      </div>
    </div>
  );
}
