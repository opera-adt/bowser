import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { RasterGroup } from '../../types';
import { clearHistogramCache } from '../../utils/colorPresets';
import MainTab from './MainTab';

vi.mock('../Histogram', () => ({ default: () => null }));

const RANGES: Record<string, object> = {
  quality: { min: 0, max: 1, p2: 0.2, p98: 0.95 },
  amplitude: { min: 0, max: 9000, p2: 40, p98: 2500 },
};
const HISTOGRAMS: Record<string, object> = {
  quality: { bins: [0, 0.25, 0.5, 0.75, 1], counts: [10, 20, 30, 40], min: 0, max: 1, p2: 0.2, p98: 0.95, p16: 0.3, p84: 0.9, p23: 0.2, p977: 0.95 },
  amplitude: { bins: [0, 1000, 2000, 3000], counts: [50, 30, 20], min: 0, max: 3000, p2: 40, p98: 2500, p16: 300, p84: 2000, p23: 40, p977: 2500 },
};
let held: Array<() => void> = [];
let holdRanges = false;

beforeEach(() => {
  held = []; holdRanges = false;
  clearHistogramCache();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const name = Object.keys(RANGES).find(n => url.includes(`/${n}`));
    if (url.includes('dataset_range') && name) {
      // Optionally keep the answer back, as a slow server would.
      if (holdRanges) await new Promise<void>(resolve => held.push(resolve));
      return new Response(JSON.stringify(RANGES[name]), { status: 200 });
    }
    if (url.includes('/histogram/') && name) return new Response(JSON.stringify(HISTOGRAMS[name]), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Seed() {
  const { dispatch } = useAppContext();
  useEffect(() => {
    const layer = (name: string): RasterGroup => ({
      name, description: '', unit: '', description_source: 'bowser',
      file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
      uses_spatial_ref: false, algorithm: null, x_values: [0],
      latlon_bounds: [0, 0, 1, 1], available_mask_vars: [],
    });
    dispatch({ type: 'SET_DATASETS', payload: { quality: layer('quality'), amplitude: layer('amplitude') } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'quality' });
  }, [dispatch]);
  return <MainTab />;
}

const row = () => document.querySelector('.layer-mask-row') as HTMLElement;
const threshold = () => Number((row().querySelector('input[type="number"]') as HTMLInputElement).value);
const slider = () => row().querySelector('input[type="range"]') as HTMLInputElement;

async function addMask() {
  render(<AppProvider><Seed /></AppProvider>);
  const header = screen.getByText(/^Masking/);
  if (!screen.queryByRole('button', { name: /Add layer mask/ })) fireEvent.click(header);
  fireEvent.click(await screen.findByRole('button', { name: /Add layer mask/ }));
  await waitFor(() => expect(row()).toBeTruthy());
}

describe('Main tab › masking', () => {
  it("a new mask takes its layer's own default once the layer's range is known", async () => {
    holdRanges = true;
    await addMask();
    expect(threshold()).toBe(0.5);   // nothing known about the layer yet
    held.splice(0).forEach(release => release());
    await waitFor(() => expect(threshold()).toBe(0.2));
    expect([slider().min, slider().max]).toEqual(['0.2', '0.95']);
  });

  it("moving a mask to another layer sets that layer's default, not the old threshold", async () => {
    await addMask();
    await waitFor(() => expect(threshold()).toBe(0.2));
    // The user tightens it, then picks a layer in other units whose range is not known yet.
    fireEvent.change(slider(), { target: { value: '0.7' } });
    expect(threshold()).toBe(0.7);
    holdRanges = true;
    fireEvent.change(row().querySelector('select') as HTMLSelectElement, { target: { value: 'amplitude' } });
    held.splice(0).forEach(release => release());
    await waitFor(() => expect(threshold()).toBe(40));
    expect([slider().min, slider().max]).toEqual(['40', '2500']);
  });

  it('a threshold the user typed is left alone when ranges of other masks arrive', async () => {
    await addMask();
    await waitFor(() => expect(threshold()).toBe(0.2));
    fireEvent.change(row().querySelector('input[type="number"]') as HTMLInputElement, { target: { value: '0.6' } });
    await waitFor(() => expect(threshold()).toBe(0.6));
    await new Promise(r => setTimeout(r, 30));
    expect(threshold()).toBe(0.6);
  });

  it('shows how much of the layer the threshold keeps, under the slider', async () => {
    await addMask();
    await waitFor(() => expect(threshold()).toBe(0.2));
    const status = await screen.findByText(/Keeps .* of this layer's pixels/, {}, { timeout: 3000 });
    expect(status.textContent).toBe("Keeps 92% of this layer's pixels");   // 0.2 cuts the first bin: 100 - 8
    fireEvent.change(slider(), { target: { value: '0.5' } });
    await waitFor(() => expect(screen.getByText(/Keeps/).textContent).toBe("Keeps 70% of this layer's pixels"));
  });
});


it('explains restored incompatible masks even with the panel collapsed', async () => {
  function MaskSeed() {
    const { dispatch } = useAppContext();
    useEffect(() => {
      const layer = { name: 'velocity', x_values: [], mask_compatibility: {
        quality: 'Dynamic mask requires matching acquisition coordinates', static_quality: null,
      } } as unknown as RasterGroup;
      dispatch({ type:'SET_DATASETS', payload:{ velocity:layer, quality:layer, static_quality:layer } });
      dispatch({ type:'SET_CURRENT_DATASET', payload:'velocity' });
      dispatch({ type:'ADD_LAYER_MASK', payload:{ id:'q', dataset:'quality', threshold:.5, mode:'min' } });
    }, [dispatch]);
    return <MainTab />;
  }
  render(<AppProvider><MaskSeed /></AppProvider>);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Remove this mask'));
  fireEvent.click(screen.getByText('Masking · 1 on'));
  const options = Array.from(document.querySelectorAll<HTMLSelectElement>('.layer-mask-row select'))[0].options;
  expect(Array.from(options).find(o=>o.value==='quality')?.disabled).toBe(true);
  expect(Array.from(options).find(o=>o.value==='static_quality')?.disabled).toBe(false);
  fireEvent.click(document.querySelector('.layer-mask-row button')!);
  fireEvent.click(screen.getByText('Add layer mask'));
  expect((document.querySelector('.layer-mask-row select') as HTMLSelectElement).value).toBe('static_quality');
});
