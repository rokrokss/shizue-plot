import { defineConfig } from 'vitest/config';

// Package-local config: without it vitest walks up to the repo-root config, whose
// include globs do not match from this directory.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
