// What the window may load, navigate to, ask for and open (plan section 10). Pure, so it is unit-tested.
//
// The window shows exactly one origin: the daemon at http://127.0.0.1:<port>. Nothing else is loaded into it (no remote
// content); a link to anywhere else is handed to the owner's browser, and only when it is a plain http(s) link.

/** The origin string the daemon is served from. */
export const daemonOrigin = (port: number): string => `http://127.0.0.1:${port}`;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The window itself may navigate here: the daemon origin and nothing else. */
export function isDaemonUrl(url: string, origin: string): boolean {
  const u = parse(url);
  return u !== null && u.origin === origin && u.username === '' && u.password === '';
}

/** A link we may hand to the system browser: http or https, no credentials in the address. */
export function isExternalAllowed(url: string): boolean {
  const u = parse(url);
  return u !== null && (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '' && u.hostname !== '';
}

/**
 * A network request the page makes. The daemon origin over http, the same host and port over ws (the /ws socket),
 * and inline data: / blob: (xterm and the favicon use them). Everything else is cancelled.
 */
export function isRequestAllowed(url: string, origin: string): boolean {
  const u = parse(url);
  if (u === null) return false;
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol === 'devtools:') return false;
  const o = parse(origin);
  if (o === null) return false;
  if (u.protocol === 'ws:') return u.host === o.host;
  return u.origin === o.origin;
}

/** Only the top frame of our own page may talk to the main process over IPC. */
export function isTrustedSender(frameUrl: string | undefined, isMainFrame: boolean, origin: string): boolean {
  return isMainFrame && frameUrl !== undefined && isDaemonUrl(frameUrl, origin);
}

/** Permissions the page may have: desktop notifications, from our origin. Everything else (camera, geolocation ...) is refused. */
export function isPermissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  return permission === 'notifications' && isDaemonUrl(requestingUrl, origin);
}
