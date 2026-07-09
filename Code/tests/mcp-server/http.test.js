import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../../src/mcp-server/http.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

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

// Реальный сквозной раунд-трип через /mcp — та же связка Client +
// StreamableHTTPClientTransport из @modelcontextprotocol/sdk, что уже
// используется deepParsingClient.js (клиентская сторона у Агента 3),
// только здесь Агент 3 выступает сервером. Проверяет, что реальный
// WebStandardStreamableHTTPServerTransport (обход бага Node v24 в
// @hono/node-server) действительно работает end-to-end, а не только
// listTools/callTool в изоляции (server.test.js их уже покрывает
// напрямую, минуя транспорт).
async function connectRealClient(port) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

test('/mcp: a real client can connect and list the three tools over the actual HTTP transport', async () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const { client } = await connectRealClient(port);
  try {
    const result = await client.listTools();

    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      ['analysis_detail', 'analysis_digest', 'analysis_status']
    );
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/mcp: a real client can call analysis_status and receive a genuine tool response over HTTP', async () => {
  const db = makeFakeDb({
    runs: () => ({ data: [{ run_at: '2026-07-09T10:00:00Z', status: 'ok', items_processed: 2, cost_usd: 0.01 }], error: null }),
    pending_user_decisions: () => ({ data: [], error: null })
  });
  const server = createMcpHttpServer({ db, port: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const { client } = await connectRealClient(port);
  try {
    const result = await client.callTool({ name: 'analysis_status', arguments: {} });

    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.items_processed, 2);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/mcp: a real client calling an unknown tool gets a genuine isError response over HTTP', async () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const { client } = await connectRealClient(port);
  try {
    const result = await client.callTool({ name: 'not_a_real_tool', arguments: {} });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
