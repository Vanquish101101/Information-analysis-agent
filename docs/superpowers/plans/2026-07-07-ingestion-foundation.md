# Agent 3 — Ingestion Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Agent 3 (`information-analysis-agent`) Node.js project, create its Supabase
schema, and implement tested readers that pull data from Agent 1 (`intelligence_agent.
search_results`) and Agent 2 (`deep_parsing_agent.agent3_handoff_queue` → `parsing_results` →
`parsing_jobs`) into one normalized internal shape.

**Architecture:** Plain Node.js ESM (no TypeScript, no framework), matching Agent 1/Agent 2's
existing stack. Supabase client is dependency-injected into reader functions (not read from global
state) so they're testable without a live database. This plan covers only ingestion — the LangGraph
analysis graph, MCP server, and Telegram notifications are separate follow-up plans (see
`7. Архитектура (Бекенд).md` §11 roadmap in `План разработки/`).

**Tech Stack:** Node.js LTS (ESM), `@supabase/supabase-js`, `dotenv`. Testing: Node's built-in
`node:test` + `node:assert/strict` — zero new dependencies, since Agent 1/Agent 2 have no test
framework and this keeps the addition minimal while still giving Agent 3's logic-heavy code
(unlike Agent 1/2's thin API wrappers) automated regression coverage.

## Global Constraints

- **Git repo root is `Information analysis agent/`, not `Information analysis agent/Code/`** — the
  repo was already initialized there (`git init`, branch `main`, remote `origin` →
  `https://github.com/Vanquish101101/Information-analysis-agent.git`), matching the sibling repos
  (`Intelligence-agent`, `Deep-parsing-agent`), which each track `Code/`, `docs/`, `План разработки/`
  together at the agent-folder root. All file paths below are given relative to `Code/` for
  readability, but every `git add`/commit in this plan runs from the repo root and must reference
  paths with the `Code/` prefix (e.g. `git add Code/package.json`, not `git add package.json`).
- **Commit message format:** `Information Analysis Agent | <краткое описание на русском> | vX.Y.Z`
  — confirmed from the sibling repos' own commit history (e.g. `Intelligence Agent | Структурированный
  вывод для Агента 3 + search_results | v0.2.2`). Use `v0.1.0` for every commit in this plan (still
  pre-MVP, single version bump happens at the end of the ingestion-foundation milestone, not per
  task) unless a later task in this same plan says otherwise.
- **Do not push to `origin`** — commits stay local until the human partner explicitly asks for a
  push.
- Runtime: Node.js (ESM, `"type": "module"` in package.json), no TypeScript — `5. ТЗ.md` §5,
  `8. Разработка.md` §6.
- Supabase project `Marketing agency`, schema `information_analysis_agent` — `1. Идея.md`.
- Confidence level enum values are the literal Russian strings `"высокая"`, `"средняя"`, `"низкая"`
  — `5. ТЗ.md` §3.1/§3.2, must match exactly (not translated) since Agent 1/Agent 2 already write
  these exact strings into their tables.
- Column names `subject_entity_id`/`object_entity_id` (not `subject_id`/`object_id`) — fixed during
  the consistency review, `5. ТЗ.md` §4 / `7. Архитектура (Бекенд).md` §8.2.
- No new test-framework dependency — use Node's built-in `node:test`.
- Agent 2's `parsing_results` table does **not** currently persist `meta` (cost/tools/duration) —
  confirmed by reading `Deep parsing agent/Code/src/router/index.js` lines 93–99. Readers must treat
  `meta` as possibly absent, not assume it exists.

---

### Task 1: Project scaffolding

**Files:**
- Create: `Information analysis agent/Code/package.json`
- Create: `Information analysis agent/Code/.gitignore`
- Create: `Information analysis agent/Code/.env.example`
- Create: `Information analysis agent/Code/tests/smoke.test.js`

**Interfaces:**
- Produces: a working `npm test` command (`node --test tests/`) that later tasks' test files plug
  into automatically (any `*.test.js` under `tests/` is picked up).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "information-analysis-agent",
  "version": "0.1.0",
  "description": "Агент семантического анализа и синтеза — третье звено цепочки Marketing agency Project",
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.46.0",
    "dotenv": "^16.4.5"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.env
logs/
```

- [ ] **Step 3: Create `.env.example`**

```bash
# Supabase (проект Marketing agency, схема information_analysis_agent)
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
```

- [ ] **Step 4: Write a smoke test to confirm the test runner works**

```javascript
// tests/smoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner is working', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Install dependencies and run the smoke test**

Run (from `Information analysis agent/Code/`): `npm install && npm test`
Expected: 1 test passes (`tests/smoke.test.js`), exit code 0.

- [ ] **Step 6: Commit**

Repo is already initialized at `Information analysis agent/` (root, not `Code/`) — do not run
`git init` again. Run from the repo root:

```bash
git add Code/package.json Code/.gitignore Code/.env.example Code/tests/smoke.test.js
git commit -m "Information Analysis Agent | Скаффолдинг проекта, настройка node:test | v0.1.0"
```

---

### Task 2: Supabase client factory

**Files:**
- Create: `Information analysis agent/Code/src/db/client.js`
- Test: `Information analysis agent/Code/tests/db/client.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createSupabaseClient({ url, serviceKey }) -> SupabaseClient` — exported from
  `src/db/client.js`. Later tasks (readers) receive a `SupabaseClient` instance as a parameter, they
  don't call this factory themselves — that happens once at the application's entry point (a later
  plan). Tests for later tasks use hand-rolled fakes instead of this factory.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/db/client.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseClient } from '../../src/db/client.js';

test('createSupabaseClient throws when url is missing', () => {
  assert.throws(
    () => createSupabaseClient({ serviceKey: 'fake-key' }),
    /url and serviceKey are required/
  );
});

test('createSupabaseClient throws when serviceKey is missing', () => {
  assert.throws(
    () => createSupabaseClient({ url: 'https://example.supabase.co' }),
    /url and serviceKey are required/
  );
});

test('createSupabaseClient returns a usable client when config is valid', () => {
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    serviceKey: 'fake-key'
  });
  assert.equal(typeof client.from, 'function');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/db/client.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/db/client.js
import { createClient } from '@supabase/supabase-js';

export function createSupabaseClient({ url, serviceKey } = {}) {
  if (!url || !serviceKey) {
    throw new Error(
      'createSupabaseClient: url and serviceKey are required (see .env.example: SUPABASE_URL, SUPABASE_SERVICE_KEY)'
    );
  }
  return createClient(url, serviceKey, {
    db: { schema: 'information_analysis_agent' }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all tests in `tests/db/client.test.js` green, `createClient` does not make a
network call at construction time so this runs offline.

- [ ] **Step 5: Commit**

```bash
git add Code/src/db/client.js Code/tests/db/client.test.js
git commit -m "Information Analysis Agent | Supabase client factory | v0.1.0"
```

---

### Task 3: Supabase schema migration

**Files:**
- Create: `Information analysis agent/Code/src/db/migrations/001_information_analysis_agent_schema.sql`
- Test: `Information analysis agent/Code/tests/db/migration.test.js`

**Interfaces:**
- Consumes: nothing (static SQL file).
- Produces: the five tables (`entities`, `sources`, `claims`, `runs`, `pending_user_decisions`)
  that Task 5/6 readers and all future plans (graph, MCP server) read from and write to. Exact
  column names below are the contract later tasks/plans must match.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/db/migration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/001_information_analysis_agent_schema.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('migration creates all five required tables', () => {
  for (const table of ['entities', 'sources', 'claims', 'runs', 'pending_user_decisions']) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS information_analysis_agent\\.${table}`)
    );
  }
});

