/**
 * Validates the packaged ZIP as an extension archive.
 *
 * `assert-store-ready.mjs` checks dist/ — the FOLDER. This checks the ARCHIVE,
 * which is a different artefact with its own ways of being broken, and it is
 * the one people actually download and extract.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * This project shipped three releases of a ZIP whose End Of Central Directory
 * record under-reported its entry count by one. Node, Python, 7-Zip and macOS
 * Archive Utility all scan and recover, so every check we had said the archive
 * was fine. `unzip` said "expected central file header signature not found".
 * Windows Explorer — which is what a Windows user extracts with — is in the
 * strict camp, and a partial extraction that drops manifest.json is reported by
 * the browser as, exactly:
 *
 *     "Manifest file is missing or unreadable"
 *
 * Which is what the user saw. So this file parses the archive the STRICT way on
 * purpose: it honours the EOCD count, walks the central directory record by
 * record, follows every local-header offset and verifies every CRC. A tolerant
 * reader here would defeat the point of the check.
 *
 * ---------------------------------------------------------------------------
 * THE REST OF THE RULES
 *
 * Everything else here is a way an archive extracts cleanly and still will not
 * load through "Load unpacked": the manifest nested one folder down, a path
 * Windows cannot create, two entries differing only in case, a file the
 * manifest points at that is not in the archive.
 *
 * Run with `npm run package:check`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { inflateRawSync, crc32 } from 'node:zlib';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zipDir = resolve(root, 'dist-zip');

const problems = [];
const notes = [];

function fail(rule, detail, remedy) {
  problems.push({ rule, detail, remedy });
}

// --------------------------------------------------------------- locate

if (!existsSync(zipDir)) {
  console.error('dist-zip/ not found — run `npm run package` first.');
  process.exit(1);
}

const archives = readdirSync(zipDir).filter((name) => name.endsWith('.zip'));
if (archives.length === 0) {
  console.error('No .zip in dist-zip/ — run `npm run package` first.');
  process.exit(1);
}

const archivePath = resolve(zipDir, archives.sort().at(-1));
const buffer = readFileSync(archivePath);
console.log(`checking ${posix.basename(archivePath)} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)\n`);

// --------------------------------------------------------------- strict read

/**
 * Reads the archive exactly as a strict extractor does.
 *
 * No scanning, no recovery: the EOCD count is taken as authoritative and each
 * record must follow the previous one. That is the whole point — a reader that
 * recovers from a malformed directory cannot detect a malformed directory.
 */
function readArchiveStrictly(data) {
  const eocdOffset = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) {
    fail('structure', 'No End Of Central Directory record.', 'The archive is truncated or not a ZIP.');
    return null;
  }

  const declared = data.readUInt16LE(eocdOffset + 10);
  const directorySize = data.readUInt32LE(eocdOffset + 12);
  const directoryStart = data.readUInt32LE(eocdOffset + 16);

  if (directoryStart + directorySize > data.length) {
    fail('structure', 'The central directory runs past the end of the file.', 'The archive is truncated.');
    return null;
  }

  const entries = [];
  let cursor = directoryStart;

  for (let index = 0; index < declared; index++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) {
      fail(
        'structure',
        `Central directory record ${index + 1} of ${declared} has no header signature (offset ${cursor}).`,
        'The EOCD entry count does not match the records written. A strict extractor stops here; Windows Explorer may extract only part of the archive.'
      );
      return null;
    }

    const method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  // After the declared number of records, the next thing must be the EOCD. If
  // another central-directory signature is sitting there, the count is short
  // and entries past it are invisible to a strict extractor.
  if (cursor !== eocdOffset) {
    const stray = cursor + 4 <= data.length && data.readUInt32LE(cursor) === 0x02014b50;
    fail(
      'structure',
      stray
        ? `The EOCD declares ${declared} entries, but more central directory records follow. Everything past entry ${declared} is invisible to a strict extractor.`
        : `${eocdOffset - cursor} unexpected byte(s) between the central directory and the EOCD.`,
      'Write the true entry count into both EOCD count fields.'
    );
    return null;
  }

  return { entries, declared };
}

