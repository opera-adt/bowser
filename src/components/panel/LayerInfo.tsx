import type { RasterGroup } from '../../types';

/** Read-only guidance, with producer text and category values kept distinct. */
export default function LayerInfo({ info }: { info: RasterGroup | null | undefined }) {
  if (!info) return null;
  const brief = info.summary;
  const sourceIsDescription = info.description_source === 'source';
  const producer = sourceIsDescription ? info.description : info.source_description;
  const visibleProducer = brief && producer !== brief && (sourceIsDescription || producer !== info.label) ? producer : null;
  const separateSource = !brief && !sourceIsDescription && producer !== info.description ? producer : null;
  const detailedDescription = brief && !sourceIsDescription && info.description !== brief && info.description !== visibleProducer ? info.description : null;
  const flags = info.source_flags ?? [];
  const notes = info.metadata_notes ?? [];
  const guidance = info.guidance && info.guidance !== info.description ? info.guidance : null;
  const measurement = info.measurement;
  const direction = measurement?.kind === 'line_of_sight'
    ? 'Along the radar viewing direction'
    : measurement?.kind === 'vertical' ? 'Vertical' : null;
  return (
    <div role="note" aria-label="Layer information" style={{ fontSize: '0.75em', lineHeight: 1.4, color: 'var(--sb-muted)', marginTop: 6 }}>
      {brief && <p style={{ margin: '4px 0' }}>{brief}</p>}
      {visibleProducer && <p aria-label="Producer description" style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{visibleProducer}</p>}
      {!brief && info.description && <p style={{ margin: '4px 0' }} title={info.description_source === 'bowser' ? 'General guidance from Bowser; supplied source information is separate.' : undefined}>{info.description}</p>}
      {brief && <div style={{ marginTop: 6, fontWeight: 600 }}>How to read this layer</div>}
      <div>{info.unit_status === 'mixed' ? 'Source units differ between rasters' : info.unit ? `Source units: ${info.unit}` : 'Units not supplied'}</div>
      {direction && <div>Measurement direction: {direction}</div>}
      {measurement?.positive_direction && <div>Positive values: {measurement.positive_direction}</div>}
      {info.reference_date && <div>Source reference date: {info.reference_date}</div>}
      {flags.length > 0 && <div>Value meanings: {flags.map(f => `${f.value}: ${f.label}`).join('; ')}</div>}
      {!brief && sourceIsDescription && <div style={{ fontSize: '0.9em' }}>Description supplied by the producer</div>}
      {(detailedDescription || guidance || separateSource || notes.length > 0) && (
        <details style={{ marginTop: 4 }}>
          <summary>More about this layer</summary>
          {detailedDescription && <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{detailedDescription}</p>}
          {guidance && <p style={{ margin: '4px 0' }} title="General guidance from Bowser; the description above is the producer's.">{guidance}</p>}
          {separateSource && <p aria-label="Producer description" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{separateSource}</p>}
          {notes.map(note => <p key={note} style={{ margin: '4px 0' }}>{note}</p>)}
        </details>
      )}
    </div>
  );
}
