import { expect, test } from 'vitest';
import { banner } from './main.ts';

test('banner mentions version and protocol', () => {
  expect(banner()).toBe('strategos-daemon 0.0.0 (protocol 1)');
});
