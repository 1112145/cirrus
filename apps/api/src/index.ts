import { Hono } from 'hono';
import type { AppEnv } from './env.ts';
import { notFound, onError } from './middleware/errors.ts';
import { server } from './routes/server.ts';

const app = new Hono<AppEnv>();

app.route('/server', server);

// M1: /collections, /fields, /relations
// M2: /items/:collection
// M3: /auth, /users, /roles, /policies, /permissions
// M5: /files, /assets

app.notFound(notFound);
app.onError(onError);

export default app;
