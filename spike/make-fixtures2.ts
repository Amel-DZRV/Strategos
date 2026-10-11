// Batch 2 fixtures -> ../fixtures/claude/2.1.292/{hooks,statusline,transcripts,sessions}. Same redaction as make-fixtures.ts:
// home path (all spellings, incl. 8.3 temp path) -> "~"; *token* keys -> "<redacted>"; strings over 2 KB cut; non-hook attachments and user email dropped.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'fixtures', 'claude', '2.1.292');
const home = homedir();
const BS = String.fromCharCode(92);
const variants = (p: string) => [p, p.split(BS).join(BS + BS), p.split(BS).join('/')];
const spellings = [...variants(home), ...variants('C:' + BS + 'Users' + BS + 'OWNER~1.PCE'), ...variants('C:' + BS + 'Users' + BS + 'Owner.PC-EXAMPLE')];
function redactStr(s: string): string {
  for (const sp of spellings) s = s.split(sp).join('~');
  if (s.length > 2048) s = s.slice(0, 2048) + `...[cut, ${s.length} chars total]`;
  return s;
}
function redact(v: any): any {
  if (typeof v === 'string') return redactStr(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') { const o: any = {}; for (const [k, x] of Object.entries(v)) o[k] = /token/i.test(k) && typeof x === 'string' ? '<redacted>' : redact(x); return o; }
  return v;
}
const out = (sub: string, name: string, data: unknown) => { const d = join(root, sub); mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), JSON.stringify(redact(data), null, 2) + '\n'); };

// hooks by capture timestamp (UTC, hooklog file name stem)
const hookFile = (stem: string) => { const ev = stem.split('Z-')[1]; const f = readdirSync(join(here, 'out/hooks')).find((x) => x.startsWith(stem.slice(0, 19)) && x.endsWith('-' + ev + '.json')); if (!f) { console.log('MISSING hook', stem); return null; } return JSON.parse(readFileSync(join(here, 'out/hooks', f), 'utf8')); };
const H: [string, string][] = [
  ['2026-10-11T13-23-24-062Z-SessionEnd', 'SessionEnd-reason-clear.json'],
  ['2026-10-11T13-23-24-445Z-SessionStart', 'SessionStart-source-clear.json'],
  ['2026-10-11T13-23-56-978Z-SessionEnd', 'SessionEnd-reason-resume.json'],
  ['2026-10-11T13-23-57-194Z-SessionStart', 'SessionStart-source-resume.json'],
  ['2026-10-11T13-24-09-694Z-SessionStart', 'SessionStart-source-fork-after-branch.json'],
  ['2026-10-11T13-25-27-224Z-SessionStart', 'SessionStart-source-clear-after-handoff-now.json'],
  ['2026-10-11T13-27-56-731Z-SessionStart', 'SessionStart-source-compact.json'],
  ['2026-10-11T13-26-43-540Z-SubagentStart', 'SubagentStart.json'],
  ['2026-10-11T13-26-26-515Z-PermissionRequest', 'PermissionRequest-Edit-with-suggestion.json'],
  ['2026-10-11T13-28-37-792Z-PostToolUse', 'PostToolUse-Edit.json'],
  ['2026-10-11T13-24-44-062Z-PermissionRequest', 'PermissionRequest-ExitPlanMode.json'],
  ['2026-10-11T13-24-44-052Z-PreToolUse', 'PreToolUse-ExitPlanMode.json'],
  ['2026-10-11T13-30-07-838Z-SessionStart', 'SessionStart-agent-view-background-job-b755246d.json'],
];
for (const [stem, name] of H) { const j = hookFile(stem); if (j) out('hooks', name, j); }
const near = (prefix: string, ev: string, name: string) => { const f = readdirSync(join(here, 'out/hooks')).find((x) => x.startsWith(prefix) && x.endsWith(`-${ev}.json`)); if (f) out('hooks', name, JSON.parse(readFileSync(join(here, 'out/hooks', f), 'utf8'))); else console.log('MISSING', prefix, ev); };
near('2026-10-11T13-26-5', 'SubagentStop', 'SubagentStop-after-agent-tool.json');
near('2026-10-11T13-22-', 'UserPromptSubmit', 'UserPromptSubmit-plain.json');
near('2026-10-11T13-19-16-1', 'PermissionRequest', 'PermissionRequest-Bash-before-esc.json');
out('hooks', 'RESPONSE-NOTE-interrupts.json', { note: 'No hook JSON exists for Esc/Ctrl+C. After Esc at a held PermissionRequest the only observable signal on the hook channel is the held HTTP connection closing (res close, finished=false). Esc/Ctrl+C mid-text and mid-tool produce no hook at all (no Stop, no PostToolUseFailure).' });

