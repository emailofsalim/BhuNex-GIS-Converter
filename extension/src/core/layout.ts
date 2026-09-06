/**
 * Output layout — the module that makes the output structure match the input.
 *
 * A delivery has a shape. A folder of site surveys, a ZIP of ZIPs, a DXF with
 * forty named layers, a KML with nested folders: the person who assembled it
 * organised it that way on purpose. Flattening all of that into a pile of files
 * named `site_converted_to_geojson.geojson` throws away the one piece of
 * information that took a human to create.
 *
 * So this module answers two questions and nothing else:
 *
 *   1. How many files should this dataset become?  (one, or one per layer)
 *   2. Where does each of them belong in the output tree?
 *
 * Writing the bytes stays in the pipeline, where the format dispatch lives. This
 * module only plans and packages, which is why it can be tested on structure
 * alone without touching a single encoder.
 */

import { collectGeometryTypes, type CirDataset, type CirLayer, type SourceOrigin, type Warning } from './cir';
import { warn } from './cir';
import { sanitizeFileName } from './naming';
import { writeZip, type ZipInput } from '../engines/archives/zip';

export type OutputLayout =
  /** Everything in one file, where the target format can hold it. */
  | 'single'
  /** One file per layer, in folders named after the layer hierarchy. */
  | 'per-layer'
  /** Per-layer, and the whole thing placed under the source's own directory tree. */
  | 'mirror-source';

export const OUTPUT_LAYOUT_LABEL: Record<OutputLayout, string> = {
  single: 'One file',
  'per-layer': 'One file per layer, in folders',
  'mirror-source': 'Mirror the input structure',
};

export const OUTPUT_LAYOUT_DESCRIPTION: Record<OutputLayout, string> = {
  single: 'Everything the target format can hold goes into a single file.',
  'per-layer': 'Each layer becomes its own file, inside a folder named after the layer hierarchy.',
  'mirror-source': 'Per-layer output, placed under the same folder tree the input came from — including nested archives.',
};

