/**
 * The conversion pipeline — the one place readers and writers are dispatched.
 *
 *   INGEST -> DETECT -> READ (CIR) -> TRANSFORM -> WRITE -> RE-IMPORT -> QA
 *
 * Every reader returns a CirDataset and every writer consumes one, so adding a
 * format means adding two entries here and nothing else. Keeping the dispatch in
 * one module is also what makes the honesty rules enforceable: the CRS gate, the
 * decimation notice and the QA re-import all sit on the single path that every
 * conversion takes.
 */

import {
  collapseWarnings,
  createLayer,
  originFromPath,
  warn,
  type CirDataset,
  type CrsRef,
  type Position,
  type SourceInfo,
  type Warning,
} from './cir';
import { detectFormat, type DetectionResult } from './detect';
import {
  deduplicatePaths,
  directoryForOrigin,
  joinPath,
  packageOutput,
  planLayout,
  type OutputLayout,
  type OutputNode,
} from './layout';
import { replayEdits, type EditCommand } from './edits';
import { ConversionError, asConversionError } from './errors';
import { featuresBounds } from './geometry';
import { sha256Hex } from './hash';
import { buildOutputName, extensionOf, type NamingOptions } from './naming';
import { SURVEY_DEFAULT_PRECISION, type PrecisionPolicy } from './precision';
import { getFormat, type FormatDef } from './registry';
import { readDwg } from '../adapters/native-messaging/client';
import type { DatumShift } from '../crs/datum';
import { crsFromEpsg } from '../crs/epsg';
import { crsLabel, planTransform, resolveSourceCrs, sameCrs, suggestCrs, transformDataset } from '../crs/transform';
import { readZip, writeZip, type ZipInput } from '../engines/archives/zip';
import { readDxf, type ReadDxfOptions } from '../engines/cad/dxf-read';
import { DEFAULT_DXF_OPTIONS, writeDxf, type WriteDxfOptions } from '../engines/cad/dxf-write';
import { applyDecimation, type DecimationSettings, type PointFilter } from '../engines/pointcloud/decimate';
import { DEFAULT_LAS_OPTIONS, readLas, writeLas, type WriteLasOptions } from '../engines/pointcloud/las';
import {
  DEFAULT_TEXT_CLOUD_OPTIONS,
  readPly,
  readPts,
  readXyzCloud,
  writePly,
  writePts,
  writeXyzCloud,
  type WriteTextCloudOptions,
} from '../engines/pointcloud/text';
import { readAsciiGrid, writeAsciiGrid } from '../engines/raster/asciigrid';
import { predictConversion, type FidelityPrediction } from './predict';
import { diffDatasets, type DiffReport } from '../qa/diff';
import { buildGeometryOverlay, type GeometryOverlay } from '../qa/geometry-overlay';
import { assessHealth, type ProjectHealth } from '../qa/health';
import { buildLegend, legendSvg } from './legend';
import { buildReport, reportFiles, type ConversionReport } from './report';
import { burnIn, describeBurnIn, DEFAULT_BURN_IN_OPTIONS, type BurnInOptions } from '../qa/burn-in';
import { polygonize, describePolygonize, DEFAULT_POLYGONIZE_OPTIONS, type PolygonizeOptions } from '../qa/polygonize';
import { readGeoTiff, rasterFootprint } from '../engines/raster/geotiff';
import { generateContours, groundContours, type ContourOptions } from '../engines/raster/contour';
import { clipRaster, type ClipOptions } from '../engines/raster/clip';
import { planWarpGrid, warpRaster } from '../engines/raster/warp';
import { vectorizeRaster, type VectorizeOptions } from '../engines/raster/vectorize';
import { DEFAULT_GEOTIFF_OPTIONS, writeGeoTiff, type WriteGeoTiffOptions } from '../engines/raster/geotiff-write';
import { buildWorldFile, readGcpPoints, writeGcpPoints } from '../engines/raster/worldfile';
import { decodeText, encodeText, sourceInfo } from '../engines/shared';
import { DEFAULT_CSV_OPTIONS, readCsvTable, tableToPoints, writeCsv, type WriteCsvOptions } from '../engines/vector/csv';
import { readGeoJson, writeGeoJson } from '../engines/vector/geojson';
import { readGml, writeGml } from '../engines/vector/gml';
import { readFlatGeobuf, writeFlatGeobuf } from '../engines/vector/flatgeobuf';
import { DEFAULT_GPX_OPTIONS, readGpx, writeGpx, type WriteGpxOptions } from '../engines/vector/gpx';
import { DEFAULT_KML_OPTIONS, readKml, readKmz, writeKml, writeKmz, type WriteKmlOptions } from '../engines/vector/kml';
import { readLandXml, writeLandXml } from '../engines/vector/landxml';
import { readMifMid, writeMifMid } from '../engines/vector/mifmid';
import { DEFAULT_OSM_OPTIONS, readOsm, writeOsm } from '../engines/vector/osm';
import { buildShapefile, readShapefile, type WriteShapefileOptions } from '../engines/vector/shapefile';
import { readSurpacStr, writeSurpacStr } from '../engines/vector/surpac';
import { readTopoJson, writeTopoJson } from '../engines/vector/topojson';
import { readWkb, writeWkb } from '../engines/vector/wkb';
import { readWkt, writeWkt } from '../engines/vector/wkt';
import { readXlsx, writeXlsx } from '../engines/vector/xlsx';
import { parsePrj, buildPrj } from '../crs/wkt';
import {
  compareVector,
  comparePointCloud,
  compareRaster,
  notValidated,
  type FidelityReport,
} from '../qa/fidelity';
import { DEFAULT_REPAIR_OPTIONS, repairTopology, type RepairOptions } from '../qa/topology';

/** One file, with any companions the grouper attached. */
export interface ConversionInput {
  fileName: string;
  bytes: Uint8Array;
  mimeType?: string;
  /** Extension -> bytes, e.g. 'dbf', 'prj', 'shx', 'mid', 'tfw'. */
  companions?: Map<string, Uint8Array>;
  siblingExtensions?: string[];
  /**
   * Path as presented, e.g. `Delivery/Survey/plots.dxf`. Carries the folder the
   * user actually organised, which the layout engine mirrors on the way out.
   */
  path?: string;
  /** Archive nesting chain, outermost first, for a file found inside a ZIP. */
  containers?: string[];
}

export interface ConversionSettings {
  precision: PrecisionPolicy;
  /** Source CRS the user selected, used only when the file declares none. */
  sourceCrs?: CrsRef | null;
  targetCrs?: CrsRef | null;
  /**
   * Helmert parameters, when the conversion crosses a datum this tool bundles
   * none for. Absent means the crossing is refused rather than approximated.
   */
  datumShift?: DatumShift | null;
  preserveZ: boolean;
  /**
   * Write the attribute table, or geometry alone.
   *
   * Absent means true, so nothing that does not set it changes behaviour.
   * `false` drops the values AND the field definitions, and says which fields
   * it left out — a file still advertising "owner" and answering nothing is
   * worse than one that does not mention it.
   */
  preserveAttributes?: boolean;
  naming: NamingOptions;
  repair: RepairOptions;
  runQa: boolean;
  arcTolerance?: number;
  decimation?: DecimationSettings;
  pointFilter?: PointFilter;
  dxf?: Partial<WriteDxfOptions>;
  kml?: Partial<WriteKmlOptions>;
  gpx?: Partial<WriteGpxOptions>;
  csv?: Partial<WriteCsvOptions>;
  shapefile?: Partial<WriteShapefileOptions>;
  las?: Partial<WriteLasOptions>;
  textCloud?: Partial<WriteTextCloudOptions>;
  geotiff?: Partial<WriteGeoTiffOptions>;
  /**
   * Assemble CAD line work into polygons before writing (spec §27.4).
   *
   * Off unless configured. Closing a boundary is a geometry change, so it obeys
   * the tolerance discipline: the gap closed for each polygon is recorded, and
   * a boundary that will not close within tolerance stays a line (R18, R21).
   */
  polygonize?: Partial<PolygonizeOptions>;
  /**
   * Attach text found inside polygons to those polygons (spec §27).
   *
   * Off unless configured. This is what makes a cadastral DXF usable as GIS:
   * the plot number drawn beside the boundary becomes an attribute on it.
   */
  burnIn?: Partial<BurnInOptions>;
  /**
   * Trace contour lines from an elevation raster (spec §16).
   *
   * Off unless an interval is given, because there is no interval that is right
   * for every survey: 0.5 m on a building plot and 10 m on a catchment are both
   * correct, and a default would be wrong for one of them without saying so.
   *
   * The contours are added as a vector layer beside the raster, so a DEM can be
   * converted straight to DXF or KML as line work.
   */
  contours?: Partial<ContourOptions> & { interval: number };
  /**
   * Clip a raster to a boundary (spec §16).
   *
   * The rings travel in the settings rather than being read from a second file
   * here, because the pipeline converts one file at a time by design. The
   * workspace fills them in from whichever queued file the user picked as the
   * boundary, so a district-wide DEM is delivered as the site and nothing else.
   */
  clip?: ClipOptions;
  /**
   * Turn a classified raster into polygons (spec §16).
   *
   * Off unless switched on. A zone map becomes editable boundaries that can be
   * delivered as a shapefile or DXF; adjacent cells sharing a value merge into
   * one polygon rather than becoming one square each.
   */
  vectorize?: Partial<VectorizeOptions> & { enabled: true };
  /** Attach a provenance record to the output package. */
  embedMetadata?: boolean;
  /**
   * Attach a per-file conversion report to the delivery (spec §22.4).
   *
   * Off by default: a report is a deliverable someone asked for, and adding two
   * files to every conversion nobody asked about is how a tidy delivery becomes
   * a cluttered one.
   */
  embedReport?: boolean;
  /**
   * Attach an SVG legend of the layers and their colours.
   *
   * Off by default for the same reason the report is: an extra file in every
   * delivery that nobody asked for is clutter, and a legend is only useful when
   * the delivery is going to somebody who will look at it as a drawing.
   *
   * The colours come from each layer's own `style`, which is what the writers
   * use too — so the legend and the file it describes cannot disagree.
   */
  includeLegend?: boolean;
  /**
   * Assess project health while converting (spec §29.2).
   *
   * Costs a topology scan and a defect scan over the whole dataset, so it is
   * opt-in rather than charged to every conversion.
   */
  assessHealth?: boolean;
  /** Look for whole missing parcels inside a coverage (spec §23.1). */
  checkCoverageGaps?: boolean;
  /**
   * Edits the user made in the workspace, replayed onto the full dataset.
   *
   * These are DESCRIPTIONS ("set OWNER to State on Plots"), not diffs, and they
   * are re-planned here against every feature the source actually has. The
   * workspace only ever holds a 5,000-feature preview per layer, so a diff
   * computed there would silently apply to an eighth of a 40,000-parcel layer.
   * See `core/edits.ts` for the full reasoning.
   */
  edits?: EditCommand[];
  /**
   * Layers the user marked legally operative. Every edit refuses on them.
   *
   * Carried into the conversion rather than enforced only in the UI: a
   * workflow replayed on another machine must refuse the same edits.
   */
  protectedLayers?: string[];
  /**
   * How the delivery is shaped. Defaults to 'single' so a one-layer conversion
   * behaves the way anyone would expect: one file in, one file out.
   */
  layout?: OutputLayout;
  /**
   * Read structure and georeference but skip the expensive payload decode.
   *
   * Set only by the inspector when opening a file too large to decode twice —
   * once for the preview and again for the conversion. A conversion never sets
   * it, so no output is ever produced from a partial read.
   */
  metadataOnly?: boolean;
}

