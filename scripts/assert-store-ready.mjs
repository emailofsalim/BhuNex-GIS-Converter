/**
 * Store-readiness checks for the Chrome Web Store and Microsoft Edge Add-ons.
 *
 * Every rule here is one a real submission is rejected for, and every one of
 * them is cheaper to fail in CI than in review: a Chrome rejection costs a
 * resubmission and days of queue, and the feedback is often a single sentence
 * that does not name the field.
 *
 * The description limit is the reason this file exists. It is a hard 132
 * characters, it is not documented anywhere the manifest is edited, and this
 * project shipped at 134 — an automatic rejection nobody would have caught by
 * reading the manifest, because 134 characters looks exactly like 132.
 *
 * Run with `npm run store:check`. Reads dist/ so it checks what would actually
 * be uploaded, not what the source says.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'dist');

const problems = [];
const notes = [];

function fail(rule, detail, remedy) {
  problems.push({ rule, detail, remedy });
}

if (!existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

// --------------------------------------------------------------- manifest

const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  fail('manifest', 'dist/manifest.json is missing.', 'The build must copy the manifest into dist/.');
  report();
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail('manifest', `dist/manifest.json is not valid JSON: ${error.message}`, 'Fix the manifest source.');
  report();
}

if (manifest.manifest_version !== 3) {
  fail(
    'manifest_version',
    `manifest_version is ${manifest.manifest_version}.`,
    'Both stores stopped accepting Manifest V2 submissions. It must be 3.'
  );
}

// Chrome: 75 characters. Edge: 45 before it is truncated in the listing.
if (!manifest.name) {
  fail('name', 'No name.', 'Every listing needs one.');
} else {
  if (manifest.name.length > 75) {
    fail('name', `name is ${manifest.name.length} characters.`, 'Chrome Web Store rejects anything over 75.');
  } else if (manifest.name.length > 45) {
    notes.push(`name is ${manifest.name.length} characters; Edge truncates the listing title past 45.`);
  }
}

// THE ONE THAT BIT US. Hard limit, silently enforced at upload.
if (!manifest.description) {
  fail('description', 'No description.', 'Both stores require one.');
} else if (manifest.description.length > 132) {
  fail(
    'description',
    `description is ${manifest.description.length} characters: "${manifest.description}"`,
    'Chrome Web Store rejects anything over 132. Shorten it in extension/manifest.json.'
  );
}

if (manifest.short_name && manifest.short_name.length > 12) {
  notes.push(`short_name is ${manifest.short_name.length} characters; Chrome truncates it under the icon past about 12.`);
}

// x.y.z.w, each part 0-65535, no leading zeros. Rejected at upload otherwise.
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version ?? '')) {
  fail(
    'version',
    `version "${manifest.version}" is not a store-valid version.`,
    'One to four dot-separated integers, each 0-65535, no leading zeros and no suffix such as -beta.'
  );
} else if (manifest.version.split('.').some((part) => Number(part) > 65535)) {
  fail('version', `version "${manifest.version}" has a part above 65535.`, 'Each part must be 0-65535.');
}

// A `key` in a published manifest pins the extension ID to a local build and is
// a common accidental leak from `chrome://extensions` "Pack extension".
if (manifest.key) {
  fail('key', 'The manifest contains a "key" field.', 'Remove it — the store assigns the extension ID.');
}

if (manifest.update_url) {
  fail(
    'update_url',
    'The manifest contains "update_url".',
    'Store-hosted extensions must not self-update; the store rejects this field.'
  );
}

// --------------------------------------------------------------- permissions

const permissions = manifest.permissions ?? [];
const optional = manifest.optional_permissions ?? [];
const hosts = manifest.host_permissions ?? [];

// Permissions that make a review slower or scarier at install time. Each is
// allowed — the point is that holding one at install time must be a decision.
const HEAVY = {
  nativeMessaging: 'Prompts "Communicate with cooperating native applications" at install. Prefer optional_permissions.',
  tabs: 'Reads tab URLs and titles; needs a strong justification.',
  '<all_urls>': 'Broad host access; triggers the slowest review tier.',
  webRequest: 'Heavily scrutinised.',
  cookies: 'Treated as sensitive user data.',
  history: 'Treated as sensitive user data.',
  management: 'Rarely approved without a very specific reason.',
  debugger: 'Almost never approved.',
};

for (const permission of permissions) {
  if (HEAVY[permission]) {
    fail(
      'permissions',
      `"${permission}" is requested at install time. ${HEAVY[permission]}`,
      'Move it to optional_permissions and request it from a user gesture, or document the justification in docs/STORE_LISTING.md.'
    );
  }
}

for (const host of hosts) {
  fail(
    'host_permissions',
    `host_permissions requests "${host}".`,
    'This extension processes local files and must not need host access. Remove it, or the listing has to justify it.'
  );
}

if (optional.length > 0) notes.push(`Optional permissions, requested at runtime: ${optional.join(', ')}.`);
if (permissions.length > 0) notes.push(`Install-time permissions: ${permissions.join(', ')}.`);

// --------------------------------------------------------------- icons

// 128 is what the store shows. 16/32/48 are the browser UI.
const REQUIRED_ICONS = [16, 32, 48, 128];
for (const size of REQUIRED_ICONS) {
  const relPath = manifest.icons?.[String(size)];
  if (!relPath) {
    fail('icons', `No ${size}x${size} icon declared.`, `Add an "${size}" entry to manifest.icons.`);
    continue;
  }
  const iconPath = join(distDir, relPath);
  if (!existsSync(iconPath)) {
    fail('icons', `manifest.icons["${size}"] points at ${relPath}, which is not in dist/.`, 'Check the build copies it.');
    continue;
  }
  const actual = pngSize(iconPath);
  if (!actual) {
    fail('icons', `${relPath} is not a readable PNG.`, 'Both stores require PNG icons.');
  } else if (actual.width !== size || actual.height !== size) {
    fail('icons', `${relPath} is ${actual.width}x${actual.height}, declared as ${size}x${size}.`, 'Resize it.');
  }
}

// --------------------------------------------------------------- remote code

/**
 * Both stores forbid remote code in an extension. This project already asserts
 * it (scripts/assert-offline.mjs) because rule R15 requires the tool to work
 * with the network off — the store policy and the product rule happen to agree,
 * which is why the check is cheap to satisfy.
 */
