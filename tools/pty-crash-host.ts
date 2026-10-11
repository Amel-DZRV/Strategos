// Helper for the pty crash test (plan section 9, "ConPTY/forkpty crash test"): stands in for the daemon.
// It spawns a long-lived node child under a pty, prints "child:<pid>" and then idles until it is killed hard.
//   node tools/pty-crash-host.ts
import pty from 'node-pty';

const p = pty.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string>,
});
process.stdout.write(`child:${p.pid}\n`);
p.onData(() => undefined);
setInterval(() => undefined, 1000);
