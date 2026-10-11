import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// safe-fs rule (plan section 4): the daemon's only write path is packages/daemon/src/safe-fs.ts.
const WRITE_FNS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'unlink', 'unlinkSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'truncate',
  'truncateSync', 'createWriteStream', 'symlink', 'symlinkSync', 'write', 'writeSync',
  'writev', 'writevSync', 'open', 'openSync',
];
const FS_MODULES = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'];
const FS_OBJECTS = ['fs', 'fsp', 'fsPromises', 'promises'];

const safeFsMessage = 'Filesystem writes in the daemon must go through packages/daemon/src/safe-fs.ts.';

export default tseslint.config(
  { ignores: ['spike/**', 'design/**', 'docs/**', 'tools/**', 'fixtures/**'] },
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/daemon/**/*.ts'],
    ignores: ['packages/daemon/src/safe-fs.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: FS_MODULES.map((name) => ({ name, importNames: WRITE_FNS, message: safeFsMessage })),
      }],
      'no-restricted-syntax': ['error',
        {
          selector: `MemberExpression[object.name=/^(${FS_OBJECTS.join('|')})$/][property.name=/^(${WRITE_FNS.join('|')})$/]`,
          message: safeFsMessage,
        },
        {
          selector: `MemberExpression[object.property.name='promises'][property.name=/^(${WRITE_FNS.join('|')})$/]`,
          message: safeFsMessage,
        },
      ],
    },
  },
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['node:*'], message: 'packages/shared must not import Node APIs.' }],
        paths: ['fs', 'path', 'os', 'child_process', 'crypto', 'http', 'net', 'url', 'util', 'stream']
          .map((name) => ({ name, message: 'packages/shared must not import Node APIs.' })),
      }],
    },
  },
);
