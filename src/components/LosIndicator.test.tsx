import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, LosMetadata } from '../types';
import LosIndicator from './LosIndicator';
let state: AppState;
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state, dispatch: vi.fn() }) }));
vi.mock('../hooks/useDraggableResizable', () => ({ useDraggableResizable: () => ({ panelRef: { current: null }, panelStyle: {}, onDragMouseDown: vi.fn(), resizeGrip: null }) }));
const metadata: LosMetadata = { heading_deg: 347, incidence_deg: 37, los_enu_ground_to_sat: { east: -0.6, north: -0.1, up: 0.79 } };
beforeEach(() => { state = { currentDataset: 'displacement', showLosIndicator: true, datasetInfo: { displacement: { los_metadata: metadata, uses_spatial_ref: true } } } as unknown as AppState; });
afterEach(cleanup);
const setMetadata = (value: LosMetadata | undefined) => { state.datasetInfo.displacement.los_metadata = value; };
describe('LOS metadata availability', () => {
  it('retains supplied geometry and labels its provenance', () => {
    render(<LosIndicator />);
    expect(screen.getByText('ascending · right-looking')).toBeTruthy();
    expect(screen.getByText('Geometry from supplied metadata')).toBeTruthy();
  });
  it('accepts null optional swath fields from serialized metadata', () => {
    setMetadata({ ...metadata, incidence_deg_near: null, incidence_deg_far: null } as unknown as LosMetadata);
    render(<LosIndicator />);
    expect(screen.getByText('Geometry from supplied metadata')).toBeTruthy();
    expect(screen.getByText('Incidence 37.0°')).toBeTruthy();
  });
  it('retains left-looking geometry', () => {
    setMetadata({ ...metadata, los_enu_ground_to_sat: { east: 0.6, north: 0.1, up: 0.79 } });
    render(<LosIndicator />);
    expect(screen.getByText('ascending · left-looking')).toBeTruthy();
  });
  it.each([
    { heading_deg: 347, incidence_deg: 37 },
    { heading_deg: 347 } as LosMetadata,
    { ...metadata, heading_deg: NaN },
    { ...metadata, incidence_deg: 100 },
    { ...metadata, los_enu_ground_to_sat: { east: Infinity, north: 0, up: 1 } },
    { ...metadata, los_enu_ground_to_sat: { east: 0, north: 0, up: 1 } },
  ])('reports incomplete/nonphysical geometry without crashing or guessing: %j', value => {
    setMetadata(value);
    render(<LosIndicator />);
    expect(screen.getByText('LOS geometry is incomplete or invalid for this dataset.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter manually' })).toBeTruthy();
    expect(screen.queryByText('ascending · right-looking')).toBeNull();
  });
  it('does not crash on incomplete metadata while the indicator is closed', () => {
    setMetadata({ heading_deg: 347, incidence_deg: 37 }); state.showLosIndicator = false;
    expect(() => render(<LosIndicator />)).not.toThrow();
  });
  it('allows an explicit manual illustration and resets it for another layer', () => {
    setMetadata({ heading_deg: 347, incidence_deg: 37 });
    const view = render(<LosIndicator />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    expect(screen.getByText(/Manual illustration/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Left-looking' }));
    expect(screen.getByText('ascending · left-looking')).toBeTruthy();
    state = { ...state, currentDataset: 'other', datasetInfo: { ...state.datasetInfo, other: { ...state.datasetInfo.displacement, los_metadata: undefined } } };
    view.rerender(<LosIndicator />);
    expect(screen.getByRole('button', { name: 'Enter manually' })).toBeTruthy();
    expect(screen.queryByText(/Manual illustration/)).toBeNull();
  });
});

describe('LOS polarity describes the layer, not its reference capability', () => {
  const measurement = (kind: string, positive_direction: string | null) => {
    Object.assign(state.datasetInfo.displacement, { measurement: { kind, positive_direction } });
  };
  it.each(['vertical', 'east_west', 'north_south', 'unknown', 'downslope'])('does not label %s values as toward/away LOS', kind => {
    measurement(kind, 'towards the satellite');
    render(<LosIndicator />);
    expect(screen.queryByText('+')).toBeNull();
    expect(screen.queryByText('−')).toBeNull();
    expect(screen.getByText('Geometry from supplied metadata')).toBeTruthy();
  });
  it('does not invent a sign when metadata is absent', () => {
    render(<LosIndicator />);
    expect(screen.queryByText('+')).toBeNull();
    expect(screen.queryByText('−')).toBeNull();
  });
  it.each([null, 'unknown', 'up'])('does not invent a LOS sign from %s', positive => {
    measurement('line_of_sight', positive);
    render(<LosIndicator />);
    expect(screen.queryByText('+')).toBeNull();
    expect(screen.queryByText('−')).toBeNull();
  });
  it.each([
    ['towards the satellite', '+', '−'],
    ['away from the satellite', '−', '+'],
  ])('uses the documented %s convention even without a moving reference', (positive, toward, away) => {
    measurement('line_of_sight', positive);
    state.datasetInfo.displacement.uses_spatial_ref = false;
    render(<LosIndicator />);
    expect(screen.getByLabelText(`Toward satellite: ${toward}`).textContent).toBe(toward);
    expect(screen.getByLabelText(`Away from satellite: ${away}`).textContent).toBe(away);
  });
});

it('updates sign labels when the active layer changes without changing its geometry', () => {
  Object.assign(state.datasetInfo.displacement, { measurement: { kind: 'line_of_sight', positive_direction: 'towards the satellite' } });
  const view = render(<LosIndicator />);
  expect(screen.getByLabelText('Toward satellite: +')).toBeTruthy();
  state = { ...state, currentDataset: 'vertical', datasetInfo: { ...state.datasetInfo,
    vertical: { ...state.datasetInfo.displacement, measurement: { kind: 'vertical', positive_direction: 'up' } } } };
  view.rerender(<LosIndicator />);
  expect(screen.queryByText('+')).toBeNull();
  expect(screen.queryByText('−')).toBeNull();
  expect(screen.getByText('Geometry from supplied metadata')).toBeTruthy();
});
