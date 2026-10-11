// Auto-deny guards (task 4.04).
//
// SAFETY NET, NOT A SECURITY BOUNDARY. A guard is a regular expression over the text of a tool call, and text can always be
// written in a way a pattern does not expect (a variable that holds the command, a script that calls rm, base64, a very
// long command). Guards only ever DENY; nothing here approves anything. The owner's own `deny` rules in Claude Code's
// settings remain the real control. The list of spellings the starter rules do NOT catch is in guards.test.ts.
//
// Rules for the code in this file:
//   - fast: every pattern is linear or bounded; the text is capped (HEAD_CAP + TAIL_CAP characters per variant);
//   - fail open: a bad pattern or any exception means "no opinion", never a denial and never an approval;
//   - `{HOME}` in a pattern expands to the user's home folder in its common spellings (see homeAlternation).
import type { GuardRule, PreToolUseInput } from '@strategos/shared';

export type GuardVerdict = { deny: false } | { deny: true; ruleId: string; reason: string };

export interface GuardCtx {
  /** The user's home folder, for `{HOME}` in patterns. Pass os.homedir(); this file does not read it. */
  home?: string;
}

/** Text longer than this is not scanned in full: the first HEAD_CAP and the last TAIL_CAP characters are. */
export const HEAD_CAP = 4096;
export const TAIL_CAP = 4096;

// ---------------------------------------------------------------------------
// which text a rule looks at
// ---------------------------------------------------------------------------

const DEFAULT_FIELD: Record<string, string> = {
  Bash: 'command', PowerShell: 'command', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
};

function fieldText(tool: string, input: Record<string, unknown> | undefined, field: string | undefined): string {
  const i = input ?? {};
  const key = field ?? DEFAULT_FIELD[tool];
  if (key === undefined) return JSON.stringify(i);
  const v = i[key];
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
}

/** A rule's `tool` is a name, `*`, or names joined with `|` (Edit|Write). */
function toolMatches(rule: GuardRule, tool: string): boolean {
  return rule.tool === '*' || rule.tool.split('|').includes(tool);
}

function cap(s: string): string {
  return s.length <= HEAD_CAP + TAIL_CAP ? s : `${s.slice(0, HEAD_CAP)}\n${s.slice(-TAIL_CAP)}`;
}

/**
 * The text as a shell would read it after quote removal: quotes, carets and backticks dropped, ${IFS} read as a space,
 * line continuations joined, runs of blanks collapsed. A rule is tested against the raw text and this one.
 */
