import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { SessionRecord } from '@strategos/shared';
import { createStateStore, StoreNotLoadedError, type StateFile } from './state-store.ts';
import { makeTestEnv, type TestEnv } from './testing.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeTestEnv(); });
afterEach(async () => { await env.cleanup(); });

const mk = (over: Partial<Parameters<typeof createStateStore>[0]> = {}) =>
  createStateStore({ fs: env.fs, dir: env.home, debounceMs: 5, ...over });
const readState = (): StateFile => JSON.parse(readFileSync(path.join(env.home, 'state.json'), 'utf8')) as StateFile;
const rec = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({ strategosId: id, schema: 1, ...extra } as SessionRecord);

describe('state store', () => {
  it('refuses to write before load finished', async () => {
    const s = mk();
    expect(() => s.update(() => undefined)).toThrow(StoreNotLoadedError);
    await expect(s.flush()).rejects.toBeInstanceOf(StoreNotLoadedError);
    expect(() => s.get()).toThrow(StoreNotLoadedError);
    expect(existsSync(path.join(env.home, 'state.json'))).toBe(false);
    await s.close(); // closing an unloaded store writes nothing
    expect(existsSync(path.join(env.home, 'state.json'))).toBe(false);
  });

  it('a fresh home loads as new and persists after update', async () => {
    const s = mk();
    expect((await s.load()).status).toBe('new');
    s.update((st) => { st.sessions.push(rec('a')); });
    await s.flush();
    expect(readState().sessions.map((x) => x.strategosId)).toEqual(['a']);
    const s2 = mk();
    expect((await s2.load()).status).toBe('ok');
    expect(s2.get().sessions).toHaveLength(1);
  });

  it('debounces writes', async () => {
    const s = mk({ debounceMs: 40 });
    await s.load();
    s.update((st) => { st.dismissedSuggestions.push('x'); });
    expect(existsSync(path.join(env.home, 'state.json'))).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(readState().dismissedSuggestions).toEqual(['x']);
  });

  it('saves without pty/resource and with pending.held false', async () => {
    const s = mk();
    await s.load();
    s.update((st) => {
      st.sessions.push(rec('a', {
        pty: { pid: 1, cols: 80, rows: 24, dirtyInput: false },
        resource: { pid: 1, procStart: 'x', treeWorkingSetMb: 1, treePrivateMb: 1, cpuPct: 0, at: 0 },
        pending: { requestId: 'r', kind: 'permission', held: true, toolName: 'Bash', inputSummary: 'ls', inputTruncated: false, risk: ['run'], since: 1 },
      }));
    });
    await s.flush();
    const saved = readState().sessions[0]!;
    expect(saved.pty).toBeUndefined();
    expect(saved.resource).toBeUndefined();
    expect(saved.pending?.held).toBe(false);
    expect(s.get().sessions[0]!.pending?.held).toBe(true); // memory untouched
  });

  it('50 concurrent writes all land, with unique temp names and no leftovers', async () => {
    const s = mk({ debounceMs: 0 });
    await s.load();
    const ps: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      s.update((st) => { st.sessions.push(rec(`s${i}`)); });
      ps.push(s.flush());
    }
    await Promise.all(ps);
    expect(readState().sessions).toHaveLength(50);
    expect(readdirSync(env.home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('survives a simulated kill mid-write: leftover tmp does not corrupt state, and is swept', async () => {
    const s = mk();
    await s.load();
    s.update((st) => { st.sessions.push(rec('good')); });
    await s.flush();
    await env.fs.writeFile(path.join(env.home, 'state.json.99999.7.tmp'), '{"schema":1,"sessions":[{"strat');
    const s2 = mk();
    expect((await s2.load()).status).toBe('ok');
    expect(s2.get().sessions.map((x) => x.strategosId)).toEqual(['good']);
    expect(existsSync(path.join(env.home, 'state.json.99999.7.tmp'))).toBe(false);
  });

  it('a corrupt file is renamed, the backup is loaded and a banner is raised', async () => {
    const s = mk({ bakIntervalMs: 0 });
    await s.load();
    s.update((st) => { st.sessions.push(rec('one')); });
    await s.flush();
    s.update((st) => { st.sessions.push(rec('two')); });
    await s.flush(); // second write copies the first file to .bak
    expect(existsSync(path.join(env.home, 'state.json.bak'))).toBe(true);
    await env.fs.writeFile(path.join(env.home, 'state.json'), '{ not json');
    const s2 = mk({ now: () => 1234 });
    const r = await s2.load();
    expect(r.status).toBe('restored_from_backup');
    expect(s2.banner?.kind).toBe('restored_from_backup');
    expect(readFileSync(path.join(env.home, 'state.json.corrupt-1234'), 'utf8')).toBe('{ not json');
    expect(s2.get().sessions.map((x) => x.strategosId)).toEqual(['one']);
  });

  it('corrupt with no backup: load fails, writes refused until startEmpty()', async () => {
    await env.fs.writeFile(path.join(env.home, 'state.json'), 'garbage');
    const s = mk();
    const r = await s.load();
    expect(r.status).toBe('failed');
    expect(r.banner?.kind).toBe('corrupt_no_backup');
    expect(() => s.update(() => undefined)).toThrow(StoreNotLoadedError);
    s.startEmpty();
    s.update((st) => { st.sessions.push(rec('fresh')); });
    await s.flush();
    expect(readState().sessions).toHaveLength(1);
    expect(readdirSync(env.home).some((n) => n.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('keeps the .bak hourly, not on every write', async () => {
    let t = 10_000_000;
    const s = mk({ now: () => t });
    await s.load();
    s.update((st) => { st.dismissedSuggestions.push('1'); });
    await s.flush();
    t += 1000;
    s.update((st) => { st.dismissedSuggestions.push('2'); });
    await s.flush(); // first backup: lastBakAt was 0
    const bakTime1 = statSync(path.join(env.home, 'state.json.bak')).mtimeMs;
    t += 1000;
    s.update((st) => { st.dismissedSuggestions.push('3'); });
    await s.flush(); // within the hour: no new backup
    expect(statSync(path.join(env.home, 'state.json.bak')).mtimeMs).toBe(bakTime1);
    t += 3_600_000;
    s.update((st) => { st.dismissedSuggestions.push('4'); });
    await s.flush();
    const bak = JSON.parse(readFileSync(path.join(env.home, 'state.json.bak'), 'utf8')) as StateFile;
    expect(bak.dismissedSuggestions).toEqual(['1', '2', '3']);
  });

  it('close() flushes a pending debounced write', async () => {
    const s = mk({ debounceMs: 60_000 });
    await s.load();
    s.update((st) => { st.dismissedSuggestions.push('late'); });
    await s.close();
    expect(readState().dismissedSuggestions).toEqual(['late']);
  });

  it('fuzz: 1000 random operations, no lost write', async () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const s = mk({ debounceMs: 1, bakIntervalMs: 0 });
    await s.load();
    const expected = new Map<string, number>();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      const key = `k${Math.floor(rnd() * 40)}`;
      const op = rnd();
      if (op < 0.1 && expected.size > 0) {
        const victim = [...expected.keys()][Math.floor(rnd() * expected.size)]!;
        expected.delete(victim);
        s.update((st) => { st.sessions = st.sessions.filter((x) => x.strategosId !== victim); });
      } else {
        expected.set(key, i);
        s.update((st) => {
          const found = st.sessions.find((x) => x.strategosId === key);
          if (found) found.updatedAt = i;
          else st.sessions.push(rec(key, { updatedAt: i }));
        });
      }
      const r = rnd();
      if (r < 0.15) pending.push(s.flush());
      else if (r < 0.2) await new Promise((res) => setTimeout(res, 2));
    }
    await Promise.all(pending);
    await s.close();
    const onDisk = readState().sessions;
    expect(new Map(onDisk.map((x) => [x.strategosId, x.updatedAt]))).toEqual(expected);
    expect(readdirSync(env.home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const s2 = mk();
    await s2.load();
    expect(s2.get().sessions).toHaveLength(expected.size);
  }, 60_000);
});
