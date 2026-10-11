// S6 timing: node txwatch.mjs <file.jsonl> [seconds]. Polls every 10 ms; logs wall-clock time at which each new transcript line becomes readable.
import fs from 'node:fs';
const [, , file, secs = '120'] = process.argv;
const out = fs.createWriteStream(new URL('./out/txwatch.log', import.meta.url), { flags: 'a' });
let seen = 0, buf = '';
const end = Date.now() + Number(secs) * 1000;
const tick = () => {
  try {
    const size = fs.statSync(file).size;
    if (size > seen) {
      const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(size - seen); fs.readSync(fd, b, 0, b.length, seen); fs.closeSync(fd);
      seen = size; buf += b.toString('utf8');
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(l); out.write(`${new Date().toISOString()} seen type=${j.type} sub=${j.subtype ?? j.attachment?.type ?? ''} rec_ts=${j.timestamp ?? '-'} tool=${JSON.stringify(j.message?.content?.[0]?.name ?? j.message?.content?.[0]?.type ?? '')}\n`); } catch { out.write(`${new Date().toISOString()} partial/unparsable line ${l.length}b\n`); }
      }
    }
  } catch {}
  if (Date.now() < end) setTimeout(tick, 10); else out.end();
};
tick();
