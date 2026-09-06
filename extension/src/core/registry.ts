/**
 * Format capability registry — the single source of truth.
 *
 * The UI, the detector, the settings panel and the docs all read this file. No
 * component may hard-code a format list, and no entry may claim a support level
 * its engine has not earned: a registry-guard test walks these definitions and
 * fails the build when a 'full' claim has no covering test (instruction §4.4,
 * rule R1).
 */

import type { DataKind } from './cir';

export type SupportLevel = 'full' | 'partial' | 'metadata-only' | 'adapter' | 'none';

export type FormatCategory =
  | 'gis'
  | 'cad'
  | 'raster'
  | 'lidar'
  | 'survey'
  | 'gps'
  | 'mining'
  | 'spreadsheet'
  | 'archive'
  | 'crs';

export interface MagicRule {
  /** Byte offset the signature starts at. */
  offset: number;
  /** Literal bytes, or an ASCII string that is compared byte-for-byte. */
  bytes: number[] | string;
}

export interface FormatDef {
  id: string;
  name: string;
  extensions: string[];
  mimeTypes: string[];
  magic?: MagicRule[];
  category: FormatCategory;
  dataKind: DataKind;
  support: { import: SupportLevel; export: SupportLevel };
  requiresNative?: boolean;
  requiresWasm?: boolean;
  supports2D: boolean;
  supports3D: boolean;
  supportsZ: boolean;
  supportsM: boolean;
  supportsAttributes: boolean;
  supportsCRS: boolean;
  supportsMultiGeometry: boolean;
  supportsCurves: boolean;
  /** Extensions of files that belong to the same dataset. */
  companions?: string[];
  /** Whether a write produces one file or a package that must be zipped. */
  packaging?: 'single' | 'zip';
  maxRecommendedSizeMb?: number;
  readerEngine?: string;
  writerEngine?: string;
  /** Limitations shown on the format card and repeated in QA. */
  warnings?: string[];
  notes?: string;
}

const T = true;
const F = false;

