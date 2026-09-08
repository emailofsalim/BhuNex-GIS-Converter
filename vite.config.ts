import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, 'extension');

/**
 * Where the build lands. `dist/` unless OUT_DIR says otherwise.
 *
 * The override exists for one caller: `scripts/assert-build-committed.mjs`,
 * which rebuilds into a temporary directory and compares the result with the
 * `dist/` committed to the repository. It has to build somewhere ELSE, because
 * building over the committed copy is precisely the thing that would make the
 * comparison meaningless.
 */
const outDir = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(root, 'dist');

/**
 * Copies manifest.json and everything under extension/public into the build
 * output. Vite's own publicDir would work, but the manifest has to land at the
 * package root next to the generated HTML, and keeping the copy explicit makes
 * the extension layout obvious from the build config alone.
 */
function copyStaticAssets(): Plugin {
  return {
    name: 'ugc-copy-static',
    apply: 'build',
    closeBundle() {
      copyFileSync(resolve(extensionRoot, 'manifest.json'), resolve(outDir, 'manifest.json'));
      const publicDir = resolve(extensionRoot, 'public');
      const walk = (from: string, to: string) => {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from)) {
          const src = resolve(from, entry);
          const dst = resolve(to, entry);
          if (statSync(src).isDirectory()) walk(src, dst);
          else copyFileSync(src, dst);
        }
      };
      walk(publicDir, outDir);
    },
  };
}

export default defineConfig({
  root: extensionRoot,
  // Chrome resolves extension resources from the package root, so every asset
  // reference has to be relative rather than server-absolute.
  base: './',
  plugins: [copyStaticAssets()],
  resolve: {
    alias: {
      '@core': resolve(extensionRoot, 'src/core'),
      '@crs': resolve(extensionRoot, 'src/crs'),
      '@engines': resolve(extensionRoot, 'src/engines'),
      '@qa': resolve(extensionRoot, 'src/qa'),
      '@ui': resolve(extensionRoot, 'src/ui'),
      '@state': resolve(extensionRoot, 'src/state'),
      '@adapters': resolve(extensionRoot, 'src/adapters'),
      '@workers': resolve(extensionRoot, 'src/workers'),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'chrome116',
    // Extension pages load from disk, so a source map per chunk costs nothing
    // at runtime and makes a field bug report readable. They are dropped only
    // for a store build: they are 78% of the package, and a store listing has
    // no bug reports to symbolicate — the sideloaded and CI builds keep them.
    //
    // Set STORE_BUILD=1 (npm run build:store) to omit them.
    sourcemap: process.env.STORE_BUILD !== '1',
    modulePreload: false,
    rollupOptions: {
      input: {
        workspace: resolve(extensionRoot, 'src/workspace/index.html'),
        sidepanel: resolve(extensionRoot, 'src/sidepanel/index.html'),
        popup: resolve(extensionRoot, 'src/popup/index.html'),
        'service-worker': resolve(extensionRoot, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
        format: 'es',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
