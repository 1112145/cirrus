import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';

export const server = new Hono<AppEnv>();

// SDK: serverPing() — Directus responds with the text "pong"
server.get('/ping', (c) => c.text('pong'));

// SDK: serverInfo() — public part; once auth lands (M3), admins get more fields
server.get('/info', (c) =>
  c.json({
    data: {
      project: {
        project_name: c.env.PROJECT_NAME,
        project_descriptor: null,
        project_logo: null,
        project_color: null,
        default_language: c.env.DEFAULT_LANGUAGE,
        public_registration: false,
        public_registration_verify_email: false,
      },
      websocket: false,
    },
  }),
);

// SDK: serverHealth() — checks that D1 is reachable
server.get('/health', async (c) => {
  const started = Date.now();
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json(
      {
        status: 'ok',
        checks: {
          'database:responseTime': [
            { componentType: 'datastore', observedUnit: 'ms', observedValue: Date.now() - started, status: 'ok' },
          ],
        },
      },
      200,
      { 'Content-Type': 'application/health+json' },
    );
  } catch {
    return c.json({ status: 'error' }, 503, { 'Content-Type': 'application/health+json' });
  }
});
