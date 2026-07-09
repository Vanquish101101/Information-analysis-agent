// tests/handoff/agent4Handoff.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent4Notifier } from '../../src/handoff/agent4Handoff.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

function makeDb(overrides = {}) {
  return makeFakeDb({
    agent4_handoff_queue: () => ({ error: null }),
    ...overrides
  });
}

function fakeRedis({ publishResult = 1, publishShouldThrow = false } = {}) {
  const calls = [];
  return {
    calls,
    publish: async (channel, message) => {
      calls.push({ channel, message: JSON.parse(message) });
      if (publishShouldThrow) throw new Error('Redis unavailable');
      return publishResult;
    }
  };
}

test('inserts a pending row into agent4_handoff_queue with job_id = run_id', async () => {
  const inserts = [];
  const db = makeFakeDb({
    agent4_handoff_queue: (state) => { inserts.push(state.payload); return { error: null }; }
  });
  const redis = fakeRedis();
  const notify = createAgent4Notifier({ db, _redis: redis });

  await notify('run-42');

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].job_id, 'run-42');
  assert.equal(inserts[0].result_ref, 'run-42');
  assert.equal(inserts[0].status, 'pending');
  assert.equal(inserts[0].attempt_count, 0);
});

test('publishes digest_ready event to notifications:agent4 Redis channel', async () => {
  const redis = fakeRedis();
  const notify = createAgent4Notifier({ db: makeDb(), _redis: redis });

  await notify('run-99');

  assert.equal(redis.calls.length, 1);
  assert.equal(redis.calls[0].channel, 'notifications:agent4');
  assert.equal(redis.calls[0].message.event, 'digest_ready');
  assert.equal(redis.calls[0].message.run_id, 'run-99');
  assert.ok(redis.calls[0].message.timestamp);
});

test('a Supabase insert error is caught and does not throw (non-fatal)', async () => {
  const db = makeFakeDb({
    agent4_handoff_queue: () => ({ error: { message: 'connection timeout' } })
  });
  const redis = fakeRedis();
  const notify = createAgent4Notifier({ db, _redis: redis });

  await assert.doesNotReject(() => notify('run-fail'));
});

test('a Redis publish error is caught and does not throw (non-fatal)', async () => {
  const redis = fakeRedis({ publishShouldThrow: true });
  const notify = createAgent4Notifier({ db: makeDb(), _redis: redis });

  await assert.doesNotReject(() => notify('run-redis-fail'));
});

test('works without a Redis client — only writes to Supabase', async () => {
  const inserts = [];
  const db = makeFakeDb({
    agent4_handoff_queue: (state) => { inserts.push(state.payload); return { error: null }; }
  });
  const notify = createAgent4Notifier({ db, _redis: null });

  await notify('run-no-redis');

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].job_id, 'run-no-redis');
});
