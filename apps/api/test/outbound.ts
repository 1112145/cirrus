/**
 * The Internet as tests see it (miniflare's outboundService, run by Node): files to import from
 * https://files.test/ (POST /files/import).
 */

import { PNG } from './fixtures.ts';

export function outbound(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname !== 'files.test') return new Response('No network in tests', { status: 502 });
  switch (url.pathname) {
    case '/images/sunset-photo.png':
      return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    case '/redirect':
      return Response.redirect('https://files.test/docs/caf%C3%A9%20menu.txt', 302);
    case '/docs/caf%C3%A9%20menu.txt':
      return new Response('Soup of the day', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    case '/page.html':
      return new Response('<p>hi</p>', { headers: { 'Content-Type': 'text/html' } });
    default:
      return new Response('Not found', { status: 404 });
  }
}
