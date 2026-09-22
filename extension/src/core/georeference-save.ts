/**
 * Saving a georeference someone has just made (spec §28.3).
 *
 * WHY THIS EXISTS
 *
 * The backdrop panel could already do the hard half: load a scanned sheet or a
 * PDF page, place ground control points on it, fit an affine or a similarity,
 * and report the residual at every point. Then the panel's own opening
 * sentence said what happened next —
 *
 *   "It is a reference to trace from — it is never converted, never exported,
 *    and never leaves this machine."
 *
 * — so a surveyor who georeferenced a cadastral sheet against four known
 * corners could look at it, trace from it, and had no way to keep the work.
 * Close the tab and the georeference was gone.
 *
 * Every engine this needs was already in the tree and called only from the
 * conversion pipeline, which handles rasters that ARRIVED georeferenced:
 * `buildWorldFile`, `worldFileExtensionFor`, `writeGcpPoints`, `buildPrj`. The
 * one place in the product where a georeference is CREATED called none of them.
 *
 * ---------------------------------------------------------------------------
 * WHY A WORLD FILE AND NOT A GEOTIFF
 *
 * A world file is six numbers in a text file beside the image, and the image
 * is not touched at all. No resampling, no re-encoding, no generation loss —
 * the scan a surveyor hands on is bit-for-bit the scan they were given. Every
 * GIS reads it, and QGIS and ArcGIS both pick it up automatically from the
 * filename alone.
 *
 * Rewriting the pixels into a GeoTIFF would mean decoding someone's JPEG and
 * re-encoding it, which loses quality on a document whose whole value is that
 * it is the record. The sidecar is both the cheaper answer and the more honest
 * one.
 *
 * THE FILENAME IS THE BINDING, and this project has been bitten by that before:
 * a world file is associated with its image by name and nothing else, so a
 * `.jgw` written for a `.jpg` must be named for that jpg exactly. That is what
 * `worldFileExtensionFor` is for, and why it is used here rather than a
 * hard-coded `.wld`.
 */

import type { CrsRef } from './cir';
import type { Affine } from './georeference';
import { buildWorldFile, worldFileExtensionFor, writeGcpPoints, type Geotransform } from '../engines/raster/worldfile';
import { buildPrj } from '../crs/wkt';
import type { Gcp } from './georeference';

/** One file to hand back to the user. */
export interface GeoreferenceFile {
  name: string;
  text: string;
  /** What it is, for the line the panel prints beside it. */
  role: 'world file' | 'projection' | 'control points';
}

/**
 * The six world-file coefficients, from the affine the fitter produced.
 *
 * `Affine` was defined to match this convention deliberately — its doc comment
 * says so — and the field names are the same letters the world file uses. The
 * ORDER in the file is not the order of the letters, though: a world file is
 * written `a d b e c f`, which is x-scale, y-skew, x-skew, y-scale, x-origin,
 * y-origin. `buildWorldFile` owns that ordering, so this only has to put the
 * terms into the positional `Geotransform` it expects.
 *
 * `Geotransform` is GDAL order: [originX, pixelWidth, rowRotation, originY,
 * columnRotation, pixelHeight]. Mapping it by hand is exactly where a
 * transposed pair would produce a file that looks plausible and places the
 * scan wrongly, so each term is named as it is placed.
 */
export function geotransformFromAffine(affine: Affine): Geotransform {
  return [
    affine.c, // originX  — X of the centre of the top-left pixel
    affine.a, // pixelWidth
    affine.b, // rowRotation    (X per unit of v)
    affine.f, // originY  — Y of the centre of the top-left pixel
    affine.d, // columnRotation (Y per unit of u)
    affine.e, // pixelHeight, normally negative
  ];
}

/**
 * Everything needed to open the scan as a georeferenced raster.
 *
 * Three files, each of which a GIS looks for by name beside the image:
 *
 *   THE WORLD FILE places it. Without this there is no georeference at all.
 *   THE .prj NAMES THE CRS. Without it the layer loads with an unknown
 *     coordinate system and lands wherever the project default puts it — which
 *     is the failure that looks like a bad survey rather than a missing file.
 *   THE .points FILE KEEPS THE WORK. It is what QGIS's own georeferencer reads
 *     and writes, so the control points can be reopened, corrected and refitted
 *     somewhere else instead of being placed again from scratch.
 */
export function georeferenceFiles(options: {
  imageName: string;
  affine: Affine;
  crs: CrsRef | null;
  gcps: Gcp[];
}): GeoreferenceFile[] {
  const { imageName, affine, crs, gcps } = options;
  const dot = imageName.lastIndexOf('.');
  const stem = dot > 0 ? imageName.slice(0, dot) : imageName;
  const extension = dot > 0 ? imageName.slice(dot + 1) : '';

  const files: GeoreferenceFile[] = [
    {
      name: `${stem}.${worldFileExtensionFor(extension)}`,
      text: buildWorldFile(geotransformFromAffine(affine)),
      role: 'world file',
    },
  ];

  // A .prj for a CRS nobody has stated would be a claim invented here, so it
  // is written only when there is one. R2: an image must not be described as
  // georeferenced beyond what the reference information actually says.
  if (crs) files.push({ name: `${stem}.prj`, text: buildPrj(crs), role: 'projection' });

  if (gcps.length > 0) {
    files.push({
      name: `${stem}.points`,
      text: writeGcpPoints(
        gcps.map((gcp, index) => ({
          pixelX: gcp.pixel.u,
          pixelY: gcp.pixel.v,
          mapX: gcp.ground[0],
          mapY: gcp.ground[1],
          enabled: true,
          id: gcp.name ?? `Point ${index + 1}`,
        }))
      ),
      role: 'control points',
    });
  }

  return files;
}
