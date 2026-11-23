import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RasterGroup } from '../../types';
import LayerInfo from './LayerInfo';

afterEach(cleanup);
const info = (extra: Partial<RasterGroup> = {}) => ({
  description: 'Consistent brightness does not mean stationary ground.',
  description_source: 'bowser', unit: 'unitless', ...extra,
}) as RasterGroup;

describe('LayerInfo', () => {
  it('shows brief guidance and the explicitly supplied units', () => {
    render(<LayerInfo info={info()} />);
    expect(screen.getByRole('note', { name: 'Layer information' })).toBeTruthy();
    expect(screen.getByText('Source units: unitless')).toBeTruthy();
    expect(screen.getByText(/does not mean stationary/)).toBeTruthy();
  });

  it('keeps producer text and category values separate, including zero', () => {
    render(<LayerInfo info={info({ source_description: 'Producer-selected pixels.', source_flags: [{ value: '0', label: 'retain' }, { value: '1', label: 'exclude' }] })} />);
    expect(screen.getByText('More about this layer').closest('details')?.open).toBe(false);
    expect(screen.getByText('Producer-selected pixels.')).toBeTruthy();
    expect(screen.getByText('Value meanings: 0: retain; 1: exclude')).toBeTruthy();
  });

  it('reports missing units instead of assuming meters or radians', () => {
    render(<LayerInfo info={info({ unit: '' })} />);
    expect(screen.getByText('Units not supplied')).toBeTruthy();
  });

  it('distinguishes conflicting units from absent units', () => {
    render(<LayerInfo info={info({ unit: '', unit_status: 'mixed', metadata_notes: ['No common unit is assigned.'] })} />);
    expect(screen.getByText('Source units differ between rasters')).toBeTruthy();
    expect(screen.getByText('No common unit is assigned.')).toBeTruthy();
    expect(screen.queryByText('Units not supplied')).toBeNull();
  });

  it('uses source explanations once for an unfamiliar layer', () => {
    render(<LayerInfo info={info({ description: 'Temperature anomaly.', description_source: 'source', source_description: 'Temperature anomaly.', unit: 'K' })} />);
    expect(screen.getAllByText('Temperature anomaly.')).toHaveLength(1);
    expect(screen.getByText('Description supplied by the producer')).toBeTruthy();
  });

  it('leads with the producer description and keeps Bowser guidance under More about this layer', () => {
    const producer = 'Positive values indicate apparent motion towards the platform.';
    render(<LayerInfo info={info({ description: producer, description_source: 'source', source_description: producer, guidance: 'Saved change relative to the source reference.' })} />);
    const note = screen.getByRole('note', { name: 'Layer information' });
    expect(note.querySelector('p')?.textContent).toBe(producer);
    expect(screen.getAllByText(producer)).toHaveLength(1);
    expect(screen.getByText('Description supplied by the producer')).toBeTruthy();
    const guidance = screen.getByText('Saved change relative to the source reference.');
    expect(guidance.closest('details')?.querySelector('summary')?.textContent).toBe('More about this layer');
    expect(guidance.closest('details')?.open).toBe(false);
  });

  it('has no details section for a response without guidance or source extras', () => {
    render(<LayerInfo info={info()} />);
    expect(screen.queryByText('More about this layer')).toBeNull();
  });

  it('renders source markup as text, never executable HTML', () => {
    render(<LayerInfo info={info({ source_description: '<img src=x onerror=alert(1)>' })} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('updates when a different layer is selected', () => {
    const { rerender } = render(<LayerInfo info={info()} />);
    rerender(<LayerInfo info={info({ description: 'Neighbor support count.', unit: 'count' })} />);
    expect(screen.queryByText(/does not mean stationary/)).toBeNull();
    expect(screen.getByText('Neighbor support count.')).toBeTruthy();
    expect(screen.getByText('Source units: count')).toBeTruthy();
  });

  it('has no empty panel without a selected dataset', () => {
    const { container } = render(<LayerInfo info={null} />);
    expect(container.innerHTML).toBe('');
  });
});


it('shows the producer explanation once directly after the brief', () => {
  render(<LayerInfo info={info({ summary: 'Ground movement accumulated over time.',
    description: 'Positive values indicate motion away from the satellite.', description_source: 'source',
    source_description: 'Positive values indicate motion away from the satellite.', guidance: 'Not total 3D movement.' })} />);
  const note = screen.getByRole('note', { name: 'Layer information' });
  expect(note.querySelector('p')?.textContent).toBe('Ground movement accumulated over time.');
  const producer = screen.getAllByText(/Positive values indicate/);
  expect(producer).toHaveLength(1);
  expect(note.querySelector('p')?.nextElementSibling).toBe(producer[0]);
  expect(producer[0].closest('details')).toBeNull();
  expect(screen.getByText('Not total 3D movement.').closest('details')).not.toBeNull();
  expect(note.querySelector('details')?.open).toBe(false);
});

it('shows recommended mask values supplied only in the producer description', () => {
  const description = 'A value of 0 indicates a bad pixel and 1 indicates a good pixel.';
  render(<LayerInfo info={info({
    name: 'recommended_mask', summary: 'Pixels that pass the product quality checks.',
    description, description_source: 'source', source_description: description,
  })} />);
  expect(screen.getByText(description).closest('details')).toBeNull();
  expect(screen.queryByText(/Value meanings:/)).toBeNull();
  expect(screen.queryByText('More about this layer')).toBeNull();
});

it('reads actual measurement conventions without substituting OPERA signs', () => {
  render(<LayerInfo info={info({ summary: 'How far the ground has moved toward or away from the satellite since the reference date.',
    unit: 'centimeters', measurement: { kind: 'line_of_sight', positive_direction: 'away from the satellite' },
    reference_date: '2025-11-01', source_flags: [{ value: '0', label: 'valid' }] })} />);
  expect(screen.getByText('How to read this layer')).toBeTruthy();
  expect(screen.getByText('Source units: centimeters')).toBeTruthy();
  expect(screen.getByText('Positive values: away from the satellite')).toBeTruthy();
  expect(screen.getByText('Source reference date: 2025-11-01')).toBeTruthy();
  expect(screen.getByText('Value meanings: 0: valid').closest('details')).toBeNull();
  expect(screen.queryByText(/Positive values: toward/)).toBeNull();
});

it('does not guess directions, signs or dates from a generic summary', () => {
  render(<LayerInfo info={info({ summary: 'How far the ground has moved in the measured direction since the reference date.', unit: '' })} />);
  expect(screen.queryByText(/Measurement direction:/)).toBeNull();
  expect(screen.queryByText(/Positive values:/)).toBeNull();
  expect(screen.queryByText(/Source reference date:/)).toBeNull();
  expect(screen.getByText('Units not supplied')).toBeTruthy();
});
