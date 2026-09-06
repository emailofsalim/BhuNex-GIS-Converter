/**
 * GeoTIFF writer.
 *
 * Emits a strip-based, single-IFD, little-endian TIFF with the GeoTIFF model
 * tags and a GeoKeyDirectory. Deliberately narrow: one sample width for every
 * band, chunky planar layout, no tiling, no predictor, no BigTIFF. Those are
 * the settings GDAL, QGIS, ArcGIS and every survey package read without
 * complaint, and each extra option is another way to write a file that opens
 * wrong somewhere.
 *
 * Compression is Deflate by default because an uncompressed 32-bit DEM is
 * enormous; `none` stays available for tools with a fragile TIFF reader.
 */

import { warn, type CirDataset, type CrsRef, type Warning } from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { deflate } from './tiff-codec';

export type GeoTiffCompression = 'deflate' | 'none';
export type GeoTiffSampleWidth = 'auto' | 'float32' | 'float64' | 'int16' | 'int32' | 'uint8' | 'uint16';

export interface WriteGeoTiffOptions {
  compression: GeoTiffCompression;
  /** 'auto' picks the narrowest type that holds every value without loss. */
  sampleWidth: GeoTiffSampleWidth;
  /** Rows per strip. Smaller strips cost tags; larger ones cost memory. */
  rowsPerStrip: number;
}

export const DEFAULT_GEOTIFF_OPTIONS: WriteGeoTiffOptions = {
  compression: 'deflate',
  sampleWidth: 'auto',
  rowsPerStrip: 64,
};

const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planarConfiguration: 284,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  geoKeyDirectory: 34735,
  geoAsciiParams: 34737,
  gdalNoData: 42113,
} as const;

const TYPE = { short: 3, long: 4, double: 12, ascii: 2 } as const;

interface Field {
  tag: number;
  type: number;
  values: number[] | string;
}

interface SampleLayout {
  bits: number;
  /** TIFF SampleFormat: 1 unsigned, 2 signed, 3 IEEE float. */
  format: 1 | 2 | 3;
  write: (view: DataView, at: number, value: number) => void;
  name: string;
}

const LAYOUTS: Record<Exclude<GeoTiffSampleWidth, 'auto'>, SampleLayout> = {
  uint8: { bits: 8, format: 1, name: 'uint8', write: (view, at, value) => view.setUint8(at, clamp(value, 0, 255)) },
  uint16: { bits: 16, format: 1, name: 'uint16', write: (view, at, value) => view.setUint16(at, clamp(value, 0, 65535), true) },
  int16: { bits: 16, format: 2, name: 'int16', write: (view, at, value) => view.setInt16(at, clamp(value, -32768, 32767), true) },
  int32: { bits: 32, format: 2, name: 'int32', write: (view, at, value) => view.setInt32(at, clamp(value, -2147483648, 2147483647), true) },
  float32: { bits: 32, format: 3, name: 'float32', write: (view, at, value) => view.setFloat32(at, value, true) },
  float64: { bits: 64, format: 3, name: 'float64', write: (view, at, value) => view.setFloat64(at, value, true) },
};

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, Math.round(value)));
}

/**
 * Picks the narrowest type that stores every value exactly.
 *
 * Elevation is the case that matters. A DEM in float64 doubles the file size
 * for precision no survey instrument produces, but demoting it to int16 would
 * silently round every height to the metre — so the choice is made from the
 * data: integers stay integers, anything fractional becomes float32, and
 * values beyond float32's exact range keep float64.
 */
