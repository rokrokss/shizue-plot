import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Package-local config: without it vitest walks up to the repo-root config, whose
// include globs do not match from this directory. The alias and JSX settings
// mirror the root config so the suite resolves the same from either entry point.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'next/font/google': fileURLToPath(new URL('./test/nextFont.ts', import.meta.url)),
    },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
