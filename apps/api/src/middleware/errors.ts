import { CirrusError, isCirrusError } from '@cirrus/shared';
import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env.ts';

/** Serialize mọi lỗi sang format Directus: { errors: [{ message, extensions: { code } }] } */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const e = isCirrusError(err)
    ? err
    : new CirrusError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred.');

  if (!isCirrusError(err)) console.error(err);

  return c.json(e.toBody(), e.status as ContentfulStatusCode);
};

/** Directus trả ROUTE_NOT_FOUND với message "Route <path> doesn't exist." */
export const notFound: NotFoundHandler<AppEnv> = (c) => {
  const e = new CirrusError('ROUTE_NOT_FOUND', `Route ${c.req.path} doesn't exist.`, { path: c.req.path });
  return c.json(e.toBody(), 404);
};
