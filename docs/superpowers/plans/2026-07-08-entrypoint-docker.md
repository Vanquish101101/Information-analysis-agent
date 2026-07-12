# Agent 3 — Entry Point + Redis + Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-tested batch scheduler and analysis graph together into one running
application, back the scheduler's state with the shared Redis instance (instead of in-memory), and
deploy the whole thing as a Docker container on `marketing-agency-net`, matching Agent 1/Agent 2's
existing deployment pattern.

**Architecture:** `src/scheduler/redisStateStore.js` implements the same `{get, set}` interface as
`InMemoryStateStore` but backed by the shared Redis (`ioredis`), so the scheduler's own logic never
changes — only which `StateStore` implementation is injected. `src/index.js` is the first real
application entry point: it constructs the real Supabase client, the real OpenRouter extractor, the
real Redis-backed state store, the compiled analysis graph, and the scheduler, then starts polling.
`Dockerfile`/`docker-compose.yml` package this to run continuously, connected to the same
`marketing-agency-net` network and the same shared Redis container Agent 1/Agent 2 already use.

**Tech Stack:** Adds `ioredis` (same client library both sibling agents already use). Node.js LTS
Alpine base image (`node:22-alpine`, same as `Deep parsing agent/Code/Dockerfile`).

## Global Constraints

- **Git repo root is `Information analysis agent/`, not `Information analysis agent/Code/`** — every
  `git add`/commit runs from the repo root with the `Code/` prefix.
- **Commit message format:** `Information Analysis Agent | <краткое описание на русском> | vX.Y.Z` —
  use `v0.3.0` for every commit in this plan (matches the current `package.json` version; the next
  version bump happens once, at the end of this slice).
