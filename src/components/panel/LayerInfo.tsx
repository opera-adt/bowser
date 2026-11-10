import type { RasterGroup } from '../../types';

/** Read-only guidance, with producer text and category values kept distinct. */
export default function LayerInfo({ info }: { info: RasterGroup | null | undefined }) {
  if (!info) return null;
  const sourceIsDescription = info.description_source === 'source';
  const separateSource = info.source_description && !sourceIsDescription && info.source_description !== info.description;
  const flags = info.source_flags ?? [];
  const notes = info.metadata_notes ?? [];
  const guidance = info.guidance && info.guidance !== info.description ? info.guidance : null;
  return (
    <div role="note" aria-label="Layer information" style={{ fontSize: '0.75em', lineHeight: 1.4, color: 'var(--sb-muted)', marginTop: 6 }}>
      {info.description && <p style={{ margin: '4px 0' }} title={info.description_source === 'bowser' ? 'General guidance from Bowser; supplied source information is separate.' : undefined}>{info.description}</p>}
      <div>{info.unit_status === 'mixed' ? 'Source units differ between rasters' : info.unit ? `Source units: ${info.unit}` : 'Units not supplied'}</div>
      {sourceIsDescription && <div style={{ fontSize: '0.9em' }}>Description supplied by the producer</div>}
      {(guidance || separateSource || flags.length > 0 || notes.length > 0) && (
        <details style={{ marginTop: 4 }}>
          <summary>More about this layer</summary>
          {guidance && <p style={{ margin: '4px 0' }} title="General guidance from Bowser; the description above is the producer's.">{guidance}</p>}
          {separateSource && <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{info.source_description}</p>}
          {flags.length > 0 && <div>Value meanings: {flags.map(f => `${f.value}: ${f.label}`).join('; ')}</div>}
          {notes.map(note => <p key={note} style={{ margin: '4px 0' }}>{note}</p>)}
        </details>
      )}
    </div>
  );
}
