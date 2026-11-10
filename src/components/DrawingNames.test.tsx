/**
 * Naming drawn shapes (Overlays › Draw): the name is the shape's ``name`` property, survives the
 * editor's next sync, names the area made from the shape (chart legend, Points panel, Stats tab,
 * CSV), follows a rename of that area, and is saved with the project.
 */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, OverlayFeatures } from '../types';
import { DRAWINGS_ID } from '../map/overlays';
import { polygonChoices } from '../utils/polygonSeries';

vi.mock('../map/mapChoice', () => ({ chooseMap: () => 'maplibre', browserHasWebGL2: () => true }));
const saved = vi.hoisted(() => ({ files: [] as { data: Blob | string; name: string }[] }));
vi.mock('../utils/saveFile', () => ({
  saveFile: async (data: Blob | string, name: string) => { saved.files.push({ data, name }); return true; },
}));

import OverlaysTab from './panel/OverlaysTab';
import PointManagerPanel from './PointManagerPanel';
import StatsTab from './panel/StatsTab';
import ProjectTab from './panel/ProjectTab';

const square = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] });
const drawn = (features: unknown[]): OverlayFeatures => ({ type: 'FeatureCollection', features });
const shape = (id: string, x: number, properties: Record<string, unknown> = {}) => ({ type: 'Feature', id, properties, geometry: square(x) });

let stateRef: AppState;
let dispatchRef: (a: AppAction) => void;
function Seed({ setup, children }: { setup: AppAction[]; children?: React.ReactNode }) {
  const { state, dispatch } = useAppContext();
  stateRef = state; dispatchRef = dispatch;
  useEffect(() => { setup.forEach(dispatch); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <>{children}</>;
}
const run = (a: AppAction) => act(() => dispatchRef(a));
const drawings = () => stateRef.overlays.find(o => o.id === DRAWINGS_ID)!.data!.features as any[];

beforeEach(() => { saved.files = []; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}'))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('drawn shape names', () => {
  it('are edited in Overlays › Draw and kept when the editor syncs again', () => {
    render(<AppProvider><Seed setup={[{ type: 'SET_DRAWINGS', payload: drawn([shape('g1', 0), shape('g2', 2)]) }]}><OverlaysTab /></Seed></AppProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Draw' }));
    const box = screen.getByLabelText('Name of polygon 1') as HTMLInputElement;
    expect(box.placeholder).toBe('Polygon 1');
    fireEvent.change(box, { target: { value: 'Spillway' } });
    expect(drawings()[0].properties.name).toBe('Spillway');
    // The editor hands back its own collection, without our property: the name stays (by id, or by shape).
    run({ type: 'SET_DRAWINGS', payload: drawn([shape('g1', 0.5), shape('g2', 2)]) });
    expect(drawings()[0].properties.name).toBe('Spillway');
    run({ type: 'SET_DRAWINGS', payload: drawn([{ ...shape('x', 0.5), id: undefined }, shape('g2', 2)]) });
    expect(drawings()[0].properties.name).toBe('Spillway');
    // + Area offers it by that name.
    expect(polygonChoices(stateRef.overlays).map(c => c.name)).toEqual(['Spillway', 'Drawings 2']);
  });

  it('name the area drawn for + Area, and a rename either way follows', () => {
    render(<AppProvider><Seed setup={[{ type: 'SET_DRAWINGS', payload: drawn([shape('g1', 0)]) }]}>
      <PointManagerPanel /><StatsTab />
    </Seed></AppProvider>);
    run({ type: 'ADD_CHART_AREA', payload: { geometry: square(0) } });
    expect(stateRef.chartAreas[0].name).toBe('Area 1');
    expect(drawings()[0].properties.name).toBe('Area 1');  // the shape takes the area's name
    run({ type: 'RENAME_DRAWING', payload: { index: 0, name: 'Dam crest' } });
    expect(stateRef.chartAreas[0].name).toBe('Dam crest');
    expect(screen.getByRole('listitem', { name: 'Dam crest' })).toBeTruthy();  // the Stats tab
    run({ type: 'UPDATE_CHART_AREA', payload: { id: stateRef.chartAreas[0].id, updates: { name: 'Crest' } } });
    expect(drawings()[0].properties.name).toBe('Crest');
  });

  it('give a named shape its name when it becomes an area', () => {
    render(<AppProvider><Seed setup={[{ type: 'SET_DRAWINGS', payload: drawn([shape('g1', 0, { name: 'Lot 7' })]) }]} /></AppProvider>);
    run({ type: 'ADD_CHART_AREA', payload: { geometry: square(0) } });
    expect(stateRef.chartAreas[0].name).toBe('Lot 7');
  });

  it('are saved with the project', async () => {
    render(<AppProvider><Seed setup={[{ type: 'SET_DRAWINGS', payload: drawn([shape('g1', 0)]) },
      { type: 'RENAME_DRAWING', payload: { index: 0, name: 'Spillway' } }]}><ProjectTab /></Seed></AppProvider>);
    await act(async () => { fireEvent.click(screen.getByTitle(/Save points/)); });
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved.files[0].data as Blob);
    });
    const drawingsLayer = JSON.parse(text).overlays.find((o: any) => o.id === DRAWINGS_ID);
    expect(drawingsLayer.data.features[0].properties.name).toBe('Spillway');
  });
});
