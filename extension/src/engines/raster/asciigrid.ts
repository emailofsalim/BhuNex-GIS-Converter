/**
 * ESRI ASCII Grid (.asc) — the working DEM path.
 *
 * Header, then a row-major value matrix written north to south. Values
 * round-trip exactly, which is why the DEM regression test runs here rather
 * than against GeoTIFF (whose pixel codec is not bundled).
 *
 * The xllcorner/xllcenter distinction is handled explicitly: they differ by half
 * a cell, and treating one as the other shifts an entire terrain model.
 */

import {
  createDataset,
  warn,
  type CirDataset,
  type CirRaster,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { formatFixed, type PrecisionPolicy } from '../../core/precision';
import { parsePrj } from '../../crs/wkt';
import { decodeText } from '../shared';

export interface AsciiGridHeader {
  ncols: number;
  nrows: number;
  /** Always the corner form internally; a center header is converted on read. */
  xllcorner: number;
  yllcorner: number;
  cellsize: number;
  nodata: number;
  /** True when the source declared cell centres rather than corners. */
  centerReferenced: boolean;
}

const HEADER_KEYS = new Set(['ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter', 'yllcenter', 'cellsize', 'nodata_value', 'dx', 'dy']);

export function readAsciiGrid(bytes: Uint8Array, source: SourceInfo, prjText?: string): CirDataset {
  const text = decodeText(bytes);
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  const header: Partial<AsciiGridHeader> & { dx?: number; dy?: number } = {};
  let cursor = 0;
  let centerReferenced = false;

  while (cursor + 1 < tokens.length) {
    const key = tokens[cursor].toLowerCase();
    if (!HEADER_KEYS.has(key)) break;
    const value = Number(tokens[cursor + 1]);
    switch (key) {
      case 'ncols':
        header.ncols = value;
        break;
      case 'nrows':
        header.nrows = value;
        break;
      case 'xllcorner':
        header.xllcorner = value;
        break;
      case 'yllcorner':
        header.yllcorner = value;
        break;
      case 'xllcenter':
        header.xllcorner = value;
        centerReferenced = true;
        break;
      case 'yllcenter':
        header.yllcorner = value;
        centerReferenced = true;
        break;
      case 'cellsize':
        header.cellsize = value;
        break;
      case 'nodata_value':
        header.nodata = value;
        break;
      case 'dx':
        header.dx = value;
        break;
      case 'dy':
        header.dy = value;
        break;
      default:
        break;
    }
    cursor += 2;
  }

  if (!header.ncols || !header.nrows) {
    throw new ConversionError({
      code: 'ASC_NO_HEADER',
      what: 'The grid header is missing ncols or nrows.',
      why: 'An ESRI ASCII grid begins with ncols, nrows, an origin, a cell size and an optional NODATA_value.',
      action: 'Confirm the detected format in the inspector — this may be a plain coordinate list.',
    });
  }
  const cellsize = header.cellsize ?? header.dx;
  if (!cellsize) {
    throw new ConversionError({
      code: 'ASC_NO_CELLSIZE',
      what: 'The grid header declares no cellsize.',
      why: 'Without a cell size the grid has no ground scale and cannot be georeferenced.',
      action: 'Add a cellsize line to the header, or re-export the DEM from your GIS.',
    });
  }
  if (header.dx && header.dy && Math.abs(header.dx - header.dy) > 1e-12) {
    // Non-square cells are legal in the GRASS variant but not in ESRI's.
    throw new ConversionError({
      code: 'ASC_NON_SQUARE_CELLS',
      what: `The grid declares non-square cells (dx ${header.dx}, dy ${header.dy}).`,
      why: 'The ESRI ASCII grid format assumes square cells; a single cellsize cannot describe this raster.',
      action: 'Resample the raster to square cells in QGIS or GDAL before converting.',
    });
  }

  const ncols = header.ncols;
  const nrows = header.nrows;
  const expected = ncols * nrows;
  const values = new Float64Array(expected);
  const nodata = header.nodata ?? -9999;
  const warnings: Warning[] = [];

  let read = 0;
  let min = Infinity;
  let max = -Infinity;
  for (; cursor < tokens.length && read < expected; cursor++) {
    const value = Number(tokens[cursor]);
    if (!Number.isFinite(value)) continue;
    values[read++] = value;
    if (value !== nodata) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (read < expected) {
    warnings.push(
      warn('ASC_TRUNCATED', `The header declares ${expected.toLocaleString()} cells but only ${read.toLocaleString()} values were present.`, {
        severity: 'error',
        reason: 'The file is truncated. Missing cells were filled with the NODATA value rather than with invented elevations.',
        action: 'Re-export the grid; the missing rows do not exist in this file.',
      })
    );
    values.fill(nodata, read);
  }

  // A center-referenced header names the centre of the lower-left cell, half a
  // cell in from the corner the geotransform needs.
  const originX = centerReferenced ? header.xllcorner! - cellsize / 2 : header.xllcorner ?? 0;
  const originY = centerReferenced ? header.yllcorner! - cellsize / 2 : header.yllcorner ?? 0;
  const topY = originY + nrows * cellsize;

  const raster: CirRaster = {
    width: ncols,
    height: nrows,
    bandCount: 1,
    pixelType: 'float64',
    noData: nodata,
    // GDAL order, with a negative north-south pixel size: rows run north to south.
    geotransform: [originX, cellsize, 0, topY, 0, -cellsize],
    extent: { minX: originX, minY: originY, maxX: originX + ncols * cellsize, maxY: topY },
    statistics: Number.isFinite(min) ? [{ min, max }] : undefined,
    bands: [values],
    hasPixelData: true,
    isElevation: true,
  };

  const prj = prjText ? parsePrj(prjText) : null;
  if (!prj?.crs) {
    warnings.push(
      warn('ASC_NO_CRS', 'The grid declares no coordinate reference system.', {
        reason: 'An ESRI ASCII grid stores its CRS in a separate .prj file.',
        action: 'Add the matching .prj file, or select the source CRS before converting.',
      })
    );
  }

  return createDataset({
    kind: 'raster',
    name: source.fileName,
    source,
    crs: prj?.crs ?? null,
    crsOrigin: prj?.crs ? 'sidecar' : 'unknown',
    units: prj?.crs?.kind === 'projected' ? 'm' : null,
    axisOrder: 'xy',
    vertical: { kind: 'unknown' },
    layers: [],
    raster,
    warnings,
    metadata: { ncols, nrows, cellsize, nodata, centerReferenced },
  });
}

export interface WriteAsciiGridOptions {
  precision: PrecisionPolicy;
  /** Write xllcenter/yllcenter instead of the corner form. */
  centerReferenced?: boolean;
  nodata?: number;
}

export function writeAsciiGrid(dataset: CirDataset, options: WriteAsciiGridOptions): { text: string; warnings: Warning[] } {
  const raster = dataset.raster;
  const warnings: Warning[] = [];
  if (!raster) {
    throw new ConversionError({
      code: 'ASC_NO_RASTER',
      what: 'The dataset holds no raster to write.',
      why: 'ASCII Grid output needs pixel values; this dataset is vector, point-cloud or table only.',
      action: 'Pick a vector or table target instead.',
    });
  }
  if (!raster.hasPixelData || !raster.bands || raster.bands.length === 0) {
    throw new ConversionError({
      code: 'ASC_NO_PIXEL_DATA',
      what: 'The source raster carries georeference and structure but no decoded pixel values.',
      why: 'The source was read metadata-only — GeoTIFF pixel decoding is not bundled — so there are no elevations to write.',
      action: 'Convert the source to ASCII Grid or GeoTIFF-uncompressed in QGIS or GDAL first, then bring it here.',
    });
  }
  if (!raster.geotransform) {
    throw new ConversionError({
      code: 'ASC_NO_GEOTRANSFORM',
      what: 'The raster has no georeference.',
      why: 'An ASCII grid header must state an origin and a cell size; inventing them would place the terrain somewhere arbitrary.',
      action: 'Add a world file or a georeferenced source, then convert again.',
    });
  }

  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = raster.geotransform;
  if (Math.abs(rowRotation) > 1e-12 || Math.abs(columnRotation) > 1e-12) {
    throw new ConversionError({
      code: 'ASC_ROTATED_RASTER',
      what: 'The raster is rotated.',
      why: 'The geotransform carries rotation terms, and an ESRI ASCII grid is always axis-aligned.',
      action: 'Rectify the raster in QGIS or GDAL (gdalwarp) before converting.',
    });
  }
  if (Math.abs(Math.abs(pixelWidth) - Math.abs(pixelHeight)) > 1e-9) {
    warnings.push(
      warn('ASC_NON_SQUARE_CELLS', `Cell size differs between axes (${Math.abs(pixelWidth)} × ${Math.abs(pixelHeight)}); the X size was written.`, {
        reason: 'The ASCII grid header has a single cellsize field.',
        action: 'Resample to square cells if the vertical scale matters.',
      })
    );
  }

  const nodata = options.nodata ?? raster.noData ?? -9999;
  const decimals = options.precision.mode === 'full' ? 6 : options.precision.elevationDecimals;
  const cellsize = Math.abs(pixelWidth);
  const bottomY = originY - raster.height * Math.abs(pixelHeight);

  const lines: string[] = [
    `ncols         ${raster.width}`,
    `nrows         ${raster.height}`,
    options.centerReferenced ? `xllcenter     ${formatFixed(originX + cellsize / 2, 6)}` : `xllcorner     ${formatFixed(originX, 6)}`,
    options.centerReferenced ? `yllcenter     ${formatFixed(bottomY + cellsize / 2, 6)}` : `yllcorner     ${formatFixed(bottomY, 6)}`,
    `cellsize      ${formatFixed(cellsize, 10)}`,
    `NODATA_value  ${nodata}`,
  ];

  const band = raster.bands[0];
  if (raster.bandCount > 1) {
    warnings.push(
      warn('ASC_SINGLE_BAND', `Only band 1 of ${raster.bandCount} was written.`, {
        reason: 'An ESRI ASCII grid holds a single band.',
        action: 'Convert each band separately, or export to GeoTIFF once a raster codec is available.',
      })
    );
  }

  const row: string[] = new Array(raster.width);
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const value = band[y * raster.width + x];
      row[x] = value === nodata || !Number.isFinite(value) ? String(nodata) : formatFixed(value, decimals);
    }
    lines.push(row.join(' '));
  }

  return { text: lines.join('\n') + '\n', warnings };
}
