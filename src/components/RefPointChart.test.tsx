import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RefPointChart from './RefPointChart';

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown>, fetch: vi.fn(), data: null as { datasets: Array<{ label: string; data: number[] }> } | null }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: ctx.state }) }));
vi.mock('../hooks/useApi', () => ({ useApi: () => ({ fetchBufferTimeSeries: ctx.fetch }) }));
vi.mock('../hooks/useDraggableResizable', () => ({ useDraggableResizable: () => ({ panelRef: { current: null }, panelStyle: {}, onDragMouseDown: vi.fn(), resizeGrip: null }) }));
vi.mock('react-chartjs-2', () => ({ Line: ({ data }: { data: { datasets: Array<{ label: string; data: number[] }> } }) => { ctx.data = data; return <div data-testid="chart" />; } }));
const dates = ['2026-01-01', '2026-01-13', '2026-01-25'];
const series = (values: number[]) => values.map((y, i) => ({ x: dates[i], y }));
const reply = { labels: dates, median: series([0, 2, 4]), samples: [series([0, 1, 2]), series([0, 3, 6])], n_pixels: 2 };
const curve = (label: string) => ctx.data!.datasets.find((d: { label: string }) => d.label === label)!.data;
beforeEach(() => {
  ctx.state = { refBufferEnabled: true, showRefChart: true, currentDataset: 'displacement', datasetInfo: { displacement: { x_values: dates } }, refMarkerPosition: [1, 2], refBufferRadius: 15 };
  ctx.fetch.mockReset().mockResolvedValue(reply); ctx.data = null;
});
afterEach(cleanup);
describe('reference area preview', () => {
  it('plots native dated observations and valid zeros without changing sampling options', async () => {
    render(<RefPointChart />);
    await screen.findByTestId('chart');
    expect(curve('Median')).toEqual([0, 2, 4]);
    expect(curve('Mean')).toEqual([0, 2, 4]);
    expect(curve('+1σ')).toEqual([0, 3, 6]);
    expect(ctx.fetch).toHaveBeenCalledWith(2, 1, 'displacement', 15, 20);
  });
  it('aligns gaps by exact saved labels rather than shifting observations', async () => {
    const gaps = [reply.median[2], reply.median[0]];
    ctx.fetch.mockResolvedValue({ ...reply, median: gaps, samples: [gaps] });
    render(<RefPointChart />);
    await screen.findByTestId('chart');
    expect(curve('Median')).toEqual([0, NaN, 4]);
    expect(curve('Mean')).toEqual([0, NaN, 4]);
  });
  it('does not manufacture a zero mean when there are no sample curves', async () => {
    ctx.fetch.mockResolvedValue({ ...reply, samples: [] });
    render(<RefPointChart />);
    await screen.findByTestId('chart');
    expect(curve('Mean')).toEqual([NaN, NaN, NaN]);
    expect(curve('Median')).toEqual([0, 2, 4]);
  });
  it('clears an earlier result when a new request fails', async () => {
    const view = render(<RefPointChart />);
    await screen.findByTestId('chart');
    ctx.fetch.mockResolvedValue(undefined);
    ctx.state = { ...ctx.state, refMarkerPosition: [1, 3] };
    view.rerender(<RefPointChart />);
    await waitFor(() => expect(screen.queryByTestId('chart')).toBeNull());
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
  });
  it('ignores an obsolete response after the area changes', async () => {
    let resolve!: (value: typeof reply) => void;
    ctx.fetch.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const view = render(<RefPointChart />);
    ctx.state = { ...ctx.state, refMarkerPosition: [1, 3] };
    view.rerender(<RefPointChart />);
    await screen.findByTestId('chart');
    await act(async () => resolve({ ...reply, median: series([90, 90, 90]) }));
    expect(curve('Median')).toEqual([0, 2, 4]);
  });
});
