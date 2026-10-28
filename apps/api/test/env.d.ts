import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Bindings } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import('../src/index.ts');
    }
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