/** One file in the delivery, addressed by its path inside the output tree. */
export interface OutputNode {
  /** Forward-slashed path relative to the delivery root, e.g. `Survey/Plots/Plot.shp`. */
  path: string;
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * One thing the pipeline should write: a dataset (possibly a single-layer slice
 * of the original), and where its output belongs.
 */
export interface LayoutUnit {
  dataset: CirDataset;
  /** Folder path for this unit, '' at the delivery root. */
  directory: string;
  /** Filename without extension. */
  baseName: string;
  /** The layer this unit came from, absent when the whole dataset is one unit. */
  layer?: CirLayer;
}

export interface LayoutOptions {
  layout: OutputLayout;
  /** Base name from the naming policy, already sanitised. */
  baseName: string;
  /** Whether the target format can hold several layers in one file. */
  targetHoldsLayers: boolean;
}

/** Sanitises one path segment. Empty and dot-only segments would break the tree. */
export function safeSegment(segment: string, fallback = 'layer'): string {
  const cleaned = sanitizeFileName(segment.trim(), fallback).replace(/^\.+$/, fallback);
  return cleaned || fallback;
}

export function joinPath(...parts: (string | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * The directory a source file's outputs belong under.
 *
 * Nested archives become folders so a ZIP-of-ZIPs stays navigable rather than
 * collapsing two levels of someone's filing into one.
 */
export function directoryForOrigin(origin: SourceOrigin | undefined): string {
  if (!origin) return '';
  const containers = origin.containers.map((container) => safeSegment(stripExtension(container), 'archive'));
  const directories = origin.directory
    .split('/')
    .filter(Boolean)
    .map((segment) => safeSegment(segment, 'folder'));
  return joinPath(...containers, ...directories);
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Slices a dataset down to one layer, keeping everything else about it intact. */
export function datasetForLayer(dataset: CirDataset, layer: CirLayer): CirDataset {
  return {
    ...dataset,
    name: layer.name,
    layers: [{ ...layer, geometryTypes: collectGeometryTypes(layer.features) }],
    // A layer slice carries no raster or point cloud: those are whole-dataset
    // payloads and duplicating them into every slice would multiply the output.
    raster: undefined,
    pointcloud: undefined,
  };
}

/**
 * Plans the output files for one dataset.
 *
 * `single` is not merely the absence of structure — for a target that genuinely
 * holds layers (KML folders, DXF layer table), keeping them together is the
 * higher-fidelity answer, and splitting would be the lossy one.
 */
export function planLayout(dataset: CirDataset, options: LayoutOptions): { units: LayoutUnit[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const root = options.layout === 'mirror-source' ? directoryForOrigin(dataset.origin) : '';

  const wholeDataset = (): LayoutUnit[] => [{ dataset, directory: root, baseName: options.baseName }];

  if (options.layout === 'single') return { units: wholeDataset(), warnings };

  // Rasters, point clouds and unmapped tables have no layers to split by.
  const layers = dataset.layers.filter((layer) => layer.features.length > 0);
  if (layers.length === 0) return { units: wholeDataset(), warnings };

  if (layers.length === 1) {
    // One layer is not a hierarchy. Adding a folder for it would be noise.
    return { units: [{ dataset, directory: root, baseName: options.baseName, layer: layers[0] }], warnings };
  }

  if (options.targetHoldsLayers && options.layout === 'per-layer') {
    warnings.push(
      warn('LAYOUT_TARGET_HOLDS_LAYERS', `The target format can hold all ${layers.length} layers in one file, but per-layer output was requested.`, {
        severity: 'info',
        reason: 'Splitting is still done as asked; it just is not required by the format.',
        action: 'Choose "One file" if a single layered file would suit the recipient better.',
      })
    );
  }

  const used = new Set<string>();
  const units: LayoutUnit[] = layers.map((layer) => {
    const segments = (layer.path.length > 0 ? layer.path : [layer.name]).map((segment) => safeSegment(segment));
    // The last segment names the file; the ones before it are folders. That is
    // what turns `Pit / Bench crests` into `Pit/Bench crests.geojson`.
    const fileSegment = segments[segments.length - 1];
    const folderSegments = segments.slice(0, -1);
    const directory = joinPath(root, ...folderSegments);

    let baseName = fileSegment;
    let index = 2;
    // Two layers can legitimately share a leaf name under different parents;
    // they only collide once the directory is the same.
    while (used.has(`${directory}/${baseName}`.toLowerCase())) baseName = `${fileSegment}_${index++}`;
    used.add(`${directory}/${baseName}`.toLowerCase());

    return { dataset: datasetForLayer(dataset, layer), directory, baseName, layer };
  });

  return { units, warnings };
}

/**
 * Packages the delivery.
 *
 * A single file is handed over as-is — wrapping one GeoJSON in a ZIP would be an
 * annoyance, not a structure. Anything with a tree becomes a ZIP whose internal
 * paths *are* that tree.
 */
export async function packageOutput(
  nodes: OutputNode[],
  zipName: string
): Promise<{ files: OutputNode[]; zipped: boolean }> {
  if (nodes.length <= 1) return { files: nodes, zipped: false };

  const entries: ZipInput[] = nodes.map((node) => ({ name: node.path, bytes: node.bytes }));
  const bytes = await writeZip(entries);
  return { files: [{ path: zipName, bytes, mimeType: 'application/zip' }], zipped: true };
}

interface TreeNode {
  directories: Map<string, TreeNode>;
  files: string[];
}

/**
 * Renders the planned paths as an indented tree, so the user can see the shape
 * of the delivery before converting rather than discovering it in a download.
 */
export function describeTree(paths: string[]): string[] {
  const root: TreeNode = { directories: new Map(), files: [] };
  for (const path of paths) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = node.directories.get(segment) ?? { directories: new Map(), files: [] };
      node.directories.set(segment, next);
      node = next;
    }
    node.files.push(segments[segments.length - 1]);
  }

  const lines: string[] = [];
  const render = (node: TreeNode, depth: number): void => {
    // Directories first, then files, each alphabetically — the order a file
    // browser would show, so the preview matches what the user will open.
    for (const name of [...node.directories.keys()].sort()) {
      lines.push(`${'  '.repeat(depth)}${name}/`);
      render(node.directories.get(name)!, depth + 1);
    }
    for (const name of [...node.files].sort()) lines.push(`${'  '.repeat(depth)}${name}`);
  };
  render(root, 0);
  return lines;
}

/**
 * Ensures every path in a delivery is unique.
 *
 * Two source files called `plots.dxf` in different folders keep their folders and
 * do not collide; two at the same path would, and silently overwriting one with
 * the other loses data.
 */
export function deduplicatePaths(nodes: OutputNode[]): { nodes: OutputNode[]; collisions: number } {
  const used = new Set<string>();
  let collisions = 0;
  const out = nodes.map((node) => {
    const key = node.path.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return node;
    }
    collisions++;
    const dot = node.path.lastIndexOf('.');
    const stem = dot > 0 ? node.path.slice(0, dot) : node.path;
    const extension = dot > 0 ? node.path.slice(dot) : '';
    for (let index = 2; index < 10000; index++) {
      const candidate = `${stem}_${index}${extension}`;
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase());
        return { ...node, path: candidate };
      }
    }
    return node;
  });
  return { nodes: out, collisions };
}
