import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';

interface Options {
  defaultWidth: number;
  defaultHeight: number;
  /** Offset from right edge for initial placement (default 20) */
  initialRight?: number;
  /** Offset from bottom edge for initial placement (default 20) */
  initialBottom?: number;
  minWidth?: number;
  minHeight?: number;
  /** Grow the window when its content gets taller than it (kept on screen); a smaller size the user picks stays until the content grows again. */
  fitContent?: boolean;
}

export function useDraggableResizable({ defaultWidth, defaultHeight, initialRight = 20, initialBottom = 20, minWidth = 320, minHeight = 180, fitContent = false }: Options) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [size, setSize] = useState({ width: defaultWidth, height: defaultHeight });
  const panelRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const resizeState = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  // Initialise to bottom-right on first render
  useEffect(() => {
    setPos(p => p ?? {
      left: window.innerWidth  - defaultWidth  - initialRight,
      top:  window.innerHeight - defaultHeight - initialBottom,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDragMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = pos ?? { left: window.innerWidth - defaultWidth - initialRight, top: window.innerHeight - defaultHeight - initialBottom };
    dragState.current = { startX: e.clientX, startY: e.clientY, startLeft: cur.left, startTop: cur.top };
    const onMove = (me: MouseEvent) => {
      if (!dragState.current) return;
      setPos({
        left: Math.max(0, Math.min(window.innerWidth  - size.width,  dragState.current.startLeft + me.clientX - dragState.current.startX)),
        top:  Math.max(0, Math.min(window.innerHeight - 60,           dragState.current.startTop  + me.clientY - dragState.current.startY)),
      });
    };
    const onUp = () => { dragState.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeState.current = { startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height };
    const onMove = (me: MouseEvent) => {
      if (!resizeState.current) return;
      setSize({
        width:  Math.max(minWidth,  resizeState.current.startW + me.clientX - resizeState.current.startX),
        height: Math.max(minHeight, resizeState.current.startH + me.clientY - resizeState.current.startY),
      });
    };
    const onUp = () => { resizeState.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Content that grew (a card opened, a summary added) makes the window taller, never past the screen.
  const contentHeight = useRef(0);
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!fitContent || !el) return;
    const need = el.scrollHeight;
    if (need > contentHeight.current + 1 && need > el.clientHeight + 1) {
      const height = Math.min(need + 2, window.innerHeight - 16);
      setSize(s => ({ ...s, height }));
    }
    contentHeight.current = need;
  });

  const resolvedPos = pos ?? { left: window.innerWidth - defaultWidth - initialRight, top: window.innerHeight - defaultHeight - initialBottom };
  // A window that grew to fit its content moves up rather than run off the bottom of the screen.
  const top = fitContent ? Math.max(8, Math.min(resolvedPos.top, window.innerHeight - size.height - 8)) : resolvedPos.top;
  const panelStyle: React.CSSProperties = {
    left: resolvedPos.left, top,
    width: size.width, height: size.height,
    bottom: 'auto', right: 'auto', transform: 'none',
  };

  const resizeGrip = (
    <div
      onMouseDown={onResizeMouseDown}
      style={{
        position: 'absolute', right: 0, bottom: 0, width: 18, height: 18,
        cursor: 'nwse-resize', zIndex: 10, display: 'flex',
        alignItems: 'flex-end', justifyContent: 'flex-end',
        padding: 3, color: 'var(--sb-muted)', fontSize: 11, userSelect: 'none',
      }}
      title="Resize"
    >⤡</div>
  );

  return { panelRef, panelStyle, size, onDragMouseDown, resizeGrip };
}
