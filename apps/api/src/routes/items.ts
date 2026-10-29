import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { itemsContext } from '../items/context.ts';
import { requestContext } from '../request.ts';
import { itemRoutes } from './item-routes.ts';

/**
 * SDK: readItems, readItem, createItem(s), updateItem(s), updateItemsBatch, deleteItem(s),
 * readSingleton, updateSingleton, and withSearch() (the SEARCH method). Access follows the
 * request's permissions (spec §10); the public policy starts with none, as in Directus. System
 * collections (directus_*) have their own paths and are FORBIDDEN here.
 */
export const items = new Hono<AppEnv>();

itemRoutes(items, '/:collection', async (c) => itemsContext(await requestContext(c), c.req.param('collection')!));
