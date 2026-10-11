/**
 * Annotation DOM shared by both maps: the label, the "new annotation" form (annotation
 * mode click) and the edit/delete form (click on a label). The maps only wrap these in
 * their own popup and marker.
 */
import type { AppAction, MapAnnotation } from '../types';
import { annotationAction } from './interactions';

/** The label drawn on the map for an annotation. */
export function annotationLabelHtml(ann: MapAnnotation): string {
  return `<div style="
          color:${ann.color};font-size:${ann.fontSize}px;font-weight:600;white-space:nowrap;
          text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 3px rgba(0,0,0,0.9);
          cursor:move;user-select:none;padding:2px 5px;
          background:rgba(0,0,0,0.35);border-radius:3px;
          border:1px solid rgba(255,255,255,0.15);
        ">${ann.text}</div>`;
}

/** Form for a new annotation at `position`: Add (or Enter) dispatches it, Cancel/Escape closes. */
export function annotationCreateForm(
  position: [number, number],
  on: { dispatch: (a: AppAction) => void; close: () => void },
): { el: HTMLElement; focus: () => void } {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:2px;min-width:180px;';

  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Annotation text…';
  input.style.cssText = 'flex:1;padding:3px 6px;border:1px solid #888;border-radius:4px;font-size:12px;min-width:0;';
  const colorPick = document.createElement('input');
  colorPick.type = 'color';
  colorPick.value = '#ffffff';
  colorPick.style.cssText = 'width:26px;height:22px;padding:0;border:none;cursor:pointer;background:none;flex-shrink:0;';
  const sizeLabel = document.createElement('span');
  sizeLabel.textContent = 'px';
  sizeLabel.style.cssText = 'font-size:11px;color:#aaa;flex-shrink:0;';
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.value = '13';
  sizeInput.min = '8';
  sizeInput.max = '72';
  sizeInput.style.cssText = 'width:40px;padding:2px 4px;border:1px solid #888;border-radius:4px;font-size:12px;flex-shrink:0;';
  row1.appendChild(input);
  row1.appendChild(colorPick);
  row1.appendChild(sizeInput);
  row1.appendChild(sizeLabel);

  const row2 = document.createElement('div');
  row2.style.cssText = 'display:flex;gap:4px;justify-content:flex-end;';
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add';
  addBtn.style.cssText = 'padding:2px 10px;cursor:pointer;font-size:12px;border:none;background:#5bc0be;color:#072a2d;border-radius:4px;font-weight:600;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:2px 10px;cursor:pointer;font-size:12px;border:1px solid #888;background:none;color:#ccc;border-radius:4px;';
  row2.appendChild(cancelBtn);
  row2.appendChild(addBtn);
  wrap.appendChild(row1);
  wrap.appendChild(row2);

  const commit = () => {
    const action = annotationAction(position, input.value, colorPick.value, sizeInput.value);
    if (action) on.dispatch(action);
    on.close();
  };
  addBtn.onclick = commit;
  cancelBtn.onclick = () => on.close();
  input.onkeydown = ev => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') on.close(); };
  return { el: wrap, focus: () => input.focus() };
}

/** Edit form for an existing annotation: Apply (or Enter) updates it, the bin removes it. */
export function annotationEditForm(
  ann: MapAnnotation,
  on: { dispatch: (a: AppAction) => void; close: () => void },
): { el: HTMLElement; focus: () => void } {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:7px;min-width:190px;font-size:12px;';

  // ── Label input ──
  const textRow = document.createElement('div');
  textRow.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
  const textLbl = document.createElement('label');
  textLbl.textContent = 'Label';
  textLbl.style.cssText = 'font-size:10px;color:#aaa;';
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = ann.text;
  textInput.style.cssText = 'padding:3px 6px;border:1px solid #666;border-radius:4px;font-size:12px;width:100%;box-sizing:border-box;background:#2a2d35;color:#e8e6e3;';
  textRow.appendChild(textLbl);
  textRow.appendChild(textInput);

  // ── Color + font-size row ──
  const row2 = document.createElement('div');
  row2.style.cssText = 'display:flex;gap:8px;align-items:flex-end;';

  const colorCol = document.createElement('div');
  colorCol.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
  const colorLbl = document.createElement('label');
  colorLbl.textContent = 'Color';
  colorLbl.style.cssText = 'font-size:10px;color:#aaa;';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = ann.color;
  colorInput.style.cssText = 'width:36px;height:26px;padding:0;border:none;cursor:pointer;background:none;';
  colorCol.appendChild(colorLbl);
  colorCol.appendChild(colorInput);

  const sizeCol = document.createElement('div');
  sizeCol.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
  const sizeLbl = document.createElement('label');
  sizeLbl.textContent = 'Font size (px)';
  sizeLbl.style.cssText = 'font-size:10px;color:#aaa;';
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.value = String(ann.fontSize);
  sizeInput.min = '8';
  sizeInput.max = '72';
  sizeInput.style.cssText = 'padding:3px 6px;border:1px solid #666;border-radius:4px;font-size:12px;width:100%;box-sizing:border-box;background:#2a2d35;color:#e8e6e3;';
  sizeCol.appendChild(sizeLbl);
  sizeCol.appendChild(sizeInput);

  row2.appendChild(colorCol);
  row2.appendChild(sizeCol);

  // ── Action buttons ──
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;';

  const applyBtn = document.createElement('button');
  applyBtn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:4px"></i>Apply';
  applyBtn.style.cssText = 'flex:1;padding:4px 0;cursor:pointer;font-size:12px;border:1px solid #5bc0be;background:rgba(91,192,190,0.15);color:#5bc0be;border-radius:4px;font-weight:600;';
  applyBtn.onclick = () => {
    on.dispatch({
      type: 'UPDATE_ANNOTATION',
      payload: {
        id: ann.id,
        updates: {
          text: textInput.value.trim() || ann.text,
          color: colorInput.value,
          fontSize: Math.max(8, Math.min(72, parseInt(sizeInput.value) || ann.fontSize)),
        },
      },
    });
    on.close();
  };

  const delBtn = document.createElement('button');
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
  delBtn.title = 'Delete annotation';
  delBtn.style.cssText = 'padding:4px 10px;cursor:pointer;font-size:12px;border:1px solid #e07b7b;background:rgba(224,123,123,0.15);color:#e07b7b;border-radius:4px;';
  delBtn.onclick = () => {
    on.dispatch({ type: 'REMOVE_ANNOTATION', payload: ann.id });
    on.close();
  };

  btnRow.appendChild(applyBtn);
  btnRow.appendChild(delBtn);

  wrap.appendChild(textRow);
  wrap.appendChild(row2);
  wrap.appendChild(btnRow);

  textInput.onkeydown = e => { if (e.key === 'Enter') applyBtn.click(); if (e.key === 'Escape') on.close(); };
  return { el: wrap, focus: () => { textInput.focus(); textInput.select(); } };
}
