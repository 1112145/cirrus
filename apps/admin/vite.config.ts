import vue from '@vitejs/plugin-vue';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

/** The API Worker, for `pnpm dev:admin` (`pnpm dev` runs it on 8787). */
const API = process.env.CIRRUS_API ?? 'http://localhost:8787';

/** API paths the dev server forwards to the Worker; the app itself is served under /admin/. */
const API_PATHS = ['/auth', '/server', '/collections', '/fields', '/relations', '/items', '/users', '/roles', '/policies', '/permissions', '/access', '/files', '/folders', '/assets'];

export default defineConfig({
  // Served by Workers Static Assets under /admin/ (spec §13).
  base: '/admin/',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(
      API_PATHS.map((path): [string, ProxyOptions] => [
        path,
        {
          target: API,
          changeOrigin: true,
          // The session cookie only authenticates same-origin writes: present them as the Worker's own.
          configure: (proxy) => proxy.on('proxyReq', (req) => req.setHeader('origin', API)),
        },
      ]),
    ),
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
