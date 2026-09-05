/**
 * World files (.tfw, .jgw, .pgw, .wld, .gfw, .bpw) and QGIS GCP .points.
 *
 * A world file is six numbers describing the affine transform from pixel to
 * ground coordinates. The catch that trips most implementations: lines 5 and 6
 * give the ground coordinate of the **centre of the top-left pixel**, while a
 * GDAL geotransform uses its top-left **corner**. The half-pixel shift between
 * them is applied here, once, in both directions.
 */

import { warn, type Warning } from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { formatFixed } from '../../core/precision';

export interface WorldFileTerms {
  /** Pixel size in the x direction. */
  a: number;
  /** Rotation about the y axis. */
  d: number;
  /** Rotation about the x axis. */
  b: number;
  /** Pixel size in the y direction, normally negative. */
  e: number;
  /** X of the centre of the top-left pixel. */
  c: number;
  /** Y of the centre of the top-left pixel. */
  f: number;
}

export type Geotransform = [number, number, number, number, number, number];

export function parseWorldFile(text: string): WorldFileTerms {
  const values = text
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value));
  if (values.length < 6) {
    throw new ConversionError({
      code: 'WORLDFILE_INCOMPLETE',
      what: `The world file holds ${values.length} numeric line(s); six are required.`,
      why: 'A world file is exactly six numbers: x pixel size, y rotation, x rotation, y pixel size, and the ground coordinates of the top-left pixel centre.',
      action: 'Re-export the world file from your GIS, or write the six values by hand.',
    });
  }
  const [a, d, b, e, c, f] = values;
  if (a === 0 || e === 0) {
    throw new ConversionError({
      code: 'WORLDFILE_ZERO_PIXEL_SIZE',
      what: 'The world file declares a zero pixel size.',
      why: `Line 1 (x size) is ${a} and line 4 (y size) is ${e}; a zero collapses the image to no ground extent.`,
      action: 'Correct the world file — the pixel size must be non-zero.',
    });
  }
  return { a, d, b, e, c, f };
}

/** World-file terms to a GDAL geotransform, shifting the origin by half a pixel. */
export function worldFileToGeotransform(terms: WorldFileTerms): Geotransform {
  return [terms.c - terms.a / 2 - terms.b / 2, terms.a, terms.b, terms.f - terms.d / 2 - terms.e / 2, terms.d, terms.e];
}

export function geotransformToWorldFile(geotransform: Geotransform): WorldFileTerms {
  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = geotransform;
  return {
    a: pixelWidth,
    d: columnRotation,
    b: rowRotation,
    e: pixelHeight,
    c: originX + pixelWidth / 2 + rowRotation / 2,
    f: originY + columnRotation / 2 + pixelHeight / 2,
  };
}

export function buildWorldFile(geotransform: Geotransform, decimals = 10): string {
  const terms = geotransformToWorldFile(geotransform);
  return [terms.a, terms.d, terms.b, terms.e, terms.c, terms.f].map((value) => formatFixed(value, decimals)).join('\n') + '\n';
}

/** World-file extension for an image extension: first and last letter plus 'w'. */
export function worldFileExtensionFor(imageExtension: string): string {
  const known: Record<string, string> = {
    tif: 'tfw',
    tiff: 'tfw',
    jpg: 'jgw',
    jpeg: 'jgw',
    png: 'pgw',
    gif: 'gfw',
    bmp: 'bpw',
  };
  const key = imageExtension.toLowerCase().replace(/^\./, '');
  if (known[key]) return known[key];
  return key.length >= 2 ? `${key[0]}${key[key.length - 1]}w` : 'wld';
}

export interface Gcp {
  pixelX: number;
  pixelY: number;
  mapX: number;
  mapY: number;
  enabled: boolean;
  id?: string;
}

/**
 * QGIS ground-control-point files.
 *
 * Header: `mapX,mapY,pixelX,pixelY,enable[,dX,dY,residual]`. Note that QGIS
 * writes pixelY as a negative number measured downward from the top-left, which
 * is why the sign is normalised here rather than at each call site.
 */
