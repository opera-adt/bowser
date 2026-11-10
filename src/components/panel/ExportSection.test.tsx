import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = {
  currentDataset: 'displacement',
  currentTimeIndex: 0,
  layerMasks: [],
  customMaskPath: null,
  datasetInfo: {},
  overlays: [],
};
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch: vi.fn() }) }));

import ExportSection from './ExportSection';

function serverSays(config: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(config) }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ExportSection', () => {
  it('offers GeoTIFF export when the server can write GeoTIFFs', async () => {
    serverSays({ title: 'Bowser', geotiff_export: true });
    render(<ExportSection />);
    const button = screen.getByRole('button', { name: /GeoTIFF/ }) as HTMLButtonElement;
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/config'));
    expect(button.disabled).toBe(false);
    expect(screen.queryByText(/needs the full Bowser server/)).toBeNull();
  });

  it('turns GeoTIFF export off on bowser-lite, and says why', async () => {
    serverSays({ title: 'Bowser', geotiff_export: false });
    render(<ExportSection />);
    await waitFor(() => expect((screen.getByRole('button', { name: /GeoTIFF/ }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/needs the full Bowser server/)).toBeTruthy();
  });

  it('keeps export on when /config has no flag (an older server)', async () => {
    serverSays({ title: 'Bowser' });
    render(<ExportSection />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect((screen.getByRole('button', { name: /GeoTIFF/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
