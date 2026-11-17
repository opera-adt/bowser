import { useState } from 'react';
import type { OverlayFeatures } from '../../types';
import { selectSourceLayers, sourceLayerChoices } from '../../map/sourceLayerSelection';

/** Selection affects only the added overlay. Cached conversion and original file are untouched. */
export default function SourceLayerPicker({ data, onAdd, onCancel }: {
  data: OverlayFeatures; onAdd: (value: OverlayFeatures) => void; onCancel: () => void;
}) {
  const choices = sourceLayerChoices(data);
  const [selected, setSelected] = useState(() => choices.map(c => c.name));
  return <fieldset className="ov-style" aria-label="Choose source layers">
    <legend>Choose layers to add</legend>
    <div className="ov-zonal-note">Nothing from this file is drawn or analyzed until you add the selected layers.</div>
    <div style={{ maxHeight: 200, overflowY: 'auto' }}>
      {choices.map(c => <label key={c.name} className="toggle-row">
        <input type="checkbox" checked={selected.includes(c.name)}
          onChange={e => setSelected(s => e.target.checked ? [...s, c.name] : s.filter(n => n !== c.name))} />
        <span>{c.name} ({c.count.toLocaleString()} features)</span>
      </label>)}
    </div>
    <div className="toggle-row">
      <button type="button" className="hist-btn" onClick={() => setSelected(choices.map(c => c.name))}>All</button>
      <button type="button" className="hist-btn" onClick={() => setSelected([])}>None</button>
      <button type="button" className="hist-btn" disabled={!selected.length} onClick={() => onAdd(selectSourceLayers(data, selected))}>Add selected layers</button>
      <button type="button" className="hist-btn" onClick={onCancel}>Cancel</button>
    </div>
  </fieldset>;
}
