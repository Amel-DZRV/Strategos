// Vitest globals are off, so Testing Library does not unmount between tests by itself. Import this for the side effect.
import { cleanup } from '@testing-library/preact';
import { afterEach } from 'vitest';

afterEach(() => { cleanup(); });