const archive = readArchiveStrictly(buffer);
if (!archive) report();

const { entries } = archive;
const byName = new Map(entries.map((entry) => [entry.name, entry]));
notes.push(`${entries.length} entries, all reachable through the central directory.`);

/** Extracts one entry through its local header, and verifies its CRC. */
function contentOf(entry) {
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    fail('structure', `${entry.name}: local header signature missing at offset ${offset}.`, 'The archive is corrupt.');
    return null;
  }

  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const raw = buffer.slice(start, start + entry.compressedSize);

  let data;
  try {
    data = entry.method === 0 ? raw : inflateRawSync(raw);
  } catch (error) {
    fail('structure', `${entry.name}: could not be decompressed (${error.message}).`, 'The archive is corrupt — repackage.');
    return null;
  }

  if ((crc32(data) >>> 0) !== entry.crc) {
    fail('structure', `${entry.name}: CRC mismatch — the stored checksum does not match the data.`, 'Repackage.');
    return null;
  }
  if (data.length !== entry.uncompressedSize) {
    fail('structure', `${entry.name}: declared ${entry.uncompressedSize} bytes, decompressed to ${data.length}.`, 'Repackage.');
    return null;
  }

  return data;
}

// Every entry is decompressed and checksummed, not just the ones we read.
for (const entry of entries) contentOf(entry);

// --------------------------------------------------------------- layout

/**
 * The manifest must be at the ROOT of the archive.
 *
 * If the ZIP contains `universal-bhunex-converter/manifest.json`, then after
 * extraction the user must select the INNER folder, and selecting the one they
 * just extracted gives "Manifest file is missing or unreadable". Half the
 * reports of that message are this, and the other half are OneDrive.
 */
if (!byName.has('manifest.json')) {
  const nested = entries.find((entry) => entry.name.endsWith('/manifest.json'));
  fail(
    'layout',
    nested
      ? `manifest.json is at "${nested.name}", not at the archive root.`
      : 'There is no manifest.json anywhere in the archive.',
    nested
      ? 'Package the CONTENTS of dist/, not the folder itself — otherwise "Load unpacked" fails unless the user picks the inner folder.'
      : 'The package is not a loadable extension without it.'
  );
  report();
}

const manifestBytes = contentOf(byName.get('manifest.json'));
if (!manifestBytes || manifestBytes.length === 0) {
  fail('layout', 'manifest.json is empty.', 'The build produced a zero-byte manifest.');
  report();
}

let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString('utf8'));
} catch (error) {
  fail('layout', `manifest.json is not valid JSON: ${error.message}`, 'Both browsers refuse to load the extension.');
  report();
}

// --------------------------------------------------------------- required set

/**
 * What a Manifest V3 extension archive must contain to load through
 * "Load unpacked" in Chrome and in Edge.
 *
 * Chrome and Edge run the same Chromium extension system, so one list serves
 * both; where they differ it is in store review, not in loading.
 */
const REQUIRED_MANIFEST_KEYS = [
  ['manifest_version', 'Must be 3. Chrome 139+ and Edge no longer load Manifest V2 at all.'],
  ['name', 'Shown on the extensions page. Loading fails without it.'],
  ['version', 'Must be one to four dot-separated integers.'],
];

for (const [key, why] of REQUIRED_MANIFEST_KEYS) {
  if (manifest[key] === undefined || manifest[key] === '') {
    fail('required', `manifest.json has no "${key}". ${why}`, `Add "${key}" to extension/manifest.json.`);
  }
}

if (manifest.manifest_version !== 3) {
  fail('required', `manifest_version is ${manifest.manifest_version}, not 3.`, 'Neither browser loads V2 any more.');
}

