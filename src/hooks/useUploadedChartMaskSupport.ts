import { useEffect, useState } from 'react';

/** Imported full-server projects must not break charts on a lightweight server. */
export function useUploadedChartMaskSupport(active: boolean) {
  const [status, setStatus] = useState<'checking' | 'enabled' | 'disabled' | 'unknown'>('checking');
  useEffect(() => {
    if (!active) { setStatus('checking'); return; }
    let live = true;
    fetch('/config').then(async response => {
      if (!response.ok) throw new Error('Configuration unavailable');
      return response.json();
    }).then(config => {
      if (live) setStatus(config.geotiff_upload === false ? 'disabled' : 'enabled');
    }).catch(() => { if (live) setStatus('unknown'); });
    return () => { live = false; };
  }, [active]);
  return {
    ready: !active || status !== 'checking',
    enabled: !active || status === 'enabled',
    warning: !active || status === 'enabled' || status === 'checking' ? null
      : status === 'disabled'
        ? 'Uploaded mask not applied: this server cannot read GeoTIFF masks. Charts use the remaining quality masks.'
        : 'Uploaded mask not applied: server support could not be checked. Charts use the remaining quality masks.',
  };
}
