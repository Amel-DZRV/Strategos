// Pairing (plan section 10, "Session token"). The daemon makes a one-time code when it opens the window; the code
// travels in the URL fragment (#pair=...), so it never reaches a log. The UI POSTs it to /api/pair and gets an
// HttpOnly, SameSite=Strict cookie. Codes live 60 s and work once. Everything is held in memory only.
import { randomBytes } from 'node:crypto';
import { parseCookies, sha256hex } from './guards.ts';

export const COOKIE_NAME = 'strategos_session';
export const PAIR_CODE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 7 * 86_400_000;

export interface Pairing {
  /** A new one-time code (32 random bytes, base64url). */
  issueCode(): string;
  /** Consume a code. Returns the new session value (for the cookie), or null if unknown, used or expired. */
  redeem(code: string): string | null;
  /** True when the Cookie header carries a live session value. */
  isAuthenticated(cookieHeader: string | undefined): boolean;
  /** The Set-Cookie header value for a session value. */
  setCookie(sessionValue: string): string;
  /** Forget every session (used on shutdown or when pairing is reset). */
  revokeAll(): void;
}

export function createPairing(o: { now?: () => number; codeTtlMs?: number; sessionTtlMs?: number } = {}): Pairing {
  const now = o.now ?? Date.now;
  const codeTtl = o.codeTtlMs ?? PAIR_CODE_TTL_MS;
  const sessionTtl = o.sessionTtlMs ?? SESSION_TTL_MS;
  // Only hashes are kept, so a memory dump of this map does not hand out working codes or cookies.
  const codes = new Map<string, number>(); // sha256(code) -> expiresAt
  const sessions = new Map<string, number>(); // sha256(session) -> expiresAt

  const sweep = (m: Map<string, number>) => {
    const t = now();
    for (const [k, exp] of m) if (exp <= t) m.delete(k);
  };

  return {
    issueCode() {
      sweep(codes);
      const code = randomBytes(32).toString('base64url');
      codes.set(sha256hex(code), now() + codeTtl);
      return code;
    },
    redeem(code) {
      sweep(codes);
      const key = sha256hex(code);
      const exp = codes.get(key);
      if (exp === undefined) return null;
      codes.delete(key); // single use, even if it turns out to be expired
      if (exp <= now()) return null;
      sweep(sessions);
      const value = randomBytes(32).toString('base64url');
      sessions.set(sha256hex(value), now() + sessionTtl);
      return value;
    },
    isAuthenticated(cookieHeader) {
      const v = parseCookies(cookieHeader)[COOKIE_NAME];
      if (v === undefined || v === '') return false;
      const exp = sessions.get(sha256hex(v));
      if (exp === undefined) return false;
      if (exp <= now()) {
        sessions.delete(sha256hex(v));
        return false;
      }
      return true;
    },
    setCookie(sessionValue) {
      return `${COOKIE_NAME}=${sessionValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtl / 1000)}`;
    },
    revokeAll() {
      codes.clear();
      sessions.clear();
    },
  };
}
