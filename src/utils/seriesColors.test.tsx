/** One palette for points and areas in the chart, each new series in a colour nobody uses. */
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState } from '../types';
import { nextSeriesColor, SERIES_COLORS } from './seriesColors';

const SQUARE = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

function harness() {
  const ref: { state?: AppState; dispatch?: (a: AppAction) => void } = {};
  function Probe() {
    const { state, dispatch } = useAppContext();
    ref.state = state; ref.dispatch = dispatch;
    return null;
  }
  render(<AppProvider><Probe /></AppProvider>);
  return { get state() { return ref.state!; }, run: (a: AppAction) => act(() => ref.dispatch!(a)) };
}

describe('series colours', () => {
  it('take the first unused colour, and repeat only after all 20', () => {
    expect(SERIES_COLORS).toHaveLength(20);
    expect(new Set(SERIES_COLORS).size).toBe(20);
    expect(nextSeriesColor([])).toBe('#1f77b4');
    expect(nextSeriesColor([{ color: '#1f77b4' }, { color: '#2ca02c' }])).toBe('#ff7f0e');
    const all = SERIES_COLORS.map(color => ({ color }));
    expect(nextSeriesColor(all)).toBe(SERIES_COLORS[0]);
  });

  it('give a point a colour no area uses, and an area one no point uses', () => {
    const app = harness();
    app.run({ type: 'ADD_CHART_AREA', payload: { geometry: SQUARE, name: 'Field' } });
    app.run({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0, 0] } });
    app.run({ type: 'ADD_CHART_AREA', payload: { geometry: SQUARE, name: 'Lot' } });
    const colours = [...app.state.chartAreas, ...app.state.timeSeriesPoints].map(s => s.color);
    expect(new Set(colours).size).toBe(3);
    expect(app.state.chartAreas[0].color).toBe('#1f77b4');
    expect(app.state.timeSeriesPoints[0].color).toBe('#ff7f0e');
  });

  it('keep twelve series apart', () => {
    const app = harness();
    for (let i = 0; i < 6; i++) app.run({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [i, i] } });
    for (let i = 0; i < 6; i++) app.run({ type: 'ADD_CHART_AREA', payload: { geometry: SQUARE } });
    const colours = [...app.state.timeSeriesPoints, ...app.state.chartAreas].map(s => s.color);
    expect(new Set(colours).size).toBe(12);
  });
});
