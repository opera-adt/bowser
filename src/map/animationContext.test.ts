import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { captureAnimationContext, captureLibreContext, registerAnimationContext } from './animationContext';

function fake() {
  const layers=[{id:'basemap-bottom',type:'raster',source:'base'}, {id:'data-1',type:'raster',source:'data'},
    {id:'overlay-labels',type:'symbol',source:'labels',layout:{visibility:'none'}}];
  let callback: (()=>void) | null=null;
  const map={ getPitch:()=>0,getBearing:()=>0,getTerrain:()=>null,isMoving:()=>false,areTilesLoaded:()=>true,
    getStyle:()=>({layers,sources:{base:{attribution:'<b>Synthetic tiles</b>'}}}),
    getBounds:()=>({toArray:()=>[[0,0],[1,1]]}),getCanvas:()=>({width:2000,height:1000}),
    setLayoutProperty:vi.fn(),getLayer:()=>true,triggerRepaint:vi.fn(),
    on:vi.fn((_name:string,cb:()=>void)=>{callback=cb;}),off:vi.fn(),
  };
  return { map, emit:()=>callback?.() };
}
afterEach(()=>vi.restoreAllMocks());
describe('read-only animation background capture',()=>{
  it('limits image size, strips attribution markup and restores every visibility',async()=>{
    const {map,emit}=fake();const drawImage=vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>({drawImage,getImageData:()=>({data:new Uint8ClampedArray([0,0,0,255])})}) as never);
    vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockImplementation(function(this:HTMLCanvasElement){
      expect(this.width).toBe(1024);expect(this.height).toBe(512);return 'data:image/png;base64,fixture';
    });
    const promise=captureLibreContext(map as unknown as Map,false,new AbortController().signal);
    expect(map.setLayoutProperty.mock.calls).toEqual([['data-1','visibility','none'],['overlay-labels','visibility','none']]);
    emit();const result=await promise;
    expect(result.attribution).toBe('Synthetic tiles');expect(result.bounds[2]).toBeCloseTo(111319.490793);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(map.setLayoutProperty.mock.calls.slice(-2)).toEqual([['data-1','visibility','visible'],['overlay-labels','visibility','none']]);
  });
  it('refuses a transparent failed capture and restores map layers', async () => {
    const {map,emit}=fake();
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>({
      drawImage:vi.fn(),getImageData:()=>({data:new Uint8ClampedArray([0,0,0,0])}),
    }) as never);
    const promise=captureLibreContext(map as unknown as Map,false,new AbortController().signal);
    emit();await expect(promise).rejects.toThrow(/provider|capture/i);
    expect(map.setLayoutProperty.mock.calls.slice(-2)).toEqual([['data-1','visibility','visible'],['overlay-labels','visibility','none']]);
  });
  it('rejects loading, tilted and split maps before changing visibility',async()=>{
    const {map}=fake();
    await expect(captureLibreContext(map as unknown as Map,true,new AbortController().signal)).rejects.toThrow(/flat/);
    map.getPitch=()=>20;
    await expect(captureLibreContext(map as unknown as Map,false,new AbortController().signal)).rejects.toThrow(/flat/);
    map.getPitch=()=>0;map.areTilesLoaded=()=>false;
    await expect(captureLibreContext(map as unknown as Map,false,new AbortController().signal)).rejects.toThrow(/loading/);
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
  });
  it('restores layers on cancellation and releases its renderer registration',async()=>{
    const {map}=fake();const controller=new AbortController();
    const release=registerAnimationContext(signal=>captureLibreContext(map as unknown as Map,false,signal));
    const promise=captureAnimationContext(controller.signal);controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);
    expect(map.setLayoutProperty.mock.calls.slice(-2)).toEqual([['data-1','visibility','visible'],['overlay-labels','visibility','none']]);
    release();await expect(captureAnimationContext(new AbortController().signal)).rejects.toThrow(/not ready/);
  });
});
