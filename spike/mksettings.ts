// Writes a Strategos run settings file (plan section 5, "Injected settings (v1)").
// Hook config shape (https://code.claude.com/docs/en/hooks):
//   hooks: { Event: [ { matcher?, hooks: [ { type:"http", url, headers, allowedEnvVars, timeout } ] } ] }
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fwd = (p: string) => p.replace(/\\/g, '/');

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'CwdChanged', 'PermissionRequest'];

export interface Opts { strategosId: string; port?: number; disableAgentView?: boolean; outDir?: string }

export function buildSettings(o: Opts) {
  const port = o.port ?? 47801;
  const hook = (ev: string, timeout?: number) => {
    const h: Record<string, unknown> = {
      type: 'http', url: `http://127.0.0.1:${port}/hook/${o.strategosId}/${ev}`,
      headers: { 'X-Strategos-Token': '$STRATEGOS_HOOK_TOKEN' }, allowedEnvVars: ['STRATEGOS_HOOK_TOKEN'],
    };
    if (timeout) h.timeout = timeout;
    return h;
  };
  const hooks: Record<string, unknown[]> = {};
  for (const ev of EVENTS) {
    if (ev === 'PreToolUse') hooks[ev] = [{ matcher: '*', hooks: [hook(ev, 5)] }, { matcher: 'AskUserQuestion', hooks: [hook(ev, 86400)] }];
    else if (ev === 'PermissionRequest') hooks[ev] = [{ matcher: '*', hooks: [hook(ev, 86400)] }];
    else if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') hooks[ev] = [{ matcher: '*', hooks: [hook(ev)] }];
    else if (ev === 'SessionEnd') hooks[ev] = [{ hooks: [hook(ev, 3)] }];
    else hooks[ev] = [{ hooks: [hook(ev)] }];
  }
  return {
    hooks,
    statusLine: { type: 'command', command: `"${fwd(process.execPath)}" "${fwd(resolve(here, 'tap.mjs'))}" ${o.strategosId}` },
    ...(o.disableAgentView === false ? {} : { disableAgentView: true }),
    permissions: { deny: ['Read(~/.strategos/**)', 'Edit(~/.strategos/**)'] },
  };
}

export function writeSettings(o: Opts): string {
  const dir = o.outDir ?? join(here, 'out', 'run');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${o.strategosId}.settings.json`);
  writeFileSync(f, JSON.stringify(buildSettings(o), null, 2));
  return f;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  console.log(writeSettings({ strategosId: get('--id') ?? 'spike-1', port: Number(get('--port') ?? 47801), disableAgentView: !a.includes('--no-agentview') }));
}
