import { spawn } from 'node:child_process';

/** Only http(s) URLs may become an app window. */
export function assertHttpUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url.slice(0, 80)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`refusing non-http URL: ${u.protocol}`);
  return u.href;
}

/** `--app=<url>`: a chromeless Chrome window. The URL may carry a #pair= fragment, so it only ever travels as one argv entry. */
export function chromeAppArgs(url: string): string[] {
  return [`--app=${assertHttpUrl(url)}`];
}

export type SpawnDetached = (exe: string, args: string[]) => void;

export const spawnDetached: SpawnDetached = (exe, args) => {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* surfaced by the caller's pre-check; nothing else to do for a detached UI process */ });
  child.unref();
};
