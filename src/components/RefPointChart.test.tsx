import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RefPointChart from './RefPointChart';

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown>, fetch: vi.fn(), data: null as { datasets: Array<{ label: string; data: number[] }> } | null }));
vi.mock('../context/AppContext', async () =>
  (await import('../test/appContextMock')).appContextMock(() => ({ state: ctx.state })));
vi.mock('../hooks/useApi', () => ({ useApi: () => ({ fetchBufferTimeSeries: ctx.fetch }) }));
vi.mock('../hooks/useDraggableResizable', () => ({ useDraggableResizable: () => ({ panelRef: { current: null }, panelStyle: {}, onDragMouseDown: vi.fn(), resizeGrip: null }) }));
vi.mock('react-chartjs-2', () => ({ Line: ({ data }: { data: { datasets: Array<{ label: string; data: number[] }> } }) => { ctx.data = data; return <div data-testid="chart" />; } }));
const dates = ['2026-01-01', '2026-01-13', '2026-01-25'];
const series = (values: number[]) => values.map((y, i) => ({ x: dates[i], y }));
const reply = { labels: dates, median: series([0, 2, 4]), samples: [series([0, 1, 2]), series([0, 3, 6])], n_pixels: 2 };
const curve = (label: string) => ctx.data!.datasets.find((d: { label: string }) => d.label === label)!.data;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ geotiff_upload: true }))));
  ctx.state = { refBufferEnabled: true, showRefChart: true, currentDataset: 'displacement', datasetInfo: { displacement: { x_values: dates } }, refMarkerPosition: [1, 2], refBufferRadius: 15 };
  ctx.fetch.mockReset().mockResolvedValue(reply); ctx.data = null;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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


describe('optional quality-screened reference diagnostic', () => {
  it('is opt-in, forwards external masks without a reference shift and restores the raw preview', async () => {
    ctx.state = { ...ctx.state, dataMode: 'cog', customMaskPath: 'mask.tif',
      layerMasks: [], datasetInfo: { displacement: { x_values: dates, mask_file_list: ['quality.tif'], mask_min_value: 0 } } };
    const originalPosition = ctx.state.refMarkerPosition;
    render(<RefPointChart />);
    await screen.findByTestId('chart');
    expect(ctx.fetch).toHaveBeenLastCalledWith(2, 1, 'displacement', 15, 20);
    ctx.fetch.mockResolvedValue({ ...reply, median: series([0, 1, 2]) });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(curve('Median')).toEqual([0, 1, 2]));
    expect(ctx.fetch).toHaveBeenLastCalledWith(2, 1, 'displacement', 15, 20,
      undefined, undefined, [], 0, { primary_mask: true, mask_min_value: 0, custom_mask_path: 'mask.tif' });
    expect(ctx.state.refMarkerPosition).toBe(originalPosition);
    expect(screen.getByText(/does not change the map reference/)).toBeTruthy();
    ctx.fetch.mockResolvedValue(reply);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(curve('Median')).toEqual([0, 2, 4]));
    expect(ctx.fetch).toHaveBeenLastCalledWith(2, 1, 'displacement', 15, 20);
  });
  it('clears failed screened results and leaves the raw-mode control available', async () => {
    render(<RefPointChart />); await screen.findByTestId('chart');
    ctx.fetch.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByRole('alert');
    expect(screen.queryByTestId('chart')).toBeNull();
    ctx.fetch.mockResolvedValue(reply);
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByTestId('chart');
    expect(curve('Median')).toEqual([0, 2, 4]);
  });
  it('discards late screened replies after returning to raw mode', async () => {
    render(<RefPointChart />); await screen.findByTestId('chart');
    let finish!: (value: typeof reply) => void;
    ctx.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('checkbox'));
    // The screened request goes out after the request gap; wait until it has been sent.
    await waitFor(() => expect(ctx.fetch).toHaveBeenCalledTimes(2));
    expect(ctx.fetch.mock.calls[1].length).toBeGreaterThan(5);   // with masks
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByTestId('chart');
    await act(async () => finish({ ...reply, median: series([99, 99, 99]) }));
    expect(curve('Median')).toEqual([0, 2, 4]);
  });
});


it('shows Loading, not the previous curve under the new settings, while the request waits', async () => {
  const view = render(<RefPointChart />); await screen.findByTestId('chart');
  ctx.state = { ...ctx.state, refBufferRadius: 999 };
  view.rerender(<RefPointChart />);
  // Within the request gap the 999 m request has not gone out yet.
  expect(ctx.fetch).toHaveBeenLastCalledWith(2, 1, 'displacement', 15, 20);
  expect(screen.queryByTestId('chart')).toBeNull();
  expect(screen.getByText('Loading reference buffer…')).toBeTruthy();
  await screen.findByTestId('chart');
  expect(ctx.fetch).toHaveBeenLastCalledWith(2, 1, 'displacement', 999, 20);
});


it('says the masks may leave no valid pixel when the screened request fails', async () => {
  render(<RefPointChart />); await screen.findByTestId('chart');
  ctx.fetch.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole('checkbox'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/current quality masks: they may leave no valid pixel/);
  // Only the message is announced, not the controls.
  expect(alert.querySelector('input')).toBeNull();
  expect(screen.getByRole('checkbox')).toBeTruthy();
});


it('refreshes the screened diagnostic when mask settings change', async () => {
  const view = render(<RefPointChart />); await screen.findByTestId('chart');
  fireEvent.click(screen.getByRole('checkbox'));
  await screen.findByTestId('chart');
  ctx.state = { ...ctx.state, customMaskPath: 'replacement.tif', dataMode: 'md' };
  view.rerender(<RefPointChart />);
  await waitFor(() => expect(ctx.fetch).toHaveBeenLastCalledWith(2, 1, 'displacement', 15, 20,
    undefined, undefined, [], 0, { custom_mask_path: 'replacement.tif' }));
});


it('discloses an unsupported uploaded mask on lite and retains the other diagnostic options', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ geotiff_upload: false }))));
  ctx.state = { ...ctx.state, customMaskPath: 'saved-mask.tif', dataMode: 'lite' };
  render(<RefPointChart />); await screen.findByTestId('chart');
  fireEvent.click(screen.getByRole('checkbox'));
  await screen.findByText(/Uploaded mask not applied/);
  await waitFor(() => expect(ctx.fetch).toHaveBeenLastCalledWith(2, 1, 'displacement', 15, 20,
    undefined, undefined, [], 0, {}));
});
