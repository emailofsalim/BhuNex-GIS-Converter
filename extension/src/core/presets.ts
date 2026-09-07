/**
 * Conversion presets (spec §31.3).
 *
 * A preset is a named set of settings for a job someone actually does: a
 * cadastral DXF to labelled polygons, a borehole CSV to a styled KMZ, a DEM to
 * an exchange format. It exists because the settings that make those jobs work
 * are not obvious — the cadastral one needs polygonisation, burn-in, a CRS and
 * a layout, in that combination — and expecting every user to rediscover them
 * is how a capable tool ends up used as a dumb one.
 *
 * Two rules:
 *
 *  - A PRESET NEVER ENABLES A DESTRUCTIVE OPTION. None of them sets
 *    `replaceSource`, and none turns on a repair that moves geometry. A preset
 *    is a starting point, not a licence to edit someone's survey (R18).
 *  - EVERY PRESET SAYS WHAT IT CHANGES. `describePreset` lists the settings it
 *    will apply, so applying one is an informed act rather than a leap.
 */

/**
 * The settings a preset may set.
 *
 * Declared structurally here rather than imported from the state store: core
 * must not depend on the UI layer, and a preset is a description of intent that
 * the store applies, not a store object itself.
 */
export interface PresetSettings {
  globalTargetFormatId?: string;
  outputLayout?: 'single' | 'per-layer' | 'mirror-source';
  precisionMode?: 'full' | 'fixed';
  precisionDecimals?: number;
  preserveZ?: boolean;
  targetCrsEpsg?: number | null;
  arcTolerance?: number;
  kmlTemplate?: string;
  kmlBoreholeLog?: boolean;
  polygonizeEnabled?: boolean;
  polygonizeTolerance?: number;
  polygonizeKeepLines?: boolean;
  burnInEnabled?: boolean;
  burnInField?: string;
  burnInMode?: string;
  burnInPriority?: string;
  burnInReplaceSource?: boolean;
  decimationMode?: 'none' | 'nth' | 'grid' | 'voxel';
  mirrorBatchTree?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  /** One line: what job this is for. */
  purpose: string;
  /** Why these settings, in the terms of the work rather than the software. */
  rationale: string;
  /** Source formats this makes sense for. Empty means any. */
  appliesTo: string[];
  settings: PresetSettings;
}

