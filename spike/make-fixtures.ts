// Builds redacted fixtures under ../fixtures/claude/<version>/{hooks,statusline,transcripts} from spike/out (run1 + run2 captures).
// Redaction: home path (all spellings, incl. 8.3 short temp path) -> "~"; X-Strategos-Token -> "<redacted>"; any string over 2 KB is cut.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const VER = '2.1.292';
const root = join(here, '..', 'fixtures', 'claude', VER);
const home = homedir(); // C:\Users\Amel.DESKTOP-8UP1MTT
const BS = String.fromCharCode(92);
const variants = (p: string) => [p, p.split(BS).join(BS + BS), p.split(BS).join('/')];
const spellings = [...variants(home), ...variants('C:' + BS + 'Users' + BS + 'AMEL~1.DES'), ...variants('C:' + BS + 'Users' + BS + 'Amel.DESKTOP-8UP1MTT')];
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
const out = (sub: string, name: string, data: unknown) => {
  const d = join(root, sub); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(redact(data), null, 2) + '\n');
};
const load = (dir: string) => readdirSync(dir).sort().map((f) => ({ f, j: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
const run1 = load(join(here, 'out/run1/hooks'));
const run2 = load(join(here, 'out/hooks'));
const pick = (list: typeof run1, pred: (j: any) => boolean, nth = 0) => list.filter((x) => pred(x.j.body))[nth]?.j;
const ev = (e: string, tool?: string) => (b: any) => b.hook_event_name === e && (tool === undefined || b.tool_name === tool);
const hookEvName = (j: any) => j.url.split('/').pop();
const evOf = (list: typeof run1, e: string, tool?: string, nth = 0) => list.filter((x) => hookEvName(x.j) === e && (tool === undefined || x.j.body.tool_name === tool))[nth]?.j;

const hooks: [string, any][] = [
  ['SessionStart-via-command-relay.json', evOf(run2, 'SessionStart')],
  ['UserPromptSubmit-multiline-paste.json', run1.map((x) => x.j).find((j) => hookEvName(j) === 'UserPromptSubmit' && /Line one/.test(j.body.prompt))],
  ['PreToolUse-Bash.json', evOf(run1, 'PreToolUse', 'Bash')],
  ['PreToolUse-AskUserQuestion.json', evOf(run1, 'PreToolUse', 'AskUserQuestion')],
  ['PermissionRequest-Bash-with-suggestion.json', evOf(run1, 'PermissionRequest', 'Bash')],
  ['PermissionRequest-AskUserQuestion-after-PreToolUse-none.json', evOf(run1, 'PermissionRequest', 'AskUserQuestion')],
  ['Notification-permission-needed.json', evOf(run1, 'Notification')],
  ['PostToolUse-Bash.json', evOf(run1, 'PostToolUse', 'Bash')],
  ['PostToolUseFailure-Bash-exit3.json', evOf(run1, 'PostToolUseFailure', 'Bash')],
  ['Stop.json', evOf(run1, 'Stop')],
  ['SubagentStop-internal-helper.json', evOf(run1, 'SubagentStop')],
  ['PreCompact.json', evOf(run1, 'PreCompact')],
  ['PostCompact.json', evOf(run1, 'PostCompact')],
  ['SessionEnd-clear.json', evOf(run1, 'SessionEnd')],
  ['SessionEnd-exit.json', evOf(run2, 'SessionEnd')],
];
for (const [n, j] of hooks) { if (!j) { console.log('MISSING', n); continue; } out('hooks', n, j); }

// Responses the daemon sent (hand-written from the shapes that worked in the spike; not captured from claude).
const R = (o: unknown) => o;
out('hooks', 'RESPONSE-PermissionRequest-allow.json', R({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
out('hooks', 'RESPONSE-PermissionRequest-deny-with-message.json', R({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by the Strategos spike (S2 deny test)' } } }));
out('hooks', 'RESPONSE-PermissionRequest-always-suggestion0.json', R({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'addDirectories', directories: ['~\sandbox'], destination: 'session' }] } } }));
out('hooks', 'RESPONSE-PreToolUse-AskUserQuestion-answer.json', R({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: ['<echo the tool_input.questions array>'], answers: { 'Which colour do you prefer?': 'Green' } } } }));
out('hooks', 'RESPONSE-PostToolUse-additionalContext.json', R({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'STRATEGOS-NOTE-7731' } }));

// Status line
const sl = readdirSync(join(here, 'out/run1/statusline')).sort();
const rd = (f: string) => JSON.parse(readFileSync(join(here, 'out/run1/statusline', f), 'utf8'));
out('statusline', 'statusline-first-no-request-yet.json', rd(sl[0]));
out('statusline', 'statusline-after-turns-with-rate-limits-and-cache.json', rd(sl[sl.length - 3]));

// Transcripts (session b5a6d25c, run 1). Keep only hook_* attachments (others embed the system prompt, skill and tool listings, user email).
const tdir = join(home, '.claude', 'projects', 'C--dev-strategos-sandbox');
const lines = readFileSync(join(tdir, 'b5a6d25c-f79c-4a72-b9fe-4763c2448c98.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((j) => (j.type !== 'attachment' || String(j.attachment?.type).startsWith('hook_')) && !/userEmail|totalTokens|total_tokens/.test(JSON.stringify(j)));
const slice = (name: string, from: RegExp, to: RegExp) => {
  const a = lines.findIndex((j) => from.test(JSON.stringify(j))); if (a < 0) return console.log('MISSING transcript', name);
  let b = lines.findIndex((j, i) => i > a && to.test(JSON.stringify(j))); if (b < 0) b = Math.min(lines.length - 1, a + 30);
  const d = join(root, 'transcripts'); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), lines.slice(a, b + 1).map((j) => JSON.stringify(redact(j))).join('\n') + '\n');
};
slice('turn-bash-permission-allowed-with-hook-additional-context.jsonl', /"role":"user".*Run the shell command: echo strategos-probe/, /"turn_duration"/);
slice('turn-bash-permission-denied-by-hook.jsonl', /Line one: run the shell command/, /"turn_duration"/);
slice('turn-ask-user-question-answered-by-hook.jsonl', /Use the AskUserQuestion tool to ask me one multiple-choice question: which colour/, /"turn_duration"/);
slice('turn-compact.jsonl', /isCompactSummary|compact_boundary/, /"turn_duration"|compact_boundary/);
slice('turn-bash-exit3-tool-error.jsonl', /Run exactly this shell command and nothing appended/, /"turn_duration"/);
console.log('fixtures written to', root);
