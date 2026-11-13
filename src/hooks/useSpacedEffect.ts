import { useEffect, useRef, type DependencyList } from 'react';

/**
 * An effect that runs at most once per `gapMs`: at once if none ran in the last
 * `gapMs`, otherwise when that gap has passed, and only for the latest change (a
 * newer one replaces a waiting one). For requests set off by a slider, which
 * changes on every tick: the first tick asks at once, a drag asks a few times a
 * second, and the value it stops on is always asked for.
 *
 * `onWait` runs at once when the effect has to wait (drop what is shown, say
 * loading). The effect's own cleanup runs as for `useEffect`.
 */
export function useSpacedEffect(
  effect: () => void | (() => void),
  deps: DependencyList,
  gapMs: number,
  onWait?: () => void,
): void {
  const lastRun = useRef(-Infinity);
  useEffect(() => {
    let cleanup: void | (() => void);
    const run = () => { lastRun.current = performance.now(); cleanup = effect(); };
    const wait = gapMs - (performance.now() - lastRun.current);
    if (wait <= 0) {
      run();
      return () => { if (cleanup) cleanup(); };
    }
    onWait?.();
    const timer = setTimeout(run, wait);
    return () => { clearTimeout(timer); if (cleanup) cleanup(); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
