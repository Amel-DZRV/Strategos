/**
 * Claude Code's project directory name for a working directory: every non-alphanumeric becomes "-".
 * [ran] C:\Users\Amel.DESKTOP-8UP1MTT -> C--Users-Amel-DESKTOP-8UP1MTT.
 * Names over 200 characters: Claude truncates to 200 and appends "-" + a hash of the full path.
 * TODO(verify): the hash below is the Java-style 31x hash in base 36 that Claude's Node build uses [inferred, from memory of the
 * bundled source]. The native claude.exe is a Bun build and may use Bun.hash instead; no over-200 directory exists on this
 * machine to compare. Until verified, callers must treat a long-name result as a guess and fall back to scanning
 * `projects/` for a directory that starts with `projectDirPrefix(cwd)`.
 */
export const MAX_PROJECT_DIR_LEN = 200;

export function javaStyleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}

export function projectDirName(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_PROJECT_DIR_LEN) return sanitized;
  return `${sanitized.slice(0, MAX_PROJECT_DIR_LEN)}-${javaStyleHash(cwd)}`;
}

/** The part of the name that is certain even for long paths. */
export function projectDirPrefix(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, MAX_PROJECT_DIR_LEN);
}
