/**
 * Asserts that the `dist/` committed to this repository is what the current
 * source actually builds.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BUILD OUTPUT IS COMMITTED AT ALL
 *
 * Committing build output is normally a mistake, and this is the exception that
 * earns itself. The product is a browser extension, and a browser loads a
 * FOLDER — it cannot build anything. So there are exactly two ways for someone
 * to get a working extension out of this repository:
 *
 *   INSTALL A TOOLCHAIN FIRST. Node, npm, `npm ci`, `npm run build`. For a
 *     survey office on a managed laptop that is not a small ask, and it is not
 *     an ask the product should be making at all.
 *
 *   DOWNLOAD AND LOAD IT. Which is what everyone tries first, and what every
 *     other extension they have ever installed does.
 *
 * Before this, the second path produced "Manifest file is missing or
 * unreadable", because `dist/` was gitignored and `extension/` holds
 * TypeScript. A repository whose obvious use fails is a broken repository,
 * however defensible the reason.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT HAS TO EXIST
 *
 * The real objection to committing build output is that it DRIFTS: source
 * changes, nobody rebuilds, and the folder people load is last week's
 * extension. That failure is silent and it is worse than no build at all,
 * because the bug report describes code that is already fixed.
 *
 * So the freshness is checked rather than trusted. This rebuilds from source
 * into a temporary directory and compares every file byte for byte. Drift is a
 * build failure with the file list attached.
 *
 * It is the same guard `npm run docs:check` puts on the generated format
 * matrix, for the same reason: a generated artefact in the tree is only safe
 * when something fails if it goes stale.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORE BUILD
 *
 * The committed copy is built with STORE_BUILD=1, so it carries no source maps.
 * Maps are 78% of the package and exist to make a field bug report readable —
 * which is a developer's need, met by `npm run build` locally, not something
 * every person who downloads the extension should pay for.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committed = resolve(root, 'dist');

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

let fresh;
try {
  statSync(committed);
} catch {
  console.error('dist/ is not committed. Run `npm run build:store` and commit the result.');
  process.exit(1);
}

fresh = mkdtempSync(join(tmpdir(), 'ubc-build-'));

try {
  execFileSync('npx', ['vite', 'build'], {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, STORE_BUILD: '1', OUT_DIR: fresh },
  });

  const committedFiles = walk(committed).sort();
  const freshFiles = walk(fresh).sort();

  const missing = freshFiles.filter((name) => !committedFiles.includes(name));
  const extra = committedFiles.filter((name) => !freshFiles.includes(name));
  const differing = freshFiles
    .filter((name) => committedFiles.includes(name))
    .filter((name) => !readFileSync(join(fresh, name)).equals(readFileSync(join(committed, name))));

  // The ROOT manifest is generated from extension/manifest.json too, and it is
  // the file that makes the repository root loadable. Left to drift, the
  // extension still loads and the toolbar button opens a blank tab — a failure
  // with no error attached, which is the kind worth a check.
  const rootManifest = resolve(root, 'manifest.json');
  const expectedRoot = execFileSync('node', [resolve(root, 'scripts/write-root-manifest.mjs')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ROOT_MANIFEST_OUT: join(fresh, 'root-manifest.json') },
  });
  void expectedRoot;

  let rootDiffers = false;
  try {
    rootDiffers = !readFileSync(rootManifest).equals(readFileSync(join(fresh, 'root-manifest.json')));
  } catch {
    rootDiffers = true;
  }

  if (missing.length === 0 && extra.length === 0 && differing.length === 0 && !rootDiffers) {
    console.log(
      `Committed build is current — ${committedFiles.length} files match a fresh build exactly, ` +
        'and the root manifest matches what extension/manifest.json generates.'
    );
    process.exit(0);
  }

  console.error('The committed dist/ does not match what the source builds.\n');
  for (const name of missing) console.error(`  missing from dist/   ${name}`);
  for (const name of extra) console.error(`  should not be there  ${name}`);
  for (const name of differing) console.error(`  differs              ${name}`);
  if (rootDiffers) console.error('  differs              manifest.json (repository root — regenerated from extension/manifest.json)');
  console.error(
    '\nThe extension people download is therefore not the extension this source' +
      '\ndescribes. Run:\n\n  npm run build:store && npm run package\n\nand commit dist/ and dist-zip/ with your change.'
  );
  process.exit(1);
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
