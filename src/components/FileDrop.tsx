import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { useAddFiles } from '../hooks/useAddFiles';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Accepts files dropped on the map (a full-size hint while dragging) and shows what happened. */
export default function FileDrop() {
  const { state, dispatch } = useAppContext();
  const addFiles = useAddFiles();
  const [dragging, setDragging] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = anchorRef.current?.parentElement;
    if (!target) return;
    let depth = 0;
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); depth += 1; setDragging(true); } };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); } };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
    };
    // A file dropped beside the map must not make the browser navigate away to it.
    const guard = (e: DragEvent) => { if (hasFiles(e) && !target.contains(e.target as Node)) e.preventDefault(); };
    target.addEventListener('dragenter', onEnter);
    target.addEventListener('dragover', onOver);
    target.addEventListener('dragleave', onLeave);
    target.addEventListener('drop', onDrop);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      target.removeEventListener('dragenter', onEnter);
      target.removeEventListener('dragover', onOver);
      target.removeEventListener('dragleave', onLeave);
      target.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, [addFiles]);

  const message = state.overlayMessage;
  useEffect(() => {
    if (!message || message.endsWith('…')) return;
    const timer = setTimeout(() => dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: null }), 8000);
    return () => clearTimeout(timer);
  }, [message, dispatch]);

  return (
    <div ref={anchorRef}>
      {dragging && (
        <div className="file-drop-hint">
          <div className="file-drop-box">
            <strong>Drop files to add them as layers</strong>
            <small>GeoJSON, CSV, KML, GPX, Shapefile or GeoTIFF</small>
          </div>
        </div>
      )}
      {message && <div className="file-drop-message" role="status">{message}</div>}
    </div>
  );
}
