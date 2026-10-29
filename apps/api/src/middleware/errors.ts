import { CirrusError, isCirrusError, routeNotFound } from '@cirrus/shared';
import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env.ts';

/** Serialize every error in Directus format: { errors: [{ message, extensions: { code } }] } */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const e = isCirrusError(err)
    ? err
    : new CirrusError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred.');

  if (!isCirrusError(err)) console.error(err);

  return c.json(e.toBody(), e.status as ContentfulStatusCode);
};

/** Directus returns ROUTE_NOT_FOUND with the message "Route <path> doesn't exist." */
export const notFound: NotFoundHandler<AppEnv> = (c) => c.json(routeNotFound(c.req.path).toBody(), 404);
