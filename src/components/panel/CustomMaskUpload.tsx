import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../../context/AppContext';

/** Why Upload is off on bowser-lite (its /config says geotiff_upload: false). */
export const MASK_UPLOAD_NEEDS_SERVER = 'Custom masks need the full Bowser server (bowser run)';

/**
 * Masking › Custom mask (GeoTIFF): upload a mask file, or clear it. Off, with the reason, when the
 * server can't take uploads (bowser-lite); a refused upload says why instead of doing nothing.
 */
export default function CustomMaskUpload() {
  const { state, dispatch } = useAppContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [canUpload, setCanUpload] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => { if (live && cfg?.geotiff_upload === false) setCanUpload(false); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const upload = async (f: File) => {
    setError(null);
    const form = new FormData();
    form.append('file', f);
    try {
      const res = await fetch('/upload_mask', { method: 'POST', body: form });
      if (!res.ok) {
        const detail = await res.json().then(j => j?.detail).catch(() => null);
        setError(`${f.name}: ${typeof detail === 'string' ? detail : `HTTP ${res.status}`}`);
        return;
      }
      const data = await res.json();
      dispatch({ type: 'SET_CUSTOM_MASK_PATH', payload: data.path });
    } catch (err) {
      setError(`${f.name}: ${(err as Error).message}`);
    }
  };

  return (
    <div className="custom-mask-row" style={{ marginTop: 8 }}>
      <label className="minmax-label" style={{ marginBottom: 4 }}>Custom mask (GeoTIFF)</label>
      <div className="custom-mask-controls">
        <button type="button" className="hist-btn" disabled={!canUpload}
          title={canUpload ? 'Upload a GeoTIFF mask' : MASK_UPLOAD_NEEDS_SERVER}
          onClick={() => inputRef.current?.click()}>
          Upload
        </button>
        <input ref={inputRef} type="file" accept=".tif,.tiff" style={{ display: 'none' }} aria-label="Custom mask file"
          disabled={!canUpload}
          onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }} />
        {state.customMaskPath && (
          <button className="hist-btn" style={{ color: 'var(--sb-red)' }}
            onClick={() => dispatch({ type: 'SET_CUSTOM_MASK_PATH', payload: null })}>Clear</button>
        )}
      </div>
      {!canUpload && (
        <div className="row-label" style={{ fontSize: '0.72em', textAlign: 'center' }}>
          Custom masks need the full Bowser server (<code>bowser run</code>)
        </div>
      )}
      {error && (
        <div className="row-label" role="alert" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{error}</div>
      )}
      {state.customMaskPath && (
        <div style={{ fontSize: '0.72em', color: 'var(--sb-muted)', wordBreak: 'break-all', marginTop: 2 }}>
          {state.customMaskPath.split('/').pop()}
        </div>
      )}
    </div>
  );
}
