import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';

/** Resolve claude via PATH + PATHEXT; claude.cmd (npm shim) -> sibling node_modules/@anthropic-ai/claude-code/bin/claude.exe */
export function resolveClaude(): string {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, 'claude' + ext.toLowerCase());
      if (!existsSync(p)) continue;
      if (/\.exe$/i.test(p)) return p;
      if (/\.cmd$/i.test(p)) {
        const real = join(dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (existsSync(real)) return real;
        const m = readFileSync(p, 'utf8').match(/"%dp0%\\([^"]*claude\.exe)"/i);
        if (m) { const r = join(dirname(p), m[1]); if (existsSync(r)) return r; }
      }
    }
  }
  throw new Error('claude not found');
}

