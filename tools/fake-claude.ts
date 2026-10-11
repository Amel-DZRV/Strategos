// A stand-in `claude` for tests: node tools/fake-claude.ts [--session-id ID | --resume ID] [--settings FILE|JSON] [--name N] [...ignored]
// Scripted by env FAKE_CLAUDE_SCRIPT (builtin scenario name or a JSON file; default "plain"). See fake-claude-scenarios.ts.
// It never runs tools: dangerous-looking commands are only strings inside hook bodies.
//
// Env:   CLAUDE_CONFIG_DIR  where transcripts and sessions/<pid>.json go (REQUIRED, else nothing is written; the real ~/.claude is never touched
//                           unless FAKE_CLAUDE_ALLOW_HOME=1)
//        STRATEGOS_HOOK_TOKEN (any variable named in a hook's allowedEnvVars is substituted into its headers)
//        FAKE_CLAUDE_PROMPT  submit this prompt automatically after startup (otherwise wait for a typed line)
//        FAKE_CLAUDE_STEP_MS pause between steps (default 5)
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { projectDirName } from '../packages/daemon/src/platform/common/project-dir.ts';
import { builtinScenarios, type Scenario, type Step } from './fake-claude-scenarios.ts';

const VERSION = '2.1.292';

class Interrupted extends Error {
  constructor() { super('interrupted'); }
}

// ---------- argv ----------
const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const resumeId = flagValue('--resume');
let sessionId = flagValue('--session-id') ?? resumeId ?? randomUUID();
const sessionName = flagValue('--name');
const settingsArg = flagValue('--settings');
const permissionMode = flagValue('--permission-mode') ?? 'default';

// ---------- scenario ----------
function loadScenario(): Scenario {
  const spec = process.env['FAKE_CLAUDE_SCRIPT'] || 'plain';
  const builtin = builtinScenarios[spec];
  if (builtin) return builtin;
  const parsed = JSON.parse(readFileSync(spec, 'utf8')) as Scenario;
  if (!parsed || !Array.isArray(parsed.turns)) throw new Error(`bad scenario file ${spec}`);
  return parsed;
}

// ---------- paths ----------
const cwd = process.cwd();
const allowHome = process.env['FAKE_CLAUDE_ALLOW_HOME'] === '1';
const configDir = process.env['CLAUDE_CONFIG_DIR'] || (allowHome ? join(homedir(), '.claude') : '');
const stepMs = Number(process.env['FAKE_CLAUDE_STEP_MS'] ?? 5);
const transcriptPathFor = (id: string): string => join(configDir || '(no-config-dir)', 'projects', projectDirName(cwd), `${id}.jsonl`);
const sessionsFile = (): string => join(configDir, 'sessions', `${process.pid}.json`);

function safeWrite(fn: () => void): void {
  if (!configDir) return;
  try { fn(); } catch (e) { process.stderr.write(`fake-claude: write failed: ${String(e)}\n`); }
}

// ---------- hooks ----------
interface HttpHook { type: 'http'; url: string; headers: Record<string, string>; allowedEnvVars: string[]; timeoutS: number }
interface CommandHook { type: 'command'; command: string; timeoutS: number }
type AnyHook = HttpHook | CommandHook;

function loadHooks(): Record<string, { matcher?: string; hooks: AnyHook[] }[]> {
  const out: Record<string, { matcher?: string; hooks: AnyHook[] }[]> = {};
  if (!settingsArg) return out;
  let settings: { hooks?: Record<string, { matcher?: string; hooks?: Record<string, unknown>[] }[]> };
  try {
    settings = JSON.parse(settingsArg.trim().startsWith('{') ? settingsArg : readFileSync(settingsArg, 'utf8'));
  } catch (e) {
    process.stderr.write(`fake-claude: cannot read --settings: ${String(e)}\n`);
    return out;
  }
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    out[event] = entries.map((en) => ({
      ...(en.matcher !== undefined ? { matcher: en.matcher } : {}),
      hooks: (en.hooks ?? []).flatMap((h): AnyHook[] => {
        const timeoutS = typeof h['timeout'] === 'number' ? h['timeout'] : 600;
        if (h['type'] === 'http' && typeof h['url'] === 'string') {
          return [{ type: 'http', url: h['url'], headers: (h['headers'] as Record<string, string> | undefined) ?? {}, allowedEnvVars: (h['allowedEnvVars'] as string[] | undefined) ?? [], timeoutS }];
        }
        if (h['type'] === 'command' && typeof h['command'] === 'string') return [{ type: 'command', command: h['command'], timeoutS }];
        return [];
      }),
    }));
  }
  return out;
}
const hookConfig = loadHooks();