export function chooseSampleLayout(bands: Float64Array[], noData: number | null): SampleLayout {
  let allIntegers = true;
  let min = Infinity;
  let max = -Infinity;
  let needsFloat64 = false;

  for (const band of bands) {
    for (let index = 0; index < band.length; index++) {
      const value = band[index];
      if (!Number.isFinite(value)) {
        needsFloat64 = true;
        allIntegers = false;
        continue;
      }
      if (!Number.isInteger(value)) {
        allIntegers = false;
        // float32 has 24 bits of mantissa; beyond that a round trip loses
        // digits a surveyor would notice on a coordinate-like value.
        if (Math.abs(value) > 3.4e38 || (value !== 0 && Math.fround(value) !== value && Math.abs(value) > 1e7)) needsFloat64 = true;
      }
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (noData !== null) {
    if (noData < min) min = noData;
    if (noData > max) max = noData;
    if (!Number.isInteger(noData)) allIntegers = false;
  }

  if (!Number.isFinite(min)) return LAYOUTS.float32;
  if (!allIntegers) return needsFloat64 ? LAYOUTS.float64 : LAYOUTS.float32;
  if (min >= 0 && max <= 255) return LAYOUTS.uint8;
  if (min >= 0 && max <= 65535) return LAYOUTS.uint16;
  if (min >= -32768 && max <= 32767) return LAYOUTS.int16;
  if (min >= -2147483648 && max <= 2147483647) return LAYOUTS.int32;
  return LAYOUTS.float64;
}

/**
 * The minimal GeoKeyDirectory: model type, raster type and the EPSG code.
 *
 * Entries are 4 shorts and must be sorted by key id, which is why they are
 * built as a list and sorted rather than appended in the order they occur to a
 * reader of the spec.
 */
function buildGeoKeys(crs: CrsRef | null): { keys: number[]; ascii: string } {
  const entries: [number, number, number, number][] = [];
  const epsg = crs?.epsg ? Number(crs.epsg) : null;
  const projected = crs?.kind === 'projected';

  // 1024 GTModelTypeGeoKey: 1 projected, 2 geographic.
  entries.push([1024, 0, 1, projected ? 1 : 2]);
  // 1025 GTRasterTypeGeoKey: 1 = PixelIsArea, which is what a geotransform
  // describing pixel corners means.
  entries.push([1025, 0, 1, 1]);
  if (epsg) {
    if (projected) entries.push([3072, 0, 1, epsg]);
    else entries.push([2048, 0, 1, epsg]);
  }

  const ascii = crs?.name ? `${crs.name}|` : '';
  if (ascii) entries.push([projected ? 3073 : 2049, TAG.geoAsciiParams, ascii.length, 0]);

  entries.sort((left, right) => left[0] - right[0]);
  const keys = [1, 1, 0, entries.length];
  for (const entry of entries) keys.push(...entry);
  return { keys, ascii };
}

export async function writeGeoTiff(
  dataset: CirDataset,
  options: WriteGeoTiffOptions = DEFAULT_GEOTIFF_OPTIONS
): Promise<{ bytes: Uint8Array; warnings: Warning[] }> {
  const raster = dataset.raster;
  const warnings: Warning[] = [];

  if (!raster) {
    throw new ConversionError({
      code: 'TIFF_NO_RASTER',
      what: 'The dataset holds no raster to write.',
      why: 'GeoTIFF output needs pixel values; this dataset is vector, point-cloud or table only.',
      action: 'Pick a vector or table target instead — GeoJSON, DXF, Shapefile and CSV all accept this data.',
    });
  }
  if (!raster.hasPixelData || !raster.bands || raster.bands.length === 0) {
    throw new ConversionError({
      code: 'TIFF_NO_PIXEL_DATA',
      what: 'The source raster carries georeference and structure but no decoded pixel values.',
      why: 'Writing a GeoTIFF from it would mean inventing every pixel, which this tool will not do.',
      action: 'Export the footprint as vector instead, or supply a raster whose pixels can be read.',
    });
  }
  if (!raster.geotransform) {
    throw new ConversionError({
      code: 'TIFF_NO_GEOREFERENCE',
      what: 'The raster has no georeference, so no GeoTIFF can be written.',
      why: 'A GeoTIFF without model tags is just a TIFF; writing one would silently discard the fact that this data has no known ground position.',
      action: 'Georeference the source first, or export it as a plain image with a separate world file.',
    });
  }

  const { width, height, bands } = { width: raster.width, height: raster.height, bands: raster.bands };
  const layout = options.sampleWidth === 'auto' ? chooseSampleLayout(bands, raster.noData) : LAYOUTS[options.sampleWidth];
  const bandCount = bands.length;
  const bytesPerSample = layout.bits / 8;
  const rowsPerStrip = Math.max(1, Math.min(options.rowsPerStrip, height));
  const stripCount = Math.ceil(height / rowsPerStrip);

  reportPrecisionLoss(bands, raster.noData, layout, warnings);

  // Encode strips first: their compressed sizes decide the byte offsets that go
  // into the IFD, so the header cannot be laid out until they are known.
  const strips: Uint8Array[] = [];
  for (let strip = 0; strip < stripCount; strip++) {
    const firstRow = strip * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - firstRow);
    const raw = new Uint8Array(rows * width * bandCount * bytesPerSample);
    const view = new DataView(raw.buffer);
    let at = 0;
    for (let row = 0; row < rows; row++) {
      const rowStart = (firstRow + row) * width;
      for (let column = 0; column < width; column++) {
        for (let band = 0; band < bandCount; band++) {
          layout.write(view, at, bands[band][rowStart + column]);
          at += bytesPerSample;
        }
      }
    }
    strips.push(options.compression === 'deflate' ? await deflate(raw) : raw);
  }

  const geotransform = raster.geotransform;
  if (geotransform[2] !== 0 || geotransform[4] !== 0) {
    warnings.push(
      warn('TIFF_ROTATION_DROPPED', 'The source georeference includes rotation terms, which were not written.', {
        reason: 'This writer emits ModelPixelScale and ModelTiepoint, which describe an axis-aligned raster only.',
        action: 'Reproject or rectify the raster first if the rotation matters. The pixel values themselves are unchanged.',
        detail: { rowRotation: geotransform[2], columnRotation: geotransform[4] },
      })
    );
  }

  const { keys, ascii } = buildGeoKeys(dataset.crs);
  if (!dataset.crs?.epsg) {
    warnings.push(
      warn('TIFF_NO_EPSG', 'The GeoTIFF was written without an EPSG code.', {
        reason: dataset.crs
          ? `The source CRS "${dataset.crs.name}" has no EPSG code in the bundled list, and inventing one would assert a projection this data may not use.`
          : 'The source declares no coordinate reference system.',
        action: 'Select a target CRS before converting if the output needs to carry one, or supply the .prj alongside.',
      })
    );
  }

  const fields: Field[] = [
    { tag: TAG.imageWidth, type: TYPE.long, values: [width] },
    { tag: TAG.imageLength, type: TYPE.long, values: [height] },
    { tag: TAG.bitsPerSample, type: TYPE.short, values: new Array(bandCount).fill(layout.bits) },
    { tag: TAG.compression, type: TYPE.short, values: [options.compression === 'deflate' ? 8 : 1] },
    // 1 = BlackIsZero. A single-band elevation or a multi-band stack both read
    // correctly under it; declaring RGB for three bands would be a guess.
    { tag: TAG.photometric, type: TYPE.short, values: [1] },
    { tag: TAG.stripOffsets, type: TYPE.long, values: new Array(stripCount).fill(0) },
    { tag: TAG.samplesPerPixel, type: TYPE.short, values: [bandCount] },
    { tag: TAG.rowsPerStrip, type: TYPE.long, values: [rowsPerStrip] },
    { tag: TAG.stripByteCounts, type: TYPE.long, values: strips.map((strip) => strip.length) },
    { tag: TAG.planarConfiguration, type: TYPE.short, values: [1] },
    { tag: TAG.sampleFormat, type: TYPE.short, values: new Array(bandCount).fill(layout.format) },
    { tag: TAG.modelPixelScale, type: TYPE.double, values: [Math.abs(geotransform[1]), Math.abs(geotransform[5]), 0] },
    { tag: TAG.modelTiepoint, type: TYPE.double, values: [0, 0, 0, geotransform[0], geotransform[3], 0] },
    { tag: TAG.geoKeyDirectory, type: TYPE.short, values: keys },
  ];
  if (ascii) fields.push({ tag: TAG.geoAsciiParams, type: TYPE.ascii, values: ascii });
  if (raster.noData !== null) fields.push({ tag: TAG.gdalNoData, type: TYPE.ascii, values: `${raster.noData}\0` });

  fields.sort((left, right) => left.tag - right.tag);
  return { bytes: assemble(fields, strips, TAG.stripOffsets), warnings };
}

const TYPE_SIZE: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };

