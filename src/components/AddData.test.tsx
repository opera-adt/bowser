/**
 * Overlays › Add data: files converted on the server in the background (a raster to a COG,
 * a large vector to PMTiles) with their status in the layer's row, a file by its server
 * path, small vectors still read in the browser, and the DEM styling of an elevation raster.
 */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppState, Overlay } from '../types';
import OverlaysTab from './panel/OverlaysTab';

vi.mock('../map/pmtiles', async orig => ({
  ...(await orig<typeof import('../map/pmtiles')>()),
  inspectPmtiles: vi.fn(async () => ({
    kind: 'vector', layers: ['parcels'], bounds: [-90.2, 34.7, -90.0, 34.8], minzoom: 8, maxzoom: 14, name: 'parcels', attribution: null,
  })),
}));

const CONVERSION = { cog: true, pmtiles: true, pmtiles_min_mb: 0.01 };  // 10 kB, so a test file is "large"
let config: Record<string, unknown>;
let catalog: Record<string, unknown>;
let dataReplies: Record<string, unknown>[];
let requests: string[];

beforeEach(() => {
  config = { polygon_stats: true, data_conversion: CONVERSION };
  catalog = { datasets: [], allow_open: false };
  dataReplies = [];
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? ` ${init.body}` : '';
    requests.push(`${init?.method ?? 'GET'} ${url}${body}`);
    if (url.startsWith('/config')) return new Response(JSON.stringify(config));
    if (url.startsWith('/catalog')) return new Response(JSON.stringify(catalog));
    if (url === '/upload_data') {
      const name = ((init!.body as FormData).getAll('files')[0] as File).name;
      return new Response(JSON.stringify({ path: `/up/data_1_${name}`, name }));
    }
    if (url.startsWith('/data')) {
      const reply = dataReplies.shift()!;
      return new Response(JSON.stringify(reply), { status: (reply.http as number) ?? 200 });
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

let stateRef: AppState;
function Tab({ seed }: { seed: Overlay[] }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => { dispatch({ type: 'SET_OVERLAYS', payload: seed }); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <OverlaysTab />;
}
const renderTab = async (seed: Overlay[] = []) => {
  render(<AppProvider><Tab seed={seed} /></AppProvider>);
  await act(async () => {});
};
const openStyle = () => fireEvent.click(screen.getByTitle('Style'));
const choose = async (...files: File[]) => {
  await act(async () => { fireEvent.change(screen.getByLabelText('Add files'), { target: { files } }); });
};
const status = () => screen.getByRole('status').textContent;
/** A file as the browser gives it (jsdom's File has no text()). */
const file = (content: string, name: string) => Object.assign(new File([content], name), { text: async () => content });

const BANDS = [{ name: 'b1', min: 54, max: 94, p2: 60, p98: 90, p5: 62, p95: 88 }];
const DEM_READY = {
  id: 'k', name: 'arkabutla_3dep_10m.tif', kind: 'raster', format: 'cog', status: 'ready', converted: true,
  cog: '/up/k.tif', band_count: 1, bands: BANDS, dem: true, bounds: [-90.2, 34.7, -90.0, 34.8],
};

describe('Add data: a raster', () => {
  it('is uploaded, converted to a COG ("Converting to COG… 3 s"), then drawn as a DEM under the data', async () => {
    vi.useFakeTimers();
    dataReplies = [
      { id: 'k', name: 'arkabutla_3dep_10m.tif', kind: 'raster', format: 'cog', status: 'converting', elapsed_s: 3, bounds: DEM_READY.bounds },
      DEM_READY,
    ];
    await renderTab([{ id: 'roads', name: 'roads', type: 'wms', visible: true, opacity: 1, aboveData: false }]);
    await choose(new File(['II*'], 'arkabutla_3dep_10m.tif'));
    expect(requests).toContain('POST /upload_data');
    expect(requests).toContain('POST /data {"path":"/up/data_1_arkabutla_3dep_10m.tif","name":"arkabutla_3dep_10m.tif"}');
    expect(status()).toBe('Converting to COG… 3 s');
    const row = stateRef.overlays[1];
    expect(row).toMatchObject({ type: 'geotiff', conversion: { status: 'converting', format: 'cog' } });
    expect(row.path).toBeUndefined();  // nothing to draw yet

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(requests).toContain('GET /data/k');
    expect(screen.queryByRole('status')).toBeNull();
    // Ready, and the server took it for elevation: DEM styling, moved to the bottom.
    expect(stateRef.overlays.map(o => o.id)[1]).toBe('roads');
    expect(stateRef.overlays[0]).toMatchObject({
      path: '/up/k.tif', bandCount: 1, cmap: 'schwarzwald', vmin: 60, vmax: 90, aboveData: false,
      dem: { style: 'both', exaggeration: 2, base: 60 }, conversion: { status: 'ready' },
    });
    expect(screen.getByText('DEM')).toBeTruthy();  // the row's type label
  });

  it('a raster that is not a DEM keeps "Use as DEM", which gives it the DEM styling', async () => {
    dataReplies = [{ ...DEM_READY, name: 'velocity.tif', dem: false, bands: [{ ...BANDS[0], p2: -5, p98: 5 }] }];
    await renderTab();
    await choose(new File(['II*'], 'velocity.tif'));
    expect(stateRef.overlays[0]).toMatchObject({ cmap: 'viridis', vmin: -5, vmax: 5 });
    expect(stateRef.overlays[0].dem).toBeUndefined();
    openStyle();
    fireEvent.click(screen.getByRole('switch', { name: 'Use as DEM' }));
    expect(stateRef.overlays[0]).toMatchObject({ cmap: 'schwarzwald', dem: { style: 'both' } });
    expect(screen.getByRole('combobox', { name: 'DEM style' })).toBeTruthy();
    // Off again: an ordinary raster.
    fireEvent.click(screen.getByRole('switch', { name: 'Use as DEM' }));
    expect(stateRef.overlays[0].dem).toBeUndefined();
  });

  it('shows why a conversion failed', async () => {
    dataReplies = [{ id: 'k', name: 'bad.tif', kind: 'raster', format: 'cog', status: 'failed', error: 'GDAL: not a raster' }];
    await renderTab();
    await choose(new File(['x'], 'bad.tif'));
    expect(status()).toBe('Could not add it: GDAL: not a raster');
  });
});

describe('Add data: a vector', () => {
  const parcels = () => file(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-90.1, 34.75] } }] }).padEnd(20_000), 'parcels.geojson');

  it('a large one is tiled on the server ("Converting to PMTiles…"), then drawn from the archive', async () => {
    vi.useFakeTimers();
    dataReplies = [
      { id: 'p', name: 'parcels.geojson', kind: 'vector', format: 'pmtiles', status: 'converting', elapsed_s: 65,
        layers: ['parcels'], feature_count: 60000, bounds: [-90.2, 34.7, -90.0, 34.8] },
      { id: 'p', name: 'parcels.geojson', kind: 'vector', format: 'pmtiles', status: 'ready', converted: true,
        url: '/data/p.pmtiles', layers: ['parcels'], feature_count: 60000, bounds: [-90.2, 34.7, -90.0, 34.8] },
    ];
    await renderTab();
    await choose(parcels());
    expect(requests).toContain('POST /data {"path":"/up/data_1_parcels.geojson","name":"parcels.geojson"}');
    expect(status()).toBe('Converting to PMTiles… 1 min 5 s');
    expect(stateRef.overlays[0]).toMatchObject({ name: 'parcels', type: 'pmtiles', pmtilesKind: 'vector', featureCount: 60000 });

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(stateRef.overlays[0]).toMatchObject({
      url: `${window.location.origin}/data/p.pmtiles`, sourceLayers: ['parcels'], minzoom: 8, maxNativeZoom: 14,
      conversion: { status: 'ready', format: 'pmtiles' },
    });
    // Zonal stats need the features in the browser: the button says why it is off.
    const zonal = screen.getByRole('button', { name: 'Zonal stats' }) as HTMLButtonElement;
    expect(zonal.disabled).toBe(true);
    expect(zonal.title).toMatch(/^60,000 features, drawn from vector tiles: Identify shows their attributes, but zonal stats/);
  });

  it('a small one is still read in the browser, as before', async () => {
    await renderTab();
    const small = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [-90.1, 34.75] } }] };
    await choose(file(JSON.stringify(small), 'wells.geojson'));
    await waitFor(() => expect(stateRef.overlays[0]).toMatchObject({ name: 'wells', type: 'vector' }));
    expect(requests.filter(r => /upload|\/data/.test(r))).toEqual([]);
    expect(stateRef.overlays[0].data!.features).toHaveLength(1);
    expect(stateRef.overlays[0].conversion).toBeUndefined();
  });

  it('on bowser-lite, a large one too: there is no server conversion', async () => {
    config = { polygon_stats: false, data_conversion: { cog: false, pmtiles: false, pmtiles_min_mb: null } };
    await renderTab();
    await choose(parcels());
    await waitFor(() => expect(stateRef.overlays[0]).toMatchObject({ name: 'parcels', type: 'vector' }));
    expect(requests.filter(r => /upload|\/data/.test(r))).toEqual([]);
  });
});