export function readGcpPoints(text: string): { gcps: Gcp[]; warnings: Warning[] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    throw new ConversionError({
      code: 'GCP_EMPTY',
      what: 'The GCP file is empty.',
      why: 'No lines were found.',
      action: 'Re-export the control points from the QGIS Georeferencer.',
    });
  }

  const warnings: Warning[] = [];
  const header = lines[0].toLowerCase();
  const hasHeader = header.includes('mapx') || header.includes('pixelx');
  const columns = hasHeader ? header.split(',').map((cell) => cell.trim().replace(/^#\s*/, '')) : ['mapx', 'mapy', 'pixelx', 'pixely', 'enable'];
  const indexOf = (name: string) => columns.findIndex((column) => column === name);

  const mapXIndex = indexOf('mapx');
  const mapYIndex = indexOf('mapy');
  const pixelXIndex = indexOf('pixelx');
  const pixelYIndex = indexOf('pixely');
  const enableIndex = indexOf('enable');

  const gcps: Gcp[] = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    if (line.trim().startsWith('#')) continue;
    const cells = line.split(',').map((cell) => cell.trim());
    const mapX = Number(cells[mapXIndex >= 0 ? mapXIndex : 0]);
    const mapY = Number(cells[mapYIndex >= 0 ? mapYIndex : 1]);
    const pixelX = Number(cells[pixelXIndex >= 0 ? pixelXIndex : 2]);
    const pixelY = Number(cells[pixelYIndex >= 0 ? pixelYIndex : 3]);
    if (![mapX, mapY, pixelX, pixelY].every(Number.isFinite)) continue;
    const enableCell = enableIndex >= 0 ? cells[enableIndex] : '1';
    gcps.push({
      mapX,
      mapY,
      pixelX,
      // QGIS stores pixelY negative, downward from the top-left corner.
      pixelY: Math.abs(pixelY),
      enabled: enableCell !== '0' && enableCell.toLowerCase() !== 'false',
    });
  }

  if (gcps.length === 0) {
    throw new ConversionError({
      code: 'GCP_NO_POINTS',
      what: 'No usable control points were read.',
      why: `${lines.length} line(s) were present but none held four finite numbers.`,
      action: 'Check the file — it should have mapX, mapY, pixelX and pixelY columns.',
    });
  }
  const disabled = gcps.filter((gcp) => !gcp.enabled).length;
  if (disabled > 0) {
    warnings.push(
      warn('GCP_DISABLED_POINTS', `${disabled} of ${gcps.length} control point(s) are marked disabled.`, {
        severity: 'info',
        count: disabled,
        reason: 'The QGIS Georeferencer excludes disabled points from its transform.',
        action: 'Re-enable them in QGIS if they should contribute.',
      })
    );
  }

  return { gcps, warnings };
}

export function writeGcpPoints(gcps: Gcp[]): string {
  const lines = ['mapX,mapY,pixelX,pixelY,enable'];
  for (const gcp of gcps) {
    lines.push(
      [
        formatFixed(gcp.mapX, 6),
        formatFixed(gcp.mapY, 6),
        formatFixed(gcp.pixelX, 4),
        // Written back in QGIS's downward-negative convention.
        formatFixed(-Math.abs(gcp.pixelY), 4),
        gcp.enabled ? '1' : '0',
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Least-squares affine fit through the enabled control points.
 *
 * Three points define an affine transform exactly; more are fitted. Fewer cannot
 * be solved, and guessing one would georeference the image to nowhere in
 * particular.
 */
export function affineFromGcps(gcps: Gcp[]): { geotransform: Geotransform; residual: number } {
  const usable = gcps.filter((gcp) => gcp.enabled);
  if (usable.length < 3) {
    throw new ConversionError({
      code: 'GCP_TOO_FEW',
      what: `Only ${usable.length} enabled control point(s) are available.`,
      why: 'An affine transform has six unknowns and needs at least three non-collinear points.',
      action: 'Add more control points in the QGIS Georeferencer, or supply a world file instead.',
    });
  }

  // Solve the normal equations for [a b c] and [d e f] separately; both share
  // the same design matrix, so it is accumulated once.
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  let sumU = 0;
  let sumV = 0;
  let sumXU = 0;
  let sumYU = 0;
  let sumXV = 0;
  let sumYV = 0;
  const n = usable.length;

  for (const gcp of usable) {
    const x = gcp.pixelX;
    const y = gcp.pixelY;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
    sumYY += y * y;
    sumU += gcp.mapX;
    sumV += gcp.mapY;
    sumXU += x * gcp.mapX;
    sumYU += y * gcp.mapX;
    sumXV += x * gcp.mapY;
    sumYV += y * gcp.mapY;
  }

  const solve = (rhs: [number, number, number]): [number, number, number] => {
    const matrix: number[][] = [
      [sumXX, sumXY, sumX, rhs[0]],
      [sumXY, sumYY, sumY, rhs[1]],
      [sumX, sumY, n, rhs[2]],
    ];
    // Gaussian elimination with partial pivoting — three unknowns, so the cost
    // is negligible and the stability is worth it for near-collinear points.
    for (let column = 0; column < 3; column++) {
      let pivot = column;
      for (let row = column + 1; row < 3; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
      if (Math.abs(matrix[pivot][column]) < 1e-12) {
        throw new ConversionError({
          code: 'GCP_COLLINEAR',
          what: 'The control points do not define an affine transform.',
          why: 'They are collinear or coincident, so the normal equations are singular.',
          action: 'Spread the control points across the image, avoiding a single line.',
        });
      }
      [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
      for (let row = column + 1; row < 3; row++) {
        const factor = matrix[row][column] / matrix[column][column];
        for (let k = column; k < 4; k++) matrix[row][k] -= factor * matrix[column][k];
      }
    }
    const solution: [number, number, number] = [0, 0, 0];
    for (let row = 2; row >= 0; row--) {
      let value = matrix[row][3];
      for (let column = row + 1; column < 3; column++) value -= matrix[row][column] * solution[column];
      solution[row] = value / matrix[row][row];
    }
    return solution;
  };

  const [a, b, c] = solve([sumXU, sumYU, sumU]);
  const [d, e, f] = solve([sumXV, sumYV, sumV]);

  let residual = 0;
  for (const gcp of usable) {
    const predictedX = a * gcp.pixelX + b * gcp.pixelY + c;
    const predictedY = d * gcp.pixelX + e * gcp.pixelY + f;
    residual += (predictedX - gcp.mapX) ** 2 + (predictedY - gcp.mapY) ** 2;
  }

  return { geotransform: [c, a, b, f, d, e], residual: Math.sqrt(residual / usable.length) };
}
