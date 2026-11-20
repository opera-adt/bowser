import type { Map as LeafletMap, TileLayer } from 'leaflet';
/** Session-only access to the active map; images/URLs are never persisted in projects. */
import type { Map as LibreMap } from 'maplibre-gl';
export interface AnimationContext { png: string; bounds: number[]; attribution: string }
type Capture = (signal: AbortSignal) => Promise<AnimationContext>;
let capture: Capture | null = null;
export function registerAnimationContext(value: Capture): () => void {
  capture = value;
  return () => { if (capture === value) capture = null; };
}
export function captureAnimationContext(signal: AbortSignal): Promise<AnimationContext> {
  if (!capture) return Promise.reject(new Error('Background capture is not ready for this map.'));
  return capture(signal);
}
function mercator(lon: number, lat: number): [number, number] {
  if (Math.abs(lon)>180 || Math.abs(lat)>85.05112878) throw new Error('Use a non-wrapping view within Web Mercator bounds.');
  return [lon*20037508.342789244/180,6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))];
}
/** Capture the already loaded layers below the data. Restore visibility even on failure. */
export async function captureLibreContext(map: LibreMap, split: boolean, signal: AbortSignal): Promise<AnimationContext> {
  if (split || map.getPitch() !== 0 || map.getBearing() !== 0 || map.getTerrain()) throw new Error('Background GIFs need one flat, north-up map with terrain and split screen off.');
  if (signal.aborted || map.isMoving() || !map.areTilesLoaded()) throw new Error('Wait for the map and background tiles to finish loading.');
  const style=map.getStyle();
  const cut=style.layers.findIndex(l=>l.id.startsWith('data-') || l.id==='gpu-data');
  if(cut<0) throw new Error('Wait for the data layer before capturing context.');
  const below=style.layers.slice(0,cut).filter(l=>l.layout?.visibility!=='none');
  const credits=new Set<string>();
  for(const layer of below) {
    if(!('source' in layer) || typeof layer.source!=='string') continue;
    const source=style.sources[layer.source] as { attribution?: string };
    if(source?.attribution) { const text=document.createElement('div');text.innerHTML=source.attribution;credits.add(text.textContent?.replace(/\s+/g,' ').trim() ?? ''); }
  }
  const attribution=[...credits].filter(Boolean).join(' | ') || 'Local background layers';
  if(attribution.length>280) throw new Error('Background attribution is too long for this GIF layout; simplify the visible background stack.');
  const fingerprint=()=>{
    const current=map.getStyle();const stop=current.layers.findIndex(l=>l.id.startsWith('data-')||l.id==='gpu-data');
    return JSON.stringify({ layers:current.layers.slice(0,stop), sources:current.sources });
  };
  const backgroundState=fingerprint();
  const initial=map.getBounds().toArray();
  const lower=mercator(initial[0][0],initial[0][1]), upper=mercator(initial[1][0],initial[1][1]);
  const hidden=style.layers.slice(cut).map(l=>({ id:l.id, visibility:l.layout?.visibility ?? 'visible' }));
  try {
    for(const l of hidden) map.setLayoutProperty(l.id,'visibility','none');
    const png=await new Promise<string>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);map.off('render',render);signal.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();reject(new Error('Background capture cancelled.'));};
      const render=()=>{cleanup();try {
        const source=map.getCanvas(),scale=Math.min(1,1024/Math.max(source.width,source.height));
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(source.width*scale));canvas.height=Math.max(1,Math.round(source.height*scale));
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');
        ctx.drawImage(source,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/png'));
      }catch {reject(new Error('Background capture failed; the provider or browser may prohibit image export.'));}};
      const timer=setTimeout(()=>{cleanup();reject(new Error('Background capture timed out.'));},15000);
      signal.addEventListener('abort',abort,{once:true});map.on('render',render);map.triggerRepaint();
    });
    if(backgroundState!==fingerprint() || JSON.stringify(initial)!==JSON.stringify(map.getBounds().toArray())) throw new Error('Map or background changed during capture. Keep settings fixed and retry.');
    return { png,bounds:[...lower,...upper],attribution };
  } finally {
    for(const l of hidden) if(map.getLayer(l.id)) map.setLayoutProperty(l.id,'visibility',l.visibility);
    map.triggerRepaint();
  }
}

/** Leaflet uses only already visible loaded grid tiles, preserving their stack order. */
export async function captureLeafletContext(map: LeafletMap, split: boolean, signal: AbortSignal): Promise<AnimationContext> {
  if(split || signal.aborted) throw new Error('Use one map and keep the view fixed for background capture.');
  const box=map.getContainer().getBoundingClientRect(), initial=map.getBounds();
  const layers: (TileLayer & { _tiles: Record<string,{current:boolean;el:HTMLImageElement}> })[]=[];
  map.eachLayer(layer=>{ const grid=layer as typeof layers[number];
    if(grid._tiles && (grid.options.zIndex ?? 0)<10 && (grid.options.opacity ?? 1)>0) layers.push(grid);
  });
  layers.sort((a,b)=>(a.options.zIndex ?? 0)-(b.options.zIndex ?? 0));
  const fingerprint=()=>JSON.stringify(layers.map(l=>[l.options.opacity,l.options.zIndex,l.getAttribution?.()]));
  const backgroundState=fingerprint();
  if(!layers.length || box.width<1 || box.height<1)throw new Error('No loaded background is visible.');
  const canvas=document.createElement('canvas'), scale=Math.min(1,1024/Math.max(box.width,box.height));
  canvas.width=Math.round(box.width*scale);canvas.height=Math.round(box.height*scale);
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');ctx.scale(scale,scale);
  const credits=new Set<string>();let count=0;
  for(const layer of layers) {
    const text=document.createElement('div');text.innerHTML=layer.getAttribution?.() ?? '';
    if(text.textContent)credits.add(text.textContent.replace(/\s+/g,' ').trim());
    for(const tile of Object.values(layer._tiles)) {
      if(!tile.current)continue;
      const img=tile.el, rect=img.getBoundingClientRect();
      if(rect.right<=box.left || rect.left>=box.right || rect.bottom<=box.top || rect.top>=box.bottom)continue;
      if(!img.complete || !img.naturalWidth)throw new Error('Background tiles are still loading or unavailable.');
      if(++count>128)throw new Error('Too many background tiles; zoom in and retry.');
      let bitmap: ImageBitmap | null=null;
      try {
        const response=await fetch(img.src,{ mode:'cors', credentials:'omit', cache:'force-cache', signal });
        if(!response.ok)throw new Error('Tile unavailable');
        bitmap=await createImageBitmap(await response.blob());ctx.globalAlpha=layer.options.opacity ?? 1;
        ctx.drawImage(bitmap,rect.left-box.left,rect.top-box.top,rect.width,rect.height);
      }catch {throw new Error('Background export failed because a tile is unavailable or its provider disallows export.');}
      finally {bitmap?.close();}
    }
  }
  const attribution=[...credits].join(' | ') || 'Local background layers';
  if(!count || attribution.length>280)throw new Error('Background needs loaded tiles and an attribution of at most 280 characters.');
  if(layers.some(l=>!map.hasLayer(l)) || backgroundState!==fingerprint() || !map.getBounds().equals(initial,1e-9) || map.getContainer().getBoundingClientRect().width!==box.width || map.getContainer().getBoundingClientRect().height!==box.height) throw new Error('Map moved during capture; retry with a fixed view.');
  return { png:canvas.toDataURL('image/png'),bounds:[...mercator(initial.getWest(),initial.getSouth()),...mercator(initial.getEast(),initial.getNorth())],attribution };
}
