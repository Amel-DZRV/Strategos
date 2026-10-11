import { act, render, screen } from '@testing-library/preact';
import { afterEach, expect, test } from 'vitest';
import { App } from './app.tsx';
import { store } from './state/store.ts';
import { makeSession } from './test/fixtures.ts';

afterEach(() => {
  store.applyEvent({ t: 'snapshot', seq: 0, sessions: [], planets: [], initiatives: [], prefs: store.prefs.value });
});

test('renders the app name and re-renders when the store changes', async () => {
  render(<App />);
  expect(screen.getByText('Strategos')).toBeTruthy();
  await act(() => {
    store.applyEvent({
      t: 'snapshot', seq: 1, sessions: [makeSession({ strategosId: 'a', displayName: 'Alpha' })], planets: [], initiatives: [], prefs: store.prefs.value,
    });
  });
  expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
});
