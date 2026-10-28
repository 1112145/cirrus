import { exports } from 'cloudflare:workers';

const BASE = 'http://cirrus.test';

/** Gọi Worker đang test, không qua mạng. */
export const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(BASE + path, init));

/** fetch giả để @directus/sdk gọi thẳng vào Worker. */
export const workerFetch: typeof fetch = (input, init) => exports.default.fetch(new Request(input, init));

export { BASE };
