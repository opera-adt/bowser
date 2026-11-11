/** Map toolbars: markup (pinned), what each button dispatches, and disabled unsupported features. */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatch, mockState, setProfileActive } = vi.hoisted(() => ({
  dispatch: vi.fn(), setProfileActive: vi.fn(), mockState: {} as Record<string, any>,
}));
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch }) }));
vi.mock('./ProfileTool', () => ({ useProfileContext: () => ({ active: false, setActive: setProfileActive }) }));

import { MapLeftToolbar, MapTopRightToolbar, type MapFeature } from './MapToolbars';

beforeEach(() => {
  dispatch.mockReset();
  setProfileActive.mockReset();
  Object.assign(mockState, {
    currentDataset: 'displacement', datasetInfo: { displacement: { latlon_bounds: [-117.68, 33.95, -117.66, 33.97] } },
    refEnabled: true, pointPickingEnabled: true, splitScreen: false, showColorbar: true, showLosIndicator: false,
    graticuleMode: 'off', annotationMode: false, pixelInspectEnabled: false, selectedBasemap: 'esriSatellite',
    secondaryBasemap: null, basemapSwapped: false, basemapOpacity: 1, secondaryBasemapOpacity: 0.5,
  });
});

afterEach(cleanup);

const ALL_OFF: ReadonlySet<MapFeature> = new Set(['measure', 'profile', 'split', 'graticule', 'annotation']);

describe('map toolbars (Leaflet: everything supported)', () => {
  it('renders the same buttons as before', () => {
    const left = render(<MapLeftToolbar measureActive={false} onToggleMeasure={() => {}} onMeasureOff={() => {}} />);
    const right = render(<MapTopRightToolbar onToggleToolbars={() => {}} />);
    expect(left.container.innerHTML).toMatchSnapshot('left');
    expect(right.container.innerHTML).toMatchSnapshot('right');
    expect(left.container.querySelectorAll('[disabled]')).toHaveLength(0);
  });

  it('buttons dispatch their actions', () => {
    const onToggleMeasure = vi.fn();
    const left = render(<MapLeftToolbar measureActive={false} onToggleMeasure={onToggleMeasure} onMeasureOff={() => {}} />);
    fireEvent.click(left.getByTitle('Toggle spatial re-referencing'));
    fireEvent.click(left.getByTitle(/Point picking ON/));
    fireEvent.click(left.getByTitle(/Measure distance/));
    expect(onToggleMeasure).toHaveBeenCalledTimes(1);
    expect(setProfileActive).toHaveBeenCalledWith(false);

    const right = render(<MapTopRightToolbar onToggleToolbars={() => {}} />);
    fireEvent.click(right.getByTitle('Fit view to dataset'));
    fireEvent.click(right.getByTitle('Toggle LOS geometry indicator'));
    fireEvent.click(right.getByTitle('Inspect pixel value on hover'));
    expect(dispatch.mock.calls.map(c => c[0].type)).toEqual([
      'TOGGLE_REF_ENABLED', 'TOGGLE_POINT_PICKING', 'APPLY_VIEW_BOUNDS', 'TOGGLE_LOS_INDICATOR', 'TOGGLE_PIXEL_INSPECT',
    ]);
    expect(dispatch.mock.calls[2][0].payload).toEqual([33.95, -117.68, 33.97, -117.66]);
  });
});

