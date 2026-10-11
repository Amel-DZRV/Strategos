// Guards are a safety net, not a security boundary (see guards.ts). These tests say what the starter rules catch, what
// they leave alone, and, in "KNOWN BYPASSES", the spellings they do NOT catch. If one of those starts being caught, good:
// move it up. The list is the honest part of the feature.
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { isGuardRule, type GuardRule, type PreToolUseInput } from '@strategos/shared';
import { checkGuards, HEAD_CAP, normalise, STARTER_GUARDS, starterGuards, TAIL_CAP } from './guards.ts';

const HOME = 'C:\\Users\\Amel';
const rules = starterGuards();
const bashEv = (command: string): PreToolUseInput => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const fileEv = (tool: string, file_path: string): PreToolUseInput => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path } });
const denies = (ev: PreToolUseInput, ruleId?: string): boolean => {
  const v = checkGuards(rules, ev, { home: HOME });
  return v.deny && (ruleId === undefined || v.ruleId === ruleId);
};
const deniesCmd = (c: string, id?: string): boolean => denies(bashEv(c), id);

describe('starter rules are valid config', () => {
  it('every rule passes isGuardRule and has a unique id', () => {
    for (const r of STARTER_GUARDS) expect(isGuardRule(r), r.id).toBe(true);
    expect(new Set(STARTER_GUARDS.map((r) => r.id)).size).toBe(STARTER_GUARDS.length);
  });
  it('the frozen list cannot be edited through the copies', () => {
    const copy = starterGuards();
    copy[0]!.enabled = false;
    expect(STARTER_GUARDS[0]!.enabled).toBe(true);
  });
});

describe('git push --force', () => {
  it.each([
    'git push --force', 'git push -f', 'git push origin main --force', 'git push -f origin main', 'git push origin +main',
    'git push -uf origin main', 'git -C ../x push --force', 'git -c user.name=x push -f', 'GIT_TRACE=1 git push -f',
    'cd x && git push --force', 'ls; git push -f', 'sudo git push -f', 'bash -c "git push -f"', "sh -c 'git push --force origin main'",
    'git.exe push -f', '/usr/bin/git push -f', 'GIT push -F', 'git push --force --no-verify', 'git push --force-with-lease --force',
    'git push origin HEAD:main -f', 'echo hi | git push -f', 'git   push   -f', 'git\tpush\t-f', 'g""it push -f', 'git "push" -f',
    "git push '--force'", 'git push `echo`-f -f',
  ])('denies %s', (c) => { expect(deniesCmd(c, 'git-force-push')).toBe(true); });

  it.each([
    'git push', 'git push origin main', 'git push -u origin main', 'git push --force-with-lease', 'git push --force-with-lease=main origin',
    'git push --force-if-includes', 'git push --follow-tags', 'git push origin feature-f', 'git commit -m "do not git push -f"',
    'echo git push -f', 'git log --oneline', 'git fetch -f', 'git branch -f x', 'git checkout -f main', 'git pull --force',
  ])('allows %s', (c) => { expect(deniesCmd(c, 'git-force-push')).toBe(false); });
});

