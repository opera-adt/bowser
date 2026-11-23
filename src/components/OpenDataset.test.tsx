/** Rail › Open: switch to another catalog dataset or the picker, offering to save the project first. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState } from '../types';

const saved = vi.hoisted(() => ({ files: [] as string[], answer: true }));
vi.mock('../utils/saveFile', () => ({
  saveFile: async (_data: Blob | string, name: string) => { saved.files.push(name); return saved.answer; },
}));

import { nav, OPEN_EVENT } from '../utils/openDataset';
import OpenDataset from './OpenDataset';

let stateRef: AppState;
function Seed({ setup = [] }: { setup?: AppAction[] }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => { setup.forEach(dispatch); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <OpenDataset icon={<span />} />;
}
const POINT: AppAction = { type: 'ADD_TIME_SERIES_POINT', payload: { position: [34.76, -90.13] } } as AppAction;
const CATALOG = { datasets: [{ id: 'hawaii', name: 'Hawaii' }, { id: 'dam', name: 'Arkabutla dam' }], allow_open: true };

let went: string[];
let catalog: object;
beforeEach(() => {
  went = [];
  saved.files = []; saved.answer = true;
  catalog = CATALOG;
  vi.spyOn(nav, 'go').mockImplementation(href => { went.push(href); });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/catalog') ? catalog : {}))));
  window.history.replaceState(null, '', '/?dataset=hawaii');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const openList = async () => {
  fireEvent.click(await screen.findByTitle(/Open another dataset/));
  return screen.findByRole('listbox', { name: 'Datasets' });
};

describe('Open another dataset', () => {
  it('lists the catalog, marks the open one and switches without asking when there is no work', async () => {
    render(<AppProvider><Seed /></AppProvider>);
    await openList();
    expect(screen.getByRole('option', { name: 'Hawaii (open)' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: 'Arkabutla dam' }));
    expect(went).toEqual(['/?dataset=dam']);
  });

  it('asks to save first when there is work: open without saving, or cancel', async () => {
    render(<AppProvider><Seed setup={[POINT]} /></AppProvider>);
    await waitFor(() => expect(stateRef.timeSeriesPoints).toHaveLength(1));
    await openList();
    fireEvent.click(screen.getByRole('option', { name: 'Arkabutla dam' }));
    expect(screen.getByText('Save the project first?')).toBeTruthy();
    expect(went).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(went).toEqual([]);
    fireEvent.click(screen.getByRole('option', { name: 'Arkabutla dam' }));
    fireEvent.click(screen.getByRole('button', { name: "Don't save" }));
    expect(went).toEqual(['/?dataset=dam']);
    expect(saved.files).toEqual([]);
  });

  it('saves the project, then opens; a cancelled save stays', async () => {
    render(<AppProvider><Seed setup={[POINT]} /></AppProvider>);
    await waitFor(() => expect(stateRef.timeSeriesPoints).toHaveLength(1));
    await openList();
    fireEvent.click(screen.getByRole('button', { name: 'Show the dataset picker' }));
    saved.answer = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save and open' })); });
    expect(saved.files).toHaveLength(1);
    expect(went).toEqual([]);
    saved.answer = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save and open' })); });
    expect(saved.files).toHaveLength(2);
    expect(went).toEqual(['/picker']);
  });

  it('opens with Ctrl+O, and answers the desktop File menu', async () => {
    render(<AppProvider><Seed /></AppProvider>);
    await screen.findByTitle(/Open another dataset/);
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(await screen.findByRole('listbox', { name: 'Datasets' })).toBeTruthy();
    const event = new CustomEvent(OPEN_EVENT, { detail: 'picker', cancelable: true });
    act(() => { window.dispatchEvent(event); });
    // Handled here, so the menu does not fall back to loading the picker itself.
    expect(event.defaultPrevented).toBe(true);
    expect(went).toEqual(['/picker']);
  });

  it('sends a cube by path or folder search to Project › Open data', async () => {
    render(<AppProvider><Seed /></AppProvider>);
    await openList();
    fireEvent.click(screen.getByRole('button', { name: 'Open a cube or search a folder…' }));
    expect(stateRef.panelTab).toBe('project');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is not shown on a single-cube server: no catalog and no opening', async () => {
    catalog = { datasets: [], allow_open: false };
    render(<AppProvider><Seed /></AppProvider>);
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(screen.queryByTitle(/Open another dataset/)).toBeNull();
  });
});
