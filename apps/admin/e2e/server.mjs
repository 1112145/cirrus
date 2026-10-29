// The Worker for the end-to-end tests: a fresh local D1/R2 state with the migrations applied, and
// `wrangler dev` serving the API and the built admin app. Playwright starts it (playwright.config.ts).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = fileURLToPath(new URL('../../api', import.meta.url));
const state = mkdtempSync(join(tmpdir(), 'cirrus-e2e-'));
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };

execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: api, env, stdio: 'inherit' });

const vars = { SECRET: 'e2e-secret', ADMIN_TOKEN: process.env.E2E_ADMIN_TOKEN ?? 'e2e-admin-token' };
const args = ['exec', 'wrangler', 'dev', '--port', process.env.E2E_PORT ?? '8788', '--persist-to', state, '--show-interactive-dev-session=false'];
for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);

const child = spawn('pnpm', args, { cwd: api, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
