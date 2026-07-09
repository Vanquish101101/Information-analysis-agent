import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTools, callTool, createMcpServer } from '../../src/mcp-server/server.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('listTools returns the three expected tools', async () => {
  const result = await listTools();

  const names = result.tools.map((t) => t.name);
  assert.deepEqual(names, ['analysis_digest', 'analysis_detail', 'analysis_status']);
});

test('analysis_digest tool schema does not require any parameters', async () => {
  const result = await listTools();
  const tool = result.tools.find((t) => t.name === 'analysis_digest');

  assert.equal(tool.inputSchema.required, undefined);
});

test('analysis_detail tool schema requires claim_id', async () => {
  const result = await listTools();
  const tool = result.tools.find((t) => t.name === 'analysis_detail');

  assert.deepEqual(tool.inputSchema.required, ['claim_id']);
});

test('callTool analysis_digest returns the digest as JSON text content', async () => {
  const db = makeFakeDb({ digests: () => ({ data: [{ id: 'digest-1', run_id: 'run-1', run_at: '2026-07-09T10:00:00Z', facts: [], contradictions: [], meta: {} }], error: null }) });

  const result = await callTool(db, { params: { name: 'analysis_digest', arguments: {} } });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.digest_id, 'digest-1');
});

test('callTool analysis_digest passes through a given run_id', async () => {
  let filters = null;
  const db = makeFakeDb({ digests: (state) => { filters = state.filters; return { data: [{ id: 'digest-2', run_id: state.filters.run_id, run_at: 'x', facts: [], contradictions: [], meta: {} }], error: null }; } });

  await callTool(db, { params: { name: 'analysis_digest', arguments: { run_id: 'run-99' } } });

  assert.equal(filters.run_id, 'run-99');
});

test('callTool analysis_detail returns a descriptive isError when claim_id is missing', async () => {
  const db = makeFakeDb({});

  const result = await callTool(db, { params: { name: 'analysis_detail', arguments: {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /claim_id is required/);
});

test('callTool analysis_detail returns a descriptive isError when the claim is not found', async () => {
  const db = makeFakeDb({ claims: () => ({ data: [], error: null }) });

  const result = await callTool(db, { params: { name: 'analysis_detail', arguments: { claim_id: 'claim-missing' } } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /claim-missing/);
  assert.match(result.content[0].text, /not found/);
});

test('callTool analysis_detail returns the claim detail as JSON text content on success', async () => {
  const db = makeFakeDb({
    claims: () => ({ data: [{ id: 'claim-1', subject_entity_id: 'ent-1', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }], error: null }),
    entities: () => ({ data: [{ id: 'ent-1', name: 'X' }], error: null }),
    claim_sources: () => ({ data: [], error: null })
  });

  const result = await callTool(db, { params: { name: 'analysis_detail', arguments: { claim_id: 'claim-1' } } });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.claim_id, 'claim-1');
});

test('callTool analysis_status returns the status as JSON text content', async () => {
  const db = makeFakeDb({
    runs: () => ({ data: [], error: null }),
    pending_user_decisions: () => ({ data: [], error: null })
  });

  const result = await callTool(db, { params: { name: 'analysis_status', arguments: {} } });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, null);
});

test('callTool returns a descriptive isError for an unknown tool name', async () => {
  const db = makeFakeDb({});

  const result = await callTool(db, { params: { name: 'unknown_tool', arguments: {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool/);
});

test('callTool wraps a query failure in isError rather than throwing', async () => {
  const db = makeFakeDb({ digests: () => ({ data: null, error: { message: 'connection lost' } }) });

  const result = await callTool(db, { params: { name: 'analysis_digest', arguments: {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /connection lost/);
});

test('createMcpServer returns a real Server instance wired with db', () => {
  const db = makeFakeDb({});
  const server = createMcpServer({ db });

  assert.ok(server);
});
