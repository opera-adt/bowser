/** A project keeps the chart's model: whether it and its residuals are shown, and its fit settings. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState } from '../types';

const saved = vi.hoisted(() => ({ files: [] as { data: Blob | string; name: string }[] }));
vi.mock('../utils/saveFile', () => ({
  saveFile: async (data: Blob | string, name: string) => { saved.files.push({ data, name }); return true; },
}));

import ProjectTab from './panel/ProjectTab';

let stateRef: AppState;
function Seed({ setup }: { setup: AppAction[] }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => { setup.forEach(dispatch); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <ProjectTab />;
}
const FIT = { polyOrder: 2 as const, annual: true, semiannual: false, steps: ['2021-06-01'], breaks: [], rejectOutliers: true };
const MODEL_ON: AppAction[] = [
  { type: 'TOGGLE_TRENDS' },
  { type: 'TOGGLE_RESIDUALS' },
  { type: 'SET_FIT_SETTINGS', payload: FIT },
];

const readBlob = (blob: Blob) => new Promise<string>(resolve => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.readAsText(blob);
});
const load = async (project: object) => {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  const text = JSON.stringify(project);
  // jsdom's File has no text(); the browser's does.
  const file = Object.assign(new File([text], 'p.json', { type: 'application/json' }), { text: async () => text });
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

beforeEach(() => {
  saved.files = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the model in a project', () => {
  it('is saved: shown, residuals and fit settings', async () => {
    render(<AppProvider><Seed setup={MODEL_ON} /></AppProvider>);
    await act(async () => { fireEvent.click(screen.getByTitle(/Save points/)); });
    const project = JSON.parse(await readBlob(saved.files[0].data as Blob));
    expect(project.showTrends).toBe(true);
    expect(project.showResiduals).toBe(true);
    expect(project.fitSettings).toEqual(FIT);
  });

  it('comes back on load', async () => {
    render(<AppProvider><Seed setup={[]} /></AppProvider>);
    expect(stateRef.showTrends).toBe(false);
    await load({ bowser_project: 1, showTrends: true, showResiduals: true, fitSettings: FIT });
    expect(stateRef.showTrends).toBe(true);
    expect(stateRef.showResiduals).toBe(true);
    expect(stateRef.fitSettings).toEqual(FIT);
  });

  it('is left alone by an older project file without it', async () => {
    render(<AppProvider><Seed setup={[]} /></AppProvider>);
    await load({ bowser_project: 1, currentTimeIndex: 3 });
    expect(stateRef.currentTimeIndex).toBe(3);
    expect(stateRef.showTrends).toBe(false);
    expect(stateRef.showResiduals).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it('ignores a malformed flag and says so', async () => {
    render(<AppProvider><Seed setup={[]} /></AppProvider>);
    await load({ bowser_project: 1, currentTimeIndex: 2, showTrends: 'yes' });
    expect(stateRef.showTrends).toBe(false);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('showTrends'));
  });
});
