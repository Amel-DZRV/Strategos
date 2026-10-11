import { expect, test } from 'vitest';
import { PROTOCOL } from './index.ts';

test('protocol version is 1', () => {
  expect(PROTOCOL).toBe(1);
});