describe('rm -r on a drive root or home', () => {
  it.each([
    'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf ~/', 'rm -rf ~/*', 'rm -fr /', 'rm -Rf /', 'rm -r /', 'rm --recursive --force /',
    'rm -rf $HOME', 'rm -rf ${HOME}', 'rm -rf $HOME/', 'rm -rf C:\\', 'rm -rf C:/', 'rm -rf C:', 'rm -rf c:\\*', 'rm -rf /c/', 'rm -rf C:\\Users\\Amel',
    'rm -rf C:\\Users\\Amel\\', 'rm -rf C:/Users/Amel/*', 'rm -rf %USERPROFILE%', 'rm -rf $env:USERPROFILE', 'rm -rf -- /', 'rm -rf --no-preserve-root /',
    'rm -rf build /', 'rm -rf build ~', 'sudo rm -rf /', '/bin/rm -rf /', '\\rm -rf /', 'RM -RF /', 'rm.exe -rf /', 'cd x; rm -rf /',
    'ls && rm -rf ~', 'rm  -rf   /', 'rm\t-rf\t/', 'r""m -rf /', "'rm' -rf /", 'rm -rf "/"', "rm -rf '~'", 'rm -rf "$HOME"', 'rm -r -f /',
    'rm -f -r /', 'bash -c "rm -rf /"', 'xargs rm -rf /', 'echo x | xargs rm -rf ~', 'rm -rf / --no-preserve-root', 'rm -rf \\\n/',
    'rm -rf c^:\\', 'ls\nrm -rf /',
  ])('denies %s', (c) => { expect(deniesCmd(c, 'rm-recursive-root')).toBe(true); });

  it.each([
    'rm -rf build', 'rm -rf ./build', 'rm -rf /tmp/x', 'rm -rf ~/project/build', 'rm -rf $HOME/project', 'rm file', 'rm /', 'rm -f /x',
    'rm -rf C:\\Users\\Amel\\project', 'rm -rf node_modules', 'echo rm -rf /', 'git rm -r --cached /', 'rm -rf C:\\dev\\repo\\build',
    'rm -rf /home/me/x', 'ls /', 'firm -rf /',
  ])('allows %s', (c) => { expect(deniesCmd(c, 'rm-recursive-root')).toBe(false); });
});

describe('Remove-Item -Recurse on a drive root or home', () => {
  it.each([
    'Remove-Item -Recurse -Force C:\\', 'Remove-Item -Recurse -Force C:/', 'remove-item -recurse -force c:\\*', 'Remove-Item -Force -Recurse C:\\',
    'Remove-Item -Path C:\\ -Recurse -Force', 'Remove-Item -LiteralPath "C:\\" -Recurse', 'ri -r -fo C:\\', 'Remove-Item -Recurse $env:USERPROFILE',
    'Remove-Item -Recurse -Force ~', 'Remove-Item -Recurse -Force C:\\Users\\Amel', 'Remove-Item -Recurse -Force "C:\\Users\\Amel\\*"',
    'Remove-Item -Recurse -Force $HOME', 'powershell -Command "Remove-Item -Recurse -Force C:\\"', 'pwsh -c "ri -Recurse -Force D:\\"',
    'cd x; Remove-Item -Recurse -Force C:\\', 'REMOVE-ITEM -RECURSE -FORCE C:\\', 'Remove-Item  -Recurse   -Force   C:\\', 'Remove-Item -rec -force C:\\',
    'Remove-Item -Force -Recurse -Path D:/',
  ])('denies %s', (c) => { expect(deniesCmd(c, 'remove-item-recursive-root')).toBe(true); });

  it.each([
    'Remove-Item -Recurse -Force build', 'Remove-Item -Recurse C:\\dev\\repo\\build', 'Remove-Item C:\\', 'Remove-Item file.txt',
    'Remove-Item -Recurse -Force .\\node_modules', 'Get-ChildItem -Recurse C:\\', 'Remove-Item -Recurse $env:USERPROFILE\\project',
  ])('allows %s', (c) => { expect(deniesCmd(c, 'remove-item-recursive-root')).toBe(false); });
});

describe('del /s on a drive root', () => {
  it.each(['del /s /q C:\\', 'del /s /q C:\\*', 'del /q /s C:\\*.*', 'DEL /S /Q c:/', 'erase /s /q D:\\', 'rd /s /q C:\\', 'rmdir /s /q C:\\',
    'cmd /c "del /s /q C:\\"', 'cmd.exe /c del /f /s /q C:\\', 'cd x && del /s /q C:\\'])('denies %s', (c) => {
    expect(deniesCmd(c, 'del-recursive-root')).toBe(true);
  });
  it.each(['del /s /q build', 'del C:\\', 'del /q C:\\temp\\x.txt', 'rd /s /q C:\\dev\\repo\\build', 'dir /s C:\\'])('allows %s', (c) => {
    expect(deniesCmd(c, 'del-recursive-root')).toBe(false);
  });
});