export function normalise(s: string): string {
  return s
    .replace(/\\\r?\n/g, ' ')
    .replace(/\$\{?IFS\}?/g, ' ')
    .replace(/["'`^]/g, '')
    .replace(/[ \t\f\v]+/g, ' ');
}

// ---------------------------------------------------------------------------
// {HOME}
// ---------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source for "the home folder": ~, $HOME, ${HOME}, %USERPROFILE%, $env:USERPROFILE, and the real path with either slash. */
export function homeAlternation(home: string | undefined): string {
  const forms = ['~', '\\$HOME', '\\$\\{HOME\\}', '%USERPROFILE%', '\\$env:USERPROFILE', '\\$env:HOME'];
  if (home !== undefined && home !== '') {
    const trimmed = home.replace(/[\\/]+$/, '');
    forms.push(trimmed.split(/[\\/]+/).map(esc).join('[\\\\/]+'));
  }
  return `(?:${forms.join('|')})`;
}

const compiled = new Map<string, RegExp | null>();

function compile(rule: GuardRule, home: string | undefined): RegExp | null {
  const key = `${home ?? ''}\u0000${rule.pattern}`;
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  try {
    re = new RegExp(rule.pattern.replaceAll('{HOME}', homeAlternation(home)), 'i');
  } catch {
    re = null;
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(key, re);
  return re;
}

// ---------------------------------------------------------------------------
// checkGuards
// ---------------------------------------------------------------------------

/** The first enabled rule that matches denies. Never throws. */
export function checkGuards(rules: readonly GuardRule[], ev: PreToolUseInput, ctx: GuardCtx = {}): GuardVerdict {
  try {
    const tool = ev.tool_name ?? '';
    if (tool === '') return { deny: false };
    for (const rule of rules) {
      if (!rule.enabled || !toolMatches(rule, tool)) continue;
      const re = compile(rule, ctx.home);
      if (re === null) continue;
      const raw = cap(fieldText(tool, ev.tool_input, rule.field));
      if (raw === '') continue;
      if (re.test(raw) || re.test(cap(normalise(raw)))) {
        return {
          deny: true,
          ruleId: rule.id,
          reason: `Blocked by a Strategos guard (${rule.id}): ${rule.description} If you really need this, ask the user to run it themselves.`,
        };
      }
    }
  } catch {
    // fail open
  }
  return { deny: false };
}

// ---------------------------------------------------------------------------
// starter rules
// ---------------------------------------------------------------------------

// Pieces shared by the patterns below. Every repetition is bounded or a single character class.
// A command word: at the start of the text or after ; & | ( { newline $( , behind wrappers such as sudo, env, VAR=1, bash -c, cmd /c.
// "echo git push -f" is not a command position, so it is not denied; "sudo git push -f" and "bash -c 'git push -f'" are.
const WRAP = '(?:\\w+=\\S*|(?:sudo|doas|env|time|nohup|command|exec|call|start|then|do|else|xargs|bash|sh|zsh|dash|ksh|cmd|cmd\\.exe|powershell|powershell\\.exe|pwsh|wsl|eval)|[-/]\\w[\\w-]*)';
const START = '(?:^|[;&|({\\n]|\\$\\()[ \\t]*(?:' + WRAP + '[ \\t]+){0,6}\\\\?(?:[\\w.:~\\\\/-]*[\\\\/])?'; // ... optionally \rm or /bin/rm
const END = '(?=\\s|$|[;&|)])';
const ROOTS = '(?:/\\*?|/[a-z]/\\*?|[a-z]:[\\\\/]?\\*?|{HOME}[\\\\/]?\\*?)'; // /  /*  /c/  C:\  C:  C:\*  ~  ~/  $HOME  <home>
const SKIP_ARGS = '(?:[^\\s;&|]+\\s+){0,12}';
const GIT = 'git(?:\\.exe)?\\s+(?:-{1,2}[^\\s;&|]+\\s+(?:[^-\\s;&|][^\\s;&|]*\\s+)?){0,4}'; // git -C dir -c k=v --no-pager

export const STARTER_GUARDS: readonly GuardRule[] = Object.freeze([
  {
    id: 'git-force-push',
    description: "git push --force (or -f, or +branch) can overwrite other people's work on the remote. --force-with-lease is allowed.",
    tool: 'Bash|PowerShell',
    pattern: `${START}${GIT}push\\s+(?:[^\\s;&|]+\\s+){0,10}?(?:--force${END}|-[a-z]*f[a-z]*${END}|\\+[\\w/.-])`,
    enabled: true,
  },
  {
    id: 'rm-recursive-root',
    description: 'rm -r on the root of a drive or on your home folder.',
    tool: 'Bash|PowerShell',
    pattern: `${START}rm(?:\\.exe)?\\s+(?=(?:[^\\s;&|]+\\s+){0,8}?(?:-[a-z]*r[a-z]*|--recursive)(?=\\s|$))${SKIP_ARGS}${ROOTS}${END}`,
    enabled: true,
  },
  {
    id: 'remove-item-recursive-root',
    description: 'Remove-Item -Recurse on the root of a drive or on your home folder.',
    tool: 'Bash|PowerShell',
    pattern: `${START}(?:remove-item|ri)\\s+(?=(?:[^\\s;&|]+\\s+){0,8}?-r[a-z]*(?=\\s|$))${SKIP_ARGS}${ROOTS}${END}`,
    enabled: true,
  },
  {
    id: 'del-recursive-root',
    description: 'del /s, rd /s or rmdir /s on the root of a drive.',
    tool: 'Bash|PowerShell',
    pattern: `${START}(?:del|erase|rd|rmdir)\\s+(?=(?:[^\\s;&|]+\\s+){0,8}?/s${END})${SKIP_ARGS}[a-z]:[\\\\/]?\\*?(?:\\.\\*)?${END}`,
    enabled: true,
  },
  {
    id: 'git-reset-hard-origin',
    description: 'git reset --hard origin/... throws away all local commits and changes.',
    tool: 'Bash|PowerShell',
    pattern: `${START}${GIT}reset\\s+(?:[^\\s;&|]+\\s+){0,6}?--hard\\s+(?:[^\\s;&|]+\\s+){0,3}?(?:origin\\b|upstream\\b|@\\{u(?:pstream)?\\})`,
    enabled: true,
  },
  {
    id: 'write-claude-home',
    description: "Writing to ~/.claude or ~/.strategos changes Claude Code's own settings or Strategos itself.",
    tool: 'Edit|Write|MultiEdit|NotebookEdit',
    pattern: '^\\s*{HOME}[\\\\/]+\\.(?:claude\\.json|(?:claude|strategos)(?:[\\\\/]|$))',
    enabled: true,
  },
  {
    id: 'shell-write-claude-home',
    description: 'A shell command that writes to ~/.claude or ~/.strategos.',
    tool: 'Bash|PowerShell',
    pattern: '(?:>>?|\\btee\\b|\\b(?:cp|mv|ln|touch|rm|install|set-content|add-content|out-file|copy-item|move-item|remove-item|new-item)\\b|\\bsed\\s+-i\\S*)[^;&|\\n]{0,200}?{HOME}[\\\\/]+\\.(?:claude\\.json|(?:claude|strategos)(?:[\\\\/]|\\b))',
    enabled: true,
  },
]);

/** Copies, so a caller can edit the result without touching the frozen list. */
export function starterGuards(): GuardRule[] {
  return STARTER_GUARDS.map((g) => ({ ...g }));
}
