import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAgent2Items } from '../../src/ingestion/agent2Reader.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('joins handoff_queue -> parsing_results -> parsing_jobs into a normalized item', async () => {
  const db = makeFakeDb({
    agent3_handoff_queue: () => ({
      data: [{ id: 'hq-1', job_id: 'job-9', result_ref: 'pr-1', attempt_count: 0, status: 'pending', created_at: '2026-07-07T09:00:00Z' }],
      error: null
    }),
    parsing_results: (state) => {
      assert.equal(state.filters.id, 'pr-1');
      return {
        data: {
          job_id: 'job-9',
          module: 'video-module',
          result_json: { transcript: 'текст видео' },
          confidence_level: 'средняя',
          confidence_text: 'Автосубтитры, не проверено вручную'
        },
        error: null
      };
    },
    parsing_jobs: (state) => {
      assert.equal(state.filters.id, 'job-9');
      return { data: { content_type: 'video' }, error: null };
    }
  });

  const items = await fetchAgent2Items(db);

  assert.equal(items.length, 1);
  assert.equal(items[0].job_id, 'job-9');
  assert.equal(items[0].agent, 2);
  assert.equal(items[0].content_type, 'video');
  assert.deepEqual(items[0].result, { transcript: 'текст видео' });
  assert.equal(items[0].confidence.level, 'средняя');
  assert.equal(items[0].handoff_queue_id, 'hq-1');
  assert.equal(items[0].created_at, '2026-07-07T09:00:00Z');
});

test('meta defaults to null-filled object since Agent 2 does not persist it yet', async () => {
  const db = makeFakeDb({
    agent3_handoff_queue: () => ({
      data: [{ id: 'hq-2', job_id: 'job-10', result_ref: 'pr-2', attempt_count: 0, status: 'pending' }],
      error: null
    }),
    parsing_results: () => ({
      data: {
        job_id: 'job-10',
        module: 'audio-module',
        result_json: { transcript: 'аудио' },
        confidence_level: 'высокая',
        confidence_text: 'ok'
      },
      error: null
    }),
    parsing_jobs: () => ({ data: { content_type: 'audio' }, error: null })
  });

  const items = await fetchAgent2Items(db);
  assert.deepEqual(items[0].meta, { tools_used: [], cost_usd: null, duration_sec: null });
});

test('skips a handoff row when result_ref is null', async () => {
  const db = makeFakeDb({
    agent3_handoff_queue: () => ({
      data: [{ id: 'hq-3', job_id: 'job-11', result_ref: null, attempt_count: 0, status: 'pending' }],
      error: null
    })
  });
  const items = await fetchAgent2Items(db);
  assert.deepEqual(items, []);
});

test('skips a handoff row when the joined parsing_results lookup errors', async () => {
  const db = makeFakeDb({
    agent3_handoff_queue: () => ({
      data: [{ id: 'hq-4', job_id: 'job-12', result_ref: 'pr-missing', attempt_count: 0, status: 'pending' }],
      error: null
    }),
    parsing_results: () => ({ data: null, error: { message: 'not found' } })
  });
  const items = await fetchAgent2Items(db);
  assert.deepEqual(items, []);
});

test('returns an empty array when the queue is empty', async () => {
  const db = makeFakeDb({ agent3_handoff_queue: () => ({ data: [], error: null }) });
  const items = await fetchAgent2Items(db);
  assert.deepEqual(items, []);
});

test('throws a descriptive error when the handoff_queue query itself fails', async () => {
  const db = makeFakeDb({
    agent3_handoff_queue: () => ({ data: null, error: { message: 'connection refused' } })
  });
  await assert.rejects(() => fetchAgent2Items(db), /fetchAgent2Items: connection refused/);
});