if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(String(manifest.version ?? ''))) {
  fail('required', `version "${manifest.version}" is not a valid extension version.`, 'One to four integers, each 0-65535.');
}

/**
 * Every path the manifest points at, and whether it is required.
 *
 * A manifest that references a file the archive does not contain is the
 * failure mode where the extension INSTALLS and then does nothing — a blank
 * workspace, a popup that never opens — and the browser reports no error at
 * install time at all.
 */
const referenced = [
  ['background.service_worker', manifest.background?.service_worker],
  ['action.default_popup', manifest.action?.default_popup],
  ['side_panel.default_path', manifest.side_panel?.default_path],
  ['options_page', manifest.options_page],
  ['options_ui.page', manifest.options_ui?.page],
  ['devtools_page', manifest.devtools_page],
  ['chrome_url_overrides', ...Object.values(manifest.chrome_url_overrides ?? {})],
  ...Object.entries(manifest.icons ?? {}).map(([size, path]) => [`icons.${size}`, path]),
  ...Object.entries(manifest.action?.default_icon ?? {}).map(([size, path]) => [`action.default_icon.${size}`, path]),
  ...(manifest.content_scripts ?? []).flatMap((script, index) => [
    ...(script.js ?? []).map((path) => [`content_scripts[${index}].js`, path]),
    ...(script.css ?? []).map((path) => [`content_scripts[${index}].css`, path]),
  ]),
  ...(manifest.web_accessible_resources ?? []).flatMap((rule, index) =>
    (rule.resources ?? []).filter((path) => !path.includes('*')).map((path) => [`web_accessible_resources[${index}]`, path])
  ),
].filter(([, path]) => typeof path === 'string' && path !== '');