describe('Add data: a file on the server', () => {
  it('replaces the DEM-only path box: one field for any file, when the server allows opening files', async () => {
    catalog = { datasets: [], allow_open: true };
    dataReplies = [{ id: 'g', name: 'site.gpkg', kind: 'vector', format: 'geojson', status: 'converting',
      layers: ['wells'], feature_count: 2, bounds: [-90.2, 34.7, -90.0, 34.8] }];
    await renderTab();
    expect(screen.queryByRole('textbox', { name: 'DEM path on the server' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add DEM' })).toBeNull();
    expect(screen.queryByText('DEM on the server')).toBeNull();
    const input = await screen.findByRole('textbox', { name: 'File path on the server' });
    fireEvent.change(input, { target: { value: '/data/site.gpkg' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
    expect(requests).toContain('POST /data {"path":"/data/site.gpkg"}');
    expect(stateRef.overlays[0]).toMatchObject({ name: 'site', type: 'vector', conversion: { status: 'converting', format: 'geojson' } });
    expect(status()).toBe('Reading the features…');
  });

  it('shows the server refusing a path', async () => {
    catalog = { datasets: [], allow_open: true };
    dataReplies = [{ http: 403, detail: 'Opening data from the page is off on this server' }];
    await renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'File path on the server' }), { target: { value: '/etc/x.tif' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
    expect(screen.getByText('Opening data from the page is off on this server')).toBeTruthy();
    expect(stateRef.overlays).toEqual([]);
  });

  it('no field when the server does not allow opening files, or cannot convert (bowser-lite)', async () => {
    await renderTab();
    expect(screen.queryByRole('textbox', { name: 'File path on the server' })).toBeNull();
    cleanup();
    catalog = { datasets: [], allow_open: true };
    config = { polygon_stats: false, data_conversion: { cog: false, pmtiles: false, pmtiles_min_mb: null } };
    await renderTab();
    await act(async () => {});
    expect(screen.queryByRole('textbox', { name: 'File path on the server' })).toBeNull();
  });
});

describe('DEM controls', () => {
  const ready: Overlay = {
    id: 'g1', name: 'lidar.tif', type: 'geotiff', path: '/up/k.tif', bandCount: 1, bands: BANDS, visible: true, opacity: 1,
    mode: 'cmap', cmap: 'schwarzwald', vmin: 70, vmax: 95, discrete: false, nbins: 5, aboveData: false,
    dem: { style: 'both', exaggeration: 2 }, conversion: { status: 'ready', format: 'cog' },
  };

  it('style, hillshade exaggeration and relief colours, each where it applies', async () => {
    await renderTab([ready]);
    openStyle();
    const style = screen.getByRole('combobox', { name: 'DEM style' }) as HTMLSelectElement;
    expect(style.value).toBe('both');
    expect([...style.options].map(o => o.textContent)).toEqual(['Hillshade and colour', 'Hillshade', 'Colour relief']);
    const slider = screen.getByRole('slider', { name: 'Hillshade exaggeration' }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '6.5' } });
    expect(stateRef.overlays[0].dem!.exaggeration).toBe(6.5);
    expect(screen.getByText('×6.5')).toBeTruthy();
    // 3D terrain needs the WebGL map (jsdom has none, as on the Leaflet map)
    const terrain = screen.getByRole('switch', { name: 'Use for 3D terrain' }) as HTMLButtonElement;
    expect(terrain.disabled).toBe(true);
    expect(terrain.closest('[title]')!.getAttribute('title')).toMatch(/needs the WebGL map/);
    // the ordinary raster's discrete-classes switch makes no sense for a DEM
    expect(screen.queryByRole('switch', { name: 'Discrete classes' })).toBeNull();

    fireEvent.change(style, { target: { value: 'hillshade' } });
    expect(stateRef.overlays[0].dem!.style).toBe('hillshade');
    expect(screen.queryByText(/70/)).toBeNull();  // no colour range for a grey hillshade

    fireEvent.change(style, { target: { value: 'relief' } });
    expect(screen.queryByRole('slider', { name: 'Hillshade exaggeration' })).toBeNull();

    // opacity is the row's own slider
    fireEvent.change(screen.getByRole('slider', { name: 'Opacity of lidar.tif' }), { target: { value: '0.4' } });
    expect(stateRef.overlays[0].opacity).toBe(0.4);
  });

  it('"Use as DEM" is offered for single-band rasters only', async () => {
    await renderTab([{ ...ready, dem: undefined, bandCount: 3, mode: 'rgb' }]);
    openStyle();
    expect(screen.queryByRole('switch', { name: 'Use as DEM' })).toBeNull();
  });
});
