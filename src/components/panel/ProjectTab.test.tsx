import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBUG_KEY } from '../../utils/debug';
import ProjectTab from './ProjectTab';

const state = { units: 'metric', datasetInfo: {}, currentDataset: null } as unknown as Record<string, unknown>;
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state, dispatch: vi.fn() }) }));
vi.mock('./ExportSection', () => ({ default: () => null }));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.removeItem(DEBUG_KEY); });

describe('Project tab › diagnostics', () => {
  it('a small bug icon turns diagnostics on and off; off by default', () => {
    render(<ProjectTab />);
    const bug = screen.getByRole('button', { name: 'Diagnostics' });
    expect(bug.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(bug);
    expect(bug.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(DEBUG_KEY)).toBe('1');
    fireEvent.click(bug);
    expect(bug.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(DEBUG_KEY)).toBeNull();
  });
});
