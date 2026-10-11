import { act, render } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../test/cleanup.ts';
import { store } from '../state/store.ts';
import { installFakeTransport, type FakeTransport } from '../test/fakes.ts';

// xterm needs a real canvas and layout; the pane's wiring is what we test, so replace it with a recorder.
const h = vi.hoisted(() => {
  const instances: Array<{
    cols: number; rows: number; written: string[]; resets: number; disposed: boolean; blurred: number;
    data?: (d: string) => void; resize?: () => void;
    keyHandler?: (e: KeyboardEvent) => boolean;
  }> = [];
  return { instances, fits: { count: 0 } };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100; rows = 30;
    rec: (typeof h.instances)[number];
    constructor() {
      this.rec = { cols: 100, rows: 30, written: [], resets: 0, disposed: false, blurred: 0 };
      h.instances.push(this.rec);
    }
    loadAddon() {}
    open() {}
    write(d: string) { this.rec.written.push(d); }
    reset() { this.rec.resets++; }
    blur() { this.rec.blurred++; }
    dispose() { this.rec.disposed = true; }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) { this.rec.keyHandler = fn; }
    onData(fn: (d: string) => void) { this.rec.data = fn; return { dispose() {} }; }
    onResize(fn: () => void) { this.rec.resize = fn; return { dispose() {} }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { h.fits.count++; } } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { TerminalPane } from './TerminalPane.tsx';

class RO { observe() {} disconnect() {} }
let t: FakeTransport;
beforeEach(() => {
  h.instances.length = 0;
  vi.stubGlobal('ResizeObserver', RO);
  t = installFakeTransport();
  store.connection.value = 'open';
});

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });

describe('TerminalPane', () => {
  it('subscribes with the terminal size on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<TerminalPane strategosId="a" />);
    expect(t.sent).toEqual([{ c: 'pty.subscribe', strategosId: 'a', cols: 100, rows: 30 }]);
    unmount();
    expect(t.sent.at(-1)).toEqual({ c: 'pty.unsubscribe', strategosId: 'a' });
    expect(h.instances[0]!.disposed).toBe(true);
  });

  it('renders replay (after a reset) and then live data, only for its own session', () => {
    render(<TerminalPane strategosId="a" />);
    const term = h.instances[0]!;
    act(() => {
      t.emit({ t: 'pty.replay', strategosId: 'a', data: 'old screen' });
      t.emit({ t: 'pty.data', strategosId: 'a', data: 'live 1' });
      t.emit({ t: 'pty.data', strategosId: 'other', data: 'not mine' });
    });
    expect(term.resets).toBe(1);
    expect(term.written).toEqual(['old screen', 'live 1']);
  });

  it('sends keystrokes as pty.input', () => {
    render(<TerminalPane strategosId="a" />);
    h.instances[0]!.data!('ls\r');
    expect(t.sent.at(-1)).toEqual({ c: 'pty.input', strategosId: 'a', data: 'ls\r' });
  });

  it('sends pty.resize when the terminal is resized', () => {
    render(<TerminalPane strategosId="a" />);
    h.instances[0]!.resize!();
    expect(t.sent.at(-1)).toEqual({ c: 'pty.resize', strategosId: 'a', cols: 100, rows: 30 });
  });

  it('sends pty.focus when the terminal gains focus', () => {
    const { getByTestId } = render(<TerminalPane strategosId="a" />);
    getByTestId('terminal').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(t.sent.at(-1)).toEqual({ c: 'pty.focus', strategosId: 'a' });
  });

  it('leaves the terminal on Ctrl+Alt+M (Windows) and lets every other key through to Claude', () => {
    const onLeave = vi.fn();
    render(<TerminalPane strategosId="a" onLeave={onLeave} />);
    const term = h.instances[0]!;
    expect(term.keyHandler!(key({ key: 'm', ctrlKey: true, altKey: true }))).toBe(false);
    expect(term.blurred).toBe(1);
    expect(onLeave).toHaveBeenCalledOnce();
    expect(term.keyHandler!(key({ key: 'm' }))).toBe(true);
    expect(term.keyHandler!(key({ key: 'c', ctrlKey: true }))).toBe(true); // Ctrl+C is Claude's
    expect(term.keyHandler!(key({ key: 'Escape' }))).toBe(true);
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('creates one xterm instance and keeps it across re-renders and signal updates', () => {
    const { rerender } = render(<TerminalPane strategosId="a" />);
    rerender(<TerminalPane strategosId="a" onLeave={() => undefined} />);
    act(() => { store.connection.value = 'reconnecting'; });
    act(() => { store.connection.value = 'open'; });
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.disposed).toBe(false);
  });

  it('subscribes again after a reconnect, because the daemon forgets subscriptions with the socket', () => {
    render(<TerminalPane strategosId="a" />);
    act(() => { store.connection.value = 'reconnecting'; });
    act(() => { store.connection.value = 'open'; });
    expect(t.sent.filter((c) => c.c === 'pty.subscribe')).toHaveLength(2);
  });

  it('waits for the connection before subscribing', () => {
    store.connection.value = 'connecting';
    render(<TerminalPane strategosId="a" />);
    expect(t.sent).toEqual([]);
    act(() => { store.connection.value = 'open'; });
    expect(t.sent).toHaveLength(1);
  });

  it('makes a new terminal for a different session', () => {
    const { rerender } = render(<TerminalPane key="a" strategosId="a" />);
    rerender(<TerminalPane key="b" strategosId="b" />);
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.disposed).toBe(true);
    expect(t.sent.map((c) => c.c)).toEqual(['pty.subscribe', 'pty.unsubscribe', 'pty.subscribe']);
  });
});
