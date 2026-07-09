import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollQueues } from '../../src/scheduler/pollQueues.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

function agent1Row(jobId, createdAt) {
  return {
    job_id: jobId,
    telegram_id: 123,
    result: { raw: { ok: true } },
    telegram_text: '',
    confidence: { level: 'высокая', explanation: 'ok' },
    meta: { tools_used: [], cost_usd: 0, duration_sec: 1 },
    created_at: createdAt
  };
}

test('merges agent1 and agent2 items and filters by sinceTimestamp', async () => {
  const db = makeFakeDb({
    search_results: () => ({
      data: [agent1Row('job-old', '2026-07-08T08:00:00Z'), agent1Row('job-new', '2026-07-08T08:20:00Z')],
      error: null
    }),
    agent3_handoff_queue: () => ({
      data: [{ id: 'hq-1', job_id: 'job-mid', result_ref: 'pr-1', attempt_count: 0, status: 'pending' }],
      error: null
    }),
    parsing_results: () => ({
      data: { job_id: 'job-mid', module: 'video-module', result_json: { ok: true }, confidence_level: 'средняя', confidence_text: 'ok' },
      error: null
    }),
    parsing_jobs: () => ({ data: { content_type: 'video', created_at: '2026-07-08T08:10:00Z' }, error: null })
  });

  const { items, newestSeenAt } = await pollQueues(db, { telegramId: 123, sinceTimestamp: '2026-07-08T08:05:00Z' });

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.job_id).sort(), ['job-mid', 'job-new']);
  assert.equal(newestSeenAt, '2026-07-08T08:20:00Z');
});

test('returns all items when sinceTimestamp is null', async () => {
  const db = makeFakeDb({
    search_results: () => ({ data: [agent1Row('job-a', '2026-07-08T08:00:00Z')], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });

  const { items, newestSeenAt } = await pollQueues(db, { telegramId: 123 });

  assert.equal(items.length, 1);
  assert.equal(newestSeenAt, '2026-07-08T08:00:00Z');
});

test('returns empty items and null newestSeenAt when both queues are empty', async () => {
  const db = makeFakeDb({
    search_results: () => ({ data: [], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });

  const { items, newestSeenAt } = await pollQueues(db, { telegramId: 123 });

  assert.deepEqual(items, []);
  assert.equal(newestSeenAt, null);
});

test('tolerates Agent 1 read failure, still returns Agent 2 items', async () => {
  const db = makeFakeDb({
    search_results: () => ({ data: null, error: { message: 'agent1 down' } }),
    agent3_handoff_queue: () => ({
      data: [{ id: 'hq-2', job_id: 'job-b', result_ref: 'pr-2', attempt_count: 0, status: 'pending', created_at: '2026-07-08T08:00:00Z' }],
      error: null
    }),
    parsing_results: () => ({
      data: { job_id: 'job-b', module: 'audio-module', result_json: { ok: true }, confidence_level: 'высокая', confidence_text: 'ok' },
      error: null
    }),
    parsing_jobs: () => ({ data: { content_type: 'audio' }, error: null })
  });

  const { items } = await pollQueues(db, { telegramId: 123 });

  assert.equal(items.length, 1);
  assert.equal(items[0].job_id, 'job-b');
});

test('tolerates Agent 2 read failure, still returns Agent 1 items', async () => {
  const db = makeFakeDb({
    search_results: () => ({ data: [agent1Row('job-c', '2026-07-08T08:00:00Z')], error: null }),
    agent3_handoff_queue: () => ({ data: null, error: { message: 'agent2 down' } })
  });

  const { items } = await pollQueues(db, { telegramId: 123 });

  assert.equal(items.length, 1);
  assert.equal(items[0].job_id, 'job-c');
});
