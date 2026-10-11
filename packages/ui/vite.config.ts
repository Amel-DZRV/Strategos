import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// In development the page is served by Vite and the daemon (or the mock, scripts/mock-daemon.ts) runs elsewhere.
// /api and /ws are proxied so the page stays same-origin and the pairing cookie works. changeOrigin makes the
// Host header the daemon's own (it rejects any other); the Origin header stays http://127.0.0.1:5173, so start the
// real daemon with STRATEGOS_DEV_ORIGIN=http://127.0.0.1:5173.
const target = process.env['STRATEGOS_DEV_TARGET'] ?? 'http://127.0.0.1:47800';

export default defineConfig({
  plugins: [preact()],
  // Listed up front so Vite does not re-optimise mid-session when it first meets xterm (that gave two Preact copies).
  optimizeDeps: { include: ['preact', 'preact/hooks', '@preact/signals', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, changeOrigin: true, ws: true },
    },
  },
});
