import { useEffect, useRef, useState } from 'react';
import { displayUnit } from '../utils/units';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js';
import { useAppDispatch, useAppFields } from '../context/AppContext';
import { cachedHistogram, fetchHistogram, presetRange, type HistogramData, type RangePreset } from '../utils/colorPresets';
import { hasStoredRange } from '../utils/colorRange';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

/** Wait this long after the last date change before asking for its histogram. */
export const HISTOGRAM_DEBOUNCE_MS = 250;

// The shared histogram cache lives in ../utils/colorPresets (also used by the Assistant).
export { clearHistogramCache } from '../utils/colorPresets';

interface HistogramProps {
  // When provided, overrides the defaults drawn from state.
  dataset?: string;
  /** The date the histogram is of: the map's unless given (the split screen's right layer has its own). */
  timeIndex?: number;
  vmin?: number;
  vmax?: number;
  onSetVmin?: (v: number) => void;
  onSetVmax?: (v: number) => void;
}

export default function Histogram({ dataset, timeIndex, vmin, vmax, onSetVmin, onSetVmax }: HistogramProps = {}) {
  const state = useAppFields('currentDataset', 'currentTimeIndex', 'datasetInfo', 'playing', 'units', 'vmax', 'vmin', 'wrapEnabled');
  const dispatch = useAppDispatch();
  const [histData, setHistData] = useState<HistogramData | null>(null);
  // The layer the histogram is of (the shown one may still be the previous layer's).
  const [histDataset, setHistDataset] = useState('');
  const [loading, setLoading] = useState(false);

  const effectiveDataset = dataset ?? state.currentDataset;
  const effectiveTime = timeIndex ?? state.currentTimeIndex;
  const effectiveVmin = vmin ?? state.vmin;
  const effectiveVmax = vmax ?? state.vmax;
  const setVmin = onSetVmin ?? ((v: number) => dispatch({ type: 'SET_VMIN', payload: v }));
  const setVmax = onSetVmax ?? ((v: number) => dispatch({ type: 'SET_VMAX', payload: v }));

  useEffect(() => {
    if (!effectiveDataset) return;
    const cached = cachedHistogram(effectiveDataset, effectiveTime);
    // An aborted request leaves `loading` set; clear it on every early return.
    if (cached) {
      setHistData(cached);
      setHistDataset(effectiveDataset);
      setLoading(false);
      return;
    }
    // While playing through the dates, keep the last histogram (its range buttons
    // still work) and ask for the date playback stops on.
    if (state.playing) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await fetchHistogram(effectiveDataset, effectiveTime, controller.signal);
        if (data) {
          setHistData(data);
          setHistDataset(effectiveDataset);
        }
      } catch (e) {
        if ((e as any).name !== 'AbortError') console.error('Error fetching histogram:', e);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, HISTOGRAM_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [effectiveDataset, effectiveTime, state.playing]);

  // The buttons' ranges: src/utils/colorPresets.ts (also the Assistant's set_color_range).
  const apply = (preset: RangePreset) => {
    const r = presetRange(preset, histData, effectiveVmin, effectiveVmax);
    if (!r) return;
    setVmin(r[0]);
    setVmax(r[1]);
  };

  // A layer opens on its 2–98 % range, not the 0–1 default, unless a range is kept for it
  // (chosen earlier, or from a project). Phase layers and rewrap set their own ±π range.
  // A layer given by the caller (the split screen's right one) keeps no range between visits:
  // it gets its 2–98 % once, when it is chosen, and whatever is set after that stays.
  const rangedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!histData || histDataset !== effectiveDataset) return;
    const algorithm = state.datasetInfo[histDataset]?.algorithm;
    if (algorithm === 'phase' || algorithm === 'rewrap' || algorithm === 'amplitude') return;
    if (dataset !== undefined) {
      if (rangedFor.current === histDataset) return;
      rangedFor.current = histDataset;
      apply('2-98%');
      return;
    }
    if (state.wrapEnabled || hasStoredRange(histDataset)) return;
    apply('2-98%');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histData, histDataset]);

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

  const shown = displayUnit(state.datasetInfo[histDataset]?.unit, state.units);
  return (
    <div className="histogram-wrapper">
      <div className="histogram-chart-area">
        <Bar data={chartData} options={options as any} />
      </div>
      <div className="histogram-range">
        {/* In the unit the colour range above is shown in (inches under Imperial). */}
        <span className="hist-val">{(histData.min * shown.factor).toFixed(3)}</span>
        <span className="hist-val">{(histData.max * shown.factor).toFixed(3)}</span>
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