describe('git reset --hard origin', () => {
  it.each(['git reset --hard origin', 'git reset --hard origin/main', 'git reset --hard upstream/main', 'git reset --hard @{u}', 'git reset --hard @{upstream}',
    'git -C x reset --hard origin/main', 'git reset -q --hard origin/main', 'cd x && git reset --hard origin/dev', 'GIT reset --HARD ORIGIN/main'])('denies %s', (c) => {
    expect(deniesCmd(c, 'git-reset-hard-origin')).toBe(true);
  });
  it.each(['git reset --hard', 'git reset --hard HEAD', 'git reset --hard HEAD~1', 'git reset --soft origin/main', 'git reset origin/main', 'git reset --hard abc123'])('allows %s', (c) => {
    expect(deniesCmd(c, 'git-reset-hard-origin')).toBe(false);
  });
});

describe('writing to ~/.claude or ~/.strategos', () => {
  it.each([
    ['Edit', 'C:\\Users\\Amel\\.claude\\settings.json'], ['Write', 'C:/Users/Amel/.claude/settings.json'], ['Write', 'c:\\users\\amel\\.CLAUDE\\x'],
    ['Edit', 'C:\\Users\\Amel\\.strategos\\config.json'], ['Write', 'C:\\Users\\Amel\\.claude.json'], ['MultiEdit', '~/.claude/CLAUDE.md'],
    ['Write', '$HOME/.strategos/x'], ['Write', '%USERPROFILE%\\.claude\\x'], ['Write', 'C:\\Users\\Amel\\.claude'], ['Write', 'C:\\\\Users\\\\Amel\\\\.claude\\\\x'],
  ])('denies %s %s', (tool, p) => { expect(denies(fileEv(tool, p), 'write-claude-home')).toBe(true); });

  it.each([
    ['Edit', 'C:\\dev\\Strategos\\.claude\\worktrees\\w1\\a.ts'], ['Edit', 'C:\\dev\\repo\\.claude\\settings.json'], ['Write', 'C:\\Users\\Amel\\project\\.claude\\x'],
    ['Write', 'C:\\Users\\Amel\\.claude-other\\x'], ['Write', 'C:\\Users\\Amel\\.claudeish'], ['Read', 'C:\\Users\\Amel\\.claude\\settings.json'],
    ['Write', 'C:\\Users\\Bob\\.claude\\x'],
  ])('allows %s %s', (tool, p) => { expect(denies(fileEv(tool, p))).toBe(false); });

  it.each([
    'echo x > ~/.claude/settings.json', 'echo x >> $HOME/.claude/settings.json', 'cp a.json ~/.claude/settings.json', 'mv a ~/.strategos/x',
    'tee ~/.claude/x', 'sed -i s/a/b/ ~/.claude/settings.json', 'Set-Content -Path $env:USERPROFILE\\.claude\\settings.json -Value x',
    'echo x > C:\\Users\\Amel\\.claude\\settings.json', 'echo x > C:/Users/Amel/.strategos/config.json', 'rm ~/.claude/settings.json',
    'echo "{}" > "$HOME/.claude/settings.json"',
  ])('denies the shell command %s', (c) => { expect(deniesCmd(c, 'shell-write-claude-home')).toBe(true); });

  it.each(['cat ~/.claude/settings.json', 'ls ~/.claude', 'echo x > ./.claude/settings.json', 'cp ~/.claude/a ./a'])('allows %s', (c) => {
    // `cp ~/.claude/a ./a` has the folder as SOURCE; the regex cannot tell source from target and would deny it. Listed
    // under KNOWN OVER-BLOCKS below instead.
    if (c === 'cp ~/.claude/a ./a') return;
    expect(deniesCmd(c, 'shell-write-claude-home')).toBe(false);
  });
});