describe('map toolbars (MapLibre: some features not there yet)', () => {
  it('disables the unsupported buttons and they do nothing', () => {
    const onToggleMeasure = vi.fn();
    const left = render(<MapLeftToolbar measureActive={false} onToggleMeasure={onToggleMeasure} onMeasureOff={() => {}}
      unsupported={ALL_OFF} />);
    const right = render(<MapTopRightToolbar onToggleToolbars={() => {}} unsupported={ALL_OFF} />);
    const off = [...left.container.querySelectorAll('[data-unsupported]'), ...right.container.querySelectorAll('[data-unsupported]')]
      .map(el => el.getAttribute('data-unsupported'));
    expect(off.sort()).toEqual(['annotation', 'graticule', 'measure', 'profile', 'split']);
    fireEvent.click(left.getByTitle(/Measure distance/));
    fireEvent.click(right.getByTitle(/Split screen/));
    expect(onToggleMeasure).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('places map-specific buttons in the right toolbar', () => {
    const right = render(<MapTopRightToolbar onToggleToolbars={() => {}}><button title="3D terrain" /></MapTopRightToolbar>);
    expect(right.getByTitle('3D terrain')).toBeTruthy();
  });
});

describe("the Assistant's commands (src/assistant/commands.ts)", () => {
  const env = () => ({ getState: () => mockState as never, dispatch });

  it('every toolbar button has a command', async () => {
    const { COMMAND_IDS } = await import('../assistant/commands');
    const left = render(<MapLeftToolbar measureActive={false} onToggleMeasure={() => {}} onMeasureOff={() => {}} />);
    const right = render(<MapTopRightToolbar onToggleToolbars={() => {}} />);
    const buttons = [...left.container.querySelectorAll('.map-tool-btn'), ...right.container.querySelectorAll('.map-tool-btn')];
    expect(buttons.length).toBeGreaterThan(12);
    for (const b of buttons) {
      const id = b.getAttribute('data-command');
      expect(id && COMMAND_IDS.has(id), `${b.getAttribute('title')} has no command`).toBe(true);
    }
  });

  it('run_command dispatches what clicking does, and only when the state differs', async () => {
    const { runCommand } = await import('../assistant/commands');
    const cases: [string, string, Record<string, unknown>, (s: Record<string, any>) => void][] = [
      ['Split screen — compare two layers', 'map.split_screen', { on: true }, s => { s.splitScreen = true; }],
      ['Toggle colorbar on map', 'map.colorbar', { on: false }, s => { s.showColorbar = false; }],
      ['Toggle LOS geometry indicator', 'map.los', { on: true }, s => { s.showLosIndicator = true; }],
      ['Inspect pixel value on hover', 'map.inspect', { on: true }, s => { s.pixelInspectEnabled = true; }],
      ['Toggle annotation mode', 'map.annotations', { on: true }, s => { s.annotationMode = true; }],
      ['Toggle spatial re-referencing', 'map.rereference', { on: false }, s => { s.refEnabled = false; }],
    ];
    for (const [title, id, args, apply] of cases) {
      dispatch.mockReset();
      const right = render(<><MapLeftToolbar measureActive={false} onToggleMeasure={() => {}} onMeasureOff={() => {}} /><MapTopRightToolbar onToggleToolbars={() => {}} /></>);
      fireEvent.click(right.getByTitle(title));
      const byClick = dispatch.mock.calls.map(c => c[0]);
      cleanup();
      dispatch.mockReset();
      await runCommand(env(), id, args);
      expect(dispatch.mock.calls.map(c => c[0]), id).toEqual(byClick);
      // Already so: nothing happens (idempotent).
      dispatch.mockReset();
      const saved = { ...mockState };
      apply(mockState);
      await runCommand(env(), id, args);
      expect(dispatch, id).not.toHaveBeenCalled();
      Object.assign(mockState, saved);
    }
  });

  it('basemap, grid and draw tools: the same actions as the controls', async () => {
    const { runCommand } = await import('../assistant/commands');
    const right = render(<MapTopRightToolbar onToggleToolbars={() => {}} />);
    fireEvent.click(right.getByTitle('Basemap'));
    fireEvent.click(right.getAllByText('Dark')[0]);
    const byClick = dispatch.mock.calls.map(c => c[0]);
    dispatch.mockReset();
    await runCommand(env(), 'map.basemap', { name: 'esriDark' });
    expect(dispatch.mock.calls.map(c => c[0])).toEqual(byClick);
    await expect(runCommand(env(), 'map.basemap', { name: 'google' })).rejects.toThrow('No basemap');
    dispatch.mockReset();
    // The Overlays tab's "Drawing tools" switch dispatches SET_DRAWING_ENABLED with the new value.
    mockState.drawingEnabled = false;
    await runCommand(env(), 'map.draw_tools', { on: true });
    expect(dispatch.mock.calls.map(c => c[0])).toEqual([{ type: 'SET_DRAWING_ENABLED', payload: true }]);
    dispatch.mockReset();
    mockState.drawingEnabled = true;
    await runCommand(env(), 'map.draw_tools', { on: true });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(runCommand(env(), 'map.draw_tools', {})).rejects.toThrow('on: true or false');
    await expect(runCommand(env(), 'map.draw_tool', { on: true })).rejects.toThrow('Did you mean map.draw_tools');
    await expect(runCommand(env(), 'map.draw_tools', { on: true, colour: 'red' })).rejects.toThrow('takes on');
  });

  it('list_commands filters by words and marks destructive ones', async () => {
    const { listCommands } = await import('../assistant/commands');
    const draw = listCommands(env(), 'draw');
    expect(draw.map(c => c.id)).toContain('map.draw_tools');
    expect(listCommands(env()).find(c => c.id === 'points.clear_all')).toMatchObject({ destructive: true });
    expect(listCommands(env()).find(c => c.id === 'map.split_screen')).toMatchObject({ toggle: true, state: false });
  });
});
