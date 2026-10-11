import { describe, expect, it, vi } from 'vitest';
import { annotationCreateForm, annotationEditForm, annotationLabelHtml } from './annotationForms';
import type { MapAnnotation } from '../types';

const ann: MapAnnotation = { id: 'a1', position: [33.96, -117.67], text: 'Spillway', color: '#ff0000', fontSize: 14 };
const inputs = (el: HTMLElement) => [...el.querySelectorAll('input')] as HTMLInputElement[];
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text)!;

describe('annotation forms', () => {
  it('create: Add dispatches the annotation at the clicked point and closes', () => {
    const on = { dispatch: vi.fn(), close: vi.fn() };
    const { el } = annotationCreateForm([33.96, -117.67], on);
    const [text, color, size] = inputs(el);
    text.value = '  Toe drain  '; color.value = '#00ff00'; size.value = '200';
    button(el, 'Add').click();
    const a = on.dispatch.mock.calls[0][0];
    expect(a.type).toBe('ADD_ANNOTATION');
    expect(a.payload).toMatchObject({ position: [33.96, -117.67], text: 'Toe drain', color: '#00ff00', fontSize: 72 });
    expect(on.close).toHaveBeenCalled();
  });

  it('create: empty text adds nothing; Escape and Cancel close', () => {
    const on = { dispatch: vi.fn(), close: vi.fn() };
    const { el } = annotationCreateForm([0, 0], on);
    inputs(el)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(on.dispatch).not.toHaveBeenCalled();
    inputs(el)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    button(el, 'Cancel').click();
    expect(on.close).toHaveBeenCalledTimes(3);
  });

  it('edit: Apply updates text/colour/size (size clamped), the bin removes it', () => {
    const on = { dispatch: vi.fn(), close: vi.fn() };
    const { el } = annotationEditForm(ann, on);
    const [text, color, size] = inputs(el);
    expect([text.value, color.value, size.value]).toEqual(['Spillway', '#ff0000', '14']);
    text.value = ' '; color.value = '#0000ff'; size.value = '3';
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(on.dispatch).toHaveBeenLastCalledWith({ type: 'UPDATE_ANNOTATION',
      payload: { id: 'a1', updates: { text: 'Spillway', color: '#0000ff', fontSize: 8 } } });
    (el.querySelector('button[title="Delete annotation"]') as HTMLButtonElement).click();
    expect(on.dispatch).toHaveBeenLastCalledWith({ type: 'REMOVE_ANNOTATION', payload: 'a1' });
    expect(on.close).toHaveBeenCalledTimes(2);
  });

  it('label shows the text in its colour and size', () => {
    const div = document.createElement('div');
    div.innerHTML = annotationLabelHtml(ann);
    const label = div.firstElementChild as HTMLElement;
    expect(label.textContent).toBe('Spillway');
    expect(label.style.color).toBe('rgb(255, 0, 0)');
    expect(label.style.fontSize).toBe('14px');
  });
});