- **Do not push to `origin`** — commits stay local until the human partner explicitly asks for a push.
- **Confirmed real infrastructure facts (checked directly, not assumed):**
  - The shared Redis container is already running (`marketing-agency-redis`, image `redis:7-alpine`),
    reachable from the host at `redis://localhost:6379` (port `6379` is published) and from inside
    `marketing-agency-net` at `redis://redis:6379` (service name `redis`, per
    `Инфраструктура (Docker)/docker-compose.yml`).
  - `Deep parsing agent/Code/docker-compose.yml` overrides `REDIS_URL` via its `environment:` block
    to `redis://redis:6379/0` when running inside Docker (the `.env`'s own `REDIS_URL` value is for
    local/non-Docker runs only) — this plan's `docker-compose.yml` follows the identical pattern.
  - Both `Intelligence agent` and `Deep parsing agent` depend on `ioredis` (`^5.11.1` and `^5.4.2`
    respectively) — this plan adds `"ioredis": "^5.4.2"` for consistency with the more recent sibling.
  - `Deep parsing agent/Code/Dockerfile` uses `FROM node:22-alpine`, `npm ci --omit=dev`, copies only
    `package.json`/`package-lock.json` then `src/` — this plan's `Dockerfile` follows the identical
    structure (no `EXPOSE`, since Agent 3 has no HTTP server yet — that's a future MCP-server slice).
  - `marketing-agency-net` is a real, currently-running external Docker network (confirmed via
    `docker ps` — `deep-parsing-agent`, `video-pipeline`, `intelligence-agent`,
    `marketing-agency-redis` are all up).
- **Critical correctness fact discovered while writing the design spec, confirmed by reading the
  actual code:** `src/scheduler/index.js`'s `checkOnce()` calls `stateStore.get(...)` and
  `stateStore.set(...)` **without `await`** (lines 32, 34, 35, 47, 55, 75-77). This is harmless with
  the existing synchronous `InMemoryStateStore`, but a Redis-backed store's `get`/`set` are
  necessarily asynchronous (`Promise`-returning) — without adding `await`, `state.watchStartedAt`
  would become a pending `Promise` object (always truthy) instead of the real stored value, silently
  breaking every decision the scheduler makes. **Task 2 fixes this.** `await`-ing a synchronous,
  non-Promise return value is a no-op in JavaScript (`await 'foo'` resolves to `'foo'` on the next
  microtask) — so this fix is safe for the existing `InMemoryStateStore` and requires no test changes
  to the 7 pre-existing tests in `tests/scheduler/index.test.js`, only one new regression test proving
  the async case.
- `RedisStateStore` keys are prefixed `scheduler:agent3:` to avoid collision with any other agent's
  keys in the same shared Redis instance.
- Setting a key to `null` (the scheduler's reset-to-null pattern after a trigger) must delete the
  Redis key (`DEL`), not write the literal string `"null"` — writing the string would make
  `stateStore.get(...)` return the truthy string `"null"` instead of the real `null` on the next read,
  breaking the scheduler's `!state.watchStartedAt` checks.
- No MCP server, no Telegram notifications, no deduplication/contradictions/escalation/synthesis, no
  connecting this container into the shared top-level deploy file (`Инфраструктура (Docker)/
  docker-compose.yml`'s `include:`) — all separate future slices per the design doc's own scope
  boundary.

---

### Task 1: Redis-backed state store (`redisStateStore.js`)

**Files:**
- Modify: `Information analysis agent/Code/package.json` (add `ioredis` dependency)
- Create: `Information analysis agent/Code/src/scheduler/redisStateStore.js`
- Test: `Information analysis agent/Code/tests/scheduler/redisStateStore.test.js`

**Interfaces:**
- Consumes: `ioredis`'s `Redis` client (in production; a fake with the same `get/set/del` async
  method shapes in tests).
- Produces: `createRedisStateStore({ redisUrl, client } = {}) -> { get(key): Promise<string|null>, set(key, value): Promise<void> }`
  — the same shape as `createInMemoryStateStore()` from `src/scheduler/stateStore.js` (unchanged,
  not part of this task), so `createScheduler({ stateStore: ... })` accepts either interchangeably.

- [ ] **Step 1: Add the `ioredis` dependency**

Edit `package.json`'s `"dependencies"` block to add (keep every existing entry as-is):

```json
    "ioredis": "^5.4.2",
```

Run (working directory `Information analysis agent/Code/`): `npm install`
Expected: install succeeds, `node_modules/ioredis` exists.

- [ ] **Step 2: Write the failing tests**

```javascript
// tests/scheduler/redisStateStore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisStateStore } from '../../src/scheduler/redisStateStore.js';

function fakeRedisClient(initialData = {}) {
  const data = { ...initialData };
  const calls = { get: [], set: [], del: [] };
  return {
    calls,
    async get(key) {
      calls.get.push(key);
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async set(key, value) {
      calls.set.push([key, value]);
      data[key] = value;
    },
    async del(key) {
      calls.del.push(key);
      delete data[key];
    }
  };
}

test('get returns null when the key does not exist in Redis', async () => {
  const client = fakeRedisClient();
  const store = createRedisStateStore({ client });

  const value = await store.get('watchStartedAt');

  assert.equal(value, null);
});

test('get applies the scheduler:agent3: key prefix', async () => {
  const client = fakeRedisClient({ 'scheduler:agent3:watchStartedAt': '2026-07-08T08:00:00.000Z' });
  const store = createRedisStateStore({ client });

  const value = await store.get('watchStartedAt');

  assert.equal(value, '2026-07-08T08:00:00.000Z');
  assert.deepEqual(client.calls.get, ['scheduler:agent3:watchStartedAt']);
});

test('set with a string value calls client.set with the prefixed key', async () => {
  const client = fakeRedisClient();
  const store = createRedisStateStore({ client });

  await store.set('lastSeenAt', '2026-07-08T08:10:00Z');

  assert.deepEqual(client.calls.set, [['scheduler:agent3:lastSeenAt', '2026-07-08T08:10:00Z']]);
  assert.equal(client.calls.del.length, 0);
});

test('set with null deletes the key instead of writing the string "null"', async () => {
  const client = fakeRedisClient({ 'scheduler:agent3:watchStartedAt': '2026-07-08T08:00:00.000Z' });
  const store = createRedisStateStore({ client });

  await store.set('watchStartedAt', null);

  assert.deepEqual(client.calls.del, ['scheduler:agent3:watchStartedAt']);
  assert.equal(client.calls.set.length, 0);

  const value = await store.get('watchStartedAt');
  assert.equal(value, null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/scheduler/redisStateStore.js'`

- [ ] **Step 4: Write the implementation**

```javascript
// src/scheduler/redisStateStore.js
import Redis from 'ioredis';

const KEY_PREFIX = 'scheduler:agent3:';

// Ключи планировщика хранятся с префиксом, чтобы не пересекаться с ключами
// других агентов в общем Redis. set(key, null) удаляет ключ (DEL), а не
// пишет строку "null" — иначе следующий get() вернул бы truthy-строку
// вместо настоящего null, ломая проверки вида `!state.watchStartedAt`.
export function createRedisStateStore({ redisUrl, client } = {}) {
  const redis = client ?? new Redis(redisUrl);

  return {
    async get(key) {
      const value = await redis.get(KEY_PREFIX + key);
      return value ?? null;
    },
    async set(key, value) {
      if (value === null || value === undefined) {
        await redis.del(KEY_PREFIX + key);
      } else {
        await redis.set(KEY_PREFIX + key, String(value));
      }
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 4 tests in `tests/scheduler/redisStateStore.test.js` green.

- [ ] **Step 6: Commit**

```bash
git add Code/package.json Code/package-lock.json Code/src/scheduler/redisStateStore.js Code/tests/scheduler/redisStateStore.test.js
git commit -m "Information Analysis Agent | RedisStateStore — состояние планировщика в общем Redis | v0.3.0"
```

---

### Task 2: Fix `scheduler/index.js` to await `StateStore` calls

**Files:**
- Modify: `Information analysis agent/Code/src/scheduler/index.js`
- Modify: `Information analysis agent/Code/tests/scheduler/index.test.js` (add one regression test,
  do not change any existing test)

**Interfaces:**
- Consumes: nothing new. `StateStore`'s `get`/`set` are now treated as possibly-async (may return a
  value directly or a `Promise` — both are `await`-ed uniformly).
- Produces: no change to `createScheduler`'s public interface — `checkOnce`/`start`/`stop` keep their
  exact existing signatures. This is purely an internal correctness fix so `RedisStateStore` (Task 1)
  can be safely injected in Task 3.

- [ ] **Step 1: Write the failing regression test**

Add this test to the end of `tests/scheduler/index.test.js` (keep every existing test in that file
exactly as-is):

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — the second `checkOnce()` returns `'WAITING'` instead of `'BATCH_READY'` (or the test
throws/behaves incorrectly), because `state.watchStartedAt` is a pending `Promise` object (always
truthy, and not a valid date string) rather than the real stored value — reproducing the bug this
task fixes.

- [ ] **Step 3: Fix the implementation**

In `src/scheduler/index.js`, add `await` to every `stateStore.get`/`stateStore.set` call inside
`checkOnce()`. The full corrected function body:

```javascript
// src/scheduler/index.js
import { decideAction } from './decision.js';
import { pollQueues } from './pollQueues.js';

const STATE_KEYS = {
  watchStartedAt: 'watchStartedAt',
  lastSeenAt: 'lastSeenAt',
  triggeredOnDate: 'triggeredOnDate'
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
    const currentDateStr = currentTime.toISOString().slice(0, 10);
    const triggeredOnDate = await stateStore.get(STATE_KEYS.triggeredOnDate);
    const state = {
      watchStartedAt: await stateStore.get(STATE_KEYS.watchStartedAt),
      lastSeenAt: await stateStore.get(STATE_KEYS.lastSeenAt),
      triggeredToday: triggeredOnDate === currentDateStr
    };

    const gateAction = decideAction({ now: currentTime, ...state, idleMinutes, ceilingHour, windowStartHour });
    if (gateAction === 'OUTSIDE_WINDOW') {
      return 'OUTSIDE_WINDOW';
    }

    try {
      if (!state.watchStartedAt) {
        state.watchStartedAt = currentTime.toISOString();
        await stateStore.set(STATE_KEYS.watchStartedAt, state.watchStartedAt);
      }

      let action = gateAction;
      if (gateAction !== 'FORCED_CEILING') {
        const { newestSeenAt } = await pollQueues(db, { telegramId, sinceTimestamp: state.lastSeenAt });
        if (newestSeenAt) {
          state.lastSeenAt = newestSeenAt;
          await stateStore.set(STATE_KEYS.lastSeenAt, newestSeenAt);
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

        await stateStore.set(STATE_KEYS.triggeredOnDate, currentDateStr);
        await stateStore.set(STATE_KEYS.watchStartedAt, null);
        await stateStore.set(STATE_KEYS.lastSeenAt, null);
      }

      return action;
    } catch (err) {
      console.error('scheduler: checkOnce failed, treating tick as WAITING:', err.message);
      return 'WAITING';
    }
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

(Only the `await` keywords were added to `stateStore.get`/`stateStore.set` call sites — every other
line is byte-identical to the existing file.)

- [ ] **Step 4: Run the full test suite to verify everything passes**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — the new regression test passes, and all 7 pre-existing tests in
`tests/scheduler/index.test.js` still pass unchanged (proving the `await` addition is a no-op for the
synchronous `InMemoryStateStore`), plus the 4 new tests from Task 1. Full suite green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/scheduler/index.js Code/tests/scheduler/index.test.js
git commit -m "Information Analysis Agent | Fix: checkOnce теперь await-ит StateStore (нужно для Redis) | v0.3.0"
```

---

### Task 3: Application entry point (`src/index.js`)

**Files:**
- Modify: `Information analysis agent/Code/.env` (add `REDIS_URL`, `TELEGRAM_ALLOWED_USER_ID` — real
  values, this file is gitignored, not committed)
- Modify: `Information analysis agent/Code/.env.example` (document the two new variables, placeholder
  values only)
- Create: `Information analysis agent/Code/src/index.js`

**Interfaces:**
- Consumes: `createSupabaseClient` (`src/db/client.js`), `createOpenRouterExtractor`
  (`src/llm/extractClaims.js`), `createRedisStateStore` (Task 1), `createAnalysisGraph`
  (`src/graph/index.js`), `createScheduler` (Task 2's fixed version) — every real, already-tested
  factory in the codebase, wired together for the first time.
- Produces: a running process. No exported function — this is the actual application, run via
  `node src/index.js`.

- [ ] **Step 1: Add real values to `.env`**

Add these two lines to the existing `Code/.env` (do not remove or change any existing line):

```bash
# Redis (общий контейнер marketing-agency-redis; для запуска вне Docker — localhost)
REDIS_URL=redis://localhost:6379/0

# Telegram (тот же пользователь, что уже настроен у Агента 1)
TELEGRAM_ALLOWED_USER_ID=1064521326
```

- [ ] **Step 2: Document the new variables in `.env.example`**

Add to `Code/.env.example` (placeholder values, not real ones):

```bash
# Redis (общий контейнер агентов; localhost при запуске вне Docker, redis://redis:6379 внутри Docker)
REDIS_URL=

# Telegram (тот же пользователь, что уже настроен у Агента 1)
TELEGRAM_ALLOWED_USER_ID=
```

- [ ] **Step 3: Write the entry point**

```javascript
// src/index.js
import 'dotenv/config';
import { createSupabaseClient } from './db/client.js';
import { createOpenRouterExtractor } from './llm/extractClaims.js';
import { createRedisStateStore } from './scheduler/redisStateStore.js';
import { createAnalysisGraph } from './graph/index.js';
import { createScheduler } from './scheduler/index.js';

const POLL_INTERVAL_MS = 60_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`index.js: missing required environment variable ${name}`);
  }
  return value;
}

const db = createSupabaseClient({
  url: requireEnv('SUPABASE_URL'),
  serviceKey: requireEnv('SUPABASE_SERVICE_KEY')
});

const extractClaims = createOpenRouterExtractor({ apiKey: requireEnv('OPENROUTER_API_KEY') });
const stateStore = createRedisStateStore({ redisUrl: requireEnv('REDIS_URL') });
const runAnalysis = createAnalysisGraph({ db, extractClaims });

const telegramId = process.env.TELEGRAM_ALLOWED_USER_ID
  ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
  : undefined;

const scheduler = createScheduler({
  db,
  stateStore,
  onBatchReady: runAnalysis,
  telegramId
});

console.log(`Information Analysis Agent: scheduler starting, polling every ${POLL_INTERVAL_MS}ms`);
scheduler.start(POLL_INTERVAL_MS);
```

- [ ] **Step 4: Verify by running it manually against real services**

This entry point is not unit-tested (same as `start()`/`stop()` in the scheduler itself) — verify by
running it for a few seconds and confirming it starts cleanly against the real, currently-running
Redis and Supabase:

Run (working directory `Information analysis agent/Code/`), let it run ~5 seconds then stop it:

```bash
node src/index.js
```

Expected: prints `Information Analysis Agent: scheduler starting, polling every 60000ms` and does not
throw or exit — stop it with Ctrl+C (or, non-interactively, run it with a shell timeout, e.g.
`timeout 5 node src/index.js` on a POSIX shell, and confirm the log line appeared and no stack trace
was printed before the timeout killed it).

Then verify the missing-env-var error path: temporarily rename `.env` (e.g. `mv .env .env.bak`), run
`node src/index.js` again, confirm it throws `index.js: missing required environment variable
SUPABASE_URL` (or whichever var is checked first) and exits — then restore it (`mv .env.bak .env`).

- [ ] **Step 5: Run the full automated test suite once more to confirm nothing broke**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — same test count as after Task 2, `src/index.js` has no test file of its own (it's
the application itself, not a testable module).

- [ ] **Step 6: Commit**

```bash
git add Code/.env.example Code/src/index.js
git commit -m "Information Analysis Agent | src/index.js — точка входа, планировщик подключён к графу | v0.3.0"
```

(`Code/.env` is gitignored and not part of this commit — only `.env.example` documents the new
variables.)

---

### Task 4: Docker deployment (`Dockerfile` + `docker-compose.yml`)

**Files:**
- Create: `Information analysis agent/Code/Dockerfile`
- Create: `Information analysis agent/Code/docker-compose.yml`

**Interfaces:**
- Consumes: `src/index.js` (Task 3) as the container's entry command.
- Produces: a buildable, runnable Docker image connected to the real `marketing-agency-net`.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# Information analysis agent/Code/Dockerfile
# Information Analysis Agent
# ver. v0.3.0

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/logs

CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Write docker-compose.yml**

```yaml
# Information analysis agent/Code/docker-compose.yml
name: information-analysis-agent

services:
  information-analysis-agent:
    build: .
    image: information-analysis-agent:v0.3.0
    container_name: information-analysis-agent
    restart: unless-stopped
    env_file: .env
    environment:
      # Переопределяет .env: внутри контейнера Redis доступен по имени сервиса
      # на общей сети, а не по localhost (тот — для локального запуска вне Docker).
      - REDIS_URL=redis://redis:6379/0
    volumes:
      - ./logs:/app/logs
    networks:
      - marketing-agency-net

networks:
  marketing-agency-net:
    name: marketing-agency-net
    external: true
```

- [ ] **Step 3: Build and run the container against the real shared infrastructure**

Run (working directory `Information analysis agent/Code/`):

```bash
docker compose build
docker compose up -d
docker compose logs --tail 20
```

Expected: build succeeds; `docker compose logs` shows
`Information Analysis Agent: scheduler starting, polling every 60000ms` with no crash/restart loop.
Confirm the container joined the network and is running:

```bash
docker ps --filter name=information-analysis-agent
```

Expected: container shows `Up` status alongside the already-running `deep-parsing-agent`,
`intelligence-agent`, `marketing-agency-redis`.

- [ ] **Step 4: Stop the container (do not leave it running unattended for this plan)**

```bash
docker compose down
```

This plan does not wire this container into the shared top-level deploy file
(`Инфраструктура (Docker)/docker-compose.yml`'s `include:`) — that is a separate, deliberate step per
the design doc, done only once the human partner wants Agent 3 running continuously alongside the
others.

- [ ] **Step 5: Commit**

```bash
git add Code/Dockerfile Code/docker-compose.yml
git commit -m "Information Analysis Agent | Dockerfile + docker-compose.yml — деплой на marketing-agency-net | v0.3.0"
```

---

## Self-Review

**Spec coverage:** Task 1 covers `redisStateStore.js` from the design doc, including the two
non-obvious correctness requirements (key prefix, null-means-delete). Task 2 covers the
`await`-missing bug the design doc flagged as needing a fix — confirmed real by reading the actual
file before writing this plan, not assumed. Task 3 covers `src/index.js` and the two new `.env`
variables. Task 4 covers `Dockerfile`/`docker-compose.yml`, verified against a real, running
`marketing-agency-net` and real sibling containers (not a hypothetical network name). The design
doc's "Явно не входит в этот слайс" items (MCP server, Telegram, dedup, contradictions, escalation,
synthesis, top-level deploy-file wiring) have no task here, matching scope.

**Placeholder scan:** No TBD/TODO markers. Every step has complete, runnable code or an exact manual
verification command.

**Type consistency:** `createRedisStateStore(...)` returns the exact same `{ get(key), set(key,
value) }` shape as `createInMemoryStateStore()` (unchanged), so `createScheduler({ stateStore })` in
Task 3 accepts it without any scheduler-side change beyond Task 2's `await` fix. `src/index.js`'s
`runAnalysis` (from `createAnalysisGraph`) is passed directly as `onBatchReady` — the same signature
match (`(items, { reason }) -> Promise`) verified during the graph slice's own final review, now
actually wired together for the first time.
