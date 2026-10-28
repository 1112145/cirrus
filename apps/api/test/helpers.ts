import { exports } from 'cloudflare:workers';

const BASE = 'http://cirrus.test';

/** Call the Worker under test without going over the network. */
export const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(BASE + path, init));

/** fetch shim that lets @directus/sdk call the Worker directly. */
export const workerFetch: typeof fetch = (input, init) => exports.default.fetch(new Request(input, init));

export { BASE };
