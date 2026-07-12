# Agent 3 — Batch Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the batch scheduler (Шаг 3 of Agent 3's MVP roadmap) — the component that watches
Agent 1/Agent 2's queues, detects a 15-minute quiet period or an 11:00 safety ceiling, and hands the
accumulated batch off to whatever consumes it next (a logging stub in this plan; the LangGraph
analysis graph in a later plan).

**Architecture:** Pure decision logic (`decision.js`) separated from I/O (`pollQueues.js`, which wraps
the existing `fetchAgent1Items`/`fetchAgent2Items` readers) and from state persistence
(`stateStore.js`, an interface with only an in-memory implementation on this slice). `index.js` wires
these together behind `createScheduler({ db, stateStore, onBatchReady, ... })`. Redis-backed state,
`docker-compose.yml`, and the real LangGraph call are explicitly deferred — see
`docs/superpowers/specs/2026-07-08-batch-scheduler-design.md` for the full rationale.

**Tech Stack:** Same as the ingestion-foundation plan — Node.js ESM, no new dependencies, Node's
built-in `node:test` + `node:assert/strict`. Reuses `tests/helpers/fakeSupabase.js` and
`src/ingestion/agent1Reader.js` / `agent2Reader.js` from that plan (already implemented, 28/28 tests
passing).

## Global Constraints

- **Git repo root is `Information analysis agent/`, not `Information analysis agent/Code/`** — every
  `git add`/commit runs from the repo root with the `Code/` prefix (e.g.
  `git add Code/src/scheduler/decision.js`), same as the ingestion-foundation plan.
- **Commit message format:** `Information Analysis Agent | <краткое описание на русском> | vX.Y.Z` —
  use `v0.1.0` for every commit in this plan (still pre-MVP), unless a later task says otherwise.
- **Do not push to `origin`** — commits stay local until the human partner explicitly asks for a push.
- Decision states are the exact literal strings `'OUTSIDE_WINDOW'`, `'WAITING'`, `'BATCH_READY'`,
  `'FORCED_CEILING'` — returned by `decideAction()` and by `checkOnce()`. Any future consumer
  (a later graph-wiring plan) must match these exact strings.
- Default thresholds live in code, not `.env` (env wiring is a separate future slice):
  `DEFAULT_IDLE_MINUTES = 15`, `DEFAULT_CEILING_HOUR = 11`, `DEFAULT_WINDOW_START_HOUR = 8` — matches
  the values already documented in `8. Разработка.md` §2.2 (`BATCH_IDLE_MINUTES`,
  `BATCH_MAX_WAIT_HOUR`).
- Hour comparisons use UTC (`Date#getUTCHours`), not host-machine local time — required for
  deterministic tests regardless of where they run; not something the design spec mandated verbatim,
  but necessary given the spec's times are meant as UTC instants.
