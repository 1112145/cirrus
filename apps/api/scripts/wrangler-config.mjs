// wrangler.jsonc is each operator's own copy of wrangler.example.jsonc, with their resource IDs; it is
// git-ignored. Create it from the template when missing. With --remote, also refuse the template's
// placeholder database_id, so nothing is deployed against a database that does not exist.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

const config = new URL('../wrangler.jsonc', import.meta.url);
const template = new URL('../wrangler.example.jsonc', import.meta.url);
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

if (!existsSync(config)) {
  copyFileSync(template, config);
  console.log('Created apps/api/wrangler.jsonc from wrangler.example.jsonc.');
}

if (process.argv.includes('--remote') && readFileSync(config, 'utf8').includes(PLACEHOLDER)) {
  console.error(
    'apps/api/wrangler.jsonc still has the placeholder database_id: run `npx wrangler d1 create cirrus` ' +
      'and copy its ID into wrangler.jsonc (README, "First deploy").',
  );
  process.exit(1);
}
