/** Identify shows a plain arrow over the map, not the "help" (question-mark) cursor. */
import { useEffect } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import { useIdentify } from './identifyTool';

const canvas = document.createElement('canvas');
const map = { getCanvas: () => canvas, on: () => {}, off: () => {} } as any;

function Host() {
  const { dispatch } = useAppContext();
  useEffect(() => { dispatch({ type: 'TOGGLE_IDENTIFY' }); }, [dispatch]);
  useIdentify(map, true);
  return null;
}

afterEach(() => { cleanup(); canvas.style.cursor = ''; });

describe('Identify cursor', () => {
  it('is an arrow while Identify is on, and reset when it turns off', async () => {
    const { unmount } = render(<AppProvider><Host /></AppProvider>);
    await waitFor(() => expect(canvas.style.cursor).toBe('default'));
    unmount();
    expect(canvas.style.cursor).toBe('');
  });
});
