import { defineConfig, devices } from '@playwright/test';
import { BASE, PORT } from './e2e/env.ts';

/**
 * End-to-end tests of the admin app against `wrangler dev` (spec §13): `pnpm test:e2e` builds the
 * app, starts the Worker on a fresh local state and runs e2e/*.spec.ts in Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } }],
  webServer: {
    command: 'pnpm build && node e2e/server.mjs',
    url: `${BASE}/server/ping`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
});
