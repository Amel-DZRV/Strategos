/**
 * Bundle denylist (plan section 10, "Other apps' binaries"). Pure string checks, usable on any OS for either path style.
 * A `claude` that lives inside another application's bundle must never be run.
 */
const WIN_BUNDLE_PATTERNS: RegExp[] = [
  /\\program files( \(x86\))?\\claude(\\|$)/i,
  /\\anthropicclaude(\\|$)/i, // %LOCALAPPDATA%\AnthropicClaude (Squirrel install of the desktop app)
  /\\windowsapps(\\|$)/i,
  /\\packages\\claude_[^\\]*(\\|$)/i,
];
const APP_BUNDLE = /\.app(\/|$)/i;

/** Returns the reason a path is refused, or null when it is acceptable. */
export function bundleRefusal(p: string): string | null {
  const win = p.replace(/\//g, '\\');
  if (APP_BUNDLE.test(p.replace(/\\/g, '/'))) return `refusing ${p}: inside an .app bundle`;
  for (const re of WIN_BUNDLE_PATTERNS) if (re.test(win)) return `refusing ${p}: inside another application's install folder`;
  return null;
}
