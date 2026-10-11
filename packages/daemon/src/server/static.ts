// Serves the built UI directory. Read-only; no directory listing; no way out of the root.
import { createReadStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { reply } from './guards.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export interface StaticHandler {
  /** Returns true when it answered (200, 304-less, 404 for a missing asset). */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string, extraHeaders?: Record<string, string>): Promise<boolean>;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function createStaticHandler(dir: string): StaticHandler {
  const root = path.resolve(dir);
  let realRoot: string | null = null;

  async function resolveFile(pathname: string): Promise<string | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\') || !decoded.startsWith('/')) return null;
    if (decoded.split('/').some((seg) => seg === '..')) return null;
    realRoot ??= await fsp.realpath(root);
    let candidate = path.resolve(root, '.' + decoded);
    if (!isInside(root, candidate)) return null;
    try {
      let real = await fsp.realpath(candidate);
      if (!isInside(realRoot, real)) return null; // a symlink out of the root
      let st = await fsp.stat(real);
      if (st.isDirectory()) {
        candidate = path.join(real, 'index.html');
        real = await fsp.realpath(candidate);
        if (!isInside(realRoot, real)) return null;
        st = await fsp.stat(real);
      }
      return st.isFile() ? real : null;
    } catch {
      return null;
    }
  }

  return {
    async handle(req, res, pathname, extraHeaders = {}) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        reply(res, 405, { Allow: 'GET, HEAD' });
        return true;
      }
      let file = await resolveFile(pathname);
      // Single-page app: a path without a file extension falls back to index.html.
      if (file === null && path.extname(pathname) === '') file = await resolveFile('/index.html');
      if (file === null) {
        reply(res, 404);
        return true;
      }
      const st = await fsp.stat(file);
      res.writeHead(200, {
        'Content-Type': mimeFor(file),
        'Content-Length': String(st.size),
        'Cache-Control': 'no-cache',
        ...extraHeaders,
      });
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      await new Promise<void>((resolve) => {
        const s = createReadStream(file);
        s.on('error', () => {
          res.destroy();
          resolve();
        });
        s.on('end', () => resolve());
        res.on('close', () => {
          s.destroy();
          resolve();
        });
        s.pipe(res);
      });
      return true;
    },
  };
}
