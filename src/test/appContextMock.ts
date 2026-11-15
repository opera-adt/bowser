/**
 * A stand-in for context/AppContext in a test that gives a component its state directly:
 *
 *   vi.mock('../context/AppContext', async () =>
 *     (await import('../test/appContextMock')).appContextMock(() => ({ state, dispatch })));
 *
 * It answers every way a component can read the app state (the whole of it, one part, on
 * demand, dispatch alone), so a test does not change when its component moves from one to
 * another. ``get`` is called on each read: the test may replace its state between renders.
 */
type Given = { state: unknown; dispatch?: (action: never) => void };

const ignore = () => undefined;

export function appContextMock(get: () => Given) {
  const dispatch = () => get().dispatch ?? ignore;
  return {
    useAppContext: () => ({ state: get().state, dispatch: dispatch() }),
    useAppState: <T>(select: (state: never) => T): T => select(get().state as never),
    useAppFields: () => get().state,
    useAppDispatch: dispatch,
    useGetAppState: () => () => get().state,
  };
}
