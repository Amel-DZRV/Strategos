import { defineConfig } from 'vitest/config';

// Tests that spawn node-pty, node children, Git Bash or whole daemons. Run concurrently with each other (and with the
// CPU-bound unit tests) they starve one another on Windows and time out or miss ordering, so they live in one project
// ('proc') whose files run one at a time. Everything else stays parallel. Paths are relative to the repo root.
const PROC = [
  'packages/daemon/src/**/*.e2e.test.ts',
  'packages/daemon/src/pty/pty-host.test.ts',
  'packages/daemon/src/statusline/tap.test.ts',
  'packages/daemon/src/platform/sampler.test.ts',
  'packages/daemon/src/platform/process.test.ts',
  'tools/fake-claude.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', environment: 'node' } },
      {
        test: {
          name: 'daemon', root: 'packages/daemon', environment: 'node', testTimeout: 30_000, hookTimeout: 30_000,
          exclude: ['**/node_modules/**', ...PROC.filter((p) => p.startsWith('packages/daemon/')).map((p) => p.replace('packages/daemon/', ''))],
        },
      },
      {
        test: {
          name: 'proc', root: '.', environment: 'node', include: PROC, maxWorkers: 4, sequence: { groupOrder: 1 }, testTimeout: 120_000, hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'tools', root: 'tools', environment: 'node', testTimeout: 60_000,
          exclude: ['**/node_modules/**', 'fake-claude.test.ts'],
        },
      },
      {
        extends: 'packages/ui/vite.config.ts',
        test: { name: 'ui', root: 'packages/ui', environment: 'jsdom' },
      },
    ],
  },
});
