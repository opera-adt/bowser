import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeStepper, { DOUBLE_CLICK_MS } from './TimeStepper';

function Harness({ start = 2, count = 6, onChange, onPlayingChange }: {
  start?: number; count?: number; onChange?: (i: number) => void; onPlayingChange?: (playing: boolean) => void;
}) {
  const [i, setI] = useState(start);
  return (
    <>
      <TimeStepper value={i} count={count} onChange={n => { setI(n); onChange?.(n); }} onPlayingChange={onPlayingChange} />
      <output data-testid="index">{i}</output>
    </>
  );
}

const index = () => Number(screen.getByTestId('index').textContent);
const prev = () => screen.getByRole('button', { name: 'Previous date' });
const next = () => screen.getByRole('button', { name: 'Next date' });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TimeStepper', () => {
  it('steps one date per click and stops at the ends', () => {
    render(<Harness start={1} count={3} />);
    fireEvent.click(prev());
    expect(index()).toBe(0);
    expect((prev() as HTMLButtonElement).disabled).toBe(true);
    tick(DOUBLE_CLICK_MS + 1);
    fireEvent.click(next());
    tick(DOUBLE_CLICK_MS + 1);
    fireEvent.click(next());
    expect(index()).toBe(2);
    expect((next() as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the slider and its keys', () => {
    render(<Harness />);
    const slider = screen.getByRole('slider', { name: 'Time step' });
    fireEvent.change(slider, { target: { value: '4' } });
    expect(index()).toBe(4);
  });

  it('plays after a second quick click, at one date a second, and stops at the last date', () => {
    render(<Harness start={1} count={5} />);
    fireEvent.click(next());
    fireEvent.click(next());
    expect(index()).toBe(2); // the second click starts playing instead of stepping
    expect(next().getAttribute('aria-pressed')).toBe('true');
    expect(next().className).toContain('playing');
    tick(999);
    expect(index()).toBe(2);
    tick(1);
    expect(index()).toBe(3);
    tick(1000);
    expect(index()).toBe(4);
    expect(next().getAttribute('aria-pressed')).toBe('false');
    tick(5000);
    expect(index()).toBe(4); // no wrap round
  });

  it('two slow clicks only step', () => {
    render(<Harness start={0} count={9} />);
    fireEvent.click(next());
    tick(DOUBLE_CLICK_MS + 1);
    fireEvent.click(next());
    expect(index()).toBe(2);
    expect(next().getAttribute('aria-pressed')).toBe('false');
    tick(3000);
    expect(index()).toBe(2);
  });

  it('stops on a click of the same arrow and turns round on the other', () => {
    render(<Harness start={5} count={9} />);
    fireEvent.click(prev());
    fireEvent.click(prev());
    tick(1000);
    expect(index()).toBe(3);
    fireEvent.click(next());
    expect(next().getAttribute('aria-pressed')).toBe('true');
    expect(prev().getAttribute('aria-pressed')).toBe('false');
    tick(2000);
    expect(index()).toBe(5);
    fireEvent.click(next());
    expect(next().getAttribute('aria-pressed')).toBe('false');
    tick(3000);
    expect(index()).toBe(5);
  });

  it('stops playing when the slider is moved and when it unmounts', () => {
    const onChange = vi.fn();
    const { unmount } = render(<Harness start={0} count={9} onChange={onChange} />);
    fireEvent.click(next());
    fireEvent.click(next());
    fireEvent.change(screen.getByRole('slider', { name: 'Time step' }), { target: { value: '6' } });
    tick(3000);
    expect(index()).toBe(6);
    fireEvent.click(next());
    fireEvent.click(next());
    onChange.mockClear();
    unmount();
    tick(3000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says when playing starts and stops: on a click, at the last date and on unmount', () => {
    const playing = vi.fn();
    const { unmount } = render(<Harness start={0} count={6} onPlayingChange={playing} />);
    const last = () => playing.mock.calls[playing.mock.calls.length - 1]?.[0];
    fireEvent.click(next());
    fireEvent.click(next());
    expect(last()).toBe(true);
    fireEvent.click(next());
    expect(last()).toBe(false);
    tick(DOUBLE_CLICK_MS + 1);
    fireEvent.click(next());
    fireEvent.click(next());
    expect(last()).toBe(true);
    tick(3000);
    expect(index()).toBe(5);
    expect(last()).toBe(false);  // stopped at the end
    fireEvent.click(prev());
    fireEvent.click(prev());
    expect(last()).toBe(true);
    unmount();
    expect(last()).toBe(false);
  });

  it('offers the speed on right-click and remembers it', () => {
    render(<Harness start={0} count={20} />);
    fireEvent.contextMenu(next());
    const pop = screen.getByRole('group', { name: 'Play speed' });
    expect(screen.getByRole('button', { name: '1' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(pop.isConnected).toBe(false);
    expect(localStorage.getItem('bowser-play-speed')).toBe('4');
    fireEvent.click(next());
    fireEvent.click(next());
    tick(250);
    expect(index()).toBe(2);
    tick(500);
    expect(index()).toBe(4);
    cleanup();
    // A new panel starts at the saved speed.
    render(<Harness start={0} count={20} />);
    fireEvent.contextMenu(next());
    expect(screen.getByRole('button', { name: '4' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Play speed' })).toBeNull();
  });
});
