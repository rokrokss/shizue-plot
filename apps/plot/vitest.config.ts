import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The web app imports itself through `@/`, which its tsconfig resolves and a
  // bare vitest does not. Only the web sources are behind it, so one entry does.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
      'next/font/google': fileURLToPath(new URL('./apps/web/test/nextFont.ts', import.meta.url)),
    },
  },
  // Next compiles the app's JSX and the tsconfig says `preserve`, which leaves
  // esbuild reaching for a global `React` that nothing imports. Tests that mount a
  // component need the automatic runtime the app is actually built with.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
