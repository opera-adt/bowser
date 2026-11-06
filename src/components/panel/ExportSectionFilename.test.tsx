import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExportSection from './ExportSection';

vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({
  state: {
    currentDataset: 'displacement', currentTimeIndex: 900,
    datasetInfo: { displacement: { x_values: ['wrong-label'] } },
    layerMasks: [], customMaskPath: null, overlays: [],
  },
}) }));

let filename: string;
beforeEach(() => {
  filename = '';
  URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    filename = this.download;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native export download name', () => {
  it('uses server dates and the configured primary mask, not browser guesses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, blob: async () => new Blob(),
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="displacement_20260101-20260201_masked.tif"' }),
    }));
    render(<ExportSection />);
    fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
    await waitFor(() => expect(filename).toBe('displacement_20260101-20260201_masked.tif'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('uses a safe layer-only fallback if the server supplies no name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, blob: async () => new Blob(), headers: new Headers(),
    }));
    render(<ExportSection />);
    fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
    await waitFor(() => expect(filename).toBe('displacement.tif'));
  });
});
