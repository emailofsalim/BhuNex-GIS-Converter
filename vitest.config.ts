import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, 'extension');

export default defineConfig({
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
  test: {
    environment: 'node',
    include: ['extension/tests/**/*.test.ts'],
    // Benchmarks are a separate run (`npm run bench`). A timing suite on a
    // shared CI runner is noise, and a noisy suite stops being read.
    benchmark: { include: ['benchmarks/**/*.bench.ts'] },
    reporters: 'default',
  },
});
