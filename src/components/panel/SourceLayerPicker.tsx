import { useState } from 'react';
import type { OverlayFeatures } from '../../types';
import { selectSourceLayers, sourceLayerChoices } from '../../map/sourceLayerSelection';

/** Selection affects only the added overlay. Cached conversion and original file are untouched. */
export default function SourceLayerPicker({ data, onAdd, onCancel }: {
  data: OverlayFeatures; onAdd: (value: OverlayFeatures) => void; onCancel: () => void;
}) {
  const choices = sourceLayerChoices(data);
  const [selected, setSelected] = useState(() => choices.map(c => c.name));
  return <div className="ov-style ov-layer-pick" role="group" aria-label="Choose source layers">
    <div className="row-label">Choose layers to add</div>
    <div className="ov-zonal-note">Nothing from this file is drawn or analyzed until you add the selected layers.</div>
    <div className="ov-layer-pick-list">
      {choices.map(c => <label key={c.name} className="row-label">
        <input type="checkbox" checked={selected.includes(c.name)}
          onChange={e => setSelected(s => e.target.checked ? [...s, c.name] : s.filter(n => n !== c.name))} />
        {c.name} ({c.count.toLocaleString()} features)
      </label>)}
    </div>
    <div className="histogram-buttons">
      <button type="button" className="hist-btn" onClick={() => setSelected(choices.map(c => c.name))}>All</button>
      <button type="button" className="hist-btn" onClick={() => setSelected([])}>None</button>
      <button type="button" className="hist-btn" disabled={!selected.length} onClick={() => onAdd(selectSourceLayers(data, selected))}>Add</button>
      <button type="button" className="hist-btn" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
