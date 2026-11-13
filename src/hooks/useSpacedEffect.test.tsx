/** useSpacedEffect: at once when quiet, then at most once per gap, always the latest. */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpacedEffect } from './useSpacedEffect';

const log: string[] = [];
function Probe({ value }: { value: number }) {
  useSpacedEffect(() => {
    log.push(`run ${value}`);
    return () => log.push(`cleanup ${value}`);
  }, [value], 250, () => log.push(`wait ${value}`));
  return null;
}

beforeEach(() => { vi.useFakeTimers(); log.length = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('useSpacedEffect', () => {
  it('runs at once, then spaces a burst and keeps its last value', () => {
    const view = render(<Probe value={1} />);
    expect(log).toEqual(['run 1']);
    // A slider: a change every 20 ms.
    for (const v of [2, 3, 4, 5]) { vi.advanceTimersByTime(20); view.rerender(<Probe value={v} />); }
    expect(log).toEqual(['run 1', 'cleanup 1', 'wait 2', 'wait 3', 'wait 4', 'wait 5']);
    vi.advanceTimersByTime(169);                  // 249 ms after the first run
    expect(log).not.toContain('run 5');
    vi.advanceTimersByTime(1);
    expect(log.slice(-1)).toEqual(['run 5']);     // 2, 3 and 4 never ran
    expect(log.filter(l => l.startsWith('run'))).toEqual(['run 1', 'run 5']);
  });

  it('a change after a quiet gap runs at once, without waiting', () => {
    const view = render(<Probe value={1} />);
    vi.advanceTimersByTime(250);
    view.rerender(<Probe value={2} />);
    expect(log).toEqual(['run 1', 'cleanup 1', 'run 2']);
  });

  it('unmounting drops a waiting run and cleans up the last one', () => {
    const view = render(<Probe value={1} />);
    view.rerender(<Probe value={2} />);
    view.unmount();
    vi.advanceTimersByTime(1000);
    expect(log).toEqual(['run 1', 'cleanup 1', 'wait 2']);
  });
});
