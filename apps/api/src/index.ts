import { Hono } from 'hono';
import type { AppEnv } from './env.ts';
import { authenticate } from './middleware/auth.ts';
import { notFound, onError } from './middleware/errors.ts';
import { auth } from './routes/auth.ts';
import { collections } from './routes/collections.ts';
import { fields } from './routes/fields.ts';
import { assets, files, folders } from './routes/files.ts';
import { items } from './routes/items.ts';
import { relations } from './routes/relations.ts';
import { server } from './routes/server.ts';
import { access, permissions, policies, roles, users } from './routes/system.ts';

const app = new Hono<AppEnv>();

app.use('*', authenticate);

app.route('/server', server);
app.route('/auth', auth);
app.route('/collections', collections);
app.route('/fields', fields);
app.route('/relations', relations);
app.route('/items', items);
app.route('/users', users);
app.route('/roles', roles);
app.route('/policies', policies);
app.route('/permissions', permissions);
app.route('/access', access);
app.route('/files', files);
app.route('/folders', folders);
app.route('/assets', assets);

app.notFound(notFound);
app.onError(onError);

export default app;
