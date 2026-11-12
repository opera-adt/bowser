// @vitest-environment node
/* eslint-env node */
/** Exercise the real development proxy with local HTTP servers. */
import { createServer as createHttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';

let vite;
let base;
let previousTarget;
const backend = createHttpServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({
    method: request.method,
    path: request.url,
    body: JSON.parse(Buffer.concat(chunks).toString() || 'null'),
  }));
});

beforeAll(async () => {
  previousTarget = process.env.VITE_API_URL;
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  process.env.VITE_API_URL = `http://127.0.0.1:${backend.address().port}`;
  // Load the repository's actual config rather than duplicating its route list.
  vite = await createServer({
    logLevel: 'silent',
    server: {
      host: '127.0.0.1', port: 0, strictPort: false,
      hmr: false, preTransformRequests: false,
    },
  });
  await vite.listen();
  base = `http://127.0.0.1:${vite.httpServer.address().port}`;
});

afterAll(async () => {
  try {
    if (vite) await vite.close();
    backend.closeAllConnections();
    await new Promise((resolve, reject) => {
      backend.close(error => error ? reject(error) : resolve());
    });
  } finally {
    if (previousTarget === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousTarget;
  }
});

describe('development API proxy', () => {
  it.each([
    '/polygon_timeseries', '/polygon_timeseries?dataset=example',
    '/polygon_timeseries/', '/multi_point', '/buffer_timeseries',
  ])('forwards POST %s with its JSON body', async path => {
    const body = {
      variable: 'displacement', support: 'common', percentiles: [10, 90],
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      },
    };
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ method: 'POST', path, body });
  });

  it.each(['/polygon_timeseries_notes', '/polygon_timeseries-extra'])(
    'does not proxy the similar frontend path %s', async path => {
      const response = await fetch(base + path, { method: 'POST', body: '{}' });
      expect(response.status).toBe(404);
    },
  );
});
