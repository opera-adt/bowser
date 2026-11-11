/** The panel's rail: a badge on the Assistant tab while it waits for an answer and another tab is open. */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockState } = vi.hoisted(() => ({ mockState: { panelTab: 'main', showChart: false, refBufferEnabled: false } as Record<string, unknown> }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch: vi.fn() }) }));
vi.mock('./panel/MainTab', () => ({ default: () => null }));
vi.mock('./panel/OverlaysTab', () => ({ default: () => null }));
vi.mock('./panel/ProjectTab', () => ({ default: () => null }));
vi.mock('./panel/GnssTab', () => ({ default: () => null }));
vi.mock('./panel/StatsTab', () => ({ default: () => null }));
vi.mock('./panel/AssistantTab', () => ({ default: () => null }));

import ControlPanel from './ControlPanel';
import { setWaiting } from '../assistant/attention';

afterEach(() => { cleanup(); act(() => setWaiting(0)); });

describe('panel rail', () => {
  it('badges the Assistant tab while it waits, unless it is the open tab', () => {
    const view = render(<ControlPanel title="" operaLogo={false} />);
    expect(view.queryByRole('status')).toBeNull();
    act(() => setWaiting(1));
    const badge = view.getByRole('status', { name: 'The Assistant waits for your answer (1)' });
    expect(badge.closest('button')!.id).toBe('tab-assistant');
    mockState.panelTab = 'assistant';
    view.rerender(<ControlPanel title="" operaLogo={false} />);
    expect(view.queryByRole('status')).toBeNull();
    mockState.panelTab = 'main';
  });
});
