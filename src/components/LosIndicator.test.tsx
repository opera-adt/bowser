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
