import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeTmpDir, removeDir, writeText } from '../testing/tmp-fs.ts';
import { jsonLines, num, readHead, readRange, readTail } from './fsutil.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = makeTmpDir();
  file = join(dir, 'f.txt');
});
afterEach(() => removeDir(dir));

describe('readRange', () => {
  it('reads [start, end) and tolerates ranges past the end or empty ranges', async () => {
    writeText(file, 'abcdefghij');
    expect((await readRange(file, 2, 5)).toString()).toBe('cde');
    expect((await readRange(file, 8, 50)).toString()).toBe('ij');
    expect((await readRange(file, 5, 5)).length).toBe(0);
    expect((await readRange(file, 9, 3)).length).toBe(0);
  });
});

describe('readHead / readTail', () => {
  const text = 'line-one\nline-two\nline-three\nline-four\n';
  beforeEach(() => writeText(file, text));

  it('return the whole file when it is smaller than the window', async () => {
    expect(await readHead(file, 1000)).toBe(text);
    expect(await readTail(file, 1000)).toBe(text);
  });

  it('readHead never ends in a partial line', async () => {
    expect(await readHead(file, 12)).toBe('line-one\n');
    expect(await readHead(file, 5)).toBe('');
  });

  it('readTail never starts in a partial line', async () => {
    expect(await readTail(file, 20)).toBe('line-four\n');
    expect(await readTail(file, 5)).toBe('');
  });

  it('readTail with a window that begins exactly at a line start keeps that line only if complete', async () => {
    const start = text.length - 'line-four\n'.length;
    expect(await readTail(file, text.length - start + 1)).toBe('line-four\n'); // starts on the previous newline
  });

  it('multi-byte characters near the cut never leak a broken character', async () => {
    writeText(file, '€€€€\n€€€€\n');
    for (let n = 1; n < 30; n++) {
      expect(await readTail(file, n)).not.toContain('�');
      expect(await readHead(file, n)).not.toContain('�');
    }
  });
});

describe('jsonLines / num', () => {
  it('parses lines, skips blank and malformed ones, handles CRLF and a missing final newline', () => {
    expect(jsonLines('{"a":1}\r\n\n  \nnot json\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(jsonLines('')).toEqual([]);
  });
  it('num accepts finite numbers only', () => {
    expect([num(3), num(0), num(NaN), num(Infinity), num('3'), num(undefined)]).toEqual([3, 0, undefined, undefined, undefined, undefined]);
  });
});
