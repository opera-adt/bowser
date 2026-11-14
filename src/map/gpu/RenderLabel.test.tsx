/** The map's diagnostic label: one line, and every message so far on a click. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDebugMessages, debugMessage } from '../../utils/debug';
import { RenderLabel } from './RenderLabel';
import type { GpuRenderStatus } from './useGpuRender';

const status = (over: Partial<GpuRenderStatus> = {}): GpuRenderStatus => ({
  active: false, chosen: false, renderer: 'tiles', reason: 'fell back to tiles: WebGL context lost',
  showLabel: true, stats: null, ...over,
});
afterEach(() => { cleanup(); clearDebugMessages(); vi.restoreAllMocks(); });

describe('RenderLabel', () => {
  it('is not there with diagnostics off', () => {
    render(<RenderLabel status={status({ showLabel: false })} />);
    expect(screen.queryByTestId('render-label')).toBeNull();
  });

  it('opens every diagnostic message on a click, in full and in order, and closes again', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    debugMessage('data layer: GPU — auto: capable GPU (Test GPU)');
    render(<RenderLabel status={status()} />);
    const label = screen.getByTestId('render-label');
    expect(label.textContent).toBe('Server tiles · fell back to tiles: WebGL context lost');
    expect(label.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('log')).toBeNull();
    fireEvent.click(label);
    expect(label.getAttribute('aria-expanded')).toBe('true');
    const lines = () => Array.from(screen.getByRole('log').children).map(c => c.textContent);
    expect(lines()[0]).toBe('Server tiles · fell back to tiles: WebGL context lost');
    expect(lines()[1]).toMatch(/^\d\d:\d\d:\d\d data layer: GPU — auto: capable GPU \(Test GPU\)$/);
    // A message that arrives while it is open is added.
    act(() => { debugMessage('data layer: tiles — fell back to tiles: WebGL context lost', true); });
    expect(lines()).toHaveLength(3);
    expect(lines()[2]).toContain('fell back to tiles: WebGL context lost');
    fireEvent.click(label);
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('says so when there is nothing yet', () => {
    render(<RenderLabel status={status({ reason: 'render=tiles (default)' })} />);
    fireEvent.click(screen.getByTestId('render-label'));
    expect(screen.getByRole('log').textContent).toContain('No messages yet.');
  });
});