function matches(matcher: string | undefined, value: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (value === undefined) return false;
  try { return new RegExp(`^(?:${matcher})$`).test(value); } catch { return false; }
}

function headersFor(h: HttpHook): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(h.headers)) {
    headers[k] = v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => (h.allowedEnvVars.includes(name) ? process.env[name] ?? '' : m));
  }
  return headers;
}

interface HookResult { status: number; json: Record<string, unknown> | null }

/** type:"command": the shell command gets the JSON body on stdin and the same env; stdout (JSON) is the result, empty = no decision. */
function runCommand(h: CommandHook, body: unknown, signal: AbortSignal): Promise<HookResult | null> {
  return new Promise((resolve) => {
    const child = spawn(h.command, { shell: true, env: process.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal });
    let outText = '';
    child.stdout.on('data', (d: Buffer) => { outText += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) { resolve({ status: 500, json: null }); return; }
      let json: Record<string, unknown> | null = null;
      try { json = outText.trim() ? (JSON.parse(outText) as Record<string, unknown>) : null; } catch { json = null; }
      resolve({ status: 200, json });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(body));
    setTimeout(() => child.kill(), h.timeoutS * 1000).unref();
  });
}

async function postOne(h: AnyHook, body: unknown, signal: AbortSignal): Promise<HookResult | null> {
  if (h.type === 'command') return runCommand(h, body, signal);
  try {
    const res = await fetch(h.url, { method: 'POST', headers: headersFor(h), body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(h.timeoutS * 1000)]) });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) return { status: res.status, json: null }; // non-2xx: non-blocking, no decision
    let json: Record<string, unknown> | null = null;
    try { json = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = null; }
    return { status: res.status, json };
  } catch {
    return null; // connection failure, timeout or abort: no decision
  }
}

// ---------- state ----------
const S = {
  working: false,
  promptId: '',
  turnAbort: new AbortController(),
  ttyAnswer: null as ((ch: string) => void) | null,
  lastUuid: null as string | null,
  ids: new Map<string, string>(),
  vars: { prompt: '', answers: '' } as Record<string, string>,
  line: '',
  ctrlCAt: 0,
  queue: [] as string[],
  promptWaiter: null as ((line: string) => void) | null,
  trustWaiter: null as (() => void) | null,
  startedAt: Date.now(),
  status: 'idle',
  waitingFor: undefined as string | undefined,
};

const out = (s: string): void => { process.stdout.write(s); };
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Interrupted()); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = (): void => { clearTimeout(t); reject(new Interrupted()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

function toolId(name: string | undefined): string {
  if (!name) return 'toolu_' + randomBytes(8).toString('hex');
  let id = S.ids.get(name);
  if (!id) { id = 'toolu_' + randomBytes(8).toString('hex'); S.ids.set(name, id); }
  return id;
}

function subst<T>(v: T): T {
  if (typeof v === 'string') {
    const vars: Record<string, string> = { ...S.vars, sessionId, cwd, transcript: transcriptPathFor(sessionId) };
    return v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m) as T;
  }
  if (Array.isArray(v)) return v.map(subst) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)])) as T;
  return v;
}

// ---------- sessions/<pid>.json ----------
function writeSessionsFile(): void {
  safeWrite(() => {
    mkdirSync(join(configDir, 'sessions'), { recursive: true });
    const now = Date.now();
    const rec: Record<string, unknown> = {
      pid: process.pid, sessionId, cwd, startedAt: S.startedAt,
      ...(process.platform === 'win32' ? { procStart: String(BigInt(S.startedAt + 11644473600000) * 10000n) } : {}),
      version: VERSION, kind: 'interactive', entrypoint: 'cli', ...(sessionName ? { name: sessionName } : {}),
      updatedAt: now, status: S.status, statusUpdatedAt: now, ...(S.waitingFor ? { waitingFor: S.waitingFor } : {}),
    };
    writeFileSync(sessionsFile(), JSON.stringify(rec));
  });
}
function setStatus(status: string, waitingFor?: string): void {
  S.status = status; S.waitingFor = waitingFor;
  writeSessionsFile();
}