/**
 * Lays out header, IFD, out-of-line values and strip data.
 *
 * TIFF puts any value larger than four bytes outside the IFD entry, so the
 * layout has to be computed in two passes: sizes first to fix every offset,
 * then the writes. `offsetsTag` is patched last, once the strips have landed.
 */
function assemble(fields: Field[], strips: Uint8Array[], offsetsTag: number): Uint8Array {
  const headerSize = 8;
  const ifdSize = 2 + fields.length * 12 + 4;
  let externalSize = 0;
  const externalAt = new Map<number, number>();

  for (const field of fields) {
    const count = typeof field.values === 'string' ? field.values.length : field.values.length;
    const bytes = count * (TYPE_SIZE[field.type] ?? 1);
    if (bytes > 4) {
      externalAt.set(field.tag, headerSize + ifdSize + externalSize);
      // Values must begin on a word boundary.
      externalSize += bytes + (bytes % 2);
    }
  }

  const stripStart = headerSize + ifdSize + externalSize;
  const stripTotal = strips.reduce((sum, strip) => sum + strip.length, 0);
  const out = new Uint8Array(stripStart + stripTotal);
  const view = new DataView(out.buffer);

  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, headerSize, true);

  // Strip offsets are only knowable now, so fill them in before the IFD is written.
  const stripOffsets: number[] = [];
  let at = stripStart;
  for (const strip of strips) {
    stripOffsets.push(at);
    out.set(strip, at);
    at += strip.length;
  }
  const offsetsField = fields.find((field) => field.tag === offsetsTag);
  if (offsetsField) offsetsField.values = stripOffsets;

  view.setUint16(headerSize, fields.length, true);
  fields.forEach((field, index) => {
    const entryAt = headerSize + 2 + index * 12;
    const count = typeof field.values === 'string' ? field.values.length : field.values.length;
    view.setUint16(entryAt, field.tag, true);
    view.setUint16(entryAt + 2, field.type, true);
    view.setUint32(entryAt + 4, count, true);

    const bytes = count * (TYPE_SIZE[field.type] ?? 1);
    const target = bytes > 4 ? externalAt.get(field.tag)! : entryAt + 8;
    if (bytes > 4) view.setUint32(entryAt + 8, target, true);
    writeValues(view, out, target, field);
  });
  view.setUint32(headerSize + 2 + fields.length * 12, 0, true);

  return out;
}

