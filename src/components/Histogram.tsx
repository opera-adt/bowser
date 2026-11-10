import { useEffect, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js';
import { useAppContext } from '../context/AppContext';
import { cachedHistogram, fetchHistogram, presetRange, type HistogramData, type RangePreset } from '../utils/colorPresets';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

interface HistogramProps {
  // When provided, overrides the defaults drawn from state.
  dataset?: string;
  vmin?: number;
  vmax?: number;
  onSetVmin?: (v: number) => void;
  onSetVmax?: (v: number) => void;
}

export default function Histogram({ dataset, vmin, vmax, onSetVmin, onSetVmax }: HistogramProps = {}) {
  const { state, dispatch } = useAppContext();
  const [histData, setHistData] = useState<HistogramData | null>(null);
  const [loading, setLoading] = useState(false);

  const effectiveDataset = dataset ?? state.currentDataset;
  const effectiveVmin = vmin ?? state.vmin;
  const effectiveVmax = vmax ?? state.vmax;
  const setVmin = onSetVmin ?? ((v: number) => dispatch({ type: 'SET_VMIN', payload: v }));
  const setVmax = onSetVmax ?? ((v: number) => dispatch({ type: 'SET_VMAX', payload: v }));

  useEffect(() => {
    if (!effectiveDataset) return;
    const cached = cachedHistogram(effectiveDataset, state.currentTimeIndex);
    if (cached) {
      setHistData(cached);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await fetchHistogram(effectiveDataset, state.currentTimeIndex, controller.signal);
        if (data) setHistData(data);
      } catch (e) {
        if ((e as any).name !== 'AbortError') console.error('Error fetching histogram:', e);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [effectiveDataset, state.currentTimeIndex]);

  // The buttons' ranges: src/utils/colorPresets.ts (also the Assistant's set_color_range).
  const apply = (preset: RangePreset) => {
    const r = presetRange(preset, histData, effectiveVmin, effectiveVmax);
    if (!r) return;
    setVmin(r[0]);
    setVmax(r[1]);
  };
  const handleAutoScale = () => apply('2-98%');
  const handleFullScale = () => apply('full');
  const handleSigmaScale = () => apply('1sigma');
  const handleTwoSigmaScale = () => apply('2sigma');
  const handleCenterZero = () => apply('symmetric');

  if (!effectiveDataset || loading) {
    return <div className="histogram-loading">{loading ? 'Computing…' : ''}</div>;
  }
  if (!histData || histData.bins.length < 2) return null;

  const labels = histData.bins.slice(0, -1).map((b, i) =>
    ((b + histData.bins[i + 1]) / 2).toFixed(4)
  );

  const bgColors = histData.bins.slice(0, -1).map((b, i) => {
    const center = (b + histData.bins[i + 1]) / 2;
    return center >= effectiveVmin && center <= effectiveVmax
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
