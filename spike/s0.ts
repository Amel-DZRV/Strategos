import pty from 'node-pty';
const p = pty.spawn('cmd.exe', ['/c', 'echo s0-ok'], { name: 'xterm-256color', cols: 80, rows: 24 });
let out = ''; p.onData(d => (out += d));
p.onExit(({ exitCode }) => { console.log(JSON.stringify(out.slice(0, 200)), 'exit', exitCode); process.exit(exitCode); });
