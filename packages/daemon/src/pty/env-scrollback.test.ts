import { describe, expect, it } from 'vitest';
import { ScrollbackBuffer, scrubEnv } from './pty-host.ts';

describe('scrubEnv', () => {
  const src = {
    PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: '1',
    ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_OTHER: 'keepme', MY_ANTHROPIC_THING: 'k', CLAUDE_PREVIEW_X: '1', CLAUDE_PID: '5', CLAUDE_EFFORT: 'high',
  };
  it('drops CLAUDECODE, CLAUDE_CODE_*, CLAUDE_AGENT_SDK_*, ANTHROPIC_* and keeps CLAUDE_CONFIG_DIR and the rest', () => {
    expect(scrubEnv(src)).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_OTHER: 'keepme', MY_ANTHROPIC_THING: 'k' });
  });
  it('is case-insensitive (Windows env names)', () => {
    expect(scrubEnv({ Anthropic_Api_Key: 'x', claudecode: '1', Claude_Code_Simple: '1', Claude_Config_Dir: 'd' })).toEqual({ Claude_Config_Dir: 'd' });
  });
  it('keep re-adds named variables from the source; set adds and overrides, replacing differently-cased duplicates', () => {
    const out = scrubEnv({ ...src, Path: 'x' }, { keep: ['anthropic_base_url'], set: { PATH: '/mine', STRATEGOS_X: '1', CLAUDE_CODE_SIMPLE: '0' } });
    expect(out['ANTHROPIC_BASE_URL']).toBe('http://x');
    expect(out['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(out['PATH']).toBe('/mine');
    expect(out['Path']).toBeUndefined();
    expect(out['STRATEGOS_X']).toBe('1');
    expect(out['CLAUDE_CODE_SIMPLE']).toBe('0');
  });
  it('skips undefined values and does not mutate the source', () => {
    const s = { A: undefined, B: 'b', ANTHROPIC_API_KEY: 'k' };
    expect(scrubEnv(s)).toEqual({ B: 'b' });
    expect(s.ANTHROPIC_API_KEY).toBe('k');
  });
});

describe('ScrollbackBuffer', () => {
  it('returns exactly what was pushed while under the limit', () => {
    const b = new ScrollbackBuffer(100);
    b.push('abc'); b.push('def');
    expect(b.contents()).toBe('abcdef');
  });
  it('keeps the last `limit` characters in order after overflow', () => {
    const b = new ScrollbackBuffer(10);
    let all = '';
    for (let i = 0; i < 50; i++) { const s = `<${i}>`; all += s; b.push(s); }
    expect(b.contents()).toBe(all.slice(-10));
  });
  it('a single chunk larger than the limit is trimmed to its tail', () => {
    const b = new ScrollbackBuffer(5);
    b.push('0123456789');
    expect(b.contents()).toBe('56789');
  });
  it('2 MB default: 3 MB in, last 2 MiB out, byte-for-byte', () => {
    const b = new ScrollbackBuffer();
    let all = '';
    const line = 'x'.repeat(99) + '\n';
    for (let i = 0; i < 31_000; i++) { const s = String(i % 10) + line; all += s; b.push(s); }
    expect(all.length).toBeGreaterThan(3_000_000);
    const out = b.contents();
    expect(out.length).toBe(2 * 1024 * 1024);
    expect(out).toBe(all.slice(-2 * 1024 * 1024));
  });
  it('never starts in the middle of a surrogate pair', () => {
    const b = new ScrollbackBuffer(3);
    b.push('a😀😀'); // 5 units; cutting 2 would split the first emoji
    expect(b.contents()).toBe('😀');
  });
});
