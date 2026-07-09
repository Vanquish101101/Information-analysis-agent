import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHttpServer } from '../../src/mcp-server/http.js';

function fakeDb() {
  return {};
}

test('GET /health returns 200 with service status', async () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await fetch(`http://localhost:${port}/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'information-analysis-agent');

  await new Promise((resolve) => server.close(resolve));
});

test('unknown routes return 404', async () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await fetch(`http://localhost:${port}/unknown`);

  assert.equal(res.status, 404);

  await new Promise((resolve) => server.close(resolve));
});

test('createMcpHttpServer returns a real http.Server instance, not started', () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 7302 });

  assert.ok(server);
  assert.equal(server.listening, false);
});
