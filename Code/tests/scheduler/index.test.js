// tests/scheduler/index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../src/scheduler/index.js';
import { createInMemoryStateStore } from '../../src/scheduler/stateStore.js';
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

test('before the observation window, checkOnce returns OUTSIDE_WINDOW without polling', async () => {
  const db = { from() { throw new Error('db.from should not be called outside the window'); } };
  const scheduler = createScheduler({
    db,
    stateStore: createInMemoryStateStore(),
    onBatchReady: async () => { throw new Error('onBatchReady should not be called'); },
    now: () => new Date('2026-07-08T07:00:00Z')
  });

  assert.equal(await scheduler.checkOnce(), 'OUTSIDE_WINDOW');
});

test('within the window with no activity yet, checkOnce polls and returns WAITING', async () => {
  let fromCalls = 0;
  const baseDb = makeFakeDb({
    search_results: () => ({ data: [], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const db = { from(table) { fromCalls += 1; return baseDb.from(table); } };
  const stateStore = createInMemoryStateStore();

  const scheduler = createScheduler({
    db,
    stateStore,
    onBatchReady: async () => {},
    telegramId: 123,
    now: () => new Date('2026-07-08T08:05:00Z')
  });

  assert.equal(await scheduler.checkOnce(), 'WAITING');
  assert.ok(fromCalls > 0, 'expected checkOnce to poll the queues within the window');
  assert.equal(stateStore.get('watchStartedAt'), '2026-07-08T08:05:00.000Z');
});

test('idle 15 minutes with no activity at all triggers BATCH_READY with reason idle', async () => {
  let currentTime = new Date('2026-07-08T08:00:00Z');
  const db = makeFakeDb({
    search_results: () => ({ data: [], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const calls = [];
  const stateStore = createInMemoryStateStore();
  const scheduler = createScheduler({
    db,
    stateStore,
    onBatchReady: async (items, meta) => { calls.push({ items, meta }); },
    telegramId: 123,
    now: () => currentTime
  });

  assert.equal(await scheduler.checkOnce(), 'WAITING');

  currentTime = new Date('2026-07-08T08:16:00Z');
  assert.equal(await scheduler.checkOnce(), 'BATCH_READY');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items, []);
  assert.equal(calls[0].meta.reason, 'idle');
  assert.equal(stateStore.get('triggeredOnDate'), '2026-07-08');
  assert.equal(stateStore.get('watchStartedAt'), null);
  assert.equal(stateStore.get('lastSeenAt'), null);
});

test('triggeredOnDate resets on a new UTC day, re-arming the scheduler', async () => {
  let currentTime = new Date('2026-07-08T08:00:00Z');
  const db = makeFakeDb({
    search_results: () => ({ data: [], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const calls = [];
  const stateStore = createInMemoryStateStore();
  const scheduler = createScheduler({
    db,
    stateStore,
    onBatchReady: async (items, meta) => { calls.push({ items, meta }); },
    telegramId: 123,
    now: () => currentTime
  });

  assert.equal(await scheduler.checkOnce(), 'WAITING');

  currentTime = new Date('2026-07-08T08:16:00Z');
  assert.equal(await scheduler.checkOnce(), 'BATCH_READY');
  assert.equal(calls.length, 1);
  assert.equal(stateStore.get('triggeredOnDate'), '2026-07-08');

  currentTime = new Date('2026-07-09T08:00:00Z');
  assert.equal(await scheduler.checkOnce(), 'WAITING');
});

test('a new item arriving resets the idle clock', async () => {
  let currentTime = new Date('2026-07-08T08:00:00Z');
  let searchRows = [];
  const db = makeFakeDb({
    search_results: () => ({ data: searchRows, error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const calls = [];
  const scheduler = createScheduler({
    db,
    stateStore: createInMemoryStateStore(),
    onBatchReady: async (items, meta) => { calls.push({ items, meta }); },
    telegramId: 123,
    now: () => currentTime
  });

  assert.equal(await scheduler.checkOnce(), 'WAITING'); // 08:00 — watch starts

  currentTime = new Date('2026-07-08T08:10:00Z');
  searchRows = [agent1Row('job-1', '2026-07-08T08:10:00Z')];
  assert.equal(await scheduler.checkOnce(), 'WAITING'); // new item arrives, resets idle clock

  currentTime = new Date('2026-07-08T08:24:00Z');
  searchRows = [];
  assert.equal(await scheduler.checkOnce(), 'WAITING'); // 14 min since 08:10 — still waiting

  currentTime = new Date('2026-07-08T08:26:00Z');
  assert.equal(await scheduler.checkOnce(), 'BATCH_READY'); // 16 min since 08:10 — triggers
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.reason, 'idle');
});

test('ceiling hour forces a trigger with reason ceiling even with very recent activity', async () => {
  let currentTime = new Date('2026-07-08T08:00:00Z');
  let searchRows = [];
  const db = makeFakeDb({
    search_results: () => ({ data: searchRows, error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const calls = [];
  const scheduler = createScheduler({
    db,
    stateStore: createInMemoryStateStore(),
    onBatchReady: async (items, meta) => { calls.push({ items, meta }); },
    telegramId: 123,
    now: () => currentTime
  });

  assert.equal(await scheduler.checkOnce(), 'WAITING'); // 08:00 — watch starts

  currentTime = new Date('2026-07-08T10:59:00Z');
  searchRows = [agent1Row('job-2', '2026-07-08T10:59:00Z')];
  assert.equal(await scheduler.checkOnce(), 'WAITING'); // fresh activity, 1 minute before ceiling

  currentTime = new Date('2026-07-08T11:00:00Z');
  searchRows = [];
  const action = await scheduler.checkOnce();

  assert.equal(action, 'FORCED_CEILING');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.reason, 'ceiling');
});

test('onBatchReady throwing does not crash checkOnce and state still resets', async () => {
  let currentTime = new Date('2026-07-08T08:00:00Z');
  const db = makeFakeDb({
    search_results: () => ({ data: [], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const stateStore = createInMemoryStateStore();
  const scheduler = createScheduler({
    db,
    stateStore,
    onBatchReady: async () => { throw new Error('boom'); },
    telegramId: 123,
    now: () => currentTime
  });

  assert.equal(await scheduler.checkOnce(), 'WAITING');

  currentTime = new Date('2026-07-08T08:16:00Z');
  const action = await scheduler.checkOnce();

  assert.equal(action, 'BATCH_READY');
  assert.equal(stateStore.get('triggeredOnDate'), '2026-07-08');
});

test('start() schedules repeated checkOnce polls, stop() halts them', async () => {
  let fromCalls = 0;
  const baseDb = makeFakeDb({
    search_results: () => ({ data: [], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const db = { from(table) { fromCalls += 1; return baseDb.from(table); } };
  const scheduler = createScheduler({
    db,
    stateStore: createInMemoryStateStore(),
    onBatchReady: async () => {},
    telegramId: 123,
    now: () => new Date('2026-07-08T08:05:00Z')
  });

  scheduler.start(10);
  await new Promise((resolve) => setTimeout(resolve, 55));
  scheduler.stop();
  const callsAfterStop = fromCalls;
  await new Promise((resolve) => setTimeout(resolve, 55));

  assert.ok(callsAfterStop >= 2, `expected at least 2 polling ticks, got ${callsAfterStop}`);
  assert.equal(fromCalls, callsAfterStop, 'stop() must prevent further polling');
});

test('works correctly with an async (Promise-returning) stateStore, not just a synchronous one', async () => {
  const syncStore = createInMemoryStateStore();
  const asyncStore = {
    async get(key) { return syncStore.get(key); },
    async set(key, value) { return syncStore.set(key, value); }
  };

  let currentTime = new Date('2026-07-08T08:00:00Z');
  const db = makeFakeDb({
    search_results: () => ({ data: [], error: null }),
    agent3_handoff_queue: () => ({ data: [], error: null })
  });
  const calls = [];
  const scheduler = createScheduler({
    db,
    stateStore: asyncStore,
    onBatchReady: async (items, meta) => { calls.push({ items, meta }); },
    telegramId: 123,
    now: () => currentTime
  });

  assert.equal(await scheduler.checkOnce(), 'WAITING');

  currentTime = new Date('2026-07-08T08:16:00Z');
  assert.equal(await scheduler.checkOnce(), 'BATCH_READY');
  assert.equal(calls.length, 1);
});
