import type { ReactNode } from 'react';
import { groupLayers } from '../../utils/layerGroups';

/** An on/off switch; the label is the row beside it. */
export function Switch({ checked, onChange, label, title }: { checked: boolean; onChange: () => void; label?: string; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title}
      className={`switch${checked ? ' on' : ''}`} onClick={onChange}>
      <span className="switch-thumb" />
    </button>
  );
}

/** A section title; a collapsible one is a disclosure button. ``action`` sits at its right end (a small icon button). */
export function SectionHeader({ label, collapsed, onToggle, action }: { label: string; collapsed?: boolean; onToggle?: () => void; action?: ReactNode }) {
  if (!onToggle) {
    return action
      ? <div className="sidebar-section-label with-action"><span>{label}</span>{action}</div>
      : <div className="sidebar-section-label">{label}</div>;
  }
  return (
    <button type="button" className="sidebar-section-label disclosure" aria-expanded={!collapsed} onClick={onToggle}>
      {label}
      <span className={`disclosure-chevron${collapsed ? '' : ' open'}`} aria-hidden="true" />
    </button>
  );
}

/** ``<option>``s under their group headings (Displacement, Quality, Radar geometry…). */
export function LayerOptions({ names, labelOf }: { names: string[]; labelOf?: (name: string) => string }) {
  return (
    <>
      {groupLayers(names).map(({ group, names: inGroup }) => (
        <optgroup key={group} label={group}>
          {inGroup.map(name => <option key={name} value={name}>{labelOf?.(name) ?? name}</option>)}
        </optgroup>
      ))}
    </>
  );
}