// ---------- transcript ----------
function appendRecord(file: string, rec: Record<string, unknown>, sidechain = false, agentId?: string): void {
  safeWrite(() => {
    mkdirSync(dirname(file), { recursive: true });
    const uuid = randomUUID();
    const full = {
      parentUuid: sidechain ? null : S.lastUuid, isSidechain: sidechain, ...(agentId ? { agentId } : {}), ...rec,
      uuid, timestamp: new Date().toISOString(), cwd, sessionId, version: VERSION, userType: 'external',
    };
    if (!sidechain) S.lastUuid = uuid;
    appendFileSync(file, JSON.stringify(full) + '\n');
  });
}

function subagentFile(agentId: string): string {
  return join(configDir || '(no-config-dir)', 'projects', projectDirName(cwd), sessionId, 'subagents', `${agentId}.jsonl`);
}

function writeTx(step: Extract<Step, { op: 'tx' }>): void {
  const sidechain = step.agentId !== undefined;
  const file = step.agentId ? subagentFile(step.agentId) : transcriptPathFor(sessionId);
  if (step.agentId) {
    safeWrite(() => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'fake subagent' }));
    });
  }
  const text = step.text ?? '';
  const id = toolId(step.toolId);
  switch (step.kind) {
    case 'user':
      appendRecord(file, { type: 'user', message: { role: 'user', content: text } }, sidechain, step.agentId);
      break;
    case 'assistant':
      appendRecord(file, { type: 'assistant', message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }, sidechain, step.agentId);
      break;
    case 'toolUse':
      appendRecord(file, { type: 'assistant', message: { role: 'assistant', model: 'fake-model', content: [{ type: 'tool_use', id, name: step.tool ?? 'Read', input: step.input ?? {} }], stop_reason: 'tool_use' } }, sidechain, step.agentId);
      break;
    case 'toolResult':
      appendRecord(file, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: step.content ?? '', ...(step.isError ? { is_error: true } : {}) }] } }, sidechain, step.agentId);
      break;
    case 'interrupt':
      appendRecord(file, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: step.toolInterrupt ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] } }, sidechain, step.agentId);
      break;
  }
}

// ---------- hook posting ----------
function bodyFor(event: string, extra: Record<string, unknown>): Record<string, unknown> {
  const sessionLevel = event === 'SessionStart' || event === 'SessionEnd';
  return {
    session_id: sessionId, transcript_path: transcriptPathFor(sessionId), cwd,
    scratchpad_dir: join(tmpdir(), 'claude', projectDirName(cwd), sessionId, 'scratchpad'),
    ...(S.promptId && event !== 'SessionStart' ? { prompt_id: S.promptId } : {}),
    ...(sessionLevel ? {} : { permission_mode: permissionMode, effort: { level: 'medium' } }),
    hook_event_name: event, ...extra,
  };
}

function matchingHooks(event: string, matcherValue: string | undefined): AnyHook[] {
  const found: AnyHook[] = [];
  for (const en of hookConfig[event] ?? []) if (matches(en.matcher, matcherValue)) found.push(...en.hooks);
  // Real Claude de-duplicates hooks that share a URL/command: one request per call, the longest timeout wins [ran, S9].
  const byKey = new Map<string, AnyHook>();
  for (const h of found) {
    const key = h.type === 'http' ? 'h:' + h.url : 'c:' + h.command;
    const prev = byKey.get(key);
    if (!prev || h.timeoutS > prev.timeoutS) byKey.set(key, h);
  }
  return [...byKey.values()];
}

async function fireHook(event: string, matcherValue: string | undefined, extra: Record<string, unknown>, signal: AbortSignal): Promise<(HookResult | null)[]> {
  const body = bodyFor(event, extra);
  return Promise.all(matchingHooks(event, matcherValue).map((h) => postOne(h, body, signal)));
}

