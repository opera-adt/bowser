/** The Leaflet map (?map=leaflet) opens on the data, and its raster layer asks only for tiles inside it. */
import { useEffect } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { RasterGroup } from '../types';
import { layerLeafletBounds } from '../map/leafletBounds';

const leaflet = vi.hoisted(() => ({ map: null as any, tiles: [] as any[] }));
vi.mock('react-leaflet', () => ({
  MapContainer: (props: any) => { leaflet.map = props; return null; },
  TileLayer: (props: any) => { leaflet.tiles.push(props); return null; },
  WMSTileLayer: () => null,
  Marker: () => null,
  useMap: () => null,
  useMapEvents: () => null,
}));
vi.mock('../map/useRasterTileUrl', () => ({ useRasterTileUrl: () => '/md/tiles/WebMercatorQuad/{z}/{x}/{y}?variable=displacement' }));

import MapContainer, { RasterTileLayer } from './MapContainer';

// Arkabutla's cube: [west, south, east, north]
const BOUNDS: [number, number, number, number] = [-90.1459, 34.7275, -90.0826, 34.7830];
const layer = (name: string) => ({
  name, unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm: null, x_values: ['2020-01-01', '2020-02-01'], latlon_bounds: BOUNDS, available_mask_vars: [],
}) as unknown as RasterGroup;

function Seed({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = useAppContext();
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer('displacement') } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.currentDataset ? <>{children}</> : null;
}

beforeEach(() => { leaflet.map = null; leaflet.tiles = []; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}'))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('layerLeafletBounds', () => {
  it('turns [west, south, east, north] into [[south, west], [north, east]]', () => {
    expect(layerLeafletBounds('displacement', { displacement: layer('displacement') }))
      .toEqual([[34.7275, -90.1459], [34.7830, -90.0826]]);
  });
  it('falls back to the first layer, and gives nothing without data', () => {
    expect(layerLeafletBounds('', { a: layer('a') })).toEqual([[34.7275, -90.1459], [34.7830, -90.0826]]);
    expect(layerLeafletBounds('', {})).toBeNull();
  });
});

describe('the Leaflet map', () => {
  it('opens fitted to the data, not at a fixed zoom', () => {
    render(<AppProvider><Seed><MapContainer toolbarsVisible={false} onToggleToolbars={() => {}} /></Seed></AppProvider>);
    expect(leaflet.map.bounds).toEqual([[34.7275, -90.1459], [34.7830, -90.0826]]);
    expect(leaflet.map.zoom).toBeUndefined();  // a zoom would win over the bounds
  });

  it('gives the raster tile layer the data bounds', async () => {
    render(<AppProvider><Seed><RasterTileLayer /></Seed></AppProvider>);
    await vi.waitFor(() => expect(leaflet.tiles.length).toBeGreaterThan(0));
    expect(leaflet.tiles[leaflet.tiles.length - 1].bounds).toEqual([[34.7275, -90.1459], [34.7830, -90.0826]]);
  });
});
