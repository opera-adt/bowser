import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppState, OverlayFeatures } from '../types';
import OverlayRow from './panel/OverlayRow';

const collection: OverlayFeatures = { type: 'FeatureCollection', bowser_source_layer_property: 'source', features: [
  { type: 'Feature', id: 0, properties: { source: 'regions' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,0]]] } },
  { type: 'Feature', id: 0, properties: { source: 'stations' }, geometry: { type: 'Point', coordinates: [20,30] } },
] };
let state: AppState;
function View() {
  const { state: current, dispatch } = useAppContext(); state = current;
  useEffect(() => { dispatch({ type: 'ADD_OVERLAY', payload: { id: 'v', name: 'Inventory', type: 'vector', visible: true, opacity: 1,
    data: { type: 'FeatureCollection', features: [] }, pendingSourceLayers: collection } }); }, [dispatch]);
  const overlay = current.overlays[0];
  return overlay ? <OverlayRow overlay={overlay} dropSide={null} onDragStart={() => {}} onDragEnd={() => {}}
    onDragOver={() => {}} onDragLeave={() => {}} onDrop={() => {}} /> : null;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('source-layer picker in the real overlay provider', () => {
  it('adds only chosen layers for drawing, zonal analysis and later project storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    render(<AppProvider><View /></AppProvider>);
    expect(await screen.findByRole('group', { name: 'Choose source layers' })).toBeTruthy();
    expect(state.overlays[0].data?.features).toEqual([]);
    expect(screen.queryByLabelText('Zonal stats')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Waiting for a layer choice');
    expect((screen.getByTitle('Hide') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle('Style') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Opacity of Inventory')).toBeNull();
    fireEvent.click(screen.getByLabelText('stations (1 features)'));
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(state.overlays[0].pendingSourceLayers).toBeUndefined());
    expect(state.overlays[0].data?.features).toEqual([collection.features[0]]);
    expect(state.overlays[0].bounds).toEqual([0,0,2,2]);
    expect(screen.getByLabelText('Zonal stats')).toBeTruthy();
    expect(screen.queryByText('Waiting for a layer choice')).toBeNull();
    expect((screen.getByTitle('Hide') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTitle('Style') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText('Opacity of Inventory')).toBeTruthy();
    expect(JSON.parse(JSON.stringify(state.overlays))[0].data.features).toHaveLength(1);
  });
  it('refuses an empty selection and cancels only the pending overlay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    render(<AppProvider><View /></AppProvider>);
    await screen.findByText('None');fireEvent.click(screen.getByText('None'));
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('All'));
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(state.overlays).toEqual([]));
  });
});
