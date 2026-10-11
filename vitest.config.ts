import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', environment: 'node' } },
      { test: { name: 'daemon', root: 'packages/daemon', environment: 'node' } },
      {
        extends: 'packages/ui/vite.config.ts',
        test: { name: 'ui', root: 'packages/ui', environment: 'jsdom' },
      },
    ],
  },
});