function writeValues(view: DataView, out: Uint8Array, at: number, field: Field): void {
  if (typeof field.values === 'string') {
    for (let index = 0; index < field.values.length; index++) out[at + index] = field.values.charCodeAt(index) & 0xff;
    return;
  }
  field.values.forEach((value, index) => {
    switch (field.type) {
      case TYPE.short:
        view.setUint16(at + index * 2, value, true);
        break;
      case TYPE.long:
        view.setUint32(at + index * 4, value, true);
        break;
      case TYPE.double:
        view.setFloat64(at + index * 8, value, true);
        break;
      default:
        out[at + index] = value & 0xff;
        break;
    }
  });
}

/**
 * Warns when the chosen sample type cannot hold the data exactly.
 *
 * Only reachable when the user overrides the type: 'auto' picks a lossless one.
 * Rule R3 — silent loss is the thing this whole tool exists to avoid — so the
 * count of affected pixels is reported rather than a vague "some values".
 */
function reportPrecisionLoss(bands: Float64Array[], noData: number | null, layout: SampleLayout, warnings: Warning[]): void {
  if (layout.format === 3 && layout.bits === 64) return;

  let clamped = 0;
  let rounded = 0;
  const low = layout.format === 3 ? -3.4e38 : layout.format === 2 ? -(2 ** (layout.bits - 1)) : 0;
  const high = layout.format === 3 ? 3.4e38 : layout.format === 2 ? 2 ** (layout.bits - 1) - 1 : 2 ** layout.bits - 1;

  for (const band of bands) {
    for (let index = 0; index < band.length; index++) {
      const value = band[index];
      if (!Number.isFinite(value)) continue;
      if (noData !== null && value === noData) continue;
      if (value < low || value > high) clamped++;
      else if (layout.format !== 3 && !Number.isInteger(value)) rounded++;
      else if (layout.format === 3 && layout.bits === 32 && Math.fround(value) !== value) rounded++;
    }
  }

  if (clamped > 0) {
    warnings.push(
      warn('TIFF_VALUES_CLAMPED', `${clamped.toLocaleString()} pixel values fall outside the range of the chosen ${layout.name} sample type and were clamped.`, {
        severity: 'error',
        reason: `${layout.name} holds values from ${low} to ${high}; the raster contains values beyond that.`,
        action: 'Choose float32 or float64 as the sample width, or leave it on automatic so the type is picked from the data.',
        count: clamped,
      })
    );
  }
  if (rounded > 0) {
    warnings.push(
      warn('TIFF_VALUES_ROUNDED', `${rounded.toLocaleString()} pixel values lost precision in the chosen ${layout.name} sample type.`, {
        reason: layout.format === 3 ? 'float32 carries about seven significant digits; these values need more.' : `${layout.name} stores whole numbers only, and these values are fractional.`,
        action: 'Choose float64 as the sample width, or leave it on automatic.',
        count: rounded,
      })
    );
  }
}
