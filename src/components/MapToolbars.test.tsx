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