describe('KNOWN BYPASSES (not caught: documented on purpose)', () => {
  it.each([
    ['a variable holds the command', 'X=rm; $X -rf /'],
    ['a variable holds the target', 'T=/; rm -rf $T'],
    ['command substitution builds the name', 'r$(echo m) -rf /'],
    ['brace expansion', '{rm,-rf,/}'],
    ['base64 piped to a shell', 'echo cm0gLXJmIC8= | base64 -d | sh'],
    ['eval of a built string', 'eval "$(printf \'\\x72\\x6d\') -rf /"'],
    ['an interpreter does the deleting', 'python -c "import shutil; shutil.rmtree(\'/\')"'],
    ['a script file does the deleting', './cleanup.sh'],
    ['find -delete', 'find / -delete'],
    ['rm via find -exec', 'find / -exec rm -rf {} +'],
    ['a glob that expands to the root contents', 'rm -rf /*/'],
    ['the root named by its parent', 'rm -rf /home/..'],
    ['backslash inside the name', 'r\\m -rf /'],
    ['dollar-quote ANSI-C string', "$'\\x72\\x6d' -rf /"],
    ['git push with a refspec using a variable for the sign', 'F=-f; git push $F'],
    ['push alias configured in git', 'git fpush'],
    ['reset --hard to a remote written as a hash', 'git reset --hard 0123abc'],
    ['PowerShell variable', '$p = "C:\\"; Remove-Item -Recurse -Force $p'],
    ['PowerShell encoded command', 'powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA=='],
    ['robocopy mirror from an empty folder', 'robocopy C:\\empty C:\\target /MIR'],
    ['format or diskpart', 'format C: /q'],
    ['a path through a junction', 'rm -rf C:\\junction-to-root\\'],
    ['a redirect to the settings through a variable', 'f=~/.claude/settings.json; echo x > $f'],
    ['a redirect to the settings from a script', './write-settings.sh'],
    ['a file write through a symbolic link', 'echo x > link-to-claude-settings'],
    ['an Edit through a short 8.3 name', 'C:\\Users\\Amel\\CLAUDE~1\\settings.json'],
  ])('%s: %s', (_why, cmd) => {
    const ev = cmd.startsWith('C:\\') ? fileEv('Edit', cmd) : bashEv(cmd);
    expect(denies(ev)).toBe(false);
  });

  it('text beyond the head and the tail of a very long command is not scanned', () => {
    const middle = `${'x '.repeat(HEAD_CAP)};rm -rf /;${'x '.repeat(TAIL_CAP)}`;
    expect(deniesCmd(`echo ${'y'.repeat(HEAD_CAP)}\n${'z'.repeat(TAIL_CAP)}\n${middle}${'w'.repeat(10)}`)).toBe(false);
  });
  it('but a long command whose danger sits in the head or the tail is caught', () => {
    expect(deniesCmd(`rm -rf /; ${'x'.repeat(100_000)}`)).toBe(true);
    expect(deniesCmd(`${'x'.repeat(100_000)}\nrm -rf /`)).toBe(true);
  });
});

describe('KNOWN OVER-BLOCKS (denied although harmless)', () => {
  it('a copy FROM the protected folder looks like a write to it', () => {
    expect(deniesCmd('cp ~/.claude/a ./a')).toBe(true);
  });
});

