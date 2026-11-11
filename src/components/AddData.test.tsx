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
/** GET /files answers, by ``dir`` ('' for the server's default folder). */
let folders: Record<string, unknown>;
let filesStatus: number | null;

beforeEach(() => {
  config = { polygon_stats: true, data_conversion: CONVERSION };
  catalog = { datasets: [], allow_open: false };
  dataReplies = [];
  requests = [];
  folders = {};
  filesStatus = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? ` ${init.body}` : '';
    requests.push(`${init?.method ?? 'GET'} ${url}${body}`);
    if (url.startsWith('/config')) return new Response(JSON.stringify(config));
    if (url.startsWith('/catalog')) return new Response(JSON.stringify(catalog));
    if (url === '/upload_data') {
      const name = ((init!.body as FormData).getAll('files')[0] as File).name;
      return new Response(JSON.stringify({ path: `/up/data_1_${name}`, name }));
    }
    if (url.startsWith('/files')) {
      if (filesStatus) return new Response(JSON.stringify({ detail: 'not here' }), { status: filesStatus });
      const dir = (new URL(url, 'http://x').searchParams.get('dir') ?? '').replace(/(.)\/$/, '$1');  // resolved
      const listing = folders[dir];
      return listing
        ? new Response(JSON.stringify(listing))
        : new Response(JSON.stringify({ detail: `${dir} is not a folder` }), { status: 400 });
    }
    if (url.startsWith('/data')) {
      const reply = dataReplies.shift()!;
      return new Response(JSON.stringify(reply), { status: (reply.http as number) ?? 200 });
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

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

describe('Add data: a KMZ', () => {
  it('is read on the server (the browser reads only KML)', async () => {
    dataReplies = [{ id: 'z', name: 'sites.kmz', kind: 'vector', format: 'geojson', status: 'converting',
      layers: ['sites'], feature_count: 3, bounds: [-90.2, 34.7, -90.0, 34.8] }];
    await renderTab();
    expect((screen.getByLabelText('Add files') as HTMLInputElement).accept.split(',')).toContain('.kmz');
    await choose(new File(['PK'], 'sites.kmz'));
    expect(requests).toContain('POST /upload_data');
    expect(requests).toContain('POST /data {"path":"/up/data_1_sites.kmz","name":"sites.kmz"}');
    expect(stateRef.overlays[0]).toMatchObject({ name: 'sites', conversion: { status: 'converting' } });
  });

  it('on bowser-lite, says it needs the full server', async () => {
    config = { polygon_stats: false, data_conversion: { cog: false, pmtiles: false, pmtiles_min_mb: null } };
    await renderTab();
    await choose(new File(['PK'], 'sites.kmz'));
    await waitFor(() => expect(stateRef.overlayMessage).toMatch(/^Could not add/));
    expect(stateRef.overlayMessage).toBe('Could not add sites.kmz: KMZ needs the full Bowser server (bowser run); or unzip it and add the .kml inside');
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

describe('Load file: browse a server folder', () => {
  const dir = (name: string, path: string) => ({ name, path, type: 'dir', size: null, kind: null });
  const tif = (name: string, path: string, size = 2_400_000) => ({ name, path, type: 'file', size, kind: 'raster' });
  const listing = (path: string, parent: string | null, entries: unknown[], extra = {}) =>
    ({ dir: path, parent, entries, truncated: false, skipped: 0, ...extra });
  const DEMTEST = listing('/home/u/demtest', '/home/u', [
    dir('lidar', '/home/u/demtest/lidar'),
    tif('arkabutla_3dep_10m.tif', '/home/u/demtest/arkabutla_3dep_10m.tif'),
    { name: 'wells.shp', path: '/home/u/demtest/wells.shp', type: 'file', size: 512, kind: 'vector' },
  ]);
  const LIDAR = listing('/home/u/demtest/lidar', '/home/u/demtest', [tif('tile_1.tif', '/home/u/demtest/lidar/tile_1.tif')]);
  const job = (path: string) => ({ id: path.length.toString(16).padStart(24, '0'), name: path.split('/').pop(), kind: 'raster',
    format: 'cog', status: 'converting', bounds: [-90.2, 34.7, -90.0, 34.8] });
  const rows = () => screen.getAllByRole('option').map(o => o.textContent);
  const browse = async () => {
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Browse…' })); });
  };

  beforeEach(() => {
    catalog = { datasets: [], allow_open: true };
    folders = { '': DEMTEST, '/home/u/demtest': DEMTEST, '/home/u/demtest/lidar': LIDAR, '/home/u': listing('/home/u', '/', [dir('demtest', '/home/u/demtest')]) };
  });

  it('is called "Load file"', async () => {
    await renderTab();
    expect(await screen.findByText('Load file')).toBeTruthy();
    expect(screen.queryByText('A file on the server')).toBeNull();
  });

  it('Browse lists the folder: sub-folders first, then the files it can add, with their sizes', async () => {
    await renderTab();
    await browse();
    expect(requests).toContain('GET /files');  // nothing remembered: the server's default (the cube's folder)
    expect((screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement).value).toBe('/home/u/demtest');
    expect(rows()).toEqual(['lidar', 'arkabutla_3dep_10m.tif2.3 MB', 'wells.shp512 B']);
    expect(screen.getByRole('button', { name: 'Add all supported files in this folder (2)' })).toBeTruthy();
    expect(localStorage.getItem('bowser.loadFile.dir')).toBe('/home/u/demtest');
  });

  it('opens a sub-folder on a click, and goes up', async () => {
    await renderTab();
    await browse();
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /lidar/ })); });
    expect(requests).toContain('GET /files?dir=%2Fhome%2Fu%2Fdemtest%2Flidar');
    expect(rows()).toEqual(['tile_1.tif2.3 MB']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Up' })); });
    expect(rows()[0]).toBe('lidar');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Up' })); });
    expect((screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement).value).toBe('/home/u');
  });

  it('a click selects a file into the path box; Add adds it', async () => {
    dataReplies = [job('/home/u/demtest/arkabutla_3dep_10m.tif')];
    await renderTab();
    await browse();
    fireEvent.click(screen.getByRole('option', { name: /arkabutla/ }));
    const input = screen.getByRole('textbox', { name: 'File path on the server' }) as HTMLInputElement;
    expect(input.value).toBe('/home/u/demtest/arkabutla_3dep_10m.tif');
    expect(screen.getByRole('option', { name: /arkabutla/ }).getAttribute('aria-selected')).toBe('true');
    expect(requests.filter(r => r.startsWith('POST /data'))).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
    expect(requests).toContain('POST /data {"path":"/home/u/demtest/arkabutla_3dep_10m.tif"}');
    expect(stateRef.overlays[0]).toMatchObject({ name: 'arkabutla_3dep_10m.tif', conversion: { status: 'converting' } });
  });

  it('a double-click adds a file at once', async () => {
    dataReplies = [job('/home/u/demtest/arkabutla_3dep_10m.tif')];
    await renderTab();
    await browse();
    await act(async () => { fireEvent.doubleClick(screen.getByRole('option', { name: /arkabutla/ })); });
    expect(requests).toContain('POST /data {"path":"/home/u/demtest/arkabutla_3dep_10m.tif"}');
    expect(stateRef.overlays).toHaveLength(1);
  });

  it('starts at the last folder used', async () => {
    localStorage.setItem('bowser.loadFile.dir', '/home/u/demtest/lidar');
    await renderTab();
    await browse();
    expect(requests).toContain('GET /files?dir=%2Fhome%2Fu%2Fdemtest%2Flidar');
    expect(requests).not.toContain('GET /files');
    expect(rows()).toEqual(['tile_1.tif2.3 MB']);
  });

  it('"Add all" adds every file, asking first above 10', async () => {
    const many = Array.from({ length: 12 }, (_, i) => tif(`t${i}.tif`, `/many/t${i}.tif`, 10));
    folders = { '': listing('/many', '/', many) };
    dataReplies = many.map(f => job(f.path));
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await renderTab();
    await browse();
    const all = screen.getByRole('button', { name: 'Add all supported files in this folder (12)' });
    await act(async () => { fireEvent.click(all); });
    expect(ask).toHaveBeenLastCalledWith('Add all 12 files in this folder as layers?');
    expect(requests.filter(r => r.startsWith('POST /data'))).toEqual([]);  // declined
    await act(async () => { fireEvent.click(all); });
    expect(requests.filter(r => r.startsWith('POST /data'))).toHaveLength(12);
    expect(stateRef.overlays).toHaveLength(12);
    expect(screen.getByText('Added 12 layers.')).toBeTruthy();
  });

  it('"Add all" adds at most 50, and says so', async () => {
    const many = Array.from({ length: 60 }, (_, i) => tif(`t${i}.tif`, `/many/t${i}.tif`, 10));
    folders = { '': listing('/many', '/', many) };
    dataReplies = many.map(f => job(f.path));
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderTab();
    await browse();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add all supported files in this folder (60)' })); });
    expect(ask).toHaveBeenCalledWith('Add the first 50 of the 60 files in this folder as layers?');
    expect(requests.filter(r => r.startsWith('POST /data'))).toHaveLength(50);
    expect(screen.getByText(/Added 50 layers\. Added the first 50 of 60; add the rest one by one/)).toBeTruthy();
  });

  it('a folder typed in the path box opens the browser there', async () => {
    dataReplies = [{ http: 400, detail: 'No such file: /home/u/demtest/lidar' }];
    await renderTab();
    const input = await screen.findByRole('textbox', { name: 'File path on the server' });
    fireEvent.change(input, { target: { value: '/home/u/demtest/lidar' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(rows()).toEqual(['tile_1.tif2.3 MB']);
    expect(screen.queryByText(/No such file/)).toBeNull();
    expect((input as HTMLInputElement).value).toBe('');
    // With a trailing slash it is a folder: no POST /data first.
    cleanup();
    requests = [];
    await renderTab();
    const again = await screen.findByRole('textbox', { name: 'File path on the server' });
    fireEvent.change(again, { target: { value: '/home/u/demtest/' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
    expect(requests.filter(r => r.startsWith('POST /data'))).toEqual([]);
    expect(rows()[0]).toBe('lidar');
  });

  it('a path that is neither a file nor a folder still shows why', async () => {
    dataReplies = [{ http: 400, detail: 'No such file: /nope.tif' }];
    await renderTab();
    const input = await screen.findByRole('textbox', { name: 'File path on the server' });
    fireEvent.change(input, { target: { value: '/nope.tif' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(requests).toContain('GET /files?dir=%2Fnope.tif');  // tried as a folder first
    expect(screen.getByText('No such file: /nope.tif')).toBeTruthy();
    expect(screen.queryByText(/is not a folder/)).toBeNull();  // the probe's own error stays quiet
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Browse is offered only where the server can list folders', async () => {
    await renderTab();
    expect(await screen.findByRole('button', { name: 'Browse…' })).toBeTruthy();
    cleanup();
    catalog = { datasets: [], allow_open: false };
    await renderTab();
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
    cleanup();
    catalog = { datasets: [], allow_open: true };
    config = { polygon_stats: false, data_conversion: { cog: false, pmtiles: false, pmtiles_min_mb: null } };  // bowser-lite
    await renderTab();
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
    cleanup();
    // A server without GET /files (501): Browse goes away.
    config = { polygon_stats: true, data_conversion: CONVERSION };
    filesStatus = 501;
    await renderTab();
    await browse();
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'File path on the server' })).toBeTruthy();
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