function toolExtra(step: { tool?: string; input?: Record<string, unknown>; toolId?: string; agentId?: string; body?: Record<string, unknown> }, withId = true): Record<string, unknown> {
  return {
    ...(step.tool ? { tool_name: step.tool, tool_input: subst(step.input ?? {}) } : {}),
    ...(withId && step.tool ? { tool_use_id: toolId(step.toolId) } : {}),
    ...(step.agentId ? { agent_id: step.agentId, agent_type: 'general-purpose' } : {}),
    ...subst(step.body ?? {}),
  };
}

// ---------- decisions ----------
interface Decision { kind: 'allow' | 'deny' | 'none'; via: 'hook' | 'tty' | 'none'; updatedInput?: Record<string, unknown> }

function decisionFrom(event: string, results: (HookResult | null)[]): Decision {
  for (const r of results) {
    const o = r?.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined;
    if (!o) continue;
    if (event === 'PermissionRequest') {
      const d = o['decision'] as { behavior?: string; updatedInput?: Record<string, unknown> } | undefined;
      if (d?.behavior === 'allow') return { kind: 'allow', via: 'hook', ...(d.updatedInput ? { updatedInput: d.updatedInput } : {}) };
      if (d?.behavior === 'deny') return { kind: 'deny', via: 'hook' };
    } else {
      const p = o['permissionDecision'];
      const ui = o['updatedInput'] as Record<string, unknown> | undefined;
      if (p === 'allow') return { kind: 'allow', via: 'hook', ...(ui ? { updatedInput: ui } : {}) };
      if (p === 'deny') return { kind: 'deny', via: 'hook' };
    }
  }
  return { kind: 'none', via: 'none' };
}

function ttyAnswer(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { S.ttyAnswer = null; reject(new Interrupted()); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    S.ttyAnswer = (ch) => { signal.removeEventListener('abort', onAbort); S.ttyAnswer = null; resolve(ch); };
  });
}

async function doHold(step: Extract<Step, { op: 'hold' }>): Promise<void> {
  const signal = S.turnAbort.signal;
  const isAuq = step.tool === 'AskUserQuestion';
  setStatus('waiting', isAuq ? 'dialog open' : 'permission prompt');
  const shownInput = JSON.stringify(step.input).slice(0, 200);
  if (isAuq) {
    const q = (step.input['questions'] as { question?: string; options?: { label?: string }[] }[] | undefined)?.[0];
    out(`\r\n${q?.question ?? 'Question?'}\r\n${(q?.options ?? []).map((o, i) => `  ${i + 1}. ${o.label}`).join('\r\n')}\r\n`);
  } else {
    out(`\r\n ${step.tool} command\r\n\r\n   ${shownInput}\r\n\r\n Do you want to proceed?\r\n > 1. Yes\r\n   2. Yes, and don't ask again\r\n   3. No, and tell Claude what to do differently (esc)\r\n`);
  }
  // Hook requests share one abort controller so a terminal answer (or Esc) closes the held connection, like the real TUI.
  const holdAbort = new AbortController();
  const onTurnAbort = (): void => holdAbort.abort();
  signal.addEventListener('abort', onTurnAbort, { once: true });
  const extra = toolExtra(step, step.event !== 'PermissionRequest');
  const hookPromise = (async (): Promise<Decision> => {
    let d = decisionFrom(step.event, await fireHook(step.event, step.tool, extra, holdAbort.signal));
    // [ran, S2] after PreToolUse(AskUserQuestion) returns no decision, a PermissionRequest for AskUserQuestion follows
    if (d.kind === 'none' && isAuq && step.event === 'PreToolUse' && !holdAbort.signal.aborted) {
      d = decisionFrom('PermissionRequest', await fireHook('PermissionRequest', step.tool, toolExtra(step, false), holdAbort.signal));
    }
    return d;
  })();
  const ttyPromise = ttyAnswer(signal).then((ch): Decision => {
    if (isAuq) {
      const n = Number.parseInt(ch, 10);
      const q = (step.input['questions'] as { question?: string; options?: { label?: string }[] }[] | undefined)?.[0];
      const label = q?.options?.[n - 1]?.label;
      return label ? { kind: 'allow', via: 'tty', updatedInput: { answers: { [q?.question ?? 'q']: label } } } : { kind: 'deny', via: 'tty' };
    }
    return ch === '1' || ch === '2' || ch === 'y' || ch === '\r' ? { kind: 'allow', via: 'tty' } : { kind: 'deny', via: 'tty' };
  });
  let decision: Decision;
  try {
    // First real decision wins. A hook result of "none" (empty body, error, timeout) falls back to the terminal.
    decision = await new Promise<Decision>((resolve, reject) => {
      hookPromise.then((d) => { if (d.kind !== 'none') resolve(d); }).catch(reject);
      ttyPromise.then(resolve).catch(reject);
    });
  } finally {
    signal.removeEventListener('abort', onTurnAbort);
    // [ran, S2] real Claude does NOT close a held request when the TUI answers: leave it open. Only an interrupt (turn abort) closes it.
    S.ttyAnswer = null;
  }
  const answers = (decision.updatedInput?.['answers']);
  S.vars['answers'] = answers === undefined ? '' : JSON.stringify(answers);
  setStatus('busy');
  out(`\r\n(${decision.kind} via ${decision.via})\r\n`);
  await runSteps(decision.kind === 'allow' ? (step.onAllow ?? []) : (step.onDeny ?? []));
}