test('claims table uses subject_entity_id/object_entity_id, not subject_id/object_id', () => {
  const claimsBlock = sql
    .split('CREATE TABLE IF NOT EXISTS information_analysis_agent.claims')[1]
    .split('CREATE TABLE')[0];
  assert.match(claimsBlock, /subject_entity_id/);
  assert.match(claimsBlock, /object_entity_id/);
  assert.doesNotMatch(claimsBlock, /\bsubject_id\b/);
  assert.doesNotMatch(claimsBlock, /\bobject_id\b/);
});

test('claims and entities both have a pgvector embedding column', () => {
  const claimsBlock = sql
    .split('CREATE TABLE IF NOT EXISTS information_analysis_agent.claims')[1]
    .split('CREATE TABLE')[0];
  const entitiesBlock = sql
    .split('CREATE TABLE IF NOT EXISTS information_analysis_agent.entities')[1]
    .split('CREATE TABLE')[0];
  assert.match(claimsBlock, /embedding\s+vector/);
  assert.match(entitiesBlock, /embedding\s+vector/);
});

test('pending_user_decisions has estimated_cost_usd column', () => {
  assert.match(sql, /estimated_cost_usd/);
});

test('confidence_level has a CHECK constraint restricting to the three Russian levels', () => {
  assert.match(sql, /confidence_level[\s\S]*?CHECK[\s\S]*?высокая[\s\S]*?средняя[\s\S]*?низкая/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — migration file does not exist yet (`ENOENT`).

- [ ] **Step 3: Write the migration**

```sql
-- src/db/migrations/001_information_analysis_agent_schema.sql
-- Схема Агента 3 (Information Analysis Agent): сущности, факты, источники, история прогонов,
-- очередь решений пользователя. Применять в проекте "Marketing agency" (id: wklecdbujgdwnbmfmggi).
--
-- ПРИМЕЧАНИЕ: размерность vector(768) — предварительная, под Gemini Embedding 2. Проверить
-- реальную размерность ответа API перед первым использованием в продакшене (задача этапа
-- "интеграция эмбеддингов", отдельный план) — при расхождении потребуется отдельная миграция
-- на ALTER COLUMN.

CREATE SCHEMA IF NOT EXISTS information_analysis_agent;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS information_analysis_agent.entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          TEXT,
  embedding     vector(768),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent       SMALLINT NOT NULL CHECK (agent IN (1, 2)),
  source_type TEXT NOT NULL,
  ref         TEXT,
  raw_job_id  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.claims (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_entity_id      UUID REFERENCES information_analysis_agent.entities(id),
  predicate              TEXT NOT NULL,
  object_entity_id       UUID REFERENCES information_analysis_agent.entities(id),
  object_value           TEXT,
  confidence_level       TEXT NOT NULL CHECK (confidence_level IN ('высокая', 'средняя', 'низкая')),
  confidence_explanation TEXT,
  source_id              UUID REFERENCES information_analysis_agent.sources(id),
  embedding              vector(768),
  extracted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_by          UUID REFERENCES information_analysis_agent.claims(id)
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                   TEXT NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running', 'ok', 'partial', 'error', 'cost_cap_reached')),
  cost_usd                 NUMERIC(10, 4) NOT NULL DEFAULT 0,
  items_processed          INTEGER NOT NULL DEFAULT 0,
  escalations_auto         INTEGER NOT NULL DEFAULT 0,
  escalations_pending_user INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.pending_user_decisions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID NOT NULL,
  question           TEXT NOT NULL,
  estimated_cost_usd NUMERIC(10, 4),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS claims_subject_predicate_idx     ON information_analysis_agent.claims(subject_entity_id, predicate);
CREATE INDEX IF NOT EXISTS claims_source_id_idx             ON information_analysis_agent.claims(source_id);
CREATE INDEX IF NOT EXISTS claims_extracted_at_idx          ON information_analysis_agent.claims(extracted_at DESC);
CREATE INDEX IF NOT EXISTS sources_agent_idx                ON information_analysis_agent.sources(agent);
CREATE INDEX IF NOT EXISTS runs_run_at_idx                  ON information_analysis_agent.runs(run_at DESC);
CREATE INDEX IF NOT EXISTS pending_user_decisions_status_idx ON information_analysis_agent.pending_user_decisions(status);

GRANT USAGE ON SCHEMA information_analysis_agent TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA information_analysis_agent TO anon, authenticated, service_role;

ALTER TABLE information_analysis_agent.entities DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.sources DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.claims DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.runs DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.pending_user_decisions DISABLE ROW LEVEL SECURITY;
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 5 tests in `tests/db/migration.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/db/migrations/001_information_analysis_agent_schema.sql Code/tests/db/migration.test.js
git commit -m "Information Analysis Agent | Схема Supabase (entities/claims/sources/runs/pending_user_decisions) | v0.1.0"
```

> Note: this task does not apply the migration to a live database (no Supabase project access from
> this environment). Applying it is a manual step before Task 5/6's readers can be integration-tested
> against real data — the unit tests in Tasks 5–6 use fakes and don't require the live schema.

---

### Task 4: Shared test double for the Supabase query builder

**Files:**
- Create: `Information analysis agent/Code/tests/helpers/fakeSupabase.js`

**Interfaces:**
- Produces: `makeFakeDb(handlers) -> { from(table) }` where `handlers` is
  `{ [table]: (state) => ({ data, error }) | Promise<{ data, error }> }` and `state` is
  `{ table, filters: { [column]: value } }`. Reused by Task 5 and Task 6 tests.

- [ ] **Step 1: Write the helper (no test needed — it's test infrastructure, exercised indirectly by every test that uses it in Tasks 5–6)**

```javascript
// tests/helpers/fakeSupabase.js

// Minimal fake for the subset of the Supabase query-builder chain this
// project uses: .from(table).select().eq().order().limit() / .single()
// The real supabase-js query builder is a thenable — `await query` resolves
// to `{ data, error }` without calling `.then()` explicitly. This fake
// mirrors that so reader code doesn't need to know it's under test.
export function makeFakeDb(handlers) {
  return {
    from(table) {
      const state = { table, filters: {} };
      const resolve = () => {
        const handler = handlers[table];
        if (!handler) {
          throw new Error(`makeFakeDb: no handler registered for table "${table}"`);
        }
        return Promise.resolve(handler(state));
      };
      const builder = {
        select() {
          return builder;
        },
        eq(column, value) {
          state.filters[column] = value;
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        single() {
          return resolve();
        },
        then(onFulfilled, onRejected) {
          return resolve().then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add Code/tests/helpers/fakeSupabase.js
git commit -m "Information Analysis Agent | Fake Supabase query builder для тестов ридеров | v0.1.0"
```

---

### Task 5: Normalization function

**Files:**
- Create: `Information analysis agent/Code/src/ingestion/normalize.js`
- Test: `Information analysis agent/Code/tests/ingestion/normalize.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure function).
- Produces: `normalizeItem(item) -> NormalizedItem` where `NormalizedItem` is
  `{ job_id, agent, content_type, result, confidence: { level, explanation }, meta: { tools_used, cost_usd, duration_sec }, created_at }`.
  Task 6's readers (`fetchAgent1Items`/`fetchAgent2Items`) each call this on every row before
  returning it, so all downstream consumers (a later graph-ingestion plan) see one consistent shape
  regardless of source agent.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/ingestion/normalize.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/ingestion/normalize.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/ingestion/normalize.js

const DEFAULT_CONFIDENCE = Object.freeze({
  level: 'низкая',
  explanation: 'confidence не указан источником'
});

const DEFAULT_META = Object.freeze({
  tools_used: [],
  cost_usd: null,
  duration_sec: null
});

export function normalizeItem(item) {
  if (item == null || typeof item !== 'object') {
    throw new TypeError('normalizeItem: item must be an object');
  }
  if (!item.job_id) {
    throw new Error('normalizeItem: job_id is required');
  }
  if (item.agent !== 1 && item.agent !== 2) {
    throw new Error('normalizeItem: agent must be 1 or 2');
  }

  return {
    job_id: item.job_id,
    agent: item.agent,
    content_type: item.content_type ?? 'unknown',
    result: item.result ?? null,
    confidence: item.confidence?.level ? item.confidence : DEFAULT_CONFIDENCE,
    meta: item.meta ?? DEFAULT_META,
    created_at: item.created_at ?? null
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 8 tests in `tests/ingestion/normalize.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/ingestion/normalize.js Code/tests/ingestion/normalize.test.js
git commit -m "Information Analysis Agent | normalizeItem — единый формат входа от Агента 1 и 2 | v0.1.0"
```

---

### Task 6: Agent 1 reader (`intelligence_agent.search_results`)

**Files:**
- Create: `Information analysis agent/Code/src/ingestion/agent1Reader.js`
- Test: `Information analysis agent/Code/tests/ingestion/agent1Reader.test.js`

**Interfaces:**
- Consumes: `makeFakeDb` from Task 4 (tests only); `normalizeItem` from Task 5.
- Produces: `fetchAgent1Items(db, { telegramId, limit } = {}) -> Promise<NormalizedItem[]>` — a
  `SupabaseClient`-shaped `db` (real one created via Task 2's `createSupabaseClient` in the actual
  app, a fake in tests) is passed in. This is the function a later "ingestion orchestration" plan
  calls to pull Agent 1's data.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/ingestion/agent1Reader.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAgent1Items } from '../../src/ingestion/agent1Reader.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('maps search_results rows into normalized items using result.raw', async () => {
  const db = makeFakeDb({
    search_results: () => ({
      data: [
        {
          job_id: 'job-1',
          telegram_id: 123,
          result: { raw: { perplexity: { summary: 'тест' }, youtube: [], firecrawl: [] } },
          telegram_text: 'готовый отчёт',
          confidence: { level: 'высокая', explanation: 'Все источники доступны' },
          meta: { tools_used: ['perplexity'], cost_usd: 0.003, duration_sec: 20 },
          created_at: '2026-07-07T08:00:00Z'
        }
      ],
      error: null
    })
  });

  const items = await fetchAgent1Items(db, { telegramId: 123 });

  assert.equal(items.length, 1);
  assert.equal(items[0].job_id, 'job-1');
  assert.equal(items[0].agent, 1);
  assert.equal(items[0].content_type, 'search');
  assert.deepEqual(items[0].result, { perplexity: { summary: 'тест' }, youtube: [], firecrawl: [] });
  assert.equal(items[0].confidence.level, 'высокая');
});

test('falls back to null result when result.raw is absent, keeps telegram_text_fallback', async () => {
  const db = makeFakeDb({
    search_results: () => ({
      data: [
        {
          job_id: 'job-2',
          telegram_id: 123,
          result: {},
          telegram_text: 'только текстовый отчёт',
          confidence: null,
          meta: null,
          created_at: '2026-07-07T08:05:00Z'
        }
      ],
      error: null
    })
  });

  const items = await fetchAgent1Items(db, { telegramId: 123 });

  assert.equal(items[0].result, null);
  assert.equal(items[0].telegram_text_fallback, 'только текстовый отчёт');
  assert.equal(items[0].confidence.level, 'низкая'); // normalizeItem default
});

test('returns an empty array when there are no rows', async () => {
  const db = makeFakeDb({ search_results: () => ({ data: [], error: null }) });
  const items = await fetchAgent1Items(db, { telegramId: 999 });
  assert.deepEqual(items, []);
});

test('throws a descriptive error when the query fails', async () => {
  const db = makeFakeDb({
    search_results: () => ({ data: null, error: { message: 'connection refused' } })
  });
  await assert.rejects(
    () => fetchAgent1Items(db, { telegramId: 123 }),
    /fetchAgent1Items: connection refused/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/ingestion/agent1Reader.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/ingestion/agent1Reader.js
import { normalizeItem } from './normalize.js';

// Читает intelligence_agent.search_results — см. "1. Идея.md" за точной схемой
// (подтверждено чтением исходников Агента 1, Code/src/orchestrator/index.js
// + Code/src/db/migrations/002_search_results.sql).
export async function fetchAgent1Items(db, { telegramId, limit = 50 } = {}) {
  let query = db.from('search_results').select('*');
  if (telegramId != null) {
    query = query.eq('telegram_id', telegramId);
  }
  query = query.order('created_at', { ascending: false }).limit(limit);

  const { data, error } = await query;
  if (error) {
    throw new Error(`fetchAgent1Items: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const normalized = normalizeItem({
      job_id: row.job_id,
      agent: 1,
      content_type: 'search',
      result: row.result?.raw ?? null,
      confidence: row.confidence,
      meta: row.meta,
      created_at: row.created_at
    });
    // fallback только на случай пустого result.raw — см. "1. Идея.md" "Откуда берётся вход"
    return { ...normalized, telegram_text_fallback: row.telegram_text ?? null };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 4 tests in `tests/ingestion/agent1Reader.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/ingestion/agent1Reader.js Code/tests/ingestion/agent1Reader.test.js
git commit -m "Information Analysis Agent | Ридер intelligence_agent.search_results (Агент 1) | v0.1.0"
```

---

### Task 7: Agent 2 reader (`agent3_handoff_queue` → `parsing_results` → `parsing_jobs`)

**Files:**
- Create: `Information analysis agent/Code/src/ingestion/agent2Reader.js`
- Test: `Information analysis agent/Code/tests/ingestion/agent2Reader.test.js`

**Interfaces:**
- Consumes: `makeFakeDb` from Task 4 (tests only); `normalizeItem` from Task 5.
- Produces: `fetchAgent2Items(db, { limit } = {}) -> Promise<NormalizedItem[]>` (each item also
  carries `handoff_queue_id`, needed by a later "mark as delivered" plan to update
  `agent3_handoff_queue.status`).

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/ingestion/agent2Reader.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAgent2Items } from '../../src/ingestion/agent2Reader.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('joins handoff_queue -> parsing_results -> parsing_jobs into a normalized item', async () => {
  const db = makeFakeDb({
    agent3_handoff_queue: () => ({
      data: [{ id: 'hq-1', job_id: 'job-9', result_ref: 'pr-1', attempt_count: 0, status: 'pending' }],
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/ingestion/agent2Reader.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/ingestion/agent2Reader.js
import { normalizeItem } from './normalize.js';

// Читает deep_parsing_agent.agent3_handoff_queue и джойнит parsing_results/parsing_jobs
// вручную (три отдельных запроса — не foreign-table join, схемы разные проекты Supabase-клиента
// с фиксированной search_path на information_analysis_agent, эти таблицы принадлежат схеме
// deep_parsing_agent и запрашиваются тем же db-клиентом с явным .schema()/отдельным клиентом —
// уточняется на этапе интеграции). Точная структура подтверждена чтением исходников Агента 2:
// Code/src/queue/index.js и Code/src/router/index.js. ВАЖНО: parsing_results пока не хранит meta
// (cost_usd/tools_used/duration_sec) — см. Global Constraints этого плана.
export async function fetchAgent2Items(db, { limit = 100 } = {}) {
  const { data: handoffRows, error: handoffError } = await db
    .from('agent3_handoff_queue')
    .select('id, job_id, result_ref, attempt_count, status')
    .eq('status', 'pending')
    .limit(limit);

  if (handoffError) {
    throw new Error(`fetchAgent2Items: ${handoffError.message}`);
  }

  const items = [];
  for (const row of handoffRows ?? []) {
    if (row.result_ref == null) continue;

    const { data: resultRow, error: resultError } = await db
      .from('parsing_results')
      .select('job_id, module, result_json, confidence_level, confidence_text')
      .eq('id', row.result_ref)
      .single();

    if (resultError || !resultRow) continue;

    const { data: jobRow } = await db
      .from('parsing_jobs')
      .select('content_type')
      .eq('id', row.job_id)
      .single();

    const normalized = normalizeItem({
      job_id: row.job_id,
      agent: 2,
      content_type: jobRow?.content_type ?? null,
      result: resultRow.result_json ?? null,
      confidence: { level: resultRow.confidence_level, explanation: resultRow.confidence_text }
    });
    items.push({ ...normalized, handoff_queue_id: row.id });
  }
  return items;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 6 tests in `tests/ingestion/agent2Reader.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/ingestion/agent2Reader.js Code/tests/ingestion/agent2Reader.test.js
git commit -m "Information Analysis Agent | Ридер agent3_handoff_queue + join parsing_results/parsing_jobs (Агент 2) | v0.1.0"
```

> Note: the schema-crossing join (Agent 3's client is pinned to `information_analysis_agent` schema
> via Task 2, but `agent3_handoff_queue`/`parsing_results`/`parsing_jobs` live in `deep_parsing_agent`)
> needs a second Supabase client scoped to `deep_parsing_agent`, or `.schema('deep_parsing_agent')`
> per call — flagged inline above, resolved in the follow-up plan that wires this reader into a real
> entry point (Task 2's `createSupabaseClient` only needs a `schema` parameter added, a small,
> backward-compatible change).

---

## Self-Review

**Spec coverage:** Tasks 1–3 cover `8. Разработка.md` §1 "Инфраструктура" (scaffolding + migration).
Tasks 5–7 cover `8. Разработка.md` §4 "Шаг 2 — Чтение входа". Everything else in the roadmap
(scheduler, graph, dedup, contradictions, escalation, MCP server, Telegram) is explicitly out of
scope for this plan — follow-up plans, per the Scope Check in the writing-plans skill guidance.

**Placeholder scan:** No TBD/TODO markers. The one open item (schema-crossing client for Task 7) is
called out explicitly with a concrete resolution path, not left vague.

**Type consistency:** `NormalizedItem` shape from Task 5 (`job_id, agent, content_type, result,
confidence, meta, created_at`) is used identically by Task 6 and Task 7 — both spread it and add
one extra field each (`telegram_text_fallback` / `handoff_queue_id`), no field renamed between
tasks.
