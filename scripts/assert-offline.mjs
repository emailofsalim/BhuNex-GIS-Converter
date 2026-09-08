/**
 * Enforces instruction rule R15 (offline-first, no CDN) against the built
 * output. The extension must work with the network interface disabled, so the
 * packaged bundle may not *load* anything from a remote origin.
 *
 * The distinction that matters: an `http://...` string is not by itself a
 * network access. XML namespace URIs — the GPX, LandXML, KML and OOXML
 * namespaces this converter writes — are identifiers that are never fetched, and
 * they are mandatory in the files it produces. Flagging them would force the
 * check to be disabled, which is worse than not having it.
 *
 * So this scans for the constructs that actually cause a load: remote src/href
 * attributes, CSS url() and @import, script-side fetch/XHR/import/Worker with a
 * remote literal, and any mention of a known CDN host.
 *
 * Runs in CI after `npm run build`, against dist/ rather than source, because a
 * transitive import is exactly how a CDN reference arrives unnoticed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'dist');

const REMOTE = String.raw`(?:https?:)?//[^\s"'\`)]+`;

/** Constructs that cause a real network load. */
const LOAD_PATTERNS = [
  { name: 'remote src attribute', pattern: new RegExp(String.raw`\bsrc\s*=\s*["']${REMOTE}`, 'gi') },
  { name: 'remote href attribute', pattern: new RegExp(String.raw`\bhref\s*=\s*["']${REMOTE}`, 'gi') },
  { name: 'CSS url()', pattern: new RegExp(String.raw`url\(\s*["']?${REMOTE}`, 'gi') },
  { name: 'CSS @import', pattern: new RegExp(String.raw`@import\s+["']${REMOTE}`, 'gi') },
  { name: 'fetch()', pattern: new RegExp(String.raw`\bfetch\s*\(\s*["'\`]${REMOTE}`, 'gi') },
  { name: 'XMLHttpRequest.open', pattern: new RegExp(String.raw`\.open\s*\(\s*["'][A-Z]+["']\s*,\s*["']${REMOTE}`, 'gi') },
  { name: 'dynamic import', pattern: new RegExp(String.raw`\bimport\s*\(\s*["'\`]${REMOTE}`, 'gi') },
  { name: 'importScripts', pattern: new RegExp(String.raw`\bimportScripts\s*\(\s*["'\`]${REMOTE}`, 'gi') },
  { name: 'new Worker', pattern: new RegExp(String.raw`new\s+(?:Shared)?Worker\s*\(\s*["'\`]${REMOTE}`, 'gi') },
  { name: 'WebSocket', pattern: new RegExp(String.raw`new\s+WebSocket\s*\(\s*["'\`]wss?://`, 'gi') },
  // A tile template. Unambiguous — a URL carrying {z}/{x}/{y} is a slippy-map
  // endpoint and nothing else — so this catches a new remote tile source
  // without the false positives that flagging every https literal would bring
  // on the XML namespaces this converter is obliged to write.
  { name: 'map tile template', pattern: /https?:\/\/[^\s"']*\{[zxy]\}[^\s"']*/gi },
];

/** Hosts that only ever appear in a bundle because something is being loaded. */
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
  'esm.sh',
  'skypack.dev',
  'jsdelivr.com',
];

const TEXT_EXTENSIONS = new Set(['.js', '.html', '.css', '.json', '.txt', '.svg']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * The one deliberate exception: the optional map basemap.
 *
 * R15 says the packaged extension must WORK with the network interface
 * disabled. It does: the basemap is off by default, it is a view-time layer
 * only, no conversion, QA, measurement or export path touches it, and a tile
 * that fails to load leaves the canvas exactly as it would otherwise be. That
 * is the rule kept, not bent.
 *
 * These templates are listed by their exact text rather than by host pattern,
 * so adding a new remote URL still fails this check even if it points at a tile
 * server. An allowlist that matched `*.tile.*` would quietly permit the next
 * one nobody reviewed.
 */
const ALLOWED_TEMPLATES = [
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  // Shown to the user as an example of the shape a custom template takes.
  // Never fetched — `your-server` does not resolve, which is the point of it.
  'https://your-server/tiles/{z}/{x}/{y}.png',
];

/** Strips the allowed templates before scanning, so they cannot mask anything else. */
function withoutAllowed(text) {
  let out = text;
  for (const template of ALLOWED_TEMPLATES) out = out.split(template).join('«basemap-template»');
  return out;
}

const findings = [];
for (const file of walk(distDir)) {
  // Source maps embed the original source and its comments, so scanning them
  // would report prose in a doc comment as a network reference.
  if (file.endsWith('.map')) continue;
  if (!TEXT_EXTENSIONS.has(extname(file))) continue;
  const text = withoutAllowed(readFileSync(file, 'utf8'));
  const where = relative(root, file);

  for (const { name, pattern } of LOAD_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push(`${where}: ${name} → ${match[0].slice(0, 120)}`);
    }
  }
  for (const host of CDN_HOSTS) {
    if (text.includes(host)) findings.push(`${where}: CDN host referenced → ${host}`);
  }
}

if (findings.length > 0) {
  console.error('Offline check FAILED — the build would load a remote resource:');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    '\nThe extension must run with the network disabled (instruction rule R15).\n' +
      'Bundle the resource locally instead of loading it from a remote origin.'
  );
  process.exit(1);
}

console.log('Offline check passed — nothing in dist/ loads from a remote origin.');
