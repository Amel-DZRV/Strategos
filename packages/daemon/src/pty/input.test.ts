import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputTracker, bracketedPaste, pasteAndSubmit, PASTE_END, PASTE_START, type KeyEvent } from './input.ts';

describe('InputTracker: Esc and Ctrl+C', () => {
  let t: InputTracker;
  let keys: KeyEvent[];
  beforeEach(() => {
    vi.useFakeTimers();
    t = new InputTracker();
    keys = [];
    t.onKey((e) => keys.push(e));
  });
  afterEach(() => { t.dispose(); vi.useRealTimers(); });

  it('a lone "\\x1b" with nothing after it for 50 ms is Esc', () => {
    t.feed('\x1b', 'user');
    vi.advanceTimersByTime(49);
    expect(keys).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(keys).toEqual([{ key: 'esc', fromStrategos: false }]);
  });

  it('a follow-up byte inside 50 ms makes it an escape sequence: no Esc event', () => {
    t.feed('\x1b', 'user');
    vi.advanceTimersByTime(20);
    t.feed('[A', 'user');
    vi.advanceTimersByTime(200);
    expect(keys).toEqual([]);
  });

  it.each(['\x1b[A', '\x1b[1;5C', '\x1bOP', '\x1b[3~', '\x1bf', '\x1b[200~\x1b[201~'])('escape sequence %j in one chunk is not Esc', (seq) => {
    t.feed(seq, 'user');
    vi.advanceTimersByTime(200);
    expect(keys).toEqual([]);
  });

  it('a sequence split across chunks inside the window is not Esc, and a later lone Esc still is', () => {
    t.feed('\x1b[', 'user');
    t.feed('1;5', 'user');
    t.feed('D', 'user');
    vi.advanceTimersByTime(200);
    expect(keys).toEqual([]);
    t.feed('\x1b', 'user');
    vi.advanceTimersByTime(60);
    expect(keys).toEqual([{ key: 'esc', fromStrategos: false }]);
  });

  it('Esc after more than 50 ms silence then another key are two separate events', () => {
    t.feed('\x1b', 'user');
    vi.advanceTimersByTime(60);
    t.feed('[', 'user'); // a literal "[" typed afterwards, not a sequence
    expect(keys).toHaveLength(1);
    expect(t.dirtyInput).toBe(true);
  });

  it('two Esc presses give two events', () => {
    t.feed('\x1b', 'user');
    vi.advanceTimersByTime(60);
    t.feed('\x1b', 'user');
    vi.advanceTimersByTime(60);
    expect(keys).toHaveLength(2);
  });

  it('records who sent it', () => {
    t.feed('\x1b', 'strategos');
    vi.advanceTimersByTime(60);
    t.feed('\x03', 'strategos');
    t.feed('\x03', 'user');
    expect(keys).toEqual([
      { key: 'esc', fromStrategos: true },
      { key: 'ctrl_c', fromStrategos: true },
      { key: 'ctrl_c', fromStrategos: false },
    ]);
  });

  it('Ctrl+C is reported immediately, also inside a longer chunk', () => {
    t.feed('abc\x03', 'user');
    expect(keys).toEqual([{ key: 'ctrl_c', fromStrategos: false }]);
  });

  it('dispose cancels a pending Esc', () => {
    t.feed('\x1b', 'user');
    t.dispose();
    vi.advanceTimersByTime(100);
    expect(keys).toEqual([]);
  });
});

describe('InputTracker: dirtyInput', () => {
  it('printable user input sets it; "\\r", Ctrl+C and Ctrl+U clear it', () => {
    const t = new InputTracker();
    expect(t.dirtyInput).toBe(false);
    t.feed('h', 'user'); expect(t.dirtyInput).toBe(true);
    t.feed('\r', 'user'); expect(t.dirtyInput).toBe(false);
    t.feed('hello', 'user'); expect(t.dirtyInput).toBe(true);
    t.feed('\x03', 'user'); expect(t.dirtyInput).toBe(false);
    t.feed('x', 'user'); t.feed('\x15', 'user'); expect(t.dirtyInput).toBe(false);
    t.feed('é世', 'user'); expect(t.dirtyInput).toBe(true);
  });

  it('control keys, arrows and Esc do not set it', () => {
    const t = new InputTracker();
    t.feed('\x1b[A\x1b[B\x1bOP\t\x7f\x08\x01\x05', 'user');
    expect(t.dirtyInput).toBe(false);
  });

  it('Strategos-origin text never sets it, but its clearing keys clear it', () => {
    const t = new InputTracker();
    t.feed('typed', 'user');
    t.feed('more', 'strategos');
    expect(t.dirtyInput).toBe(true);
    t.feed('\r', 'strategos');
    expect(t.dirtyInput).toBe(false);
    t.feed(bracketedPaste('a reply'), 'strategos');
    expect(t.dirtyInput).toBe(false);
  });

  it('a user bracketed paste sets it (even split across chunks); an empty paste does not', () => {
    const t = new InputTracker();
    t.feed(PASTE_START + 'pas', 'user');
    expect(t.dirtyInput).toBe(false);
    t.feed('ted' + PASTE_END, 'user');
    expect(t.dirtyInput).toBe(true);
    t.feed('\r', 'user');
    t.feed(PASTE_START + PASTE_END, 'user');
    expect(t.dirtyInput).toBe(false);
  });

  it('escape sequence payload letters are not typed text', () => {
    const t = new InputTracker();
    t.feed('\x1b[1;5C\x1b[15~', 'user');
    expect(t.dirtyInput).toBe(false);
  });
});

describe('bracketedPaste / pasteAndSubmit', () => {
  it('wraps the text in the paste markers', () => {
    expect(bracketedPaste('hi')).toBe('\x1b[200~hi\x1b[201~');
  });
  it('removes embedded markers so the paste cannot end early', () => {
    const evil = 'a' + PASTE_END + '\rrm -rf /' + PASTE_START + 'b';
    const out = bracketedPaste(evil);
    expect(out.startsWith(PASTE_START) && out.endsWith(PASTE_END)).toBe(true);
    expect(out.slice(PASTE_START.length, -PASTE_END.length)).toBe('a\rrm -rf /b');
    expect(out.split(PASTE_END)).toHaveLength(2);
  });
  it('pasteAndSubmit writes the paste, then "\\r", both with the given origin', async () => {
    vi.useFakeTimers();
    const writes: [string, string][] = [];
    const p = pasteAndSubmit({ write: (d, o) => writes.push([d, o]) }, 'hello', { delayMs: 100 });
    expect(writes).toEqual([['\x1b[200~hello\x1b[201~', 'strategos']]);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(writes[1]).toEqual(['\r', 'strategos']);
    vi.useRealTimers();
  });
});