- `stateStore` is a `{ get(key), set(key, value) }` interface. Only `createInMemoryStateStore()` is
  implemented in this plan. A `createRedisStateStore()` implementing the same interface, plus
  `docker-compose.yml`/`.env` for Agent 3, is the next slice (per the design doc's "Явно не входит в
  этот слайс" section) — do not build it here.
- `pollQueues`'s client-side `sinceTimestamp` filtering does plain string comparison
  (`item.created_at > sinceTimestamp`) — this is only correct because both readers hand back
  `created_at` as same-precision ISO-8601 UTC strings (as Supabase's `timestamptz` JSON serialization
  already produces, and as every existing ingestion test fixture uses). Do not introduce mixed
  timestamp formats.
- The batch-ready seam is `onBatchReady(items, { reason }) -> void | Promise<void>`, injected into
  `createScheduler`. On this slice, callers pass a stub (e.g. a logger); no LangGraph call exists yet.
- No new dependencies. No Docker/Redis/live Supabase required to run this plan's tests.

---

### Task 1: Decision logic (`decision.js`)

**Files:**
- Create: `Information analysis agent/Code/src/scheduler/decision.js`
- Test: `Information analysis agent/Code/tests/scheduler/decision.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure function).
- Produces: `decideAction({ now, watchStartedAt, lastSeenAt, triggeredToday, idleMinutes, ceilingHour, windowStartHour }) -> 'OUTSIDE_WINDOW' | 'WAITING' | 'BATCH_READY' | 'FORCED_CEILING'`
  and the constants `DEFAULT_IDLE_MINUTES`, `DEFAULT_CEILING_HOUR`, `DEFAULT_WINDOW_START_HOUR` —
  all exported from `src/scheduler/decision.js`. `now` is a `Date`; `watchStartedAt`/`lastSeenAt` are
  ISO-8601 UTC strings or `null`. Task 4 (`index.js`) calls this with state read from `stateStore`.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/scheduler/decision.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAction } from '../../src/scheduler/decision.js';

test('throws when now is not a valid Date', () => {
  assert.throws(
    () => decideAction({ now: '2026-07-08T08:00:00Z' }),
    /now must be a valid Date/
  );
  assert.throws(
    () => decideAction({ now: new Date('not-a-date') }),
    /now must be a valid Date/
  );
});

test('before the observation window returns OUTSIDE_WINDOW', () => {
  const action = decideAction({
    now: new Date('2026-07-08T07:59:00Z'),
    watchStartedAt: null,
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'OUTSIDE_WINDOW');
});

test('triggeredToday returns OUTSIDE_WINDOW even mid-window', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:00:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T08:50:00Z',
    triggeredToday: true
  });
  assert.equal(action, 'OUTSIDE_WINDOW');
});

test('ceiling hour returns FORCED_CEILING even with very recent activity', () => {
  const action = decideAction({
    now: new Date('2026-07-08T11:00:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T10:59:30Z',
    triggeredToday: false
  });
  assert.equal(action, 'FORCED_CEILING');
});

test('within window but watch not started yet returns WAITING', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:00:00Z'),
    watchStartedAt: null,
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'WAITING');
});

test('idle exactly 15 minutes since lastSeenAt returns BATCH_READY', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:15:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T09:00:00Z',
    triggeredToday: false
  });
  assert.equal(action, 'BATCH_READY');
});

test('idle 14:59 since lastSeenAt returns WAITING', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:14:59Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T09:00:00Z',
    triggeredToday: false
  });
  assert.equal(action, 'WAITING');
});

test('idle exactly 15 minutes since watchStartedAt (no lastSeenAt yet) returns BATCH_READY', () => {
  const action = decideAction({
    now: new Date('2026-07-08T08:15:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'BATCH_READY');
});

test('idle 14 minutes since watchStartedAt (no lastSeenAt yet) returns WAITING', () => {
  const action = decideAction({
    now: new Date('2026-07-08T08:14:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'WAITING');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/scheduler/decision.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/scheduler/decision.js

export const DEFAULT_IDLE_MINUTES = 15;
export const DEFAULT_CEILING_HOUR = 11;
export const DEFAULT_WINDOW_START_HOUR = 8;

// Часы сравниваются в UTC (getUTCHours), не в локальном времени машины — иначе
// поведение планировщика зависело бы от таймзоны хоста, на котором он запущен.
export function decideAction({
  now,
  watchStartedAt = null,
  lastSeenAt = null,
  triggeredToday = false,
  idleMinutes = DEFAULT_IDLE_MINUTES,
  ceilingHour = DEFAULT_CEILING_HOUR,
  windowStartHour = DEFAULT_WINDOW_START_HOUR
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('decideAction: now must be a valid Date');
  }

  if (triggeredToday || now.getUTCHours() < windowStartHour) {
    return 'OUTSIDE_WINDOW';
  }
  if (now.getUTCHours() >= ceilingHour) {
    return 'FORCED_CEILING';
  }
  if (!watchStartedAt) {
    return 'WAITING';
  }

  const referenceTime = new Date(lastSeenAt ?? watchStartedAt).getTime();
  const idleMs = now.getTime() - referenceTime;
  if (idleMs >= idleMinutes * 60 * 1000) {
    return 'BATCH_READY';
  }
  return 'WAITING';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 9 tests in `tests/scheduler/decision.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/scheduler/decision.js Code/tests/scheduler/decision.test.js
git commit -m "Information Analysis Agent | decideAction — чистая логика планировщика батча | v0.1.0"
```

---

### Task 2: Queue polling (`pollQueues.js`)

**Files:**
- Create: `Information analysis agent/Code/src/scheduler/pollQueues.js`
- Test: `Information analysis agent/Code/tests/scheduler/pollQueues.test.js`

**Interfaces:**
- Consumes: `fetchAgent1Items` from `src/ingestion/agent1Reader.js`, `fetchAgent2Items` from
  `src/ingestion/agent2Reader.js` (both already implemented); `makeFakeDb` from
  `tests/helpers/fakeSupabase.js` (tests only).
- Produces: `pollQueues(db, { telegramId, sinceTimestamp } = {}) -> Promise<{ items: NormalizedItem[], newestSeenAt: string | null }>`.
  Task 4 (`index.js`) calls this every tick. A failure reading one agent's source does not throw —
  it logs and the other source's items are still returned.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/scheduler/pollQueues.test.js
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
      data: [{ id: 'hq-1', job_id: 'job-mid', result_ref: 'pr-1', attempt_count: 0, status: 'pending', created_at: '2026-07-08T08:10:00Z' }],
      error: null
    }),
    parsing_results: () => ({
      data: { job_id: 'job-mid', module: 'video-module', result_json: { ok: true }, confidence_level: 'средняя', confidence_text: 'ok' },
      error: null
    }),
    parsing_jobs: () => ({ data: { content_type: 'video' }, error: null })
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/scheduler/pollQueues.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/scheduler/pollQueues.js
import { fetchAgent1Items } from '../ingestion/agent1Reader.js';
import { fetchAgent2Items } from '../ingestion/agent2Reader.js';

// Ни agent1Reader, ни agent2Reader не умеют фильтровать "новее X" на уровне SQL —
// оба всегда берут последние `limit` строк. Фильтруем по created_at на стороне
// клиента (см. Global Constraints плана про формат timestamp). Ошибка чтения одного
// источника не должна блокировать другой — частичный результат лучше отказа тика.
export async function pollQueues(db, { telegramId, sinceTimestamp = null } = {}) {
  const [agent1Result, agent2Result] = await Promise.allSettled([
    fetchAgent1Items(db, { telegramId }),
    fetchAgent2Items(db)
  ]);

  const items = [];

  if (agent1Result.status === 'fulfilled') {
    items.push(...agent1Result.value);
  } else {
    console.error('pollQueues: Agent 1 read failed:', agent1Result.reason.message);
  }

  if (agent2Result.status === 'fulfilled') {
    items.push(...agent2Result.value);
  } else {
    console.error('pollQueues: Agent 2 read failed:', agent2Result.reason.message);
  }

  const filtered = sinceTimestamp
    ? items.filter((item) => item.created_at && item.created_at > sinceTimestamp)
    : items;

  const newestSeenAt = filtered.reduce(
    (max, item) => (item.created_at && (!max || item.created_at > max) ? item.created_at : max),
    null
  );

  return { items: filtered, newestSeenAt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 5 tests in `tests/scheduler/pollQueues.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/scheduler/pollQueues.js Code/tests/scheduler/pollQueues.test.js
git commit -m "Information Analysis Agent | pollQueues — объединение Агент 1/Агент 2 с фильтром по курсору | v0.1.0"
```

---

### Task 3: In-memory state store (`stateStore.js`)

**Files:**
- Create: `Information analysis agent/Code/src/scheduler/stateStore.js`
- Test: `Information analysis agent/Code/tests/scheduler/stateStore.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createInMemoryStateStore() -> { get(key): any | null, set(key, value): void }`. Task 4
  (`index.js`) receives an object with this exact shape as its `stateStore` parameter — a future
  `createRedisStateStore()` must implement the same two methods.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/scheduler/stateStore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryStateStore } from '../../src/scheduler/stateStore.js';

test('get returns null for a key that was never set', () => {
  const store = createInMemoryStateStore();
  assert.equal(store.get('missing'), null);
});

test('set then get returns the stored value', () => {
  const store = createInMemoryStateStore();
  store.set('watchStartedAt', '2026-07-08T08:00:00.000Z');
  assert.equal(store.get('watchStartedAt'), '2026-07-08T08:00:00.000Z');
});

test('set overwrites a previous value for the same key', () => {
  const store = createInMemoryStateStore();
  store.set('triggeredToday', false);
  store.set('triggeredToday', true);
  assert.equal(store.get('triggeredToday'), true);
});

test('distinct keys do not interfere with each other', () => {
  const store = createInMemoryStateStore();
  store.set('a', 1);
  store.set('b', 2);
  assert.equal(store.get('a'), 1);
  assert.equal(store.get('b'), 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/scheduler/stateStore.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/scheduler/stateStore.js

export function createInMemoryStateStore() {
  const store = new Map();
  return {
    get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    set(key, value) {
      store.set(key, value);
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 4 tests in `tests/scheduler/stateStore.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/scheduler/stateStore.js Code/tests/scheduler/stateStore.test.js
git commit -m "Information Analysis Agent | InMemoryStateStore — временное хранилище состояния планировщика | v0.1.0"
```

---

### Task 4: Scheduler wiring (`index.js`)

**Files:**
- Create: `Information analysis agent/Code/src/scheduler/index.js`
- Test: `Information analysis agent/Code/tests/scheduler/index.test.js`

**Interfaces:**
- Consumes: `decideAction` + defaults from Task 1; `pollQueues` from Task 2; `createInMemoryStateStore`
  from Task 3 (tests only — `index.js` itself accepts any object matching the `stateStore` interface).
- Produces: `createScheduler({ db, stateStore, onBatchReady, telegramId, now, idleMinutes, ceilingHour, windowStartHour } = {}) -> { checkOnce(): Promise<string>, start(intervalMs): void, stop(): void }`.
  This is the entry point a future application-wiring plan constructs once at startup and a future
  graph-integration plan passes a real `onBatchReady` into (currently only a stub/logger is passed).

- [ ] **Step 1: Write the failing tests**

```javascript
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
  assert.equal(stateStore.get('triggeredToday'), true);
  assert.equal(stateStore.get('watchStartedAt'), null);
  assert.equal(stateStore.get('lastSeenAt'), null);
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
  assert.equal(stateStore.get('triggeredToday'), true);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/scheduler/index.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/scheduler/index.js
import { decideAction } from './decision.js';
import { pollQueues } from './pollQueues.js';

const STATE_KEYS = {
  watchStartedAt: 'watchStartedAt',
  lastSeenAt: 'lastSeenAt',
  triggeredToday: 'triggeredToday'
};

export function createScheduler({
  db,
  stateStore,
  onBatchReady,
  telegramId,
  now = () => new Date(),
  idleMinutes,
  ceilingHour,
  windowStartHour
} = {}) {
  if (!db) throw new Error('createScheduler: db is required');
  if (!stateStore) throw new Error('createScheduler: stateStore is required');
  if (typeof onBatchReady !== 'function') {
    throw new Error('createScheduler: onBatchReady must be a function');
  }

  let intervalHandle = null;

  async function checkOnce() {
    const currentTime = now();
    const state = {
      watchStartedAt: stateStore.get(STATE_KEYS.watchStartedAt),
      lastSeenAt: stateStore.get(STATE_KEYS.lastSeenAt),
      triggeredToday: stateStore.get(STATE_KEYS.triggeredToday) ?? false
    };

    const gateAction = decideAction({ now: currentTime, ...state, idleMinutes, ceilingHour, windowStartHour });
    if (gateAction === 'OUTSIDE_WINDOW') {
      return 'OUTSIDE_WINDOW';
    }

    if (!state.watchStartedAt) {
      state.watchStartedAt = currentTime.toISOString();
      stateStore.set(STATE_KEYS.watchStartedAt, state.watchStartedAt);
    }

    let action = gateAction;
    if (gateAction !== 'FORCED_CEILING') {
      const { newestSeenAt } = await pollQueues(db, { telegramId, sinceTimestamp: state.lastSeenAt });
      if (newestSeenAt) {
        state.lastSeenAt = newestSeenAt;
        stateStore.set(STATE_KEYS.lastSeenAt, newestSeenAt);
      }
      action = decideAction({ now: currentTime, ...state, idleMinutes, ceilingHour, windowStartHour });
    }

    if (action === 'BATCH_READY' || action === 'FORCED_CEILING') {
      let batchItems = [];
      try {
        const result = await pollQueues(db, { telegramId, sinceTimestamp: null });
        batchItems = result.items;
      } catch (err) {
        console.error('scheduler: full-range pollQueues failed at trigger:', err.message);
      }

      try {
        await onBatchReady(batchItems, { reason: action === 'BATCH_READY' ? 'idle' : 'ceiling' });
      } catch (err) {
        console.error('scheduler: onBatchReady failed:', err.message);
      }

      stateStore.set(STATE_KEYS.triggeredToday, true);
      stateStore.set(STATE_KEYS.watchStartedAt, null);
      stateStore.set(STATE_KEYS.lastSeenAt, null);
    }

    return action;
  }

  function start(intervalMs) {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
      checkOnce().catch((err) => console.error('scheduler: unexpected error in checkOnce:', err.message));
    }, intervalMs);
  }

  function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return { checkOnce, start, stop };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 7 tests in `tests/scheduler/index.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/scheduler/index.js Code/tests/scheduler/index.test.js
git commit -m "Information Analysis Agent | createScheduler — checkOnce/start/stop, onBatchReady колбэк | v0.1.0"
```

