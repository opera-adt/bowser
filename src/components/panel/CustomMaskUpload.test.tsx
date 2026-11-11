/** Masking › Custom mask (GeoTIFF): the upload, and what bowser-lite (no uploads) shows instead. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppState } from '../../types';
import CustomMaskUpload, { MASK_UPLOAD_NEEDS_SERVER } from './CustomMaskUpload';

let config: Record<string, unknown>;
let upload: { status: number; body: unknown };
let stateRef: AppState;

function Probe() {
  const { state } = useAppContext();
  useEffect(() => { stateRef = state; });
  return null;
}
const renderRow = () => render(<AppProvider><Probe /><CustomMaskUpload /></AppProvider>);
const button = () => screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement;
const choose = async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'mask.tif', { type: 'image/tiff' });
  await act(async () => { fireEvent.change(screen.getByLabelText('Custom mask file'), { target: { files: [file] } }); });
};

beforeEach(() => {
  config = { title: '', opera_logo: false, geotiff_export: true, polygon_stats: true, geotiff_upload: true };
  upload = { status: 200, body: { path: '/uploads/mask_1.tif' } };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/config') return new Response(JSON.stringify(config));
    if (url === '/upload_mask') return new Response(JSON.stringify(upload.body), { status: upload.status });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('custom mask upload', () => {
  it('uploads the file and uses it as the mask', async () => {
    renderRow();
    await act(async () => {});
    expect(button().disabled).toBe(false);
    await choose();
    await waitFor(() => expect(stateRef.customMaskPath).toBe('/uploads/mask_1.tif'));
    expect(screen.getByText('mask_1.tif')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why when the server refuses the upload, instead of doing nothing', async () => {
    upload = { status: 501, body: { detail: 'Uploading a GeoTIFF mask needs the full Bowser server (GDAL).' } };
    renderRow();
    await choose();
    expect((await screen.findByRole('alert')).textContent)
      .toBe('mask.tif: Uploading a GeoTIFF mask needs the full Bowser server (GDAL).');
    expect(stateRef.customMaskPath).toBeNull();
  });

  it('is off on bowser-lite, and says why', async () => {
    config.geotiff_upload = false;
    renderRow();
    await waitFor(() => expect(button().disabled).toBe(true));
    expect(button().title).toBe(MASK_UPLOAD_NEEDS_SERVER);
    expect(screen.getByText(/Custom masks need the full Bowser server/)).toBeTruthy();
  });

  it('stays on when /config has no flag (an older server)', async () => {
    delete config.geotiff_upload;
    renderRow();
    await act(async () => {});
    expect(button().disabled).toBe(false);
  });
});