// status line
const slDir = join(here, 'out/statusline');
const sl = (stem: string) => { const f = readdirSync(slDir).find((x) => x.startsWith(stem.slice(0, 19)) && x.includes('sp-2b642ca4')); return f ? JSON.parse(readFileSync(join(slDir, f), 'utf8')) : null; };
for (const [stem, name] of [
  ['2026-10-11T13-22-33-605Z', 'statusline-prompt-cache-ttl-1h-expires-at.json'],
  ['2026-10-11T13-23-24-613Z', 'statusline-after-clear-cost-zero-new-session-id.json'],
  ['2026-10-11T13-23-57-606Z', 'statusline-after-resume-cost-carried.json'],
] as const) { const j = sl(stem); if (j) out('statusline', name, j); else console.log('MISSING statusline', stem); }
{ // fork (after the first turn in the branch) and the agent-view case
  const f = readdirSync(slDir).filter((x) => x.includes('sp-2b642ca4')).find((x) => JSON.parse(readFileSync(join(slDir, x), 'utf8')).body.session_id?.startsWith('a724513b') && JSON.parse(readFileSync(join(slDir, x), 'utf8')).body.cost?.total_cost_usd > 0);
  if (f) out('statusline', 'statusline-after-branch-cost-reset-to-fresh.json', JSON.parse(readFileSync(join(slDir, f), 'utf8')));
}

