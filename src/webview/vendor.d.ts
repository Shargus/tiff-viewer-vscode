// Minimal types for libraries that ship none.

declare module 'shpjs' {
  import type { FeatureCollection } from 'geojson';
  type Input = ArrayBuffer | { shp: ArrayBuffer; dbf?: ArrayBuffer; prj?: ArrayBuffer | string; cpg?: ArrayBuffer | string };
  type Output = FeatureCollection & { fileName?: string };
  /** A zip (one or more shapefiles) or a shapefile's parts; reprojected to WGS 84 when a .prj is given. */
  export default function shp(input: Input): Promise<Output | Output[]>;
}

declare module 'sql.js/dist/sql-wasm-browser.js' {
  interface QueryResult {
    columns: string[];
    values: unknown[][];
  }
  interface Database {
    exec(sql: string, params?: unknown[]): QueryResult[];
    close(): void;
  }
  interface SqlJs {
    Database: new (data?: Uint8Array) => Database;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string; wasmBinary?: ArrayBuffer }): Promise<SqlJs>;
}