export const PRESETS: Preset[] = [
  {
    id: 'cad-to-gis',
    name: 'CAD → GIS',
    purpose: 'A drawing becomes GeoJSON with its layers and CAD provenance intact.',
    rationale:
      'One file per layer, so the drawing’s layer table survives as a folder tree rather than collapsing into one collection. Full precision, because CAD coordinates are survey coordinates.',
    appliesTo: ['dxf', 'dwg'],
    settings: { globalTargetFormatId: 'geojson', outputLayout: 'per-layer', precisionMode: 'full', preserveZ: true },
  },
  {
    id: 'cadastral-dxf-to-polygons',
    name: 'Cadastral DXF → labelled polygons',
    purpose: 'Boundary line work and separate plot-number text become labelled parcels.',
    rationale:
      'The job this tool exists for. Line work is assembled into closed boundaries within a 10 mm tolerance, then the plot number drawn inside each parcel is attached to it as an attribute. The source text is kept.',
    appliesTo: ['dxf', 'dwg'],
    settings: {
      globalTargetFormatId: 'geojson',
      polygonizeEnabled: true,
      polygonizeTolerance: 0.01,
      polygonizeKeepLines: false,
      burnInEnabled: true,
      burnInField: 'plot_no',
      burnInMode: 'attribute',
      burnInPriority: 'nearest-to-centre',
      burnInReplaceSource: false,
      precisionMode: 'full',
      outputLayout: 'per-layer',
    },
  },
  {
    id: 'gis-to-cad',
    name: 'GIS → CAD',
    purpose: 'Vector data becomes a DXF a draughtsman can open and work in.',
    rationale:
      'DXF keeps layers natively, so the layer hierarchy is written as a real layer table. Arc tolerance is set fine because CAD is where curves matter most.',
    appliesTo: [],
    settings: { globalTargetFormatId: 'dxf', outputLayout: 'single', precisionMode: 'full', arcTolerance: 0.001, preserveZ: true },
  },
  {
    id: 'gis-to-google-earth',
    name: 'GIS → Google Earth (KMZ)',
    purpose: 'Anything vector becomes a KMZ that opens on any machine.',
    rationale:
      'KML is defined in WGS 84, so the target CRS is set to EPSG:4326 — without it, projected coordinates land in the wrong part of the world. Folders are kept so the places panel shows the source hierarchy.',
    appliesTo: [],
    settings: { globalTargetFormatId: 'kmz', targetCrsEpsg: 4326, kmlTemplate: 'plain', outputLayout: 'single', preserveZ: true },
  },
  {
    id: 'cadastral-to-kmz',
    name: 'Cadastral → labelled KMZ',
    purpose: 'Parcels open in Google Earth with their plot numbers showing.',
    rationale:
      'The plot number is burnt in as the placemark name, which is what Google Earth displays without any styling, and the cadastral template puts tenure fields at the top of the balloon.',
    appliesTo: [],
    settings: {
      globalTargetFormatId: 'kmz',
      targetCrsEpsg: 4326,
      kmlTemplate: 'cadastral',
      burnInEnabled: true,
      burnInField: 'plot_no',
      burnInMode: 'kml',
      burnInReplaceSource: false,
    },
  },
  {
    id: 'borehole-to-kmz',
    name: 'Borehole CSV → styled KMZ',
    purpose: 'Collars and interval logs become one KMZ with a core log per hole.',
    rationale:
      'Collars are joined to their interval logs by hole id, and each balloon carries the full log — from, to, thickness, lithology, recovery, RQD, sample and assay — with any gap or overlap flagged beside it.',
    appliesTo: ['csv', 'xlsx'],
    settings: { globalTargetFormatId: 'kmz', targetCrsEpsg: 4326, kmlTemplate: 'borehole', kmlBoreholeLog: true, precisionMode: 'full' },
  },
  {
    id: 'survey-csv-to-gis',
    name: 'Survey CSV → GIS',
    purpose: 'A coordinate list becomes points with its codes intact.',
    rationale:
      'Full precision, because a survey table is the primary record and rounding it at export defeats the point of having it.',
    appliesTo: ['csv', 'xlsx'],
    settings: { globalTargetFormatId: 'geojson', precisionMode: 'full', preserveZ: true, outputLayout: 'single' },
  },
  {
    id: 'survey-to-shapefile',
    name: 'Survey → Shapefile package',
    purpose: 'Points and boundaries become a complete .shp package for a client GIS.',
    rationale:
      'Shapefile is still the required deliverable in most tenders. Mixed geometry is split automatically, and every DBF field rename is listed in the manifest so a downstream join can be fixed rather than silently broken.',
    appliesTo: [],
    settings: { globalTargetFormatId: 'shapefile', precisionMode: 'full', preserveZ: true, outputLayout: 'per-layer' },
  },
  {
    id: 'dem-to-geotiff',
    name: 'DEM → GeoTIFF',
    purpose: 'A text grid becomes a GeoTIFF any raster tool reads.',
    rationale:
      'Deflate-compressed with the sample type chosen from the data, so fractional elevations stay fractional and nodata is not clamped into the terrain.',
    appliesTo: ['asciigrid'],
    settings: { globalTargetFormatId: 'geotiff', precisionMode: 'full' },
  },
  {
    id: 'lidar-to-las',
    name: 'Point cloud → LAS',
    purpose: 'Any point source becomes LAS with its per-point attributes.',
    rationale:
      'LAS is the only bundled target that keeps classification, intensity, return number and GPS time. Decimation stays off so the delivered cloud is the whole cloud.',
    appliesTo: ['xyz', 'pts', 'ply', 'las'],
    settings: { globalTargetFormatId: 'las', decimationMode: 'none', precisionMode: 'full', preserveZ: true },
  },
  {
    id: 'mine-survey-to-kmz',
    name: 'Mine survey → KMZ',
    purpose: 'Benches, crests and lease boundaries in Google Earth.',
    rationale:
      'The mining template puts lease and bench identity at the top of each balloon, and elevations are kept so the pit reads as a pit rather than a flat outline.',
    appliesTo: [],
    settings: { globalTargetFormatId: 'kmz', targetCrsEpsg: 4326, kmlTemplate: 'mining', preserveZ: true, outputLayout: 'single' },
  },
  {
    id: 'archive-mirror',
    name: 'Archive → mirrored delivery',
    purpose: 'A ZIP of mixed files converts with its folder tree intact.',
    rationale:
      'Every output is placed under the folder its source came from, including nesting inside archives, so the delivery a client receives is organised the way the data they sent was.',
    appliesTo: ['zip'],
    settings: { globalTargetFormatId: 'geojson', outputLayout: 'mirror-source', mirrorBatchTree: true, precisionMode: 'full' },
  },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Presets that make sense for a given source format, best match first. */
export function presetsFor(sourceFormatId: string | undefined): Preset[] {
  if (!sourceFormatId) return PRESETS;
  const specific = PRESETS.filter((preset) => preset.appliesTo.includes(sourceFormatId));
  const general = PRESETS.filter((preset) => preset.appliesTo.length === 0);
  return [...specific, ...general];
}

/**
 * Lists what applying a preset would change, so it is an informed act.
 *
 * Compares against the settings in force rather than against the defaults: a
 * user wants to know what is about to change for *them*, not what the preset
 * contains in the abstract.
 */
export function describePreset(preset: Preset, current: Record<string, unknown>): string[] {
  const changes: string[] = [];
  for (const [key, value] of Object.entries(preset.settings)) {
    if (current[key] === value) continue;
    changes.push(`${SETTING_LABEL[key] ?? key}: ${formatSettingValue(value)}`);
  }
  return changes;
}

const SETTING_LABEL: Record<string, string> = {
  globalTargetFormatId: 'Output format',
  outputLayout: 'Output structure',
  precisionMode: 'Precision',
  preserveZ: 'Preserve Z',
  targetCrsEpsg: 'Target CRS',
  arcTolerance: 'Arc tolerance',
  kmlTemplate: 'Balloon template',
  kmlBoreholeLog: 'Borehole core logs',
  polygonizeEnabled: 'Build polygons from CAD line work',
  polygonizeTolerance: 'Gap that may be closed',
  polygonizeKeepLines: 'Keep source line work',
  burnInEnabled: 'Attach text to polygons',
  burnInField: 'Burn-in field',
  burnInMode: 'Burn-in mode',
  burnInPriority: 'Burn-in tie-break',
  burnInReplaceSource: 'Delete source text',
  decimationMode: 'Decimation',
  mirrorBatchTree: 'Mirror the input tree',
};

function formatSettingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === null || value === undefined) return 'unset';
  return String(value);
}

/**
 * Guard: no preset may switch on something destructive.
 *
 * Enforced here and asserted by a test rather than left to review, because the
 * whole point of a preset is that people apply it without reading it (R18).
 */
export const DESTRUCTIVE_SETTINGS = [
  'burnInReplaceSource',
  'repairCloseRings',
  'repairRemoveDuplicateVertices',
  'repairNormalizeOrientation',
  'repairDeduplicateFeatures',
];