describe('rule mechanics', () => {
  const rule = (o: Partial<GuardRule>): GuardRule => ({ id: 'r', description: 'd', tool: 'Bash', pattern: 'danger', enabled: true, ...o });

  it('only denies; the verdict says which rule and why', () => {
    const v = checkGuards(rules, bashEv('git push --force'), { home: HOME });
    expect(v).toMatchObject({ deny: true, ruleId: 'git-force-push' });
    expect(v.deny && v.reason).toMatch(/guard/);
    expect(checkGuards(rules, bashEv('ls'), { home: HOME })).toEqual({ deny: false });
  });
  it('skips disabled rules and rules for other tools', () => {
    expect(checkGuards([rule({ enabled: false })], bashEv('danger')).deny).toBe(false);
    expect(checkGuards([rule({})], fileEv('Edit', 'danger')).deny).toBe(false);
    expect(checkGuards([rule({ tool: '*' })], fileEv('Edit', 'danger')).deny).toBe(true);
    expect(checkGuards([rule({ tool: 'Edit|Write' })], fileEv('Write', 'danger')).deny).toBe(true);
  });
  it('tests the named field, else the default field of the tool, else the whole input', () => {
    const ev: PreToolUseInput = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls', description: 'danger' } };
    expect(checkGuards([rule({})], ev).deny).toBe(false);
    expect(checkGuards([rule({ field: 'description' })], ev).deny).toBe(true);
    const web: PreToolUseInput = { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://danger.example' } };
    expect(checkGuards([rule({ tool: 'WebFetch' })], web).deny).toBe(true);
    expect(checkGuards([rule({ tool: 'WebFetch', field: 'url' })], web).deny).toBe(true);
  });
  it('a pattern that does not compile, or an event without a tool, is no opinion', () => {
    expect(checkGuards([rule({ pattern: '(' })], bashEv('x(')).deny).toBe(false);
    expect(checkGuards([rule({})], { hook_event_name: 'PreToolUse' }).deny).toBe(false);
    expect(checkGuards([rule({})], { hook_event_name: 'PreToolUse', tool_name: 'Bash' }).deny).toBe(false);
    expect(checkGuards([rule({})], { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 5 } as never }).deny).toBe(false);
  });
  it('{HOME} expands to the given home folder', () => {
    const r = rule({ tool: 'Write', pattern: '^{HOME}[\\\\/]secret', field: 'file_path' });
    expect(checkGuards([r], fileEv('Write', 'D:\\h\\me\\secret'), { home: 'D:\\h\\me' }).deny).toBe(true);
    expect(checkGuards([r], fileEv('Write', 'D:/h/me/secret'), { home: 'D:\\h\\me' }).deny).toBe(true);
    expect(checkGuards([r], fileEv('Write', 'D:\\h\\other\\secret'), { home: 'D:\\h\\me' }).deny).toBe(false);
    expect(checkGuards([r], fileEv('Write', '/home/me/secret'), { home: '/home/me' }).deny).toBe(true);
  });
  it('normalise drops quotes, carets and backticks and collapses blanks', () => {
    expect(normalise('r""m   -rf\t/')).toBe('rm -rf /');
    expect(normalise('d^el /s')).toBe('del /s');
    expect(normalise('a${IFS}b')).toBe('a b');
  });
});

describe('speed and ReDoS', () => {
  const nasty: string[] = [
    'a'.repeat(8192), ' '.repeat(8192), 'rm '.repeat(2730), 'rm -r '.repeat(1365), 'rm -rf '.repeat(1170), 'git '.repeat(2048), 'git push '.repeat(910),
    'git push -a '.repeat(680), 'git -c a push '.repeat(585), 'sudo '.repeat(1638), 'sudo env time '.repeat(630), 'x=1 '.repeat(2048), '-a '.repeat(2730),
    'Remove-Item '.repeat(682), 'ri -r '.repeat(1365), 'del /s '.repeat(1170), 'rd /s '.repeat(1365), '; rm -rf '.repeat(910), '&& git push '.repeat(682),
    'git reset '.repeat(819), 'git reset --hard '.repeat(512), '> ~/.claude '.repeat(682), 'tee '.repeat(2048), `cp ${'a'.repeat(190)} `.repeat(40),
    '"'.repeat(8192), '\\'.repeat(8192), '\n'.repeat(8192), 'rm -rf ' + 'a '.repeat(4000), 'git push ' + '-x '.repeat(2700), 'C:\\'.repeat(2730),
    '$HOME/'.repeat(1170), '~/'.repeat(4096), 'rm ' + '-a '.repeat(2700) + '/', 'git ' + 'push '.repeat(1600) + '-f',
  ];
  it('every starter rule finishes each adversarial input in under 20 ms (best of 5, per input)', () => {
    for (const text of nasty) {
      for (const ev of [bashEv(text), fileEv('Write', text), fileEv('Edit', text)]) {
        let best = Infinity;
        for (let k = 0; k < 5; k++) {
          const t0 = performance.now();
          checkGuards(rules, ev, { home: HOME });
          best = Math.min(best, performance.now() - t0);
        }
        expect(best, `${text.slice(0, 30)}`).toBeLessThan(20);
      }
    }
  });
  it('a typical command takes well under 1 ms once the patterns are compiled', () => {
    checkGuards(rules, bashEv('npm test'), { home: HOME });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) checkGuards(rules, bashEv('npm run build && git status'), { home: HOME });
    expect((performance.now() - t0) / 100).toBeLessThan(1);
  });
});
