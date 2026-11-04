/** Minimal types for shpjs (zipped or loose Shapefiles to GeoJSON); it ships none. */
declare module "shpjs" {
  type Collection = { type: "FeatureCollection"; features: unknown[]; fileName?: string };
  type Input = ArrayBuffer | Uint8Array | { shp: ArrayBuffer; dbf?: ArrayBuffer; prj?: string | ArrayBuffer; cpg?: string | ArrayBuffer };
  export default function shp(input: Input): Promise<Collection | Collection[]>;
}
