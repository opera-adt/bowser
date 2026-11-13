// basemap.ts
// https://leaflet-extras.github.io/leaflet-providers/preview/
// https://github.com/geopandas/xyzservices/blob/main/provider_sources/leaflet-providers-parsed.json
//
// maxNativeZoom: the deepest zoom the provider serves anywhere; past it the maps
// upscale the last real tiles instead of asking for more.
//
// Where Esri has no tile it answers 200 with a grey "Map data not yet available"
// image, and how deep its tiles go depends on the place (Satellite stops at zoom 14
// offshore and on ice sheets, Hillshade at 14-15 at high latitudes, Relief at 11),
// so no fixed zoom is right everywhere. ``blankTile=false`` makes Esri answer 404
// for those tiles instead, and the map keeps the last real tiles, upscaled.

import { BaseMapItem } from './types';

const baseMaps: { [key: string]: BaseMapItem } = {
    esriSatellite: {
        label: 'Satellite',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false',
        attribution: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    },
    // Google's public tile endpoint (imagery + roads and labels). Google's terms allow
    // map tiles only through its Map Tiles API, so this suits personal and internal use.
    googleHybrid: {
        label: 'Google Hybrid',
        url: 'https://mt1.google.com/vt/lyrs=y&z={z}&x={x}&y={y}',
        attribution: 'Imagery and map data © Google',
    },
    esriDark: {
        label: 'Dark',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}?blankTile=false',
        attribution: 'Tiles © Esri — Source: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community',
        maxNativeZoom: 16,
    },
    esriLight: {
        label: 'Light',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}?blankTile=false',
        attribution: 'Tiles © Esri — Source: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community',
        maxNativeZoom: 16,
    },
    esriHillshade: {
        label: 'Hillshade',
        url: 'https://server.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}?blankTile=false',
        attribution: 'Tiles © Esri — Source: Esri, USGS, NGA, NASA, CGIAR, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen, GSA, Geoland, FEMA, Intermap, and the GIS user community',
        maxNativeZoom: 16,
    },
    esriTopo: {
        label: 'Topo',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}?blankTile=false',
        attribution: 'Tiles © Esri — Source: Esri, HERE, Garmin, Intermap, USGS, FAO, NPS, NRCAN, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), © OpenStreetMap contributors, and the GIS User Community',
    },
    openstreetmap: {
        label: 'OSM',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    openTopoMap: {
        label: 'OTopo',
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    },
    shadedRelief: {
        label: 'Relief',
        // Esri World Shaded Relief (coloured relief); its tiles stop at zoom 13.
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}?blankTile=false',
        attribution: 'Tiles © Esri — Source: Esri',
        maxNativeZoom: 13,
    },
};

export type { BaseMapItem };
export { baseMaps };