export const FORMATS: FormatDef[] = [
  // ---------------------------------------------------------------- GIS vector
  {
    id: 'geojson',
    name: 'GeoJSON',
    extensions: ['geojson', 'json'],
    mimeTypes: ['application/geo+json', 'application/json'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/geojson',
    writerEngine: 'vector/geojson',
    notes: 'RFC 7946 writes WGS 84 longitude/latitude. Other CRS are written with a crs member and flagged as non-standard.',
  },
  {
    id: 'geojsonseq',
    name: 'GeoJSON Sequence',
    extensions: ['geojsonl', 'jsonl', 'ndjson'],
    mimeTypes: ['application/geo+json-seq'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/geojson',
    writerEngine: 'vector/geojson',
    notes: 'One Feature per line. Streams well for very large datasets.',
  },
  {
    id: 'topojson',
    name: 'TopoJSON',
    extensions: ['topojson'],
    mimeTypes: ['application/json'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'partial' },
    supports2D: T,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/topojson',
    writerEngine: 'vector/topojson',
    warnings: ['The writer emits one arc per ring or line without shared-arc detection, so the output is valid TopoJSON but not topologically minimal.', 'Z values are not carried by TopoJSON.'],
  },
  {
    id: 'shapefile',
    name: 'ESRI Shapefile',
    extensions: ['shp'],
    mimeTypes: ['application/octet-stream'],
    magic: [{ offset: 0, bytes: [0x00, 0x00, 0x27, 0x0a] }],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: T,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    companions: ['shx', 'dbf', 'prj', 'cpg'],
    packaging: 'zip',
    readerEngine: 'vector/shapefile',
    writerEngine: 'vector/shapefile',
    warnings: [
      'One shapefile holds one geometry type; mixed input is split into _point, _line and _polygon files.',
      'DBF field names are limited to 10 bytes and text values to 254 bytes. Every rename or truncation is listed in the manifest.',
    ],
    notes: 'Exported as a ZIP containing .shp, .shx, .dbf, .prj and .cpg.',
  },
  {
    id: 'kml',
    name: 'KML',
    extensions: ['kml'],
    mimeTypes: ['application/vnd.google-earth.kml+xml'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/kml',
    writerEngine: 'vector/kml',
    notes: 'KML is defined in WGS 84 longitude/latitude. Projected input is transformed on export, and the transform is recorded.',
  },
  {
    id: 'kmz',
    name: 'KMZ',
    extensions: ['kmz'],
    mimeTypes: ['application/vnd.google-earth.kmz'],
    magic: [{ offset: 0, bytes: 'PK' }],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'zip',
    readerEngine: 'vector/kml',
    writerEngine: 'vector/kml',
  },
  {
    id: 'gpx',
    name: 'GPX',
    extensions: ['gpx'],
    mimeTypes: ['application/gpx+xml'],
    category: 'gps',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/gpx',
    writerEngine: 'vector/gpx',
    warnings: ['GPX has no polygon type. Polygons are written as closed tracks.'],
    notes: 'GPX 1.1, WGS 84 only.',
  },
  {
    id: 'wkt',
    name: 'Well-Known Text',
    extensions: ['wkt'],
    mimeTypes: ['text/plain'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: T,
    supportsAttributes: F,
    supportsCRS: F,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/wkt',
    writerEngine: 'vector/wkt',
    warnings: ['WKT carries geometry only. Attributes are not written.'],
  },
  {
    id: 'wkb',
    name: 'Well-Known Binary',
    extensions: ['wkb'],
    mimeTypes: ['application/octet-stream'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: T,
    supportsAttributes: F,
    supportsCRS: F,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/wkb',
    writerEngine: 'vector/wkb',
    warnings: ['WKB carries geometry only. Attributes are not written.'],
  },
  {
    id: 'gml',
    name: 'GML',
    extensions: ['gml'],
    mimeTypes: ['application/gml+xml'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'partial', export: 'partial' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: T,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/gml',
    writerEngine: 'vector/gml',
    warnings: [
      'Reads gml:Point, LineString, LinearRing, Polygon, MultiGeometry and their pos/posList forms. Curved GML primitives and application schemas beyond simple features are not interpreted.',
      'srsName axis order is honoured for EPSG geographic CRS, which store latitude first.',
    ],
  },
  {
    id: 'osm',
    name: 'OpenStreetMap XML',
    extensions: ['osm'],
    mimeTypes: ['application/xml'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'partial', export: 'partial' },
    supports2D: T,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/osm',
    writerEngine: 'vector/osm',
    warnings: [
      'Nodes and ways are read. Relations (multipolygons, routes) are not assembled.',
      'The writer emits nodes and ways only. Polygon interior rings need a multipolygon relation and are reported rather than written.',
      'Exported elements carry negative ids — the OSM convention for objects that do not exist in the database. This is data shaped like OSM, not an upload-ready changeset.',
    ],
  },
  {
    id: 'mifmid',
    name: 'MapInfo MIF/MID',
    extensions: ['mif'],
    mimeTypes: ['text/plain'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'partial', export: 'partial' },
    supports2D: T,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: T,
    supportsCurves: F,
    companions: ['mid'],
    packaging: 'zip',
    readerEngine: 'vector/mifmid',
    writerEngine: 'vector/mifmid',
    warnings: ['POINT, LINE, PLINE, REGION and MULTIPOINT are handled. ARC, TEXT, ELLIPSE and ROUNDRECT objects are reported, not converted.', 'MIF is 2D; Z values are dropped.'],
  },
  {
    id: 'landxml',
    name: 'LandXML',
    extensions: ['landxml', 'xml'],
    mimeTypes: ['application/xml'],
    category: 'survey',
    dataKind: 'vector',
    support: { import: 'partial', export: 'partial' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/landxml',
    writerEngine: 'vector/landxml',
    warnings: [
      'CgPoints, Parcels, Surface Pnts/Faces and PlanFeatures are read. Alignments, profiles, superelevation and pipe networks are reported, not converted.',
      'LandXML stores northing before easting; the reader swaps to x/y and records that it did.',
    ],
  },
  {
    id: 'csv',
    name: 'CSV / TSV coordinate table',
    extensions: ['csv', 'tsv', 'txt'],
    mimeTypes: ['text/csv', 'text/tab-separated-values', 'text/plain'],
    category: 'survey',
    dataKind: 'table',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/csv',
    writerEngine: 'vector/csv',
    notes: 'Recognises PNEZD, PENZD, NEZ, ENZ, XYZ and header-named schemas. Column mapping is always editable before conversion.',
  },
  {
    id: 'xlsx',
    name: 'Excel Workbook',
    extensions: ['xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    magic: [{ offset: 0, bytes: 'PK' }],
    category: 'spreadsheet',
    dataKind: 'table',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/xlsx',
    writerEngine: 'vector/xlsx',
    warnings: ['Cell formatting, formulas and charts are not preserved; values are.'],
  },

  // ------------------------------------------------------------------ CAD
  {
    id: 'dxf',
    name: 'AutoCAD DXF (ASCII)',
    extensions: ['dxf'],
    mimeTypes: ['image/vnd.dxf', 'application/dxf'],
    category: 'cad',
    dataKind: 'vector',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: T,
    packaging: 'single',
    readerEngine: 'cad/dxf-read',
    writerEngine: 'cad/dxf-write',
    warnings: [
      'Curved entities (ARC, CIRCLE, ELLIPSE, SPLINE) are segmentized on the way to GIS targets using the sagitta tolerance in the settings panel. The substitution is counted in QA.',
      'Entity classes outside the supported set are counted by name and reported rather than dropped silently.',
    ],
    notes: 'DXF has no CRS. The source CRS must be declared or selected before any coordinate transform.',
  },
  {
    id: 'dwg',
    name: 'AutoCAD DWG',
    extensions: ['dwg'],
    mimeTypes: ['image/vnd.dwg', 'application/acad'],
    magic: [{ offset: 0, bytes: 'AC10' }],
    category: 'cad',
    dataKind: 'vector',
    support: { import: 'adapter', export: 'adapter' },
    requiresNative: T,
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: T,
    readerEngine: 'adapters/native-messaging',
    writerEngine: 'adapters/native-messaging',
    warnings: ['DWG requires the local native helper driving your installed ODA File Converter. A renamed DXF is never presented as DWG.'],
    notes: 'Install instructions: docs/NATIVE_HOST.md',
  },
  {
    id: 'dgn',
    name: 'MicroStation DGN',
    extensions: ['dgn'],
    mimeTypes: ['application/octet-stream'],
    category: 'cad',
    dataKind: 'vector',
    support: { import: 'adapter', export: 'adapter' },
    requiresNative: T,
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: T,
    notes: 'Adapter contract only. No DGN parser is bundled.',
  },

  // ---------------------------------------------------------------- Raster
  {
    id: 'asciigrid',
    name: 'ESRI ASCII Grid / DEM',
    extensions: ['asc', 'grd', 'agr'],
    mimeTypes: ['text/plain'],
    category: 'raster',
    dataKind: 'raster',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: F,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    companions: ['prj'],
    packaging: 'single',
    readerEngine: 'raster/asciigrid',
    writerEngine: 'raster/asciigrid',
    notes: 'Single-band elevation grid. This is the working DEM path: values round-trip exactly.',
  },
  {
    id: 'geotiff',
    name: 'GeoTIFF',
    extensions: ['tif', 'tiff'],
    mimeTypes: ['image/tiff'],
    magic: [
      { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
      { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
      { offset: 0, bytes: [0x49, 0x49, 0x2b, 0x00] },
      { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2b] },
    ],
    category: 'raster',
    dataKind: 'raster',
    support: { import: 'metadata-only', export: 'none' },
    supports2D: T,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: F,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    companions: ['tfw', 'prj', 'aux.xml'],
    readerEngine: 'raster/geotiff',
    warnings: [
      'Georeference, dimensions, band layout and EPSG code are read. Pixel data is not decoded, so raster output from a GeoTIFF source is disabled.',
      'Footprint and extent can still be exported as vector.',
    ],
    notes: 'A full raster codec is Phase 4 work. Until it ships, this format stays metadata-only rather than claiming conversion it cannot do.',
  },
  {
    id: 'worldfile',
    name: 'World file',
    extensions: ['tfw', 'jgw', 'pgw', 'wld', 'gfw', 'bpw'],
    mimeTypes: ['text/plain'],
    category: 'raster',
    dataKind: 'sidecar',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: F,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'raster/worldfile',
    writerEngine: 'raster/worldfile',
    notes: 'Six-line affine georeference for an image. Bound automatically to a matching image file.',
  },
  {
    id: 'gcp-points',
    name: 'QGIS GCP points',
    extensions: ['points'],
    mimeTypes: ['text/csv'],
    category: 'raster',
    dataKind: 'sidecar',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'raster/gcp',
    writerEngine: 'raster/gcp',
  },
  {
    id: 'prj',
    name: 'Projection sidecar (.prj/.qpj)',
    extensions: ['prj', 'qpj'],
    mimeTypes: ['text/plain'],
    category: 'crs',
    dataKind: 'sidecar',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: F,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'crs/wkt',
    writerEngine: 'crs/wkt',
  },

  // ------------------------------------------------------------- Point cloud
  {
    id: 'las',
    name: 'LAS point cloud',
    extensions: ['las'],
    mimeTypes: ['application/octet-stream'],
    magic: [{ offset: 0, bytes: 'LASF' }],
    category: 'lidar',
    dataKind: 'pointcloud',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    maxRecommendedSizeMb: 800,
    readerEngine: 'pointcloud/las',
    writerEngine: 'pointcloud/las',
    notes: 'LAS 1.0–1.4, point record formats 0–10 on read; 0–3 and 6–7 on write. Coordinates use the file scale and offset in double precision.',
  },
  {
    id: 'laz',
    name: 'LAZ compressed point cloud',
    extensions: ['laz'],
    mimeTypes: ['application/octet-stream'],
    magic: [{ offset: 0, bytes: 'LASF' }],
    category: 'lidar',
    dataKind: 'pointcloud',
    support: { import: 'adapter', export: 'adapter' },
    requiresWasm: T,
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    warnings: ['LAZ point data is arithmetic-coded. No decoder is bundled, so the header is reported and the points are refused. LAZ bytes are never read as uncompressed LAS.'],
    notes: 'A real laszip codec is Phase 5 work.',
  },
  {
    id: 'xyz',
    name: 'XYZ point cloud / text',
    extensions: ['xyz'],
    mimeTypes: ['text/plain'],
    category: 'lidar',
    dataKind: 'pointcloud',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'pointcloud/xyz',
    writerEngine: 'pointcloud/xyz',
  },
  {
    id: 'pts',
    name: 'PTS scan points',
    extensions: ['pts'],
    mimeTypes: ['text/plain'],
    category: 'lidar',
    dataKind: 'pointcloud',
    support: { import: 'full', export: 'full' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'pointcloud/pts',
    writerEngine: 'pointcloud/pts',
    notes: 'First line is the point count, then X Y Z [intensity] [R G B].',
  },
  {
    id: 'ply',
    name: 'PLY mesh / point cloud',
    extensions: ['ply'],
    mimeTypes: ['application/octet-stream'],
    magic: [{ offset: 0, bytes: 'ply' }],
    category: 'lidar',
    dataKind: 'pointcloud',
    support: { import: 'full', export: 'partial' },
    supports2D: F,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'pointcloud/ply',
    writerEngine: 'pointcloud/ply',
    warnings: ['The writer emits ASCII PLY vertices only; faces are not written.'],
  },
  {
    id: 'e57',
    name: 'E57 point cloud',
    extensions: ['e57'],
    mimeTypes: ['application/octet-stream'],
    category: 'lidar',
    dataKind: 'pointcloud',
    support: { import: 'adapter', export: 'adapter' },
    requiresWasm: T,
    supports2D: F,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: F,
    supportsCurves: F,
    notes: 'Adapter contract only.',
  },

  // ------------------------------------------------------------------ Mining
  {
    id: 'surpac-str',
    name: 'Surpac String',
    extensions: ['str'],
    mimeTypes: ['text/plain'],
    category: 'mining',
    dataKind: 'vector',
    support: { import: 'partial', export: 'partial' },
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'single',
    readerEngine: 'vector/surpac',
    writerEngine: 'vector/surpac',
    warnings: ['String number, Y (northing), X (easting), Z and description fields are handled. Surpac styling and extended D-fields beyond the description are not interpreted.'],
    notes: 'Surpac writes northing before easting; the reader swaps to x/y and records that it did.',
  },

  // ----------------------------------------------------------------- Archive
  {
    id: 'zip',
    name: 'ZIP archive',
    extensions: ['zip'],
    mimeTypes: ['application/zip'],
    magic: [{ offset: 0, bytes: 'PK' }],
    category: 'archive',
    dataKind: 'archive',
    support: { import: 'full', export: 'full' },
    supports2D: F,
    supports3D: F,
    supportsZ: F,
    supportsM: F,
    supportsAttributes: F,
    supportsCRS: F,
    supportsMultiGeometry: F,
    supportsCurves: F,
    packaging: 'zip',
    readerEngine: 'archives/zip',
    writerEngine: 'archives/zip',
    notes: 'Opened, inspected and expanded into the queue. Nesting depth, decompressed size and compression ratio are capped.',
  },

  // -------------------------------------------------------- Adapter contracts
  {
    id: 'geopackage',
    name: 'GeoPackage',
    extensions: ['gpkg'],
    mimeTypes: ['application/geopackage+sqlite3'],
    magic: [{ offset: 0, bytes: 'SQLite format 3' }],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'adapter', export: 'adapter' },
    requiresWasm: T,
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: T,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: T,
    supportsCurves: F,
    notes: 'Needs a SQLite WASM engine. Adapter contract only.',
  },
  {
    id: 'flatgeobuf',
    name: 'FlatGeobuf',
    extensions: ['fgb'],
    mimeTypes: ['application/octet-stream'],
    magic: [{ offset: 0, bytes: [0x66, 0x67, 0x62, 0x03] }],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'adapter', export: 'adapter' },
    // FlatGeobuf is FlatBuffers-encoded; decoding it needs a generated schema
    // reader that is not part of this build.
    requiresWasm: T,
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: T,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: T,
    supportsCurves: F,
    notes: 'Adapter contract only.',
  },
  {
    id: 'geoparquet',
    name: 'GeoParquet',
    extensions: ['parquet'],
    mimeTypes: ['application/octet-stream'],
    magic: [{ offset: 0, bytes: 'PAR1' }],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'adapter', export: 'adapter' },
    requiresWasm: T,
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: F,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: T,
    supportsCurves: F,
    notes: 'Adapter contract only.',
  },
  {
    id: 'filegdb',
    name: 'File Geodatabase',
    extensions: ['gdb'],
    mimeTypes: ['application/octet-stream'],
    category: 'gis',
    dataKind: 'vector',
    support: { import: 'adapter', export: 'adapter' },
    requiresNative: T,
    supports2D: T,
    supports3D: T,
    supportsZ: T,
    supportsM: T,
    supportsAttributes: T,
    supportsCRS: T,
    supportsMultiGeometry: T,
    supportsCurves: T,
    notes: 'Requires a licensed SDK. Adapter contract only.',
  },
];

const BY_ID = new Map(FORMATS.map((format) => [format.id, format]));

const BY_EXTENSION = (() => {
  const map = new Map<string, FormatDef[]>();
  for (const format of FORMATS) {
    for (const extension of format.extensions) {
      const list = map.get(extension) ?? [];
      list.push(format);
      map.set(extension, list);
    }
  }
  return map;
})();

export function getFormat(id: string): FormatDef | undefined {
  return BY_ID.get(id);
}

export function formatsForExtension(extension: string): FormatDef[] {
  return BY_EXTENSION.get(extension.toLowerCase()) ?? [];
}

export function importableFormats(): FormatDef[] {
  return FORMATS.filter((format) => format.support.import !== 'none');
}

export function exportableFormats(): FormatDef[] {
  return FORMATS.filter((format) => format.support.export !== 'none');
}

/** Formats a dataset of this kind can actually be written to. */
export function exportTargetsFor(kind: DataKind): FormatDef[] {
  return exportableFormats().filter((format) => {
    if (format.dataKind === kind) return true;
    // A coordinate table becomes vector geometry once its columns are mapped, so
    // vector targets are legitimate for tables.
    if (kind === 'table' && format.dataKind === 'vector') return true;
    // A point cloud can be written to a coordinate table or to point vectors.
    if (kind === 'pointcloud' && (format.dataKind === 'table' || format.id === 'geojson' || format.id === 'dxf' || format.id === 'csv')) {
      return true;
    }
    if (kind === 'vector' && format.dataKind === 'table') return true;
    return false;
  });
}

export function isAvailable(format: FormatDef, direction: 'import' | 'export', nativeReady: boolean): boolean {
  const level = format.support[direction];
  if (level === 'none') return false;
  if (level === 'metadata-only') return direction === 'import';
  if (level === 'adapter') return format.requiresNative === true && nativeReady;
  return true;
}

export const SUPPORT_LABEL: Record<SupportLevel, string> = {
  full: 'Supported',
  partial: 'Partial',
  'metadata-only': 'Metadata only',
  adapter: 'Adapter required',
  none: 'Not supported',
};

export const CATEGORY_LABEL: Record<FormatCategory, string> = {
  gis: 'GIS',
  cad: 'CAD',
  raster: 'Raster',
  lidar: 'LiDAR',
  survey: 'Survey',
  gps: 'GPS',
  mining: 'Mining',
  spreadsheet: 'Spreadsheet',
  archive: 'Archive',
  crs: 'CRS',
};
