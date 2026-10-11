import { describe, expect, it } from 'vitest';
import { daemonOrigin, isDaemonUrl, isExternalAllowed, isPermissionAllowed, isRequestAllowed, isTrustedSender } from './nav-guard.ts';

const O = daemonOrigin(47800);

describe('navigation guard', () => {
  it('lets the window stay on the daemon origin only', () => {
    expect(isDaemonUrl('http://127.0.0.1:47800/', O)).toBe(true);
    expect(isDaemonUrl('http://127.0.0.1:47800/x?y=1#z', O)).toBe(true);
    for (const bad of [
      'http://127.0.0.1:47801/', 'http://localhost:47800/', 'https://127.0.0.1:47800/', 'http://127.0.0.1/', 'http://127.0.0.1:47800@evil.test/',
      'http://user:pw@127.0.0.1:47800/', 'http://evil.test/', 'file:///C:/x', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'not a url', '',
      'http://127.0.0.1:47800.evil.test/',
    ]) expect(isDaemonUrl(bad, O), bad).toBe(false);
  });

  it('hands only plain http(s) links to the system browser', () => {
    expect(isExternalAllowed('https://github.com/Amel-DZRV/strategos/pull/3')).toBe(true);
    expect(isExternalAllowed('http://example.com/a?b=c')).toBe(true);
    for (const bad of [
      'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,hi', 'vscode://x', 'ms-msdt:/x', 'smb://host/share', 'steam://run/1',
      'claude://resume/x', 'ftp://x/y', 'https://user:pw@example.com/', 'https://', '', 'nonsense', '\\\\server\\share',
    ]) expect(isExternalAllowed(bad), bad).toBe(false);
  });

  it('cancels every request that is not the daemon (no remote content)', () => {
    expect(isRequestAllowed('http://127.0.0.1:47800/assets/app.js', O)).toBe(true);
    expect(isRequestAllowed('ws://127.0.0.1:47800/ws', O)).toBe(true);
    expect(isRequestAllowed('data:image/png;base64,AAAA', O)).toBe(true);
    expect(isRequestAllowed('blob:http://127.0.0.1:47800/uuid', O)).toBe(true);
    for (const bad of [
      'https://fonts.googleapis.com/css', 'http://127.0.0.1:5173/', 'ws://127.0.0.1:47801/ws', 'ws://evil.test/ws', 'wss://127.0.0.1:47800/ws',
      'http://localhost:47800/', 'ftp://x/', 'devtools://devtools/bundled/x', '',
    ]) expect(isRequestAllowed(bad, O), bad).toBe(false);
  });

  it('answers IPC only for the top frame of our own page', () => {
    expect(isTrustedSender('http://127.0.0.1:47800/', true, O)).toBe(true);
    expect(isTrustedSender('http://127.0.0.1:47800/', false, O)).toBe(false); // an iframe
    expect(isTrustedSender('http://evil.test/', true, O)).toBe(false);
    expect(isTrustedSender('data:text/html,x', true, O)).toBe(false); // the error page gets nothing
    expect(isTrustedSender(undefined, true, O)).toBe(false);
  });

  it('grants notifications from our origin and nothing else', () => {
    expect(isPermissionAllowed('notifications', 'http://127.0.0.1:47800/', O)).toBe(true);
    expect(isPermissionAllowed('notifications', 'http://127.0.0.1:47800', O)).toBe(true);
    expect(isPermissionAllowed('notifications', 'http://evil.test/', O)).toBe(false);
    for (const p of ['media', 'geolocation', 'midi', 'clipboard-read', 'openExternal', 'fullscreen', 'hid', 'serial', 'usb', 'display-capture', 'pointerLock']) {
      expect(isPermissionAllowed(p, 'http://127.0.0.1:47800/', O), p).toBe(false);
    }
  });
});
