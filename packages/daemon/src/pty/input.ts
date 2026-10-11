// Keystroke tracking for a pty (plan sections 4 "pty/*" and 6 "interrupted", task 1.09).
// Everything written to the pty goes through InputTracker.feed(), which maintains `dirtyInput` and detects Esc / Ctrl+C.

export type InputOrigin = 'user' | 'strategos';
export interface KeyEvent { key: 'esc' | 'ctrl_c'; fromStrategos: boolean }

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Lone Esc: "\x1b" with no following byte within this many ms. Anything else starting with ESC is an escape sequence. */
export const LONE_ESC_MS = 50;

/**
 * Wrap text as a bracketed paste. Any paste markers inside the text are removed first, so pasted content cannot end the
 * paste early and have the rest interpreted as keystrokes.
 */
export function bracketedPaste(text: string): string {
  return PASTE_START + text.split(PASTE_START).join('').split(PASTE_END).join('') + PASTE_END;
}

/** Paste a prompt and submit it: bracketed paste, a short pause so the TUI has processed it, then "\r" (spike: 400 ms was safe). */
export async function pasteAndSubmit(
  target: { write(d: string, origin: InputOrigin): void },
  text: string,
  opts: { delayMs?: number; origin?: InputOrigin } = {},
): Promise<void> {
  const origin = opts.origin ?? 'strategos';
  target.write(bracketedPaste(text), origin);
  await new Promise((r) => setTimeout(r, opts.delayMs ?? 150));
  target.write('\r', origin);
}

type State = 'normal' | 'esc' | 'csi' | 'ss3' | 'paste';

export class InputTracker {
  /** The user typed something into the prompt that has not been submitted or cleared. */
  dirtyInput = false;

  private state: State = 'normal';
  private csiParams = '';
  private pasteTail = '';
  private pasteLen = 0;
  private escTimer: ReturnType<typeof setTimeout> | undefined;
  private escFromStrategos = false;
  private readonly listeners = new Set<(e: KeyEvent) => void>();
  private readonly escMs: number;

  constructor(opts: { escMs?: number } = {}) {
    this.escMs = opts.escMs ?? LONE_ESC_MS;
  }

  onKey(cb: (e: KeyEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(e: KeyEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }

  dispose(): void {
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = undefined;
    this.listeners.clear();
  }

  feed(data: string, origin: InputOrigin): void {
    const chars = Array.from(data);
    const fromStrategos = origin === 'strategos';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      switch (this.state) {
        case 'esc':
          if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = undefined; }
          // ESC followed by a byte: a sequence (arrow, function key) or Alt+key. Never a lone Esc.
          if (ch === '[') { this.state = 'csi'; this.csiParams = ''; } else if (ch === 'O') this.state = 'ss3'; else this.state = 'normal';
          break;
        case 'ss3':
          this.state = 'normal';
          break;
        case 'csi': {
          const c = ch.charCodeAt(0);
          if (c >= 0x30 && c <= 0x3f) this.csiParams += ch;
          else if (c >= 0x20 && c <= 0x2f) { /* intermediate byte */ } else {
            if (ch === '~' && this.csiParams === '200') { this.state = 'paste'; this.pasteTail = ''; this.pasteLen = 0; } else this.state = 'normal';
          }
          break;
        }
        case 'paste':
          this.pasteTail = (this.pasteTail + ch).slice(-PASTE_END.length);
          this.pasteLen++;
          if (this.pasteTail === PASTE_END) {
            this.state = 'normal';
            if (this.pasteLen - PASTE_END.length > 0 && !fromStrategos) this.dirtyInput = true;
          }
          break;
        default:
          if (ch === '\x1b') {
            this.state = 'esc';
            this.escFromStrategos = fromStrategos;
            if (i === chars.length - 1) this.armEscTimer();
          } else if (ch === '\x03') {
            this.dirtyInput = false;
            this.emit({ key: 'ctrl_c', fromStrategos });
          } else if (ch === '\r' || ch === '\x15') {
            this.dirtyInput = false;
          } else if (ch >= ' ' && ch !== '\x7f') {
            if (!fromStrategos) this.dirtyInput = true;
          }
      }
    }
  }

  private armEscTimer(): void {
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = setTimeout(() => {
      this.escTimer = undefined;
      if (this.state !== 'esc') return;
      this.state = 'normal';
      this.emit({ key: 'esc', fromStrategos: this.escFromStrategos });
    }, this.escMs);
  }
}