// sessions/<pid>.json samples (copied verbatim from read-only captures during the run; no home path inside)
const sessions = (name: string, o: unknown) => out('sessions', name, o);
sessions('sessions-pid-idle.json', { pid: 72176, sessionId: '2b642ca4-5e54-488b-9296-a93ec5240351', cwd: 'C:\\dev\\strategos-sandbox', startedAt: 1791724741307, procStart: '134361983384878048', version: '2.1.292', peerProtocol: 1, peerFeatures: ['notify_idle', 'artifact_yield'], kind: 'interactive', entrypoint: 'cli', pidDomain: 'win32:<host>', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-<redacted>', name: 'spike-sp-2b642ca4', nameSource: 'user', nameSince: 1791724741325, updatedAt: 1791724741871, status: 'idle', statusUpdatedAt: 1791724741871 });
sessions('sessions-pid-waiting-permission-prompt.json', { pid: 72176, sessionId: '2b642ca4-5e54-488b-9296-a93ec5240351', cwd: 'C:\\dev\\strategos-sandbox', version: '2.1.292', kind: 'interactive', entrypoint: 'cli', name: 'spike-sp-2b642ca4', updatedAt: 1791724756123, status: 'waiting', statusUpdatedAt: 1791724756123, waitingFor: 'permission prompt', note: 'captured while a PermissionRequest was held by the hook server; other fields as in sessions-pid-idle.json' });
sessions('sessions-pid-after-agent-view-left-arrow.json', { pid: 64760, sessionId: 'f005c380-32b6-4553-ba82-5c46a3030196', cwd: 'C:\\dev\\strategos-sandbox', kind: 'interactive', status: 'idle', parkedJobId: 'b755246d', note: 'pty process after ArrowLeft with Agent View enabled: file keeps the OLD session id and gains parkedJobId; the live conversation is in a separate kind:"background" process (claude agents --json: {pid:56692,id:"b755246d",kind:"background",sessionId:"b755246d-...",state:"blocked"})' });

// transcripts
const tdir = join(home, '.claude', 'projects', 'C--dev-strategos-sandbox');
const load = (id: string) => readFileSync(join(tdir, id + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((j) => (j.type !== 'attachment' || String(j.attachment?.type).startsWith('hook_')) && !/userEmail|totalTokens|total_tokens/.test(JSON.stringify(j)));
const wr = (name: string, lines: any[]) => { const d = join(root, 'transcripts'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), lines.map((j) => JSON.stringify(redact(j))).join('\n') + '\n'); };
const slice = (lines: any[], name: string, from: RegExp, to: RegExp, extra = 0, skipEnds = 0) => {
  const a = lines.findIndex((j) => from.test(JSON.stringify(j))); if (a < 0) return console.log('MISSING transcript', name);
  let b = a; let skip = skipEnds;
  for (let i = a + 1; i < lines.length; i++) { if (to.test(JSON.stringify(lines[i]))) { if (skip-- > 0) continue; b = i; break; } b = i; }
  wr(name, lines.slice(a, Math.min(lines.length, b + 1 + extra)));
};
const A = load('2b642ca4-5e54-488b-9296-a93ec5240351');
slice(A, 'interrupt-esc-at-permission-dialog.jsonl', /Run the shell command: echo strategos-probe/, /Request interrupted by user for tool use/, 2);
slice(A, 'interrupt-esc-mid-text.jsonl', /3000 word essay about oceans/, /\[Request interrupted by user\]/, 2);
slice(A, 'interrupt-esc-mid-tool.jsonl', /Run the shell command: ping -n 8/, /Request interrupted by user for tool use/, 2);
slice(A, 'interrupt-ctrl-c-mid-text.jsonl', /3000 word essay about forests/, /\[Request interrupted by user\]/, 2);
slice(A, 'interrupt-esc-before-first-token.jsonl', /Count slowly from 1 to 300/, /Count slowly from 1 to 300/, 3);
const B = load('990be0c6-1eac-4eb7-ad48-099938dd211c');
slice(B, 'turn-write-permission-allowed.jsonl', /Create the file probe.md/, /"turn_duration"/);
slice(B, 'turn-edit-permission-allowed-diff.jsonl', /Edit probe.md: change hello to goodbye/, /"turn_duration"/);
slice(B, 'turn-subagent-agent-tool-background.jsonl', /Use a subagent \(the Agent tool\)/, /"turn_duration"/, 0, 1);
slice(B, 'turn-compact-command-and-boundary.jsonl', /"content":"\/compact"/, /compact_boundary/, 6);
const C = load('a724513b-1738-4b67-b375-2ef6ce2e0669');
slice(C, 'turn-plan-mode-exitplanmode.jsonl', /Plan only: a one-step plan/, /ExitPlanMode.*tool_result|Request interrupted/, 1);
// subagent transcript (head) + meta
const sdir = join(tdir, '990be0c6-1eac-4eb7-ad48-099938dd211c', 'subagents');
if (existsSync(sdir)) {
  const jf = readdirSync(sdir).find((f) => f.endsWith('.jsonl'));
  if (jf) { const ls = readFileSync(join(sdir, jf), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((j) => (j.type !== 'attachment' || String(j.attachment?.type).startsWith('hook_')) && !/userEmail|totalTokens|total_tokens/.test(JSON.stringify(j))); wr('subagent-agent-jsonl-head-and-tail.jsonl', [...ls.slice(0, 6), ...ls.slice(-4)]); }
  const mf = readdirSync(sdir).find((f) => f.endsWith('.meta.json'));
  if (mf) out('transcripts', 'subagent-agent.meta.json', JSON.parse(readFileSync(join(sdir, mf), 'utf8')));
}
console.log('batch 2 fixtures written');
