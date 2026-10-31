import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import vue from '@vitejs/plugin-vue';
import type { Plugin, ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

/** The API Worker, for `pnpm dev:admin` (`pnpm dev` runs it on 8787). */
const API = process.env.CIRRUS_API ?? 'http://localhost:8787';

/** API paths the dev server forwards to the Worker; the app itself is served under /admin/. */
const API_PATHS = ['/auth', '/server', '/collections', '/fields', '/relations', '/items', '/users', '/roles', '/policies', '/permissions', '/access', '/files', '/folders', '/assets'];

/**
 * Workers Static Assets serve the SPA fallback from the root `/index.html`, so put a copy of the app's
 * there too. The Worker still answers `/` and `/index.html` itself (run_worker_first), so it is only
 * used for `/admin/…` paths that are not files.
 */
const spaFallback: Plugin = {
  name: 'cirrus-spa-fallback',
  apply: 'build',
  writeBundle(options) {
    if (options.dir) copyFileSync(join(options.dir, 'index.html'), join(options.dir, '..', 'index.html'));
  },
};

export default defineConfig({
  // Served by Workers Static Assets under /admin/ (spec §13). The build goes into dist/admin/ rather than
  // using assets.base_path, which Cloudflare does not enable on every account.
  base: '/admin/',
  plugins: [vue(), spaFallback],
  build: { outDir: 'dist/admin', emptyOutDir: true },
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
