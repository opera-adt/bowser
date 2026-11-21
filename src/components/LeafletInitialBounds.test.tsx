import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { getViewBounds, setViewBounds } from '../map/viewBounds';
const current=vi.hoisted(()=>({ south:1,west:2,north:3,east:4 }));
const bounds={getSouth:()=>current.south,getWest:()=>current.west,getNorth:()=>current.north,getEast:()=>current.east};
vi.mock('react-leaflet',()=>({MapContainer:()=>null,TileLayer:()=>null,WMSTileLayer:()=>null,Marker:()=>null,
  useMap:()=>map,useMapEvents:()=>null}));
const map={getBounds:()=>bounds};
import { MapViewController } from './MapContainer';
afterEach(()=>{cleanup();setViewBounds(null);});
it('publishes the initial Leaflet view before any user pan for cropped exports',()=>{
  setViewBounds(null);expect(getViewBounds()).toBeNull();
  render(<AppProvider><MapViewController /></AppProvider>);
  expect(getViewBounds()).toEqual([1,2,3,4]);
});
