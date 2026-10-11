import { render, screen } from '@testing-library/preact';
import { expect, test } from 'vitest';
import { App } from './app.tsx';

test('renders the app name', () => {
  render(<App />);
  expect(screen.getByText('Strategos')).toBeTruthy();
});
