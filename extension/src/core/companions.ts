/**
 * Companion-file grouping (instruction §5.4).
 *
 * A shapefile is five files, a MapInfo table is two, and a georeferenced image
 * is an image plus a world file plus a projection. Users select all of them and
 * expect one dataset. Grouping happens on basename within the same folder, and a
 * missing mandatory companion becomes a named warning — never a silent partial
 * read.
 */

import { baseName, extensionOf } from './naming';

export interface IngestFile {
  /** Path as presented by the drop or the archive, used to scope the grouping. */
  path: string;
  name: string;
  size: number;
  bytes: Uint8Array;
  mimeType?: string;
}

export interface FileGroup {
  /** The file the reader is pointed at. */
  primary: IngestFile;
  /** Extension -> file, for every companion found. */
  companions: Map<string, IngestFile>;
  /** Companion extensions the primary format requires but that were not found. */
  missing: string[];
  /** Sibling extensions in the same folder, fed to the detector as context. */
  siblingExtensions: string[];
}

interface GroupRule {
  /** Extension of the file that leads the group. */
  primary: string;
  /** Companions that must be present for a complete dataset. */
  required: string[];
  /** Companions that add information when present. */
  optional: string[];
}

const RULES: GroupRule[] = [
  { primary: 'shp', required: ['shx', 'dbf'], optional: ['prj', 'cpg', 'sbn', 'sbx', 'qpj', 'shp.xml'] },
  { primary: 'mif', required: ['mid'], optional: [] },
  { primary: 'tif', required: [], optional: ['tfw', 'prj', 'aux.xml', 'ovr'] },
  { primary: 'tiff', required: [], optional: ['tfw', 'prj', 'aux.xml', 'ovr'] },
  { primary: 'jpg', required: [], optional: ['jgw', 'prj', 'aux.xml'] },
  { primary: 'jpeg', required: [], optional: ['jgw', 'prj', 'aux.xml'] },
  { primary: 'png', required: [], optional: ['pgw', 'prj', 'aux.xml'] },
  { primary: 'bmp', required: [], optional: ['bpw', 'prj'] },
  { primary: 'gif', required: [], optional: ['gfw', 'prj'] },
  { primary: 'asc', required: [], optional: ['prj'] },
  { primary: 'las', required: [], optional: ['prj'] },
  { primary: 'laz', required: [], optional: ['prj'] },
  { primary: 'csv', required: [], optional: ['prj', 'csvt'] },
];

const RULE_BY_PRIMARY = new Map(RULES.map((rule) => [rule.primary, rule]));

/** Extensions that only ever accompany another file, never lead a dataset. */
const SIDECAR_ONLY = new Set([
  'shx',
  'dbf',
  'cpg',
  'sbn',
  'sbx',
  'mid',
  'tfw',
  'jgw',
  'pgw',
  'wld',
  'gfw',
  'bpw',
  'csvt',
  'ovr',
]);

function folderOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(0, slash) : '';
}

/**
 * Groups a flat file list into datasets.
 *
 * `.prj` is deliberately not in SIDECAR_ONLY: a lone .prj dropped on its own is
 * a legitimate CRS inspection, so it only becomes a companion when a file it can
 * accompany is present in the same folder.
 */
export function groupCompanions(files: IngestFile[]): FileGroup[] {
  const byFolder = new Map<string, IngestFile[]>();
  for (const file of files) {
    const folder = folderOf(file.path || file.name);
    const list = byFolder.get(folder) ?? [];
    list.push(file);
    byFolder.set(folder, list);
  }

  const groups: FileGroup[] = [];
  const consumed = new Set<IngestFile>();

  for (const [, folderFiles] of byFolder) {
    const byKey = new Map<string, Map<string, IngestFile>>();
    for (const file of folderFiles) {
      const key = baseName(file.name).toLowerCase();
      const extension = extensionOf(file.name);
      const bucket = byKey.get(key) ?? new Map<string, IngestFile>();
      // Keep the first file when a folder holds duplicates; the queue shows both
      // names so the user can tell them apart.
      if (!bucket.has(extension)) bucket.set(extension, file);
      byKey.set(key, bucket);
    }

    const siblingExtensions = [...new Set(folderFiles.map((file) => extensionOf(file.name)))];

    for (const [, bucket] of byKey) {
      for (const [extension, file] of bucket) {
        if (consumed.has(file)) continue;
        const rule = RULE_BY_PRIMARY.get(extension);
        if (!rule) continue;
        const companions = new Map<string, IngestFile>();
        for (const companionExtension of [...rule.required, ...rule.optional]) {
          const companion = bucket.get(companionExtension);
          if (companion && companion !== file) {
            companions.set(companionExtension, companion);
            consumed.add(companion);
          }
        }
        const missing = rule.required.filter((required) => !companions.has(required));
        consumed.add(file);
        groups.push({ primary: file, companions, missing, siblingExtensions });
      }
    }
  }

  // Everything not consumed as a companion stands alone. A stray .shx with no
  // .shp still surfaces, so the user sees why their shapefile did not appear.
  for (const file of files) {
    if (consumed.has(file)) continue;
    const extension = extensionOf(file.name);
    const folder = folderOf(file.path || file.name);
    groups.push({
      primary: file,
      companions: new Map(),
      missing: [],
      siblingExtensions: [...new Set((byFolder.get(folder) ?? []).map((f) => extensionOf(f.name)))],
    });
    if (SIDECAR_ONLY.has(extension)) {
      // Marked by the caller as an orphan companion; grouping itself stays pure.
    }
  }

  return groups;
}

export function isSidecarOnly(extension: string): boolean {
  return SIDECAR_ONLY.has(extension.toLowerCase());
}

export function requiredCompanionsFor(extension: string): string[] {
  return RULE_BY_PRIMARY.get(extension.toLowerCase())?.required ?? [];
}
