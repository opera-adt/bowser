import { useEffect, useState, useCallback } from 'react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js';
import { useAppContext } from '../context/AppContext';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

interface HistogramData {
  bins: number[];
  counts: number[];
  min: number;
  max: number;
  p2: number;
  p98: number;
  p16: number;
  p84: number;
  p23: number;
  p977: number;
}

export default function Histogram() {
  const { state, dispatch } = useAppContext();
  const [histData, setHistData] = useState<HistogramData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchHistogram = useCallback(async () => {
    if (!state.currentDataset || state.isPlaying) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ time_index: String(state.currentTimeIndex) });
      const res = await fetch(`/histogram/${encodeURIComponent(state.currentDataset)}?${params}`);
      if (res.ok) {
        const data = await res.json();
        setHistData(data);
      }
    } catch (e) {
      console.error('Error fetching histogram:', e);
    } finally {
      setLoading(false);
    }
  }, [state.currentDataset, state.currentTimeIndex, state.isPlaying]);

  useEffect(() => { fetchHistogram(); }, [fetchHistogram]);

  const handleAutoScale = () => {
    if (!histData) return;
    dispatch({ type: 'SET_VMIN', payload: parseFloat(histData.p2.toFixed(4)) });
    dispatch({ type: 'SET_VMAX', payload: parseFloat(histData.p98.toFixed(4)) });
  };

  const handleFullScale = () => {
    if (!histData) return;
    dispatch({ type: 'SET_VMIN', payload: parseFloat(histData.min.toFixed(4)) });
    dispatch({ type: 'SET_VMAX', payload: parseFloat(histData.max.toFixed(4)) });
  };

  const handleSigmaScale = () => {
    if (!histData || histData.p16 == null || histData.p84 == null) return;
    dispatch({ type: 'SET_VMIN', payload: parseFloat(histData.p16.toFixed(4)) });
    dispatch({ type: 'SET_VMAX', payload: parseFloat(histData.p84.toFixed(4)) });
  };

  const handleTwoSigmaScale = () => {
    if (!histData || histData.p23 == null || histData.p977 == null) return;
    dispatch({ type: 'SET_VMIN', payload: parseFloat(histData.p23.toFixed(4)) });
    dispatch({ type: 'SET_VMAX', payload: parseFloat(histData.p977.toFixed(4)) });
  };

  const handleCenterZero = () => {
    const absMax = parseFloat(Math.max(Math.abs(state.vmin), Math.abs(state.vmax)).toFixed(4));
    dispatch({ type: 'SET_VMIN', payload: -absMax });
    dispatch({ type: 'SET_VMAX', payload: absMax });
  };

  if (!state.currentDataset || loading) {
    return <div className="histogram-loading">{loading ? 'Computing…' : ''}</div>;
  }
  if (!histData || histData.bins.length < 2) return null;

  const labels = histData.bins.slice(0, -1).map((b, i) =>
    ((b + histData.bins[i + 1]) / 2).toFixed(4)
  );

  const bgColors = histData.bins.slice(0, -1).map((b, i) => {
    const center = (b + histData.bins[i + 1]) / 2;
    return center >= state.vmin && center <= state.vmax
      ? 'rgba(77,157,224,0.85)'
      : 'rgba(120,120,160,0.30)';
  });

  const chartData = {
    labels,
    datasets: [{ data: histData.counts, backgroundColor: bgColors, borderWidth: 0, borderRadius: 2 }],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (ctx: any) => `Value: ${ctx[0].label}`,
          label: (ctx: any) => `Count: ${ctx.raw}`,
        },
      },
    },
    scales: { x: { display: false }, y: { display: false } },
  };

  return (
    <div className="histogram-wrapper">
      <div className="histogram-chart-area">
        <Bar data={chartData} options={options as any} />
      </div>
      <div className="histogram-range">
        <span className="hist-val">{histData.min.toFixed(3)}</span>
        <span className="hist-val">{histData.max.toFixed(3)}</span>
      </div>
      <div className="histogram-buttons">
        <button className="hist-btn" onClick={handleAutoScale} title="2nd–98th percentile">
          2–98%
        </button>
        <button className="hist-btn" onClick={handleSigmaScale} title="±1σ (16–84%)">
          ±1σ
        </button>
        <button className="hist-btn" onClick={handleTwoSigmaScale} title="±2σ (2.3–97.7%)">
          ±2σ
        </button>
        <button className="hist-btn" onClick={handleFullScale} title="Full range">
          Full
        </button>
        <button className="hist-btn" onClick={handleCenterZero} title="Symmetric around zero: ±max(|vmin|,|vmax|)">
          ±0
        </button>
      </div>
    </div>
  );
}