const REMOTE = /(https?:)?\/\/(?!localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z]{2,}/i;
const SCRIPT_SRC = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
const LINK_HREF = /<link[^>]+href\s*=\s*["']([^"']+)["']/gi;

for (const file of walk(distDir)) {
  if (!/\.html?$/i.test(file)) continue;
  const html = readFileSync(file, 'utf8');
  for (const pattern of [SCRIPT_SRC, LINK_HREF]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(html))) {
      if (REMOTE.test(match[1])) {
        fail(
          'remote code',
          `${relative(distDir, file)} loads ${match[1]} from a remote origin.`,
          'Both stores reject remotely-hosted code. Bundle it.'
        );
      }
    }
  }
}

const csp = manifest.content_security_policy?.extension_pages ?? '';
if (/unsafe-eval/.test(csp) && !/wasm-unsafe-eval/.test(csp.replace(/'unsafe-eval'/g, ''))) {
  fail('csp', "content_security_policy allows 'unsafe-eval'.", "Only 'wasm-unsafe-eval' is accepted by the stores.");
}

// --------------------------------------------------------------- size

const files = walk(distDir);
const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
// Chrome's hard limit on an uploaded package.
if (totalBytes > 2 * 1024 * 1024 * 1024) {
  fail('size', `dist/ is ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`, 'Chrome Web Store rejects packages over 2 GB.');
}
notes.push(`${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB unpacked.`);

// Source maps are harmless but inflate the package and expose the full source
// tree in a listing. Worth knowing about rather than failing on.
const maps = files.filter((file) => file.endsWith('.map'));
if (maps.length > 0) {
  const mapBytes = maps.reduce((sum, file) => sum + statSync(file).size, 0);
  notes.push(`${maps.length} source map(s), ${(mapBytes / 1024 / 1024).toFixed(2)} MB — set build.sourcemap false to drop them.`);
}

// --------------------------------------------------------------- listing

const listing = resolve(root, 'docs/STORE_LISTING.md');
const privacy = resolve(root, 'docs/PRIVACY.md');
if (!existsSync(listing)) {
  fail('listing', 'docs/STORE_LISTING.md is missing.', 'Both stores need listing copy and permission justifications.');
}
if (!existsSync(privacy)) {
  fail('privacy', 'docs/PRIVACY.md is missing.', 'Both stores require a privacy policy URL before a listing can be published.');
}

report();

// --------------------------------------------------------------- helpers

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Reads width and height from a PNG's IHDR chunk. No dependency needed. */
function pngSize(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function report() {
  for (const note of notes) console.log(`  note: ${note}`);

  if (problems.length === 0) {
    console.log('\nStore check passed — the package satisfies the Chrome Web Store and Edge Add-ons rules this script covers.');
    process.exit(0);
  }

  console.error(`\n${problems.length} store problem(s) found:\n`);
  for (const problem of problems) {
    console.error(`  [${problem.rule}] ${problem.detail}`);
    console.error(`      fix: ${problem.remedy}\n`);
  }
  console.error('Each of these is something a store rejects. Fix them before uploading.');
  process.exit(1);
}