export const DEFAULT_SETTINGS: ConversionSettings = {
  precision: SURVEY_DEFAULT_PRECISION,
  preserveZ: true,
  naming: { pattern: 'converted-to' },
  repair: DEFAULT_REPAIR_OPTIONS,
  runQa: true,
};

export interface OutputFile {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface ConversionResult {
  input: ConversionInput;
  detection: DetectionResult;
  sourceDataset: CirDataset;
  outputs: OutputFile[];
  /**
   * Every path inside the delivery, before packaging. This is what the UI shows
   * as a tree, and what the batch packer places under the source's directory.
   */
  tree: string[];
  warnings: Warning[];
  qa: FidelityReport;
  /** What the pre-flight said this conversion would cost (spec §22). */
  prediction: FidelityPrediction;
  /**
   * Measured differences between the source and the re-imported output (§30.2).
   *
   * Absent when QA did not run or the target has no reader, because a
   * comparison against nothing is not a comparison.
   */
  diff?: DiffReport;
  /**
   * The output read back as a dataset, for the second canvas (§30.1).
   *
   * This is the SAME re-import the QA verdict and the measured diff are
   * computed from, so what the right-hand pane draws is the geometry the
   * numbers describe — not a third reading of the file that could differ from
   * either. Absent for the same reasons `diff` is.
   */
  outputDataset?: CirDataset;
  /** Where the source and the output differ, for the overlay (§30.1). */
  overlay?: GeometryOverlay;
  /**
   * Project health, assessed on the SOURCE (spec §29.2).
   *
   * On the source rather than the output, because it is a work list for the
   * user and the user can fix the source. Present only when asked for: it costs
   * a topology and a defect scan.
   */
  health?: ProjectHealth;
  /** The per-file conversion report (spec §22.4), when one was asked for. */
  report?: ConversionReport;
  provenance: {
    sourceFile: string;
    sha256: string;
    sourceFormat: string;
    detectionConfidence: number;
    sourceCrs: string;
    targetCrs: string;
    targetFormat: string;
    engineVersion: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    featureCount: number;
  };
}

const ENGINE_VERSION = '1.0.0';

const MIME_BY_EXTENSION: Record<string, string> = {
  geojson: 'application/geo+json',
  json: 'application/json',
  geojsonl: 'application/geo+json-seq',
  topojson: 'application/json',
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
  gpx: 'application/gpx+xml',
  gml: 'application/gml+xml',
  dxf: 'image/vnd.dxf',
  csv: 'text/csv',
  txt: 'text/plain',
  xyz: 'text/plain',
  pts: 'text/plain',
  ply: 'application/octet-stream',
  las: 'application/octet-stream',
  wkt: 'text/plain',
  wkb: 'application/octet-stream',
  asc: 'text/plain',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  str: 'text/plain',
  xml: 'application/xml',
  prj: 'text/plain',
  points: 'text/csv',
};

/** Extension a writer produces for a format id. */
export function outputExtensionFor(formatId: string): string {
  const format = getFormat(formatId);
  if (!format) return 'dat';
  if (format.packaging === 'zip' && format.id !== 'kmz') return 'zip';
  return format.extensions[0];
}

// ---------------------------------------------------------------------- read

/**
 * Reads a source file into the CIR.
 *
 * Companion bytes are passed through to the readers that need them, which is why
 * the grouper runs before this and not inside it.
 */
export async function readSource(input: ConversionInput, detection: DetectionResult, settings: ConversionSettings): Promise<CirDataset> {
  const info: SourceInfo = {
    ...sourceInfo(input.fileName, input.bytes.length, detection.formatId, detection.formatName, detection.confidence),
    companions: input.companions ? [...input.companions.keys()] : undefined,
  };
  const companion = (extension: string): Uint8Array | undefined => input.companions?.get(extension);
  const companionText = (extension: string): string | undefined => {
    const bytes = companion(extension);
    return bytes ? decodeText(bytes) : undefined;
  };

  // Every reader below builds its own dataset, so the origin is stamped on the
  // way out rather than threaded through thirty call sites.
  const origin = originFromPath(input.path ?? input.fileName, input.containers ?? []);
  const withOrigin = async (dataset: CirDataset | Promise<CirDataset>): Promise<CirDataset> => {
    const resolved = await dataset;
    return { ...resolved, origin };
  };

  return withOrigin(dispatchReader(input, detection, settings, info, companion, companionText));
}

function dispatchReader(
  input: ConversionInput,
  detection: DetectionResult,
  settings: ConversionSettings,
  info: SourceInfo,
  companion: (extension: string) => Uint8Array | undefined,
  companionText: (extension: string) => string | undefined
): CirDataset | Promise<CirDataset> {
  switch (detection.formatId) {
    case 'geojson':
      return readGeoJson(decodeText(input.bytes), info);
    case 'geojsonseq':
      return readGeoJson(decodeText(input.bytes), info, { sequence: true });
    case 'topojson':
      return readTopoJson(decodeText(input.bytes), info);
    case 'flatgeobuf':
      return readFlatGeobuf(input.bytes, info);
    case 'kml':
      return readKml(decodeText(input.bytes), info);
    case 'kmz':
      return readKmz(input.bytes, info);
    case 'gpx':
      return readGpx(decodeText(input.bytes), info);
    case 'gml':
      return readGml(decodeText(input.bytes), info);
    case 'osm':
      return readOsm(decodeText(input.bytes), info);
    case 'landxml':
      return readLandXml(decodeText(input.bytes), info);
    case 'wkt':
      return readWkt(decodeText(input.bytes), info);
    case 'wkb':
      return readWkb(input.bytes, info);
    case 'surpac-str':
      return readSurpacStr(decodeText(input.bytes), info);
    case 'mifmid':
      return readMifMid(decodeText(input.bytes), companionText('mid'), info);
    case 'shapefile':
      return readShapefile(
        { shp: input.bytes, dbf: companion('dbf'), shx: companion('shx'), prj: companionText('prj'), cpg: companionText('cpg') },
        info
      );
    case 'dxf':
      return readDxf(decodeText(input.bytes), info, {
        arcTolerance: settings.arcTolerance,
      } satisfies ReadDxfOptions);
    case 'csv':
      return readCsvTable(decodeText(input.bytes), info);
    case 'xlsx':
      return readXlsx(input.bytes, info);
    case 'las':
      return readLas(input.bytes, info, { prjText: companionText('prj') });
    case 'laz':
      // The LAS reader recognises the compression flag and refuses with the
      // header intact; routing here keeps that single honest failure path.
      return readLas(input.bytes, info, { prjText: companionText('prj') });
    case 'xyz':
      return readXyzCloud(input.bytes, info);
    case 'pts':
      return readPts(input.bytes, info);
    case 'ply':
      return readPly(input.bytes, info);
    case 'asciigrid':
      return readAsciiGrid(input.bytes, info, companionText('prj'));
    case 'geotiff':
      return readGeoTiff(input.bytes, info, {
        worldFileText: companionText('tfw') ?? companionText('wld'),
        prjText: companionText('prj'),
        metadataOnly: settings.metadataOnly,
      });
    case 'prj': {
      const parsed = parsePrj(decodeText(input.bytes));
      return {
        kind: 'sidecar',
        name: input.fileName,
        source: info,
        crs: parsed.crs,
        crsOrigin: parsed.crs ? 'declared' : 'unknown',
        units: null,
        axisOrder: 'xy',
        vertical: { kind: 'unknown' },
        layers: [],
        warnings: parsed.crs
          ? []
          : [
              warn('PRJ_UNRESOLVED', 'The projection file could not be resolved to a known CRS.', {
                reason: 'Its WKT names a projection outside the bundled set.',
                action: 'Use the CRS panel to enter an EPSG code or a PROJ string instead.',
              }),
            ],
        metadata: { wkt: parsed.wkt },
      };
    }
    case 'gcp-points': {
      const { gcps, warnings } = readGcpPoints(decodeText(input.bytes));
      return {
        kind: 'vector',
        name: input.fileName,
        source: info,
        crs: null,
        crsOrigin: 'unknown',
        units: null,
        axisOrder: 'xy',
        vertical: { kind: 'unknown' },
        layers: [
          {
            name: 'Ground control points',
            path: ['Ground control points'],
            fields: [],
            geometryTypes: ['Point'],
            features: gcps.map((gcp, index) => ({
              id: index + 1,
              geometry: { type: 'Point' as const, coordinates: [gcp.mapX, gcp.mapY], dimension: 2 as const },
              properties: { pixel_x: gcp.pixelX, pixel_y: gcp.pixelY, enabled: gcp.enabled },
            })),
          },
        ],
        warnings,
      };
    }
    case 'zip':
      throw new ConversionError({
        code: 'ARCHIVE_NEEDS_EXPANSION',
        what: 'A ZIP archive cannot be converted directly.',
        why: 'It may hold several datasets, each needing its own target format.',
        action: 'Use "Expand archive" in the queue to add its contents as separate items.',
      });
    case 'dwg':
      // The only format that leaves the extension: DWG goes to the local helper
      // driving the user's own ODA File Converter, and comes back as DXF. If the
      // helper is absent the adapter throws with install instructions rather
      // than producing something that merely looks like DWG support (rule R7).
      return readDwg(input.bytes, info, settings.arcTolerance);
    case 'dgn':
    case 'geopackage':
    case 'geoparquet':
    case 'filegdb':
    case 'e57': {
      const format = getFormat(detection.formatId)!;
      throw new ConversionError({
        code: 'FORMAT_REQUIRES_ADAPTER',
        what: `${format.name} needs an engine that is not bundled with the extension.`,
        why: format.requiresNative
          ? 'It requires the local native helper, which is either not installed or not reachable.'
          : 'It requires a WebAssembly engine that is not part of this build.',
        action: format.id === 'dwg' ? 'Install the native helper (see docs/NATIVE_HOST.md), or convert the DWG to DXF first.' : 'Convert the file with QGIS or GDAL, then bring the result here.',
      });
    }
    default:
      throw new ConversionError({
        code: 'FORMAT_NOT_READABLE',
        what: `No reader is available for "${detection.formatName}".`,
        why: detection.formatId === 'unknown' ? 'The file did not match any known format signature.' : 'This format is registered but has no import engine.',
        action: 'Confirm the format in the inspector, or convert the file to GeoJSON, DXF, CSV or Shapefile first.',
      });
  }
}

// --------------------------------------------------------------------- write

interface WriteOutcome {
  files: OutputFile[];
  warnings: Warning[];
  /**
   * True when the files form one package that must stay together — a shapefile
   * is meaningless without its .shx, .dbf and .prj beside it. The layout engine
   * gives such a set its own folder rather than scattering it.
   */
  grouped?: boolean;
}

async function writeTarget(dataset: CirDataset, targetId: string, baseName: string, settings: ConversionSettings): Promise<WriteOutcome> {
  const precision = settings.precision;
  const extension = outputExtensionFor(targetId);
  const name = `${baseName}.${extension}`;
  const mime = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
  const text = (body: string): OutputFile => ({ name, bytes: encodeText(body), mimeType: mime });
  const binary = (bytes: Uint8Array): OutputFile => ({ name, bytes, mimeType: mime });

  switch (targetId) {
    case 'geojson': {
      const { text: body, warnings } = writeGeoJson(dataset, { precision, indent: 2, includeCrsMember: true });
      return { files: [text(body)], warnings };
    }
    case 'geojsonseq': {
      const { text: body, warnings } = writeGeoJson(dataset, { precision, sequence: true });
      return { files: [text(body)], warnings };
    }
    case 'topojson': {
      const { text: body, warnings } = writeTopoJson(dataset, { precision });
      return { files: [text(body)], warnings };
    }
    case 'flatgeobuf': {
      // No precision option: FlatGeobuf stores IEEE doubles, so there is no
      // text representation to round and nothing a decimal count could change.
      const { bytes, warnings } = writeFlatGeobuf(dataset);
      return { files: [binary(bytes)], warnings };
    }
    case 'kml': {
      const { text: body, warnings } = writeKml(dataset, { ...DEFAULT_KML_OPTIONS, ...settings.kml, precision });
      return { files: [text(body)], warnings };
    }
    case 'kmz': {
      const { bytes, warnings } = await writeKmz(dataset, { ...DEFAULT_KML_OPTIONS, ...settings.kml, precision });
      return { files: [binary(bytes)], warnings };
    }
    case 'gpx': {
      const { text: body, warnings } = writeGpx(dataset, { ...DEFAULT_GPX_OPTIONS, ...settings.gpx, precision });
      return { files: [text(body)], warnings };
    }
    case 'gml': {
      const { text: body, warnings } = writeGml(dataset, { precision });
      return { files: [text(body)], warnings };
    }
    case 'landxml': {
      const { text: body, warnings } = writeLandXml(dataset, { precision });
      return { files: [text(body)], warnings };
    }
    case 'osm': {
      const { text: body, warnings } = writeOsm(dataset, { ...DEFAULT_OSM_OPTIONS, precision });
      return { files: [text(body)], warnings };
    }
    case 'wkt': {
      const { text: body, warnings } = writeWkt(dataset, { precision, includeSrid: true });
      return { files: [text(body)], warnings };
    }
    case 'wkb': {
      const { bytes, warnings } = writeWkb(dataset, { precision, includeSrid: true });
      return { files: [binary(bytes)], warnings };
    }
    case 'surpac-str': {
      const { text: body, warnings } = writeSurpacStr(dataset, { precision });
      return { files: [text(body)], warnings };
    }
    case 'dxf': {
      const { text: body, warnings } = writeDxf(dataset, {
        ...DEFAULT_DXF_OPTIONS,
        unit: (dataset.units as WriteDxfOptions['unit']) ?? 'm',
        preserveZ: settings.preserveZ,
        ...settings.dxf,
        precision,
      });
      return { files: [text(body)], warnings };
    }
    case 'csv': {
      const { text: body, warnings } = writeCsv(dataset, { ...DEFAULT_CSV_OPTIONS, ...settings.csv, precision });
      return { files: [text(body)], warnings };
    }
    case 'xlsx': {
      const { bytes, warnings } = await writeXlsx(dataset, { precision });
      return { files: [binary(bytes)], warnings };
    }
    case 'shapefile': {
      // Loose members, not a nested ZIP: the layout engine decides whether they
      // sit at the root of the delivery or in a folder of their own, and a ZIP
      // inside a ZIP would defeat both.
      const built = buildShapefile(dataset, {
        layerName: baseName,
        preserveZ: settings.preserveZ,
        encoding: 'utf-8',
        ...settings.shapefile,
        precision,
      });
      const files = built.packages.flatMap((entry) =>
        entry.files.map((file) => ({ name: file.name, bytes: file.bytes, mimeType: MIME_BY_EXTENSION[extensionOf(file.name)] ?? 'application/octet-stream' }))
      );
      return { files, warnings: built.warnings, grouped: true };
    }
    case 'mifmid': {
      const { mif, mid, warnings } = writeMifMid(dataset, { precision, layerName: baseName });
      return {
        files: [
          { name: `${baseName}.mif`, bytes: encodeText(mif), mimeType: 'text/plain' },
          { name: `${baseName}.mid`, bytes: encodeText(mid), mimeType: 'text/plain' },
        ],
        warnings,
        grouped: true,
      };
    }
    case 'las': {
      const { bytes, warnings } = writeLas(dataset, { ...DEFAULT_LAS_OPTIONS, ...settings.las });
      return { files: [binary(bytes)], warnings };
    }
    case 'xyz': {
      const { text: body, warnings } = writeXyzCloud(dataset, { ...DEFAULT_TEXT_CLOUD_OPTIONS, ...settings.textCloud, precision });
      return { files: [text(body)], warnings };
    }
    case 'pts': {
      const { text: body, warnings } = writePts(dataset, { ...DEFAULT_TEXT_CLOUD_OPTIONS, ...settings.textCloud, precision });
      return { files: [text(body)], warnings };
    }
    case 'ply': {
      const { text: body, warnings } = writePly(dataset, { ...DEFAULT_TEXT_CLOUD_OPTIONS, ...settings.textCloud, precision });
      return { files: [text(body)], warnings };
    }
    case 'asciigrid': {
      const { text: body, warnings } = writeAsciiGrid(dataset, { precision });
      return { files: [text(body)], warnings };
    }
    case 'geotiff': {
      const { bytes, warnings } = await writeGeoTiff(dataset, { ...DEFAULT_GEOTIFF_OPTIONS, ...settings.geotiff });
      return { files: [binary(bytes)], warnings };
    }
    case 'worldfile': {
      const geotransform = dataset.raster?.geotransform;
      if (!geotransform) {
        throw new ConversionError({
          code: 'WORLDFILE_NO_GEOREFERENCE',
          what: 'No world file could be written.',
          why: 'The source raster carries no georeference, so there is no affine transform to write.',
          action: 'Georeference the image in QGIS first, or supply ground control points.',
        });
      }
      return { files: [text(buildWorldFile(geotransform))], warnings: [] };
    }
    case 'gcp-points': {
      const gcps = dataset.layers
        .flatMap((layer) => layer.features)
        .filter((feature) => feature.geometry?.type === 'Point')
        .map((feature, index) => ({
          mapX: (feature.geometry!.coordinates as number[])[0],
          mapY: (feature.geometry!.coordinates as number[])[1],
          pixelX: Number(feature.properties?.pixel_x ?? index),
          pixelY: Number(feature.properties?.pixel_y ?? 0),
          enabled: feature.properties?.enabled !== false,
        }));
      return { files: [text(writeGcpPoints(gcps))], warnings: [] };
    }
    case 'prj': {
      const wkt = buildPrj(dataset.crs);
      if (!wkt) {
        throw new ConversionError({
          code: 'PRJ_NO_CRS',
          what: 'No projection file could be written.',
          why: 'The dataset has no declared CRS, and writing a .prj for an unknown CRS would assert a projection the data may not use.',
          action: 'Select a source or target CRS first.',
        });
      }
      return { files: [text(wkt)], warnings: [] };
    }
    default: {
      const format = getFormat(targetId);
      throw new ConversionError({
        code: 'TARGET_NOT_WRITABLE',
        what: `No writer is available for "${format?.name ?? targetId}".`,
        why: format?.support.export === 'adapter' ? 'This format needs an engine that is not bundled.' : 'This format is registered for import only.',
        action: 'Choose GeoJSON, DXF, Shapefile, KML, CSV or LAS as the target.',
      });
    }
  }
}

// -------------------------------------------------------------------- convert

/**
 * The CRS a target format IMPOSES on whatever is written into it, or null.
 *
 * Two registry facts have to hold together, and the difference between them is
 * the difference between a file that is unconventional and a file that is
 * wrong:
 *
 *   `limits.mandatesCrsEpsg` — the specification names one CRS.
 *   `supportsCRS === false`  — the file has nowhere to name a different one.
 *
 * GeoJSON satisfies the first and not the second: RFC 7946 says WGS 84, but the
 * format can carry a `crs` member, so projected coordinates in a GeoJSON are
 * non-standard and self-describing. Nothing is lost by leaving them alone, and
 * reprojecting a survey the user did not ask to reproject would be worse.
 *
 * KML, KMZ, GPX, OSM and GeoJSON text sequences satisfy both. A projected
 * easting written into one of those is read back as a longitude, which puts the
 * geometry a continent away — and there is no field anywhere in the file that
 * would let a reader notice. That is the case worth reprojecting for.
 */
/**
 * Whether every coordinate could be a longitude/latitude pair.
 *
 * Empty or non-finite bounds answer `true`: a file with no coordinates cannot
 * contradict anything, and treating "no evidence" as "evidence against" would
 * make an empty layer look like a CRS error.
 */
function withinGeographicRange(bounds: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  const values = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
  if (!values.every(Number.isFinite)) return true;
  return Math.abs(bounds.minX) <= 180 && Math.abs(bounds.maxX) <= 180 && Math.abs(bounds.minY) <= 90 && Math.abs(bounds.maxY) <= 90;
}

function formatImposedCrs(format: FormatDef): CrsRef | null {
  const epsg = format.limits?.mandatesCrsEpsg;
  if (!epsg || format.supportsCRS) return null;
  return crsFromEpsg(epsg);
}

/**
 * Prepares a source dataset for a target: resolves the CRS, applies decimation
 * and repair, and turns a coordinate table into geometry when the target needs
 * it. Extracted so QA's re-import path can reuse it exactly.
 */
function prepare(dataset: CirDataset, target: FormatDef, settings: ConversionSettings): { dataset: CirDataset; warnings: Warning[] } {
  const warnings: Warning[] = [];
  let working = dataset;

  // A coordinate table only becomes geometry once its columns are mapped.
  if (working.kind === 'table' && target.dataKind === 'vector') {
    const converted = tableToPoints(working);
    working = converted.dataset;
    warnings.push(...converted.warnings);
  }

  // Attributes, or geometry alone.
  //
  // This setting has existed in the store since the first version and reached
  // NOTHING: it sat beside `preserveZ`, which is honoured, so a reader of the
  // settings had every reason to think it worked. Found by the reachability
  // audit; implemented rather than removed because a geometry-only delivery is
  // a real thing to want — a parcel boundary shared with a contractor who has
  // no business seeing the owner names attached to it.
  //
  // The fields are dropped as well as the values. Leaving the columns behind
  // empty would produce a file that still advertises "owner" and "khasra" and
  // answers neither, which is worse than a file that does not mention them.
  if (settings.preserveAttributes === false && working.layers.length > 0) {
    let dropped = 0;
    const names = new Set<string>();
    for (const layer of working.layers) {
      for (const field of layer.fields ?? []) names.add(field.name);
      for (const feature of layer.features) dropped += Object.keys(feature.properties ?? {}).length;
    }

    working = {
      ...working,
      layers: working.layers.map((layer) => ({
        ...layer,
        fields: [],
        features: layer.features.map((feature) => ({ ...feature, properties: {} })),
      })),
    };

    if (dropped > 0) {
      warnings.push(
        warn('ATTRIBUTES_DROPPED', `Attributes were not written: ${dropped.toLocaleString()} value(s) across ${names.size} field(s).`, {
          count: dropped,
          reason: 'The "Write attributes" setting is off, so this delivery carries geometry only.',
          action: `The fields left out were: ${[...names].sort().join(', ')}. Turn the setting back on to include them.`,
          detail: { fields: [...names].sort() },
        })
      );
    }
  }

  if (working.pointcloud && (settings.decimation || settings.pointFilter)) {
    const decimated = applyDecimation(working, settings.decimation ?? { mode: 'none' }, settings.pointFilter);
    working = decimated.dataset;
    warnings.push(...decimated.warnings);
  }

  // Polygonisation runs BEFORE repair and before burn-in: repair should act on
  // the polygons the user will actually export, and burn-in needs polygons to
  // put text inside. Running it later would repair line work that is about to
  // be replaced.
  if (settings.polygonize) {
    const options = { ...DEFAULT_POLYGONIZE_OPTIONS, ...settings.polygonize };
    const result = polygonize(working, options);
    working = result.dataset;
    const closed = result.report.built.filter((entry) => entry.closedGap > 0);
    warnings.push(
      warn('POLYGONIZED', describePolygonize(result.report, options), {
        severity: closed.length > 0 ? 'warning' : 'info',
        count: result.report.built.length,
        reason: 'CAD line work was assembled into polygons, so closed boundaries can be exported as areas rather than as strokes.',
        action:
          closed.length > 0
            ? `${closed.length} boundar(y/ies) had to be closed within the ${options.tolerance}-unit tolerance. Each gap is recorded on the polygon as _polygonized_gap.`
            : 'Every boundary was already closed; no geometry was changed.',
        detail: { built: result.report.built.length, holes: result.report.holes, unclosed: result.report.unclosed.length },
      })
    );
    for (const entry of result.report.unclosed) {
      warnings.push(
        warn('POLYGONIZE_UNCLOSED', `${entry.sourceIds.length} line(s) in "${entry.layer}" did not form a closed boundary.`, {
          count: entry.sourceIds.length,
          reason: entry.reason,
          action: 'Raise the tolerance only if the gap is a digitising error. A genuinely open boundary must not be forced shut.',
        })
      );
    }
  }

  // Clip BEFORE contours, so contours are traced from the delivered raster
  // rather than from the whole district and then thrown away. Doing it the
  // other way round is slower and produces contour fragments hanging outside
  // the boundary, which look like a bug in the clip.
  if (settings.clip?.polygons?.length && working.raster) {
    const clipped = clipRaster(working.raster, settings.clip);
    if (clipped.refusal) {
      throw new ConversionError({
        code: 'CLIP_REFUSED',
        what: clipped.refusal.what,
        why: clipped.refusal.why,
        action: clipped.refusal.action,
      });
    }
    working = { ...working, raster: clipped.raster };
    warnings.push(...clipped.warnings);
  }

  // Vectorize after the clip, so only the delivered area becomes polygons.
  if (settings.vectorize?.enabled && working.raster) {
    const traced = vectorizeRaster(working.raster, settings.vectorize);
    if (traced.refusal) {
      throw new ConversionError({
        code: 'VECTORIZE_REFUSED',
        what: traced.refusal.what,
        why: traced.refusal.why,
        action: traced.refusal.action,
      });
    }

    warnings.push(...traced.warnings);
    if (traced.features.length > 0) {
      working = {
        ...working,
        layers: [
          ...working.layers,
          createLayer(`${working.name} regions`, traced.features, [
            { name: settings.vectorize.fieldName ?? 'value', type: 'number' },
            { name: 'cells', type: 'integer' },
          ]),
        ],
      };
    }
  }

  // Contours (spec §16). Before the burn-in stage, so text can be attached to
  // the contours a DEM produced in the same run if anyone asks for that.
  if (settings.contours?.interval && working.raster) {
    const traced = groundContours(
      generateContours(working.raster, settings.contours as ContourOptions),
      working.raster.geotransform
    );

    if (traced.refusal) {
      // A refusal here fails the conversion rather than quietly producing the
      // raster without contours. The user asked for contours; a file that
      // silently lacks them is the wrong file, and R18 forbids the silence.
      throw new ConversionError({
        code: 'CONTOUR_REFUSED',
        what: traced.refusal.what,
        why: traced.refusal.why,
        action: traced.refusal.action,
      });
    }

    warnings.push(...traced.warnings);

    if (traced.features.length > 0) {
      const name = `${working.name} contours`;
      working = {
        ...working,
        layers: [
          ...working.layers,
          createLayer(name, traced.features, [
            { name: 'elevation', type: 'number' },
            { name: 'index', type: 'boolean' },
            { name: 'length', type: 'number' },
            { name: 'closed', type: 'boolean' },
          ]),
        ],
      };

      warnings.push(
        warn('CONTOURS_TRACED', `${traced.features.length.toLocaleString()} contour line(s) traced at ${settings.contours.interval} unit intervals.`, {
          severity: 'info',
          count: traced.features.length,
          reason: `Levels ${traced.levels[0]} to ${traced.levels[traced.levels.length - 1]} were crossed by the surface.`,
          action: 'Each line carries its elevation, its length, whether it closes, and whether it is an index contour — so a CAD or GIS target can style and label them without a second pass.',
          detail: { levels: traced.levels.length, interval: settings.contours.interval },
        })
      );
    }
  }

  if (settings.burnIn?.targetLayer) {
    const options = { ...DEFAULT_BURN_IN_OPTIONS, ...settings.burnIn };
    const result = burnIn(working, options);
    working = result.dataset;
    warnings.push(
      warn('BURNED_IN', describeBurnIn(result.report, options), {
        severity: 'info',
        count: result.report.matched.length,
        reason: 'Text found inside each polygon was attached to it, making an association that was only spatial into one the target format can carry.',
        action: options.replaceSource
          ? 'The source text was removed, as "replace source" was selected.'
          : 'The source text is unchanged; burn-in only adds.',
        detail: { matched: result.report.matched.length, ambiguous: result.report.ambiguous, orphans: result.report.orphanText.length },
      })
    );
    if (result.report.orphanText.length > 0) {
      warnings.push(
        warn('BURN_IN_ORPHANS', `${result.report.orphanText.length} text item(s) fell inside no polygon and were not attached to anything.`, {
          count: result.report.orphanText.length,
          reason: 'They sit outside every boundary in the target layer, or inside a hole.',
          action: 'Check the source drawing: text outside its parcel usually means the boundary is missing or the layers do not align.',
        })
      );
    }
    if (result.report.ambiguous > 0) {
      warnings.push(
        warn('BURN_IN_AMBIGUOUS', `${result.report.ambiguous} polygon(s) contained more than one candidate text.`, {
          count: result.report.ambiguous,
          reason: `One was chosen by the rule "${options.priority}"; the rejected candidates are listed in the conversion report.`,
          action: 'Check these parcels if the plot numbers matter. A wrong number attached confidently is worse than one questioned.',
        })
      );
    }
  }

  if (working.layers.length > 0) {
    const repaired = repairTopology(working, settings.repair);
    working = repaired.dataset;
    warnings.push(...repaired.warnings);
  }

  // The CRS the target format imposes, when it imposes one. This is what makes
  // a UTM survey convert to KML without the user having to know that KML is
  // defined in WGS 84: the format already knows, so the pipeline asks it.
  const imposed = formatImposedCrs(target);

  // CRS gate. An unknown source CRS blocks a transform rather than guessing one
  // (rule R4); a conversion that keeps the source CRS is allowed to proceed.
  //
  // The target is whichever the user set, and otherwise whatever the format
  // requires. Until this read the format, converting a projected file to KML,
  // KMZ or GPX failed with an instruction to go and set a target CRS that the
  // format had already determined — an error message asking the user to supply
  // an answer the tool was holding.
  const requestedCrs = settings.targetCrs ?? null;
  const targetCrs = requestedCrs ?? imposed;
  const automatic = !requestedCrs && targetCrs !== null;

  // The source CRS is resolved unconditionally, before anything asks whether a
  // transform is needed. It used to be resolved only inside the branch below,
  // so choosing a source CRS for a file that carried an assumed one did nothing
  // at all unless a target transform happened to be configured as well.
  const bounds = featuresBounds(working.layers.flatMap((layer) => layer.features));

  // An assumption the coordinates themselves contradict is not an assumption
  // worth keeping. RFC 7946 says an undeclared GeoJSON is WGS 84; a file whose
  // eastings are 412,345 is telling a different story, and believing the
  // standard over the data would write metres into a degrees field with nothing
  // anywhere to warn a reader. A CRS the file actually STATED is left alone
  // here — arguing with a statement is the user's call, not the pipeline's.
  const assumedCrs = working.crsOrigin === 'assumed' ? working.crs : null;
  const assumptionContradicted =
    assumedCrs !== null && assumedCrs.kind === 'geographic' && !withinGeographicRange(bounds);

  const suggestion = !working.crs || assumptionContradicted ? suggestCrs(bounds) : undefined;
  const resolved = resolveSourceCrs({
    declared: working.crs && working.crsOrigin !== 'assumed' ? working.crs : null,
    assumed: assumptionContradicted ? null : assumedCrs,
    user: settings.sourceCrs,
    suggestion,
  });

  if (assumptionContradicted && resolved.origin !== 'user') {
    warnings.push(
      warn('CRS_ASSUMPTION_CONTRADICTED', `The file declares no CRS, so ${crsLabel(assumedCrs)} was assumed — but the coordinates are outside ±180° / ±90°.`, {
        severity: 'warning',
        reason: 'GeoJSON has no way to record a projected CRS since RFC 7946 removed the crs member, so a projected export from QGIS looks identical to a WGS 84 one until the numbers are read.',
        action: 'Select the source CRS in the CRS panel. Everything that depends on the CRS — reprojection, area, length — is wrong until you do.',
        detail: { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY },
      })
    );
  }

  if (resolved.crs && !sameCrs(resolved.crs, working.crs)) {
    const previous = working.crs;
    working = { ...working, crs: resolved.crs, crsOrigin: resolved.origin };

    if (resolved.overrode) {
      // Disagreeing with a file that stated its own CRS is a legitimate thing
      // to do — a wrong .prj is common — but it must never happen quietly.
      warnings.push(
        warn('CRS_OVERRIDDEN', `The file states ${crsLabel(resolved.overrode)}, but ${crsLabel(resolved.crs)} was used instead.`, {
          severity: 'warning',
          reason: 'You selected a source CRS in the CRS panel, and an explicit selection outranks the file.',
          action: 'Clear the source CRS selection to use what the file states. If the file is right, everything downstream of here is displaced.',
          detail: { stated: resolved.overrode.epsg, used: resolved.crs.epsg },
        })
      );
    } else {
      warnings.push(
        warn('CRS_SELECTED', `Source CRS was ${previous ? 'assumed by the format' : 'not declared by the file'}; ${crsLabel(resolved.crs)} was used (${resolved.origin}).`, {
          severity: 'info',
          reason:
            resolved.origin === 'user'
              ? 'You selected this CRS in the conversion settings.'
              : 'It was inferred from the coordinate ranges.',
          action: 'This selection is recorded in the conversion manifest.',
        })
      );
    }
  }

  if (targetCrs) {
    if (resolved.blocked) {
      throw new ConversionError({
        code: 'CRS_REQUIRED',
        what: automatic
          ? `${target.name} stores coordinates in ${crsLabel(targetCrs)}, but the source CRS is unknown, so they cannot be converted into it.`
          : `A transform to ${crsLabel(targetCrs)} was requested, but the source CRS is unknown.`,
        why: resolved.message ?? 'The file declares no CRS and the coordinates are ambiguous.',
        action: 'Choose the source CRS in the CRS panel. The extension will not guess it — the same easting is valid in every UTM zone.',
      });
    }
    const plan = planTransform(working.crs, targetCrs, settings.datumShift);
    if (!plan.identity) {
      // The raster is warped BEFORE `transformDataset` runs, so that the
      // warning it raises about an un-reprojected raster is not raised at all
      // when the pixels really did move. Doing it the other way round would
      // hand the user a correct file carrying a warning saying it is wrong.
      const sourceCrs = working.crs;
      if (working.raster?.hasPixelData) {
        const warped = warpRasterToCrs(working.raster, plan.transform, sourceCrs, targetCrs);
        if (warped.raster) {
          working = { ...working, raster: warped.raster };
          warnings.push(...warped.warnings);
        } else if (warped.refusal) {
          // A refusal here is not fatal: the vectors can still be reprojected,
          // and `transformDataset` will then say the raster was not. Failing
          // the whole conversion would throw away work over one band of pixels.
          warnings.push(
            warn('RASTER_WARP_REFUSED', warped.refusal.what, {
              severity: 'warning',
              reason: warped.refusal.why,
              action: warped.refusal.action,
            })
          );
        }
      }

      working = transformDataset(working, targetCrs, settings.datumShift);
      warnings.push(...plan.warnings);
      warnings.push(
        warn('CRS_TRANSFORMED', `Coordinates were transformed from ${crsLabel(plan.from)} to ${crsLabel(plan.to)}.`, {
          severity: 'info',
          reason: automatic
            ? `${target.name} stores its coordinates in ${crsLabel(targetCrs)} and has no field in which to record a different one, so the transform is part of writing the format at all.`
            : 'A target CRS was set in the conversion settings.',
          action: automatic
            ? 'Set a target CRS explicitly in the CRS panel if you need a different one — though this format will not be able to record it.'
            : undefined,
        })
      );
    }
  }

  // Last line of defence, after every transform has had its turn. Reaching here
  // still holding the wrong CRS means either the user set a target the format
  // cannot store, or the source CRS was never established — and in both cases
  // the coordinates would be read back as degrees and land in the wrong
  // hemisphere. Refusing beats writing a file that opens and draws.
  if (imposed && working.crs && !sameCrs(working.crs, imposed)) {
    throw new ConversionError({
      code: 'TARGET_CRS_NOT_STORABLE',
      what: `${target.name} stores coordinates in ${crsLabel(imposed)}, but the data is in ${crsLabel(working.crs)}.`,
      why: requestedCrs
        ? `${crsLabel(requestedCrs)} was set as the target CRS, and ${target.name} has no field in which to record it. A reader would take these numbers for longitude and latitude.`
        : 'The coordinates could not be transformed, so writing them would place the geometry in the wrong part of the world.',
      action: requestedCrs
        ? `Clear the target CRS to let ${target.name} use ${crsLabel(imposed)}, or choose a format that carries its own CRS, such as GeoPackage or Shapefile.`
        : 'Check the source CRS in the CRS panel, then convert again.',
    });
  }

  return { dataset: working, warnings };
}

/**
 * Which stage the conversion has reached.
 *
 * A stage, not a percentage. The pipeline knows where it is; it does not know
 * how far through a reader it is without instrumenting every one of them, and
 * an invented percentage that jumps 0 → 50 → 100 teaches the user that the
 * number means nothing. Then the one time a job really is stuck, they have no
 * reason to believe it.
 */
export type ConversionPhase =
  | 'detecting'
  | 'reading'
  | 'editing'
  | 'predicting'
  | 'transforming'
  | 'writing'
  | 're-importing'
  | 'checking'
  | 'packaging';

export const PHASE_LABEL: Record<ConversionPhase, string> = {
  detecting: 'Identifying the format',
  reading: 'Reading the source',
  editing: 'Applying your edits',
  predicting: 'Checking what the target can hold',
  transforming: 'Transforming coordinates',
  writing: 'Writing the output',
  're-importing': 'Reading the output back',
  checking: 'Comparing source with output',
  packaging: 'Packaging the delivery',
};

export interface ConvertOptions {
  input: ConversionInput;
  targetFormatId: string;
  settings?: Partial<ConversionSettings>;
  /** Overrides detection when the user confirmed a different format. */
  forcedSourceFormatId?: string;
  /**
   * Called as the conversion moves between stages.
   *
   * Runs inside whichever thread `convert` runs on; the worker turns each call
   * into a message so the UI can show it. Never used for control flow — a
   * caller that throws from here would stop a conversion for a reporting
   * failure, so it is invoked defensively.
   */
  onPhase?: (phase: ConversionPhase) => void;
}

export async function convert(options: ConvertOptions): Promise<ConversionResult> {
  const settings: ConversionSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const startedAt = new Date();
  const { input } = options;

  // Reporting must never be able to stop a conversion.
  const phase = (stage: ConversionPhase): void => {
    try {
      options.onPhase?.(stage);
    } catch {
      /* a progress listener that throws is not a reason to lose the job */
    }
  };
  phase('detecting');

  const detection = options.forcedSourceFormatId
    ? {
        formatId: options.forcedSourceFormatId,
        formatName: getFormat(options.forcedSourceFormatId)?.name ?? options.forcedSourceFormatId,
        confidence: 1,
        evidence: [{ layer: 'user', weight: 1, note: 'Format confirmed by the user.' }],
        alternatives: [],
        requiresConfirmation: false,
      }
    : detectFormat({
        fileName: input.fileName,
        bytes: input.bytes,
        mimeType: input.mimeType,
        siblings: input.siblingExtensions,
      });

  if (detection.requiresConfirmation) {
    throw new ConversionError({
      code: 'FORMAT_UNCONFIRMED',
      what: `The source format could not be identified with confidence (best guess: ${detection.formatName}, ${(detection.confidence * 100).toFixed(0)}%).`,
      why: 'Detection combines extension, signature, header and content evidence; none of them agreed strongly enough here.',
      action: 'Pick the source format in the inspector to confirm it, then convert again.',
    });
  }

  const target = getFormat(options.targetFormatId);
  if (!target) {
    throw new ConversionError({
      code: 'TARGET_UNKNOWN',
      what: `"${options.targetFormatId}" is not a known target format.`,
      why: 'It is not present in the format registry.',
      action: 'Choose a target from the format picker.',
    });
  }

  const warnings: Warning[] = [];
  let sourceDataset: CirDataset;
  phase('reading');
  try {
    sourceDataset = await readSource(input, detection, settings);
  } catch (error) {
    throw asConversionError(error, {
      code: 'SOURCE_READ_FAILED',
      action: 'Check the file in the inspector, or confirm the source format if detection was wrong.',
    });
  }

  // ---- Replay the workspace edits onto the real dataset.
  //
  // Before prediction, before QA and before writing, because everything
  // downstream must describe the data being exported rather than the data as it
  // arrived. A fidelity report about the unedited file would be about a file
  // nobody is producing.
  if (settings.edits && settings.edits.length > 0) {
    phase('editing');
    const replay = replayEdits(sourceDataset, settings.edits, { protectedLayers: settings.protectedLayers });

    if (replay.failure) {
      // Refusing outright rather than exporting the partial result: a file
      // carrying three of five edits matches no state the user has ever seen,
      // and nothing downstream would report which two are missing (R18).
      throw new ConversionError({
        code: 'EDIT_REPLAY_FAILED',
        what: `Edit ${replay.failure.index + 1} of ${settings.edits.length} could not be applied: ${replay.failure.what}`,
        why: `${replay.failure.why} ${replay.applied} earlier edit(s) applied cleanly; nothing was written, because a file carrying only some of the edits is not a file you asked for.`,
        action: replay.failure.action,
      });
    }

    sourceDataset = replay.dataset;
    for (const entry of replay.log) {
      warnings.push({ code: 'edit-applied', severity: 'info', message: entry });
    }
  }
  warnings.push(...sourceDataset.warnings);

  // ---- Predict the cost, and refuse the conversions that cannot happen.
  //
  // This runs before any writing so an impossible target fails immediately with
  // a reason, rather than partway through a batch with a writer-level error
  // (rule R22, spec §22.3). A *lossy* target is not refused here: the loss is
  // recorded and the conversion proceeds, because what to trade away is the
  // engineer's decision, not this tool's.
  phase('predicting');
  const prediction = predictConversion(sourceDataset, target.id, {
    sourceCrsEpsg: settings.sourceCrs?.epsg ?? null,
    targetCrsEpsg: settings.targetCrs?.epsg ?? null,
    preserveZ: settings.preserveZ,
    precisionDecimals:
      settings.precision.mode === 'fixed'
        ? sourceDataset.crs?.kind === 'geographic'
          ? settings.precision.geographicDecimals
          : settings.precision.linearDecimals
        : undefined,
  });
  if (prediction.blocked) {
    const blocker = prediction.blockers[0];
    throw new ConversionError({
      code: blocker?.code ?? 'EXPORT_BLOCKED',
      what: blocker?.statement ?? `${target.name} cannot be written from this source.`,
      why: 'The pre-flight check compares what the source holds against what the target format can store.',
      action: blocker?.remedy ?? 'Choose a different target format.',
      detail: blocker?.detail,
    });
  }
  for (const finding of prediction.findings) {
    if (finding.grade !== 'red') continue;
    // Predicted losses are raised as warnings up front, so the user sees them
    // in the same list as the ones the writers report afterwards.
    warnings.push(
      warn(`PREDICTED_${finding.code}`, finding.statement, {
        severity: 'warning',
        count: finding.count,
        reason: `Predicted before conversion from what ${target.name} can store.`,
        action: finding.remedy,
        detail: finding.detail,
      })
    );
  }

  phase('transforming');
  const prepared = prepare(sourceDataset, target, settings);
  warnings.push(...prepared.warnings);

  const baseName = buildOutputName(input.fileName, target.id, '', settings.naming).replace(/\.$/, '');

  // ---- Plan the shape of the delivery, then write each planned unit.
  const layout = settings.layout ?? 'single';
  const plan = planLayout(prepared.dataset, {
    layout,
    baseName,
    // KML nests folders and DXF has a layer table, so those formats hold a
    // multi-layer dataset without losing the hierarchy.
    targetHoldsLayers: target.id === 'kml' || target.id === 'kmz' || target.id === 'dxf',
  });
  warnings.push(...plan.warnings);

  phase('writing');
  const nodes: OutputNode[] = [];
  let firstWritten: OutputFile[] = [];

  for (const unit of plan.units) {
    const written = await writeTarget(unit.dataset, target.id, unit.baseName, settings);
    warnings.push(...written.warnings);
    if (firstWritten.length === 0) firstWritten = written.files;

    // A multi-file package gets its own folder unless it is the only thing in
    // the delivery, where a folder would be one level of nesting for nothing.
    const packageFolder = written.grouped && (plan.units.length > 1 || unit.directory) ? unit.baseName : '';
    for (const file of written.files) {
      nodes.push({ path: joinPath(unit.directory, packageFolder, file.name), bytes: file.bytes, mimeType: file.mimeType });
    }
  }

  const deduplicated = deduplicatePaths(nodes);
  if (deduplicated.collisions > 0) {
    warnings.push(
      warn('LAYOUT_PATH_COLLISIONS', `${deduplicated.collisions} output path(s) collided and were given a numeric suffix.`, {
        severity: 'info',
        count: deduplicated.collisions,
        reason: 'Two layers or sources resolved to the same path after sanitising their names.',
        action: 'Rename the source layers if the numbered names are not clear enough.',
      })
    );
  }

  // ---- QA: re-import the bytes just written and compare.
  if (settings.runQa) phase('re-importing');
  let qa: FidelityReport;
  let diff: DiffReport | undefined;
  let outputDataset: CirDataset | undefined;
  let overlay: GeometryOverlay | undefined;
  if (!settings.runQa) {
    qa = notValidated('QA was switched off in the conversion settings.');
  } else if (plan.units.length > 1) {
    // Comparing one slice against the whole source would report every other
    // layer as missing, so the check runs against the layer that was written.
    phase('checking');
    const checked = await runQa(plan.units[0].dataset, firstWritten, target, settings);
    diff = checked.diff;
    outputDataset = checked.outputDataset;
    overlay = checked.overlay;
    qa = {
      ...checked.report,
      summary: `${checked.report.summary} Checked the first of ${plan.units.length} layer files; each layer is written by the same engine on the same path.`,
    };
  } else {
    phase('checking');
    const checked = await runQa(prepared.dataset, firstWritten, target, settings);
    qa = checked.report;
    diff = checked.diff;
    outputDataset = checked.outputDataset;
    overlay = checked.overlay;
  }

  const finishedAt = new Date();

  // ---- Health: assessed on the SOURCE, since that is what the user can fix.
  // Assessing the output would report the conversion's own compromises back as
  // defects in the data, which is the opposite of useful.
  const health = settings.assessHealth
    ? assessHealth(prepared.dataset, {
        prediction,
        defects: { checkCoverageGaps: settings.checkCoverageGaps ?? false },
      })
    : undefined;

  // ---- Package: one file stays loose, a tree becomes a ZIP that *is* the tree.
  phase('packaging');
  const packaged = await packageOutput(deduplicated.nodes, `${baseName}.zip`);
  const outputs: OutputFile[] = packaged.files.map((node) => ({ name: node.path, bytes: node.bytes, mimeType: node.mimeType }));
  const tree = deduplicated.nodes.map((node) => node.path);

  if (settings.embedMetadata) {
    outputs.push({
      name: `${baseName}.provenance.json`,
      bytes: encodeText(
        JSON.stringify(
          {
            sourceFile: input.fileName,
            sourceFormat: detection.formatName,
            detectionConfidence: Number(detection.confidence.toFixed(3)),
            sourceCrs: crsLabel(sourceDataset.crs),
            targetCrs: crsLabel(prepared.dataset.crs),
            targetFormat: target.name,
            engineVersion: ENGINE_VERSION,
            convertedAt: finishedAt.toISOString(),
            qaVerdict: qa.verdict,
            warnings: collapseWarnings(warnings).map((warning) => ({ code: warning.code, message: warning.message, count: warning.count })),
          },
          null,
          2
        )
      ),
      mimeType: 'application/json',
    });
  }

  // ---- Report: the same facts as a document, for the person who receives the
  // delivery and does not have this tool.
  const report = settings.embedReport
    ? buildReport({
        dataset: sourceDataset,
        sourceFileName: input.fileName,
        sourceFormatName: detection.formatName,
        sourceSizeBytes: input.bytes.length,
        detectionConfidence: detection.confidence,
        targetFormatName: target.name,
        outputPaths: tree,
        outputSizeBytes: outputs.reduce((sum, file) => sum + file.bytes.length, 0),
        outputDataset,
        prediction,
        diff,
        qaVerdict: qa.verdict,
        qaSummary: qa.summary,
        health,
        warnings: collapseWarnings(warnings),
        now: finishedAt,
      })
    : undefined;

  if (report) outputs.push(...reportFiles(report, baseName));

  // ---- Legend: the layers and their colours, as a file the recipient can open.
  //
  // Built from `prepared.dataset` — the dataset as WRITTEN, after every edit,
  // rename and style — so the legend describes the delivery rather than the
  // source. A legend naming a layer by its old name would be wrong in the one
  // way a legend cannot afford.
  if (settings.includeLegend && prepared.dataset.layers?.length) {
    const legend = buildLegend(prepared.dataset, {
      title: baseName,
      crsLabel: crsLabel(prepared.dataset.crs),
    });
    outputs.push({
      name: `${baseName}.legend.svg`,
      bytes: encodeText(legendSvg(legend)),
      mimeType: 'image/svg+xml',
    });
  }

  return {
    input,
    detection,
    sourceDataset,
    outputs,
    tree,
    warnings: collapseWarnings(warnings),
    qa,
    prediction,
    diff,
    outputDataset,
    overlay,
    health,
    report,
    provenance: {
      sourceFile: input.fileName,
      sha256: await sha256Hex(input.bytes),
      sourceFormat: detection.formatName,
      detectionConfidence: detection.confidence,
      sourceCrs: crsLabel(sourceDataset.crs),
      targetCrs: crsLabel(prepared.dataset.crs),
      targetFormat: target.name,
      engineVersion: ENGINE_VERSION,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      featureCount: prepared.dataset.layers.reduce((sum, layer) => sum + layer.features.length, 0),
    },
  };
}

/**
 * Re-imports the written output and compares it with the source.
 *
 * A packaged target (Shapefile, MIF/MID) is unzipped first so the reader sees
 * the same files a recipient would.
 */
async function runQa(
  source: CirDataset,
  files: OutputFile[],
  target: FormatDef,
  settings: ConversionSettings
): Promise<{ report: FidelityReport; diff?: DiffReport; outputDataset?: CirDataset; overlay?: GeometryOverlay }> {
  if (target.support.import === 'none' || target.support.import === 'adapter') {
    return { report: notValidated(`${target.name} has no reader in this build, so the output could not be re-imported and checked.`) };
  }

  try {
    const primary = files[0];
    let reimportInput: ConversionInput;

    if (target.packaging === 'zip' && target.id !== 'kmz') {
      const entries = await readZip(primary.bytes);
      const main = entries.find((entry) => entry.name.toLowerCase().endsWith(`.${target.extensions[0]}`));
      if (!main) return { report: notValidated('The output package did not contain a readable primary file.') };
      const companions = new Map<string, Uint8Array>();
      for (const entry of entries) {
        if (entry === main) continue;
        companions.set(extensionOf(entry.name), entry.bytes);
      }
      reimportInput = { fileName: main.name, bytes: main.bytes, companions };
    } else {
      reimportInput = { fileName: primary.name, bytes: primary.bytes };
    }

    const detection = detectFormat({ fileName: reimportInput.fileName, bytes: reimportInput.bytes });
    // Trust the target id over detection here: the file was just written by this
    // very writer, so its identity is known even if the sniffer is unsure.
    const reimported = await readSource(reimportInput, { ...detection, formatId: target.id, formatName: target.name, confidence: 1, requiresConfirmation: false }, settings);

    if (source.pointcloud) return { report: comparePointCloud(source, reimported), outputDataset: reimported };
    if (source.raster) return { report: compareRaster(source, reimported), outputDataset: reimported };
    const prepared = source.kind === 'table' ? tableToPoints(source).dataset : source;
    const coordinateTolerance = settings.precision.mode === 'full' ? 1e-6 : 10 ** -Math.min(settings.precision.linearDecimals, 6);
    const report = compareVector(prepared, reimported, {
      coordinateTolerance,
      // Shapefile splits mixed geometry across files, so the count legitimately
      // differs on re-import of the primary one.
      allowFeatureCountChange: target.id === 'shapefile' || target.id === 'csv' || target.id === 'xlsx',
    });
    // The measured comparison, computed from the same re-import rather than by
    // reading the output a second time — so the verdict and the numbers beside
    // it can never describe different bytes.
    const diff = diffDatasets(prepared, reimported, {
      coordinateTolerance,
      featureCountTolerance: target.id === 'shapefile' || target.id === 'csv' || target.id === 'xlsx' ? Number.MAX_SAFE_INTEGER : 0,
    });
    // Where the differences are, for the second canvas to draw. Judged against
    // the same coordinate tolerance the diff used, so a coordinate the numbers
    // call "within tolerance" is not simultaneously drawn as moved.
    const overlay = buildGeometryOverlay(prepared, reimported, { tolerance: coordinateTolerance });
    return { report, diff, outputDataset: reimported, overlay };
  } catch (error) {
    return { report: notValidated(`Re-import failed: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

/** Bundles a batch's outputs into one ZIP alongside its manifest. */
export async function packageBatch(
  results: ConversionResult[],
  options: { mirrorSource?: boolean } = {}
): Promise<{ zip: Uint8Array; manifestCsv: string; manifestJson: string; tree: string[] }> {
  const mirrorSource = options.mirrorSource ?? true;
  // Each result is placed under the directory its source came from, so a batch
  // over a folder tree comes back as the same folder tree. Two files called
  // plots.dxf in different folders keep their folders and never collide.
  const nodes: OutputNode[] = [];
  for (const result of results) {
    const directory = mirrorSource ? directoryForOrigin(result.sourceDataset.origin) : '';
    for (const output of result.outputs) {
      nodes.push({ path: joinPath(directory, output.name), bytes: output.bytes, mimeType: output.mimeType });
    }
  }
  const deduplicated = deduplicatePaths(nodes);
  const files: ZipInput[] = deduplicated.nodes.map((node) => ({ name: node.path, bytes: node.bytes }));

  const columns = [
    'source_file',
    'source_format',
    'detection_confidence',
    'target_file',
    'target_format',
    'source_crs',
    'target_crs',
    'features',
    'output_bytes',
    'status',
    'qa_verdict',
    'warnings',
    'engine_version',
    'sha256',
    'converted_at',
    'duration_ms',
  ];
  const rows = results.map((result) => [
    result.provenance.sourceFile,
    result.provenance.sourceFormat,
    result.provenance.detectionConfidence.toFixed(3),
    result.outputs.map((output) => joinPath(mirrorSource ? directoryForOrigin(result.sourceDataset.origin) : '', output.name)).join(' | '),
    result.provenance.targetFormat,
    result.provenance.sourceCrs,
    result.provenance.targetCrs,
    String(result.provenance.featureCount),
    String(result.outputs.reduce((sum, output) => sum + output.bytes.length, 0)),
    'converted',
    result.qa.verdict,
    result.warnings.map((warning) => warning.code).join(' '),
    result.provenance.engineVersion,
    result.provenance.sha256,
    result.provenance.finishedAt,
    String(result.provenance.durationMs),
  ]);

  const quote = (value: string) => (value.includes(',') || value.includes('"') ? `"${value.replace(/"/g, '""')}"` : value);
  const manifestCsv = [columns.join(','), ...rows.map((row) => row.map(quote).join(','))].join('\n') + '\n';
  const manifestJson = JSON.stringify(
    results.map((result) => ({ ...result.provenance, qa: result.qa.verdict, outputs: result.outputs.map((output) => output.name), warnings: result.warnings })),
    null,
    2
  );

  files.push({ name: 'conversion-manifest.csv', bytes: encodeText(manifestCsv) });
  files.push({ name: 'conversion-manifest.json', bytes: encodeText(manifestJson) });

  return { zip: await writeZip(files), manifestCsv, manifestJson, tree: files.map((file) => file.name) };
}

/** Expands an archive into individual conversion inputs. */
export async function expandArchive(input: ConversionInput): Promise<ConversionInput[]> {
  const entries = await readZip(input.bytes);
  // The archive itself becomes a container level, and each entry keeps its
  // internal path, so a ZIP of folders expands into the same folders rather
  // than a flat pile of basenames.
  const containers = [...(input.containers ?? []), input.fileName];
  return entries.map((entry) => ({
    fileName: entry.name.split('/').pop() ?? entry.name,
    path: entry.name,
    containers,
    bytes: entry.bytes,
    siblingExtensions: entries.map((sibling) => extensionOf(sibling.name)),
  }));
}

/**
 * Reprojects a raster's PIXELS onto a grid in the target CRS.
 *
 * The warp needs the INVERSE transform — target pixel centre back to source
 * coordinates — and `planTransform` builds only the forward one. Rather than
 * invent an inverse, the forward transform is used to plan the target grid and
 * then inverted NUMERICALLY per pixel by a small search, which is exact for the
 * affine case and converges quickly for a projection.
 *
 * That is the honest way to do it with the engine available. A closed-form
 * inverse would be faster and is the right long-term answer; a wrong inverse
 * would put every pixel in the wrong place, which is the failure this whole
 * change exists to prevent.
 */
function warpRasterToCrs(
  raster: NonNullable<CirDataset['raster']>,
  forward: (position: Position) => Position,
  from: CrsRef | null,
  to: CrsRef | null
): ReturnType<typeof warpRaster> {
  const grid = planWarpGrid(raster, forward);
  if (!grid) {
    return {
      warnings: [],
      filled: 0,
      empty: 0,
      refusal: {
        what: 'A target grid for the reprojected raster could not be computed.',
        why: `Transforming this raster's extent from ${crsLabel(from)} to ${crsLabel(to)} produced no finite bounding box — the source CRS is usually declared wrongly when this happens.`,
        action: 'Check the source CRS in the CRS tab against what the file actually is.',
      },
    };
  }

  // Newton's method on the forward transform, seeded from the linear estimate.
  // Five iterations is far more than a well-behaved projection needs and costs
  // nothing at raster sizes this tool handles; it converges to well under a
  // millimetre on the projections in `crs/projection.ts`.
  const toSource = (target: Position): Position => {
    let guess: Position = [target[0], target[1]];
    const step = 1e-3;
    for (let iteration = 0; iteration < 5; iteration++) {
      const [fx, fy] = forward(guess);
      const errorX = fx - target[0];
      const errorY = fy - target[1];
      if (Math.abs(errorX) < 1e-9 && Math.abs(errorY) < 1e-9) break;

      const [fxx, fyx] = forward([guess[0] + step, guess[1]]);
      const [fxy, fyy] = forward([guess[0], guess[1] + step]);
      const a = (fxx - fx) / step;
      const b = (fxy - fx) / step;
      const c = (fyx - fy) / step;
      const d = (fyy - fy) / step;

      const determinant = a * d - b * c;
      if (!Number.isFinite(determinant) || determinant === 0) break;
      guess = [
        guess[0] - (d * errorX - b * errorY) / determinant,
        guess[1] - (a * errorY - c * errorX) / determinant,
      ];
    }
    return guess;
  };

  return warpRaster(raster, {
    toSource,
    geotransform: grid.geotransform,
    width: grid.width,
    height: grid.height,
  });
}

export { rasterFootprint };
export { predictConversion, rankTargets, validateExport, summarisePrediction } from './predict';
export type { FidelityPrediction, FidelityFinding, FidelityGrade, FidelityAxis } from './predict';
