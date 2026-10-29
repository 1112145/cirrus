import { Hono } from 'hono';
import type { AppEnv } from './env.ts';
import { accountability } from './middleware/auth.ts';
import { notFound, onError } from './middleware/errors.ts';
import { collections } from './routes/collections.ts';
import { fields } from './routes/fields.ts';
import { server } from './routes/server.ts';

const app = new Hono<AppEnv>();

app.use('*', accountability);

app.route('/server', server);
app.route('/collections', collections);
app.route('/fields', fields);

// M2: /items/:collection
// M3: /auth, /users, /roles, /policies, /permissions
// M4: /relations
// M5: /files, /assets

app.notFound(notFound);
app.onError(onError);

export default app;
