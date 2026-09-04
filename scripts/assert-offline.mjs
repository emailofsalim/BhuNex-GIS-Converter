/**
 * Enforces instruction rule R15 (offline-first, no CDN) against the built
 * output. The extension must work with the network interface disabled, so the
 * packaged bundle may not reference a remote origin at all.
 *
 * This runs in CI after `npm run build`. It reads dist/, not source, because a
 * transitive import is exactly the way a CDN reference sneaks in unnoticed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'dist');

// Remote-origin patterns. `chrome-extension:` and relative paths are fine; a
// bare scheme-relative `//host/` reference is not, because the browser resolves
// it against the extension origin only by accident of scheme.
const FORBIDDEN = [
  /https?:\/\/(?!(?:www\.)?(?:w3\.org|opengis\.net|google\.com\/kml|earth\.google\.com|schemas\.opengis\.net|inkscape\.org|purl\.org|apache\.org|sourceforge\.net))[^\s"'`)]+/gi,
  /\bcdn\.jsdelivr\.net\b/gi,
  /\bunpkg\.com\b/gi,
  /\bcdnjs\.cloudflare\.com\b/gi,
  /\bfonts\.googleapis\.com\b/gi,
  /\bfonts\.gstatic\.com\b/gi,
];

const TEXT_EXTENSIONS = new Set(['.js', '.html', '.css', '.json', '.map', '.txt', '.svg']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const findings = [];
for (const file of walk(distDir)) {
  if (!TEXT_EXTENSIONS.has(extname(file))) continue;
  // Source maps embed the original comments; scanning them would flag prose in
  // doc comments rather than real references.
  if (file.endsWith('.map')) continue;
  const text = readFileSync(file, 'utf8');
  for (const pattern of FORBIDDEN) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push(`${relative(root, file)}: ${match[0].slice(0, 120)}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Offline check FAILED — remote references found in the build:');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    '\nThe extension must run with the network disabled (instruction rule R15).\n' +
      'Bundle the resource locally instead of referencing a remote origin.'
  );
  process.exit(1);
}

console.log('Offline check passed — no remote origins in dist/.');
