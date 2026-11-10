/** Areas in the chart's Style button: colour, median line, mean and band, applied to the chart and kept in a project. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState } from '../types';
import { areaChartDatasets, type PolygonTimeSeries } from '../utils/polygonSeries';

const saved = vi.hoisted(() => ({ files: [] as { data: Blob | string; name: string }[] }));
vi.mock('../utils/saveFile', () => ({
  saveFile: async (data: Blob | string, name: string) => { saved.files.push({ data, name }); return true; },
}));

import SeriesStylePopover from './SeriesStylePopover';
import ProjectTab from './panel/ProjectTab';

const SQUARE = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const RESULT: PolygonTimeSeries = {
  labels: ['2020-01-01', '2020-02-01'], units: 'm',
  statistics: [
    { count: 4, mean: 0, median: 0, spatial_std: 0.001, minimum: 0, maximum: 0, percentiles: { 10: 0, 90: 0 } },
    { count: 4, mean: 0.01, median: 0.01, spatial_std: 0.002, minimum: 0, maximum: 0.02, percentiles: { 10: 0.005, 90: 0.015 } },
  ],
};
const base = { result: RESULT, name: 'Dam', color: '#1f77b4', factor: 1, unit: 'm', yAxisID: 'y0', reference: null, toX: (x: string) => x, inRange: () => true };

let stateRef: AppState;
function Seed({ setup, children }: { setup: AppAction[]; children: React.ReactNode }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => { setup.forEach(dispatch); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <>{children}</>;
}
const withArea: AppAction[] = [
  { type: 'ADD_CHART_AREAS', payload: [{ id: 'a1', name: 'Dam area', geometry: SQUARE, source: { overlayId: 'v', layer: 'areas.geojson', index: 0 } }] },
  { type: 'ADD_TIME_SERIES_POINT', payload: { position: [0, 0], name: 'Gauge' } },
];

beforeEach(() => { saved.files = []; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}'))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('area style in the chart', () => {
  it('defaults to a 2 px median, the dashed mean and a 20 % band', () => {
    const ds = areaChartDatasets(base);
    expect(ds.map(d => d.label)).toEqual(['Dam +1 std', 'Dam −1 std', 'Dam median', 'Dam mean']);
    expect(ds[0].backgroundColor).toBe('#1f77b433');
    expect(ds[2].borderWidth).toBe(2);
  });

  it('applies the width, line, mean, band and opacity to the three series', () => {
    const ds = areaChartDatasets({ ...base, style: { lineWidth: 4, line: 'dashed', bandOpacity: 0.5 } });
    expect(ds[0].backgroundColor).toBe('#1f77b480');
    expect(ds[2]).toMatchObject({ borderWidth: 4, borderDash: [6, 4], showLine: true });
    expect(ds[3]).toMatchObject({ borderWidth: 4, borderDash: [6, 4] });
    expect(areaChartDatasets({ ...base, style: { showMean: false } }).map(d => d.label)).toEqual(['Dam +1 std', 'Dam −1 std', 'Dam median']);
    expect(areaChartDatasets({ ...base, style: { showBand: false } }).map(d => d.label)).toEqual(['Dam median', 'Dam mean']);
    expect(areaChartDatasets({ ...base, style: { line: 'none' } })[2].showLine).toBe(false);
  });
});

describe('Style button', () => {
  const open = () => {
    render(<AppProvider><Seed setup={withArea}><SeriesStylePopover /></Seed></AppProvider>);
    fireEvent.click(screen.getByTitle(/Style the points and areas/));
  };

  it('lists areas under the points, with their colour from the palette', () => {
    open();
    expect((screen.getByLabelText('Colour of Gauge') as HTMLInputElement).value).toBe(stateRef.timeSeriesPoints[0].color);
    expect((screen.getByLabelText('Colour of Dam area') as HTMLInputElement).value).toBe('#1f77b4');
  });

  it('changes an area’s colour, median line and width, mean, band and opacity', () => {
    open();
    fireEvent.change(screen.getByLabelText('Colour of Dam area'), { target: { value: '#00aa00' } });
    fireEvent.change(screen.getByLabelText('Median line of Dam area'), { target: { value: 'dashed' } });
    fireEvent.change(screen.getByLabelText('Line width of Dam area'), { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText('Mean of Dam area'));
    fireEvent.change(screen.getByLabelText('Band opacity of Dam area'), { target: { value: '0.45' } });
    expect(stateRef.chartAreas[0]).toMatchObject({ color: '#00aa00', line: 'dashed', lineWidth: 3, showMean: false, bandOpacity: 0.45 });
    fireEvent.click(screen.getByLabelText('Band of Dam area'));
    expect(stateRef.chartAreas[0].showBand).toBe(false);
    expect((screen.getByLabelText('Band opacity of Dam area') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('areas in a project', () => {
  it('are saved with their style and the band choice', async () => {
    render(<AppProvider><Seed setup={[...withArea,
      { type: 'UPDATE_CHART_AREA', payload: { id: 'a1', updates: { color: '#00aa00', lineWidth: 3, showMean: false } } },
      { type: 'SET_AREA_BAND', payload: 'pct' },
    ]}><ProjectTab /></Seed></AppProvider>);
    await act(async () => { fireEvent.click(screen.getByTitle(/Save points/)); });
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved.files[0].data as Blob);
    });
    const project = JSON.parse(text);
    expect(project.chartAreas).toEqual([expect.objectContaining({ id: 'a1', name: 'Dam area', color: '#00aa00', lineWidth: 3, showMean: false, geometry: SQUARE })]);
    expect(project.areaBand).toBe('pct');
    localStorage.removeItem('bowser-area-band');
  });
});
