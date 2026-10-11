// The real Claude Code terminal (xterm.js) for one session. The xterm instance lives in a ref and is created once per
// mount: the Drawer keys this component by strategosId, and signal updates never touch it (plan D4).
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { isLeaveTerminal, leaveTerminalLabel } from '../keys/keymap.ts';
import { shell } from '../shell-bridge.ts';
import { fire, onChannel } from '../state/commands.ts';
import { store } from '../state/store.ts';

export interface TerminalPaneProps {
  strategosId: string;
  /** Called after Ctrl+Alt+M / Cmd+Shift+M: the owner wants the keyboard back for the app. */
  onLeave?: () => void;
}

export function TerminalPane({ strategosId, onLeave }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const leave = useRef(onLeave);
  leave.current = onLeave;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: '#090c15', foreground: '#e8ecf2', cursor: '#e8ecf2', selectionBackground: '#2f54d655' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => shell.openExternal(uri)));
    term.open(el);

    const dims = () => ({ cols: Math.max(2, term.cols), rows: Math.max(1, term.rows) });
    const safeFit = () => {
      // Hidden tabs measure 0x0; fitting then would shrink the pty to nothing.
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try { fit.fit(); } catch { /* measured while detached */ }
      }
    };
    safeFit();

    // Escape hatch: this chord is the only key that does not go to Claude.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && isLeaveTerminal(e)) {
        e.preventDefault();
        term.blur();
        leave.current?.();
        return false;
      }
      return true;
    });

    const subs = [
      term.onData((data) => fire({ c: 'pty.input', strategosId, data })),
      term.onResize(() => fire({ c: 'pty.resize', strategosId, ...dims() })),
    ];

    const offChannel = onChannel((ev) => {
      if (ev.t === 'pty.replay' && ev.strategosId === strategosId) {
        term.reset(); // a (re)subscribe replays the whole scrollback
        term.write(ev.data);
      } else if (ev.t === 'pty.data' && ev.strategosId === strategosId) {
        term.write(ev.data);
      }
    });

    // Subscribe now and again after every reconnect: the daemon forgets subscriptions with the socket.
    let wasOpen = false;
    const stopEffect = effect(() => {
      const open = store.connection.value === 'open';
      if (open && !wasOpen) {
        safeFit();
        fire({ c: 'pty.subscribe', strategosId, ...dims() });
      }
      wasOpen = open;
    });

    const ro = new ResizeObserver(() => safeFit());
    ro.observe(el);

    const onFocusIn = () => fire({ c: 'pty.focus', strategosId });
    el.addEventListener('focusin', onFocusIn);

    return () => {
      el.removeEventListener('focusin', onFocusIn);
      ro.disconnect();
      stopEffect();
      offChannel();
      for (const s of subs) s.dispose();
      fire({ c: 'pty.unsubscribe', strategosId });
      term.dispose();
    };
  }, [strategosId]);

  return (
    <div class="term-wrap">
      <div ref={host} class="term" data-testid="terminal" aria-label="Claude Code terminal" />
      <p class="term-hint mono">{leaveTerminalLabel()} leaves the terminal</p>
    </div>
  );
}