// ---------- interpreter ----------
async function runSteps(steps: Step[]): Promise<void> {
  const signal = S.turnAbort.signal;
  for (const raw of steps) {
    if (signal.aborted) throw new Interrupted();
    await sleep(stepMs, signal);
    switch (raw.op) {
      case 'print': out(subst(raw.text)); break;
      case 'sleep': await sleep(raw.ms, signal); break;
      case 'hook': await fireHook(raw.event, raw.tool, toolExtra(raw, raw.event !== 'PermissionRequest'), signal); break;
      case 'hold': await doHold(raw); break;
      case 'tx': writeTx(subst(raw)); break;
      case 'status': setStatus(raw.status, raw.waitingFor); break;
      case 'clear': await doClear(signal); break;
      case 'waitInterrupt': await sleep(raw.timeoutMs ?? 60_000, signal); break;
      case 'exit': await finish(raw.code, raw.sessionEnd, signal); break;
    }
  }
}

async function doClear(signal: AbortSignal): Promise<void> {
  await fireHook('SessionEnd', 'clear', { reason: 'clear' }, signal);
  sessionId = randomUUID();
  S.lastUuid = null;
  S.ids.clear();
  writeSessionsFile();
  await fireHook('SessionStart', 'clear', { source: 'clear', model: 'fake-model' }, signal);
  out('\r\n\x1b[2m(conversation cleared)\x1b[0m\r\n');
}

async function finish(code: number, sessionEnd: string | undefined, signal?: AbortSignal): Promise<never> {
  if (sessionEnd) await fireHook('SessionEnd', sessionEnd, { reason: sessionEnd }, signal ?? new AbortController().signal);
  if (code === 0 || sessionEnd) safeWrite(() => rmSync(sessionsFile(), { force: true })); // a crash leaves the stale file behind, like the real thing
  process.stdout.write('', () => process.exit(code));
  await new Promise(() => undefined);
  throw new Error('unreachable');
}

// ---------- turns ----------
let turnIndex = 0;
let stdinClosed = false; // stdin ended (e.g. stdio ignored): exit once idle instead of hanging
let booted = false;

async function runTurn(prompt: string, scenario: Scenario): Promise<void> {
  S.vars['prompt'] = prompt;
  S.promptId = randomUUID();
  S.working = true;
  S.turnAbort = new AbortController();
  const steps = scenario.turns[Math.min(turnIndex, scenario.turns.length - 1)] ?? [];
  turnIndex++;
  try {
    await runSteps(steps);
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    // Esc / Ctrl+C: the transcript gets the marker; Stop and PostToolUseFailure do NOT fire (plan V1)
    writeTx({ op: 'tx', kind: 'interrupt', toolInterrupt: S.status === 'waiting' || S.status === 'busy' });
    out('\r\n\x1b[31mInterrupted\x1b[0m - What should Claude do instead?\r\n');
    setStatus('idle');
  } finally {
    S.working = false;
    S.ttyAnswer = null;
  }
  showPrompt();
  const next = S.queue.shift();
  if (next !== undefined) void submit(next, scenario);
  else if (stdinClosed) void finish(0, 'prompt_input_exit');
}

