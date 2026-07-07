import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem } from '../../src/ingestion/normalize.js';

test('throws if job_id is missing', () => {
  assert.throws(
    () => normalizeItem({ agent: 1, content_type: 'search' }),
    /job_id is required/
  );
});

test('throws if agent is not 1 or 2', () => {
  assert.throws(
    () => normalizeItem({ job_id: 'abc', agent: 3, content_type: 'search' }),
    /agent must be 1 or 2/
  );
});

test('preserves a valid confidence object as-is', () => {
  const result = normalizeItem({
    job_id: 'abc',
    agent: 1,
    content_type: 'search',
    confidence: { level: 'высокая', explanation: 'Все источники доступны' }
  });
  assert.deepEqual(result.confidence, { level: 'высокая', explanation: 'Все источники доступны' });
});

test('defaults confidence to низкая when missing', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 2, content_type: 'video' });
  assert.equal(result.confidence.level, 'низкая');
  assert.match(result.confidence.explanation, /не указан/);
});

test('defaults meta when missing (Agent 2 does not persist meta yet)', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 2, content_type: 'video' });
  assert.deepEqual(result.meta, { tools_used: [], cost_usd: null, duration_sec: null });
});

test('preserves provided meta as-is', () => {
  const meta = { tools_used: ['perplexity'], cost_usd: 0.02, duration_sec: 12 };
  const result = normalizeItem({ job_id: 'abc', agent: 1, content_type: 'search', meta });
  assert.deepEqual(result.meta, meta);
});

test('defaults content_type to "unknown" when missing', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 2 });
  assert.equal(result.content_type, 'unknown');
});

test('defaults result and created_at to null when missing', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 1 });
  assert.equal(result.result, null);
  assert.equal(result.created_at, null);
});

test('regression: DEFAULT_META factory returns fresh array each call (no shared aliasing)', () => {
  const result1 = normalizeItem({ job_id: 'job1', agent: 1 });
  const result2 = normalizeItem({ job_id: 'job2', agent: 2 });

  // Mutate first result's tools_used
  result1.meta.tools_used.push('perplexity');

  // Assert second result's tools_used is still empty (not corrupted by mutation)
  assert.deepEqual(result2.meta.tools_used, [], 'tools_used arrays must not be shared');
  assert.deepEqual(result1.meta.tools_used, ['perplexity'], 'first mutation must be preserved');
});
