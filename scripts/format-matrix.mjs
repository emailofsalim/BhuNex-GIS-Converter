/**
 * Generates docs/FORMAT_MATRIX.md from the format registry.
 *
 * The matrix is documentation about what the engines actually do, so deriving it
 * from the registry is the only way it stays true. A hand-maintained table drifts
 * the first time a support level changes, and a wrong support table is exactly
 * the kind of dishonesty rule R1 exists to prevent.
 *
 *   node --experimental-strip-types scripts/format-matrix.mjs          # write
 *   node --experimental-strip-types scripts/format-matrix.mjs --check  # verify
 *
 * The --check mode runs in CI and fails when the committed file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'docs/FORMAT_MATRIX.md');

const { FORMATS, SUPPORT_LABEL, CATEGORY_LABEL } = await import(resolve(root, 'extension/src/core/registry.ts'));

const CATEGORY_ORDER = ['gis', 'cad', 'survey', 'mining', 'lidar', 'raster', 'spreadsheet', 'crs', 'archive'];

function capabilities(format) {
  const flags = [
    format.supports3D && '3D',
    format.supportsZ && 'Z',
    format.supportsM && 'M',
    format.supportsAttributes && 'attributes',
    format.supportsCRS && 'CRS',
    format.supportsCurves && 'curves',
  ].filter(Boolean);
  return flags.length > 0 ? flags.join(', ') : '—';
}

function level(value) {
  // The support level is the whole point of the table, so it is emphasised
  // rather than being one plain column among several.
  const label = SUPPORT_LABEL[value];
  return value === 'full' ? `**${label}**` : label;
}

const lines = [];
lines.push('# Format matrix');
lines.push('');
lines.push('<!--');
lines.push('  GENERATED FILE — do not edit by hand.');
lines.push('  Run: node --experimental-strip-types scripts/format-matrix.mjs');
lines.push('  CI fails if this file disagrees with extension/src/core/registry.ts.');
lines.push('-->');
lines.push('');
lines.push('Generated from `extension/src/core/registry.ts`, which is the single source of');
lines.push('truth the UI, the detector and the conversion pipeline all read. A format appears');
lines.push('here exactly as its engines actually behave.');
lines.push('');
lines.push('## What the support levels mean');
lines.push('');
lines.push('| Level | Meaning |');
lines.push('|---|---|');
lines.push('| **Supported** | Reader/writer implemented and covered by a round-trip test. |');
lines.push('| Partial | Implemented with named, enumerated limitations — listed below the table. |');
lines.push('| Metadata only | Structure and georeference are read; the payload is **not** decoded. |');
lines.push('| Adapter required | The contract exists; the engine (native helper or WASM) is not bundled. |');
lines.push('| Not supported | Not implemented, and never offered in the interface. |');
lines.push('');
lines.push('A format is never listed above what its engine has earned: a `full` claim without a');
lines.push('covering test fails the build (`extension/tests/registry.test.ts`).');
lines.push('');

const counts = { full: 0, partial: 0, 'metadata-only': 0, adapter: 0, none: 0 };
for (const format of FORMATS) {
  if (format.support.import !== 'none') counts[format.support.import]++;
}
lines.push(
  `**${counts.full} formats read directly**, ${counts.partial} partially, ` +
    `${counts['metadata-only']} metadata-only, ${counts.adapter} through adapters that are not bundled.`
);
lines.push('');

for (const category of CATEGORY_ORDER) {
  const group = FORMATS.filter((format) => format.category === category);
  if (group.length === 0) continue;
  lines.push(`## ${CATEGORY_LABEL[category]}`);
  lines.push('');
  lines.push('| Format | Extensions | Import | Export | Carries |');
  lines.push('|---|---|---|---|---|');
  for (const format of group.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      `| ${format.name} | ${format.extensions.map((extension) => `\`.${extension}\``).join(' ')} | ` +
        `${level(format.support.import)} | ${level(format.support.export)} | ${capabilities(format)} |`
    );
  }
  lines.push('');

  const limited = group.filter((format) => (format.warnings?.length ?? 0) > 0 || format.notes);
  if (limited.length > 0) {
    for (const format of limited.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`**${format.name}**`);
      lines.push('');
      if (format.notes) lines.push(`- ${format.notes}`);
      for (const warning of format.warnings ?? []) lines.push(`- ${warning}`);
      if (format.companions?.length) {
        lines.push(`- Companion files: ${format.companions.map((extension) => `\`.${extension}\``).join(', ')}.`);
      }
      if (format.packaging === 'zip') lines.push('- Multi-file output is packaged automatically as one ZIP.');
      lines.push('');
    }
  }
}

lines.push('---');
lines.push('');
lines.push('## Not offered, and why');
lines.push('');
lines.push('| Format | Reason |');
lines.push('|---|---|');
for (const format of FORMATS.filter((candidate) => candidate.support.import === 'adapter' || candidate.support.export === 'adapter')) {
  const reason = format.requiresNative
    ? 'Needs a native helper or licensed SDK on your machine.'
    : 'Needs a WebAssembly engine that is not part of this build.';
  lines.push(`| ${format.name} | ${reason} |`);
}
lines.push('');
lines.push('Closing any of these is tracked in `docs/BUILD_STATE.md`.');
lines.push('');

const generated = lines.join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error('docs/FORMAT_MATRIX.md is missing. Run: node --experimental-strip-types scripts/format-matrix.mjs');
    process.exit(1);
  }
  if (current.trim() !== generated.trim()) {
    console.error('docs/FORMAT_MATRIX.md is out of date with the format registry.');
    console.error('Run: node --experimental-strip-types scripts/format-matrix.mjs');
    process.exit(1);
  }
  console.log('Format matrix is up to date with the registry.');
} else {
  writeFileSync(target, generated);
  console.log(`wrote docs/FORMAT_MATRIX.md (${FORMATS.length} formats)`);
}
