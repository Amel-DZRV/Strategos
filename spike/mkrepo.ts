import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'C:\\dev\\strategos-sandbox';
if (existsSync(join(dir, '.git'))) { console.log('exists', dir); process.exit(0); }
mkdirSync(join(dir, '.claude'), { recursive: true });
const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'inherit' });
git('init', '-b', 'main');
writeFileSync(join(dir, 'README.md'), '# strategos-sandbox\n\nScratch repo for Strategos M0 spike checks.\n');
writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({
  permissions: { deny: ['Bash(rm *)', 'Bash(del *)', 'Bash(Remove-Item *)', 'Bash(git push *)'] } }, null, 2) + '\n');
writeFileSync(join(dir, '.gitignore'), '.claude/settings.local.json\n');
git('add', 'README.md', '.gitignore');
git('-c', 'user.name=Strategos Spike', '-c', 'user.email=spike@example.invalid', 'commit', '-m', 'init sandbox');
console.log('created', dir);
