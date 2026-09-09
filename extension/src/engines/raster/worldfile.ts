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
import { fitGcps } from '../../core/georeference';
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
 * DELEGATES to `core/georeference.ts`, which does the same arithmetic — normal
 * equations, Gaussian elimination with partial pivoting, three unknowns per
 * axis. Two copies of that lived here and there for a while, and the audit
 * found this one dead: nothing called it, not even this module.
 *
 * A dead duplicate of geodetic maths is the worse half of the problem, not the
 * better one. Whoever eventually needed it would have got an implementation
 * nobody had exercised, and a fix applied to one copy would have left the other
 * quietly wrong. One implementation, exercised by the backdrop georeferencer on
 * every use, is what makes the answer trustworthy here too.
 *
 * The conversion is a reordering: this returns a GDAL geotransform,
 * `[c, a, b, f, d, e]`, while the fitter returns the coefficients by name.
 */
export function affineFromGcps(gcps: Gcp[]): { geotransform: Geotransform; residual: number } {
  const usable = gcps.filter((gcp) => gcp.enabled);
  const { fit, refusal } = fitGcps(
    usable.map((gcp) => ({
      pixel: { u: gcp.pixelX, v: gcp.pixelY },
      ground: [gcp.mapX, gcp.mapY],
      name: gcp.id,
    }))
  );

  // An affine needs three; the fitter accepts two and produces a SIMILARITY,
  // which is a different and weaker transform. A world file records six
  // coefficients, so accepting a similarity here would write a file claiming
  // an affine fit that was never made.
  if (refusal || !fit || fit.kind !== 'affine') {
    throw new ConversionError({
      code: usable.length < 3 ? 'GCP_TOO_FEW' : 'GCP_COLLINEAR',
      what:
        usable.length < 3
          ? `Only ${usable.length} enabled control point(s) are available.`
          : 'The control points do not define an affine transform.',
      why:
        refusal?.why ??
        (usable.length < 3
          ? 'An affine transform has six unknowns and needs at least three non-collinear points.'
          : 'They are collinear or coincident, so the normal equations are singular.'),
      action: refusal?.action ?? 'Spread the control points across the image, avoiding a single line.',
    });
  }

  const { a, b, c, d, e, f } = fit.affine;
  return { geotransform: [c, a, b, f, d, e], residual: fit.rms };
}