for (const [key, path] of referenced) {
  const normalised = path.replace(/^\.?\//, '');
  if (!byName.has(normalised)) {
    fail(
      'required',
      `manifest.${key} points at "${path}", which is not in the archive.`,
      'The extension installs and then that surface is dead. Check the build emitted it.'
    );
  }
}

// Icons: the browser shows a generic puzzle piece without them, and Edge's
// extension menu looks broken. 16/32/48/128 is the full set both browsers use.
for (const size of [16, 32, 48, 128]) {
  if (!manifest.icons?.[String(size)]) {
    fail('required', `No ${size}x${size} icon.`, `Add "${size}" to manifest.icons — both browsers use this size somewhere in their UI.`);
  }
}

// --------------------------------------------------------- page references

/**
 * Assets the extension's own HTML pages pull in.
 *
 * A missing chunk here is the "it loads but the workspace is blank" failure.
 * The manifest is valid, the install succeeds, and the page is empty.
 */
const LOCAL_REF = /(?:src|href)\s*=\s*["']([^"':]+)["']/gi;
for (const entry of entries) {
  if (!/\.html?$/i.test(entry.name)) continue;
  const html = contentOf(entry)?.toString('utf8');
  if (!html) continue;

  LOCAL_REF.lastIndex = 0;
  let match;
  while ((match = LOCAL_REF.exec(html))) {
    const ref = match[1].split('?')[0].split('#')[0];
    if (ref === '' || ref.startsWith('data:') || ref.startsWith('#')) continue;

    const resolved = ref.startsWith('/')
      ? ref.slice(1)
      : posix.normalize(posix.join(posix.dirname(entry.name), ref));

    if (!byName.has(resolved)) {
      fail(
        'assets',
        `${entry.name} references "${ref}" (${resolved}), which is not in the archive.`,
        'That page loads blank or broken, with no error at install time.',
      );
    }
  }
}

// --------------------------------------------------------------- path hygiene

/**
 * Paths that extract cleanly on Linux and fail on Windows.
 *
 * Every user of this extension is on Windows. A path that Explorer refuses to
 * create produces a partial extraction — and a partial extraction missing any
 * file is, again, "Manifest file is missing or unreadable".
 */
const WINDOWS_ILLEGAL = /[<>:"|?* -]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

const lowercased = new Map();

for (const entry of entries) {
  const name = entry.name;

  if (name.startsWith('/') || /^[a-z]:/i.test(name)) {
    fail('paths', `"${name}" is an absolute path.`, 'ZIP entries must be relative. Some extractors refuse the whole archive.');
  }
  if (name.split('/').includes('..')) {
    fail('paths', `"${name}" contains "..".`, 'Path traversal. Extractors reject it, and it is a security defect.');
  }
  if (name.includes('\\')) {
    fail('paths', `"${name}" uses backslashes.`, 'ZIP paths are always forward-slashed; a backslash becomes part of the filename on Linux.');
  }
  if (WINDOWS_ILLEGAL.test(name)) {
    fail('paths', `"${name}" contains a character Windows cannot put in a filename.`, 'Rename it — Explorer will skip this file and extract the rest.');
  }
  for (const segment of name.split('/')) {
    if (WINDOWS_RESERVED.test(segment)) {
      fail('paths', `"${name}" contains the reserved Windows device name "${segment}".`, 'Windows cannot create it, whatever the extension.');
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      fail('paths', `"${name}" has a segment ending in a space or dot.`, 'Windows silently strips those, so the extracted path stops matching the manifest.');
    }
  }
  if (JUNK.test(name)) {
    fail('paths', `"${name}" is packaging junk.`, 'Chrome Web Store rejects __MACOSX and dotfile cruft. Exclude it.');
  }

  // Two entries differing only in case cannot coexist on Windows or macOS: the
  // second silently overwrites the first, and one of the two files is gone.
  const key = name.toLowerCase();
  if (lowercased.has(key) && lowercased.get(key) !== name) {
    fail(
      'paths',
      `"${name}" and "${lowercased.get(key)}" differ only in capitalisation.`,
      'On Windows and macOS one overwrites the other during extraction.'
    );
  }
  lowercased.set(key, name);
}

// --------------------------------------------------------------- content

// A source map is fine in a sideloaded ZIP but doubles its size for no benefit.
const maps = entries.filter((entry) => entry.name.endsWith('.map'));
if (maps.length > 0) {
  const bytes = maps.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  notes.push(`${maps.length} source map(s), ${(bytes / 1024 / 1024).toFixed(2)} MB — build with STORE_BUILD=1 to drop them.`);
}

// The install note is what stops the OneDrive placeholder problem recurring.
if (!byName.has('INSTALL-FIRST.txt')) {
  fail(
    'guidance',
    'INSTALL-FIRST.txt is not at the archive root.',
    'It is the only instruction a user sees at the moment they extract. Without it the OneDrive failure repeats.'
  );
}

const totalUncompressed = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
notes.push(`${(totalUncompressed / 1024 / 1024).toFixed(2)} MB extracted, ${(buffer.length / 1024 / 1024).toFixed(2)} MB compressed.`);

// Chrome's hard upload limit. Sideloading has no limit, but the same ZIP is
// what gets uploaded to both stores.
if (buffer.length > 2 * 1024 * 1024 * 1024) {
  fail('size', `The archive is ${(buffer.length / 1024 / 1024 / 1024).toFixed(2)} GB.`, 'Chrome Web Store rejects anything over 2 GB.');
}

report();

// --------------------------------------------------------------- report

function report() {
  for (const note of notes) console.log(`  note: ${note}`);

  if (problems.length === 0) {
    console.log('\nPackage check passed — the archive extracts strictly and loads through "Load unpacked" in Chrome and Edge.');
    process.exit(0);
  }

  console.error(`\n${problems.length} package problem(s) found:\n`);
  for (const problem of problems) {
    console.error(`  [${problem.rule}] ${problem.detail}`);
    console.error(`      fix: ${problem.remedy}\n`);
  }
  process.exit(1);
}
