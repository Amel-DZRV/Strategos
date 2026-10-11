// Hook logger / holder on 127.0.0.1:47801.
//
// Response shapes (https://code.claude.com/docs/en/hooks):
//  PermissionRequest allow:
//   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
//   + optional "updatedInput":{...} (replaces entire input) and "updatedPermissions":[ <entry> ] inside decision
//     entry e.g. {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"..."}],"behavior":"allow","destination":"localSettings"}
//     (entries come from request.permission_suggestions and are passed back verbatim)
//  PermissionRequest deny:
//   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"<why>"}}}  (+ optional "interrupt":true)
//  PreToolUse (AskUserQuestion answer):
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
//     "updatedInput":{"questions":[...echoed...],"answers":{"<question text>":"<option label>"}}}}
//  PreToolUse allow/deny generic: permissionDecision "allow"|"deny"|"ask"|"defer", permissionDecisionReason.
//  "none" = 200 with empty body (no decision -> normal TUI dialog).
//
// Stdin / POST /ctl commands act on the OLDEST held request:
//   allow | deny <msg> | always <i> | answer <json answers-map or {questions,answers}> | none | drop
import http from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
for (const d of ['hooks', 'statusline']) mkdirSync(join(out, d), { recursive: true });
const PORT = Number(process.env.HOOKLOG_PORT || 47801);
const logf = join(out, 'hooklog.log');
const log = (...a: unknown[]) => { const l = `${new Date().toISOString()} ${a.join(' ')}`; console.log(l); appendFileSync(logf, l + '\n'); };

interface Held { id: number; res: http.ServerResponse; body: any; event: string; since: number; closed: boolean }
const held: Held[] = [];
let seq = 0;
let postNote = '';

function respond(h: Held, kind: string, arg = ''): string {
  const ev = h.event;
  const send = (obj?: unknown) => {
    if (obj === undefined) { h.res.writeHead(200).end(); } else {
      h.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    }
  };
  const isPerm = ev === 'PermissionRequest';
  const dec = (d: any) => send({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
  switch (kind) {
    case 'allow':
      if (isPerm) dec({ behavior: 'allow' });
      else send({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
      break;
    case 'deny':
      if (isPerm) dec({ behavior: 'deny', message: arg || 'Denied by Strategos spike' });
      else send({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: arg || 'Denied by Strategos spike' } });
      break;
    case 'always': {
      const sug = h.body?.permission_suggestions?.[Number(arg || 0)];
      if (!isPerm) return 'always only for PermissionRequest';
      if (!sug) return 'no such suggestion';
      dec({ behavior: 'allow', updatedPermissions: [sug] });
      break;
    }
    case 'answer': {
      if (ev !== 'PreToolUse') return 'answer only for PreToolUse(AskUserQuestion)';
      let parsed: any;
      try { parsed = JSON.parse(arg); } catch { return 'bad json'; }
      const questions = parsed.questions ?? h.body?.tool_input?.questions;
      const answers = parsed.answers ?? parsed;
      send({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions, answers } } });
      break;
    }
    case 'none': send(); break;
    case 'drop': h.res.socket?.destroy(); break;
    default: return 'unknown cmd';
  }
  return 'ok';
}

function command(line: string): string {
  const m = line.trim().match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return 'empty';
  if (m[1] === 'list') return JSON.stringify(held.map((h) => ({ id: h.id, event: h.event, tool: h.body?.tool_name, closed: h.closed, ageS: Math.round((Date.now() - h.since) / 1000) })));
  if (m[1] === 'note') { postNote = m[2]; return 'postNote=' + JSON.stringify(postNote); }
  const h = held.shift();
  if (!h) return 'nothing held';
  const r = respond(h, m[1], m[2]);
  log(`cmd ${m[1]} -> held#${h.id} ${h.event} ${r}`);
  if (r !== 'ok') held.unshift(h);
  return r;
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = req.url || '/';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    if (url === '/ctl' && req.method === 'POST') {
      let c: any = {};
      try { c = JSON.parse(raw); } catch {}
      const r = command(`${c.cmd ?? ''} ${typeof c.arg === 'string' ? c.arg : c.arg !== undefined ? JSON.stringify(c.arg) : (c.msg ?? '')}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: r }));
      return;
    }
    let body: any = raw;
    try { body = JSON.parse(raw); } catch {}
    const sl = url.match(/^\/statusline\/([^/?]+)/);
    if (sl) {
      writeFileSync(join(out, 'statusline', `${ts}-${sl[1]}.json`), JSON.stringify({ headers: req.headers, body }, null, 2));
      log('statusline', sl[1], raw.length, 'bytes');
      res.writeHead(200).end();
      return;
    }
    const hm = url.match(/^\/hook\/([^/]+)\/([^/?]+)/);
    if (!hm) { res.writeHead(404).end(); return; }
    const [, sid, event] = hm;
    writeFileSync(join(out, 'hooks', `${ts}-${event}.json`), JSON.stringify({ url, headers: req.headers, body }, null, 2));
    const tool = body?.tool_name;
    log('hook', event, sid, tool ?? '', 'token=' + (req.headers['x-strategos-token'] ? 'present' : 'MISSING'), 'session_id=' + (body?.session_id ?? '-'));
    const hold = event === 'PermissionRequest' || (event === 'PreToolUse' && tool === 'AskUserQuestion');
    if (!hold) {
      if (event === 'PostToolUse' && postNote) {
        log('PostToolUse respond additionalContext=' + postNote);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: postNote } }));
      } else res.writeHead(200).end();
      return;
    }
    const h: Held = { id: ++seq, res, body, event, since: Date.now(), closed: false };
    held.push(h);
    // NOTE: Node emits req 'close' as soon as the request body is consumed, NOT on client disconnect; res 'close' with finished=false is the disconnect signal.
    req.on('close', () => { log(`held#${h.id} ${event} req 'close' (responseSent=${res.writableEnded})`); });
    res.on('close', () => {
      h.closed = true; log(`held#${h.id} ${event} res 'close' (finished=${res.writableFinished})`);
      const i = held.indexOf(h); if (i >= 0) held.splice(i, 1);
    });
    log(`HELD#${h.id} ${event} ${tool ?? ''} suggestions=${body?.permission_suggestions?.length ?? 0}`);
  });
});
server.listen(PORT, '127.0.0.1', () => log('hooklog listening on 127.0.0.1:' + PORT));
readline.createInterface({ input: process.stdin }).on('line', (l) => { if (l.trim()) console.log(command(l)); });
