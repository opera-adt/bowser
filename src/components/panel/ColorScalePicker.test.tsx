import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ColorScalePicker from './ColorScalePicker';

afterEach(cleanup);

function setup(colormap = 'rdbu', vmin = -0.02, vmax = 0.05, stats = vi.fn().mockResolvedValue({ p2: -0.03, p98: 0.04, p5: -0.02, p95: 0.03 })) {
  const onColormap = vi.fn();
  const onRange = vi.fn();
  render(<ColorScalePicker colormap={colormap} vmin={vmin} vmax={vmax} stats={stats} onColormap={onColormap} onRange={onRange} />);
  return { onColormap, onRange, bar: screen.getByTitle('Change the colormap and range') };
}

describe('ColorScalePicker', () => {
  it('shows the bar only, until it is clicked', () => {
    const { bar } = setup();
    expect(screen.queryByText('Viridis')).toBeNull();
    fireEvent.click(bar);
    expect(screen.getByText('Viridis')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Viridis')).toBeNull();
  });

  it('closes on a click elsewhere', () => {
    const { bar } = setup();
    fireEvent.click(bar);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Viridis')).toBeNull();
  });

  it('keeps the invert when another colormap is picked', () => {
    const { bar, onColormap } = setup('rdbu_r');
    fireEvent.click(bar);
    fireEvent.click(screen.getByText('Viridis'));
    expect(onColormap).toHaveBeenCalledWith('viridis_r');
  });

  it('inverts', () => {
    const { bar, onColormap } = setup();
    fireEvent.click(bar);
    fireEvent.click(screen.getByRole('switch', { name: 'Invert colormap' }));
    expect(onColormap).toHaveBeenCalledWith('rdbu_r');
  });

  it('centres the range on zero', () => {
    const { bar, onRange } = setup();
    fireEvent.click(bar);
    fireEvent.click(screen.getByText('± Symmetric'));
    expect(onRange).toHaveBeenCalledWith(-0.05, 0.05);
  });

  it('commits a typed range and ignores text that is not a number', () => {
    const { bar, onRange } = setup();
    fireEvent.click(bar);
    const min = screen.getByLabelText('Min value');
    fireEvent.change(min, { target: { value: 'abc' } });
    fireEvent.blur(min);
    expect(onRange).not.toHaveBeenCalled();
    fireEvent.change(min, { target: { value: '-0.1' } });
    fireEvent.blur(min);
    expect(onRange).toHaveBeenCalledWith(-0.1, 0.05);
  });

  it('sets the range from the 2–98 % and 5–95 % presets', async () => {
    const { bar, onRange } = setup();
    fireEvent.click(bar);
    fireEvent.click(screen.getByText('2–98%'));
    await vi.waitFor(() => expect(onRange).toHaveBeenCalledWith(-0.03, 0.04));
    fireEvent.click(screen.getByText('5–95%'));
    await vi.waitFor(() => expect(onRange).toHaveBeenCalledWith(-0.02, 0.03));
  });

  it('leaves the range alone when a preset has no numbers', async () => {
    const { bar, onRange } = setup('rdbu', -0.02, 0.05, vi.fn().mockResolvedValue({ p2: -0.03, p98: 0.04 }));
    fireEvent.click(bar);
    fireEvent.click(screen.getByText('5–95%'));
    await new Promise(r => setTimeout(r, 10));
    expect(onRange).not.toHaveBeenCalled();
  });
});
