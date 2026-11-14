import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBUG_KEY } from '../../utils/debug';
import { RENDER_KEY } from '../../map/gpu/renderMode';
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

describe('Project tab › renderer', () => {
  afterEach(() => { localStorage.removeItem(RENDER_KEY); });

  it('a button next to the bug goes through server tiles, automatic and GPU; tiles by default', () => {
    render(<ProjectTab />);
    const button = () => screen.getByRole('button', { name: /^Renderer: / });
    expect(button().getAttribute('aria-label')).toBe('Renderer: Server tiles');
    expect(button().className).not.toContain(' on');
    expect(button().nextElementSibling).toBe(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(button());
    expect(button().getAttribute('aria-label')).toBe('Renderer: Automatic');
    expect(button().className).toContain(' on');
    expect(localStorage.getItem(RENDER_KEY)).toBe('auto');
    fireEvent.click(button());
    expect(button().getAttribute('aria-label')).toBe('Renderer: GPU');
    expect(localStorage.getItem(RENDER_KEY)).toBe('gpu');
    fireEvent.click(button());
    expect(button().getAttribute('aria-label')).toBe('Renderer: Server tiles');
    expect(localStorage.getItem(RENDER_KEY)).toBeNull();
  });
});
});
