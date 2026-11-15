import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../types';

let state: AppState;
vi.mock('../context/AppContext', async () =>
  (await import('../test/appContextMock')).appContextMock(() => ({ state })));

import IdentifyPanel from './IdentifyPanel';

afterEach(cleanup);

const found = { lngLat: [-90.11, 34.75], items: [{ title: 'Geology', rows: [['unit', 'Alluvium']] }], pending: [] };

describe('the identify result panel', () => {
  it('is placed in the window, where its position is measured, so the side panel cannot push it off screen', () => {
    state = { identifyEnabled: true, identify: found } as unknown as AppState;
    const { container } = render(<IdentifyPanel />);
    const panel = container.querySelector('.identify-panel') as HTMLElement;
    expect(panel.style.position).toBe('fixed');
    // 320 wide, 100 from the window's right edge.
    expect(parseFloat(panel.style.left)).toBe(window.innerWidth - 320 - 100);
    expect(screen.getByText('Alluvium')).toBeTruthy();
  });

  it('shows nothing while Identify is off or nothing was clicked', () => {
    state = { identifyEnabled: false, identify: found } as unknown as AppState;
    expect(render(<IdentifyPanel />).container.querySelector('.identify-panel')).toBeNull();
    cleanup();
    state = { identifyEnabled: true, identify: null } as unknown as AppState;
    expect(render(<IdentifyPanel />).container.querySelector('.identify-panel')).toBeNull();
  });
});