let scenarioRef: Scenario;

async function submit(line: string, scenario: Scenario): Promise<void> {
  const text = line.trim();
  if (!text) { showPrompt(); return; }
  if (S.working) { S.queue.push(text); return; }
  if (text === '/exit' || text === '/quit') { await finish(0, 'prompt_input_exit'); return; }
  if (text === '/clear') { await doClear(new AbortController().signal); showPrompt(); return; }
  await runTurn(text, scenario);
}

function showPrompt(): void { out('\r\n\x1b[1m> \x1b[0m'); }

// ---------- stdin ----------
function onStdin(chunk: string): void {
  const data = chunk.replace(/\x1b\[200~|\x1b\[201~/g, '');
  if (data === '\x1b') { onEscape(); return; }
  if (/^\x1b[[O]/.test(data)) return; // arrow / function key
  for (const ch of data) {
    if (ch === '\x03') { onCtrlC(); continue; }
    if (S.trustWaiter) { if (ch === '\r' || ch === '\n') { const w = S.trustWaiter; S.trustWaiter = null; w(); } continue; }
    if (S.ttyAnswer) { S.ttyAnswer(ch === '\n' ? '\r' : ch); continue; }
    if (ch === '\r' || ch === '\n') {
      const line = S.line; S.line = '';
      out('\r\n');
      if (S.promptWaiter) { const w = S.promptWaiter; S.promptWaiter = null; w(line); } else void submit(line, scenarioRef);
    } else if (ch === '\x7f' || ch === '\b') {
      if (S.line) { S.line = S.line.slice(0, -1); out('\b \b'); }
    } else if (ch >= ' ') {
      S.line += ch; out(ch);
    }
  }
}

function onEscape(): void {
  if (S.working) S.turnAbort.abort();
}

function onCtrlC(): void {
  if (S.working) { S.turnAbort.abort(); return; }
  S.line = '';
  const now = Date.now();
  if (now - S.ctrlCAt < 2000) { void finish(0, 'prompt_input_exit'); return; }
  S.ctrlCAt = now;
  out('\r\nPress Ctrl-C again to exit\r\n');
  showPrompt();
}

// ---------- main ----------
async function main(): Promise<void> {
  const scenario = loadScenario();
  scenarioRef = scenario;
  if (!configDir) process.stderr.write('fake-claude: CLAUDE_CONFIG_DIR is not set; transcripts and session files will not be written\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onStdin);
  process.stdin.on('end', () => { stdinClosed = true; if (booted && !S.working) void finish(0, 'prompt_input_exit'); });
  process.stdin.resume();

  out(`\x1b[2J\x1b[H\x1b[36m* Claude Code (fake) v${VERSION}\x1b[0m\r\n  ${cwd}\r\n`);
  if (scenario.trust) {
    out('\r\n Do you trust the files in this folder?\r\n > 1. Yes, proceed\r\n   2. No, exit\r\n');
    await new Promise<void>((resolve) => { S.trustWaiter = resolve; });
  }
  writeSessionsFile();
  const startSignal = new AbortController().signal;
  await fireHook('SessionStart', resumeId ? 'resume' : 'startup', { source: resumeId ? 'resume' : 'startup', model: 'fake-model', ...(sessionName ? { session_title: sessionName } : {}) }, startSignal);
  showPrompt();
  booted = true;
  const auto = process.env['FAKE_CLAUDE_PROMPT'];
  if (auto) {
    out(auto + '\r\n');
    void submit(auto, scenario);
  } else if (stdinClosed) void finish(0, 'prompt_input_exit');
}

process.on('uncaughtException', (e) => { process.stderr.write(`fake-claude: ${String(e?.stack ?? e)}\n`); process.exit(2); });
void main();
