/**
 * Writes the repository-root `manifest.json`, so the ROOT of a downloaded copy
 * of this repository is itself a loadable unpacked extension.
 *
 * ---------------------------------------------------------------------------
 * THE STEP THIS REMOVES
 *
 * Committing `dist/` made the extension downloadable, but installing it still
 * read:
 *
 *     extract the download  →  go INTO the dist folder  →  Load unpacked
 *
 * and that middle step is where it goes wrong. "Load unpacked" opens a folder
 * picker on the folder you just extracted, selecting it is the obvious move,
 * and the result is "Manifest file is missing or unreadable" — the same message,
 * for the third distinct reason. Every extension anyone has ever sideloaded
 * works by selecting the folder they extracted, so that is what people do.
 *
 * With a manifest at the root, that is now the correct move:
 *
 *     extract the download  →  Load unpacked  →  select the folder
 *
 * Selecting `dist/` still works too, because `dist/` carries its own manifest.
 * Both are right, which is the point — there is no longer a wrong one.
 *
 * ---------------------------------------------------------------------------
 * WHY GENERATE IT RATHER THAN WRITE IT
 *
 * The two manifests are the same document at two different depths: every
 * relative path in the root copy needs a `dist/` in front of it. Maintained by
 * hand, they drift the first time a page moves, and the failure is a blank tab
 * rather than an error — the extension loads, the button does nothing.
 *
 * So `extension/manifest.json` stays the single source of truth and this
 * rewrites it. `scripts/assert-build-committed.mjs` regenerates and compares in
 * CI, so a drifted root manifest fails the build.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'extension/manifest.json');

/** Where the built extension sits relative to the repository root. */
const PREFIX = 'dist/';

/**
 * Every manifest key that names a file, and therefore needs the prefix.
 *
 * Listed explicitly rather than discovered by walking for anything
 * string-shaped: `default_title` is a string, `description` is a string, and
 * prefixing either would put "dist/" in front of text the user reads.
 */
function prefixPaths(manifest) {
  const out = structuredClone(manifest);
  const prefix = (value) => (typeof value === 'string' ? PREFIX + value : value);
  const prefixMap = (map) =>
    map && typeof map === 'object' ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, prefix(v)])) : map;

  if (out.icons) out.icons = prefixMap(out.icons);
  if (out.action) {
    if (out.action.default_popup) out.action.default_popup = prefix(out.action.default_popup);
    if (out.action.default_icon) out.action.default_icon = prefixMap(out.action.default_icon);
  }
  if (out.background?.service_worker) out.background.service_worker = prefix(out.background.service_worker);
  if (out.side_panel?.default_path) out.side_panel.default_path = prefix(out.side_panel.default_path);
  if (out.options_page) out.options_page = prefix(out.options_page);
  if (Array.isArray(out.web_accessible_resources)) {
    out.web_accessible_resources = out.web_accessible_resources.map((entry) =>
      entry && Array.isArray(entry.resources) ? { ...entry, resources: entry.resources.map(prefix) } : entry
    );
  }
  return out;
}

const manifest = JSON.parse(readFileSync(source, 'utf8'));
const rooted = prefixPaths(manifest);

const banner = {
  _comment: [
    'GENERATED FILE — do not edit. Source: extension/manifest.json.',
    'This manifest exists so that the ROOT of this repository loads as an unpacked',
    'extension: extract a download, click Load unpacked, select the folder. Every',
    'path here is the same as the one in dist/manifest.json with "dist/" in front.',
    'Regenerate with: npm run build:store  (CI fails if this file has drifted).',
  ].join(' '),
};

// ROOT_MANIFEST_OUT lets the freshness checker generate a copy somewhere else
// and compare, rather than overwriting the committed file it is checking.
const target = process.env.ROOT_MANIFEST_OUT
  ? resolve(process.env.ROOT_MANIFEST_OUT)
  : resolve(root, 'manifest.json');

writeFileSync(target, JSON.stringify({ ...banner, ...rooted }, null, 2) + '\n', 'utf8');
if (!process.env.ROOT_MANIFEST_OUT) {
  console.log(`Root manifest written — the repository root loads as an extension (paths under ${PREFIX}).`);
}