---

## Self-Review

**Spec coverage:** Task 1 covers the design doc's "decision.js" section (all four states, thresholds,
UTC determinism). Task 2 covers "pollQueues.js" (merge + cursor filter + partial-failure tolerance).
Task 3 covers "stateStore.js" (in-memory only, Redis explicitly deferred). Task 4 covers "index.js"
(checkOnce/start/stop, the `onBatchReady` seam, error handling for both poll and callback failures,
and the design's resolved open question — batch items are re-read as a full range at trigger time
rather than accumulated in `stateStore`). The design doc's "Явно не входит в этот слайс" items
(Redis, docker-compose, real graph call) have no task here, matching the design's own scope boundary.

**Placeholder scan:** No TBD/TODO markers. Every step has complete, runnable code.

**Type consistency:** `decideAction`'s four return strings are used identically in `decision.test.js`
and `index.js`. `pollQueues`'s `{ items, newestSeenAt }` shape is used identically in
`pollQueues.test.js` and `index.js`. `stateStore`'s `{ get, set }` interface is used identically by
`index.js` and by every `index.test.js` test that constructs `createInMemoryStateStore()` directly.
`onBatchReady(items, { reason })` — the `reason` values `'idle'`/`'ceiling'` are used identically in
`index.js` and asserted identically across all `index.test.js` trigger tests.
