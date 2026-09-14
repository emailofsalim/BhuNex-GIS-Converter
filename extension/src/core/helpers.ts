/**
 * Formats this extension cannot convert on its own, and what each one needs.
 *
 * WHY THIS IS A CATALOGUE RATHER THAN PROSE IN THE HELP DIALOG
 *
 * The same facts were stated in four places — the registry's `requiresNative`
 * flag, the format card's badge, the pipeline's refusal message, and the
 * prediction engine's remedy — and they had already drifted. DGN and File
 * Geodatabase were flagged as needing "the local native helper", and the
 * refusal told the user to install it. The helper cannot convert either: it
 * hardcodes `.dwg`, and it drives ODA File Converter, which handles DWG and DXF
 * and nothing else. A surveyor could install a helper, follow every
 * instruction, and find DGN exactly as unsupported as before.
 *
 * So the catalogue is the one place that says what is needed, and everything
 * that tells the user about it reads from here.
 *
 * THE DISTINCTION THAT MATTERS
 *
 * `bundled-helper` — this project ships a helper that really does convert the
 * format, given a program the user already has. Installing it changes the
 * answer. There is exactly one of these, and it is DWG.
 *
 * `external-tool`  — the format needs software this project does not ship and
 * cannot drive. Installing our helper changes nothing. The honest thing is to
 * name the tool that does work and get out of the way.
 */

export type HelperKind = 'bundled-helper' | 'external-tool';

export interface HelperRequirement {
  kind: HelperKind;
  /** Format ids this entry covers. */
  formats: string[];
  /** What the user ends up installing. */
  name: string;
  /** One line, for a badge or a card. */
  summary: string;
  /** What must already be on the machine for the helper to work. */
  prerequisite?: string;
  /** Where the thing comes from. Named, never invented. */
  source?: string;
  /** Ordered install steps. Empty for an external tool we do not instruct on. */
  steps: string[];
  /** Which directions it restores. */
  directions: ('import' | 'export')[];
}

/**
 * ODA File Converter is free, and converting DWG is the only thing it is asked
 * to do here. The helper is a small stdio program: the browser cannot execute a
 * converter, so it hands the bytes to a process on the user's own machine and
 * takes DXF back. Nothing leaves the machine.
 */
export const DWG_HELPER: HelperRequirement = {
  kind: 'bundled-helper',
  formats: ['dwg'],
  name: 'BhuNex DWG helper',
  summary: 'Converts DWG by driving the ODA File Converter already installed on your machine.',
  prerequisite: 'ODA File Converter (a free download from Open Design Alliance) and Python 3.9 or newer.',
  source: 'The native-host folder in the repository, or the bhunex-native-host ZIP attached to any release.',
  steps: [
    'Install ODA File Converter and note where it went.',
    'Download the helper — the native-host folder from the repository, or the bhunex-native-host ZIP on the release page.',
    'Run "python install.py" inside that folder. It registers the helper with Chrome and Edge for this extension only.',
    'If ODA did not land somewhere the installer looks, put its full path in host-config.json under "odaExecutable".',
    'Reopen the workspace. The top bar reads "Native engine: ready" when the helper answers.',
  ],
  directions: ['import', 'export'],
};

/**
 * Everything else that is registered but not readable here.
 *
 * These are grouped by the tool that actually converts them, because a
 * surveyor's question is "what do I open this in", not "which library is
 * missing". QGIS is named first throughout: it is free, it is what most survey
 * offices already have, and it carries GDAL, which covers every format below.
 */
export const EXTERNAL_TOOLS: HelperRequirement[] = [
  {
    kind: 'external-tool',
    formats: ['dgn'],
    name: 'QGIS or GDAL',
    summary: 'MicroStation DGN needs a DGN reader this extension does not ship, and the DWG helper does not cover it.',
    source: 'QGIS (qgis.org) opens DGN directly; GDAL ogr2ogr converts it from the command line.',
    steps: ['Open the DGN in QGIS and export it as DXF, Shapefile or GeoPackage.', 'Bring that result back here.'],
    directions: ['import', 'export'],
  },
  {
    kind: 'external-tool',
    formats: ['filegdb'],
    name: 'QGIS or GDAL',
    summary: 'Esri File Geodatabase is a proprietary multi-file database with no browser reader.',
    source: 'QGIS opens a .gdb folder directly through GDAL.',
    steps: ['Open the .gdb in QGIS and export the layers you need as Shapefile or GeoPackage.', 'Bring those back here.'],
    directions: ['import', 'export'],
  },
  {
    kind: 'external-tool',
    formats: ['geopackage', 'geoparquet'],
    name: 'QGIS or GDAL',
    summary: 'These need database and columnar engines that are not part of this build.',
    source: 'QGIS reads and writes both.',
    steps: ['Convert to GeoJSON, Shapefile or FlatGeobuf first, then bring that here.'],
    directions: ['import', 'export'],
  },
  {
    kind: 'external-tool',
    formats: ['e57'],
    name: 'CloudCompare or PDAL',
    summary: 'E57 point clouds need a libE57 reader. LAS is read here directly; LAZ is not, because no decompressor is bundled.',
    source: 'CloudCompare (cloudcompare.org) and PDAL both read E57.',
    steps: ['Export the cloud as LAS, then bring that here.'],
    directions: ['import', 'export'],
  },
];

export const ALL_REQUIREMENTS: HelperRequirement[] = [DWG_HELPER, ...EXTERNAL_TOOLS];

/** What a format needs, or null when it converts here unaided. */
export function requirementFor(formatId: string): HelperRequirement | null {
  return ALL_REQUIREMENTS.find((entry) => entry.formats.includes(formatId)) ?? null;
}

/**
 * True when installing something this project ships would make the format work.
 *
 * The gate for offering an install prompt. Offering one for DGN would send a
 * user to do work that cannot help them.
 */
export function hasBundledHelper(formatId: string): boolean {
  return requirementFor(formatId)?.kind === 'bundled-helper';
}
