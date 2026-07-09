# GlobalSynthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the final graph node (`globalSynthesis`) that assembles a digest (facts + contradictions + quantitative aggregates) from a completed analysis run and saves it to Supabase, closing a real data-model gap (source-confirmation tracking) that the digest's `sources_count` field depends on.

**Architecture:** `persistResults.js` gains a `claim_sources` junction write (every claim gets linked to every confirming source, not just its first) and returns the list of claims it actually touched this run (`persistedFacts`/`persistedContradictions`). A new `globalSynthesis` graph node — the new last node, after `persistResults` — reads that list, queries aggregate stats (`sources_count`/`reach_estimate`) via a new Postgres RPC function, calls `claude-sonnet-4-6` once to phrase a `statement` per fact, assembles the digest JSON shape from ТЗ §3.2, and saves it as a single row in a new `digests` table. Since `globalSynthesis` runs after `persistResults` already wrote the "final" run cost, it does one small follow-up `UPDATE runs` to add its own LLM cost on top.

**Tech Stack:** Node.js ESM, `node:test`, `@langchain/langgraph`, Supabase/Postgres (schema `information_analysis_agent`), OpenRouter (`claude-sonnet-4-6`), same DI/factory patterns used throughout this codebase.

## Global Constraints

- New OpenRouter LLM call must use `usage: { include: true }` and return real `costUsd` from `data.usage.cost ?? 0` — same pattern as every existing LLM file in `src/llm/`.
- Any new graph node must degrade gracefully on error (log, don't crash the run) — matches every existing node in `src/graph/nodes/`.
- New graph-state channels must be declared in `src/graph/state.js` before any node returns them.
- `src/index.js` wiring for any new required `createAnalysisGraph` dependency is **mandatory and must be grep-verified** before the task is considered done — this exact bug class ("new dependency never wired into the real entry point") has recurred multiple times in this project.
- Model id for synthesis: `anthropic/claude-sonnet-4-6` (per `4. Технологический стек.md`), routed through OpenRouter exactly like the existing `anthropic/claude-haiku-4-5` calls (same Helicone-optional proxy pattern).
- `reach_estimate` is a best-effort estimate (YouTube `views + likes` from Agent 1 results only, `0` for everything else) — document this in code comments, don't silently imply precision it doesn't have (same philosophy as the Gemini embedding cost estimate from Слайс 7).

---

### Task 1: Migration `005_digest.sql` — `claim_sources`, `sources.reach_estimate`, `digests`, `claim_source_stats` RPC

**Files:**
- Create: `Information analysis agent/Code/src/db/migrations/005_digest.sql`
- Create: `Information analysis agent/Code/tests/db/migration005.test.js`

**Interfaces:**
- Produces: table `information_analysis_agent.claim_sources(claim_id, source_id, linked_at)`; column `information_analysis_agent.sources.reach_estimate NUMERIC DEFAULT 0`; table `information_analysis_agent.digests(id, run_id, run_at, facts, contradictions, meta)`; RPC function `information_analysis_agent.claim_source_stats(claim_ids uuid[]) -> TABLE(claim_id uuid, sources_count bigint, reach_estimate numeric)`. Task 5 (`persistResults.js`) writes to `claim_sources`/`sources.reach_estimate`; Task 7 (`globalSynthesis.js` node) reads via `claim_source_stats` and writes to `digests`.

- [ ] **Step 1: Write the failing test**

Create `Information analysis agent/Code/tests/db/migration005.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/005_digest.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('creates the claim_sources junction table with a composite primary key', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS information_analysis_agent\.claim_sources/);
  assert.match(sql, /claim_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.claims\(id\)/);
  assert.match(sql, /source_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.sources\(id\)/);
  assert.match(sql, /PRIMARY KEY \(claim_id, source_id\)/);
});

test('adds reach_estimate column to sources, defaulting to 0', () => {
  assert.match(sql, /ALTER TABLE information_analysis_agent\.sources/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reach_estimate\s+NUMERIC NOT NULL DEFAULT 0/);
});

test('creates the digests table with facts/contradictions/meta JSONB columns', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS information_analysis_agent\.digests/);
  assert.match(sql, /run_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.runs\(id\)/);
  assert.match(sql, /facts\s+JSONB NOT NULL DEFAULT '\[\]'/);
  assert.match(sql, /contradictions\s+JSONB NOT NULL DEFAULT '\[\]'/);
  assert.match(sql, /meta\s+JSONB NOT NULL DEFAULT '\{\}'/);
});

test('creates the claim_source_stats RPC function returning claim_id/sources_count/reach_estimate', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION information_analysis_agent\.claim_source_stats/);
  assert.match(sql, /RETURNS TABLE \(claim_id uuid, sources_count bigint, reach_estimate numeric\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION information_analysis_agent\.claim_source_stats TO anon, authenticated, service_role/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/db/migration005.test.js`
Expected: FAIL — `src/db/migrations/005_digest.sql` does not exist yet.

- [ ] **Step 3: Write the migration**

Create `Information analysis agent/Code/src/db/migrations/005_digest.sql`:

```sql
-- src/db/migrations/005_digest.sql
-- Слайс 8 (GlobalSynthesis, Шаг 7-8 ТЗ).
--
-- claim_sources — junction, которого раньше не было: claims.source_id хранит
-- только ОДИН (первый) источник claim'а. Когда dedup.js находит дубль и
-- confidence существующего claim'а поднимается, связь с новым подтверждающим
-- источником нигде не сохранялась — честно посчитать "сколько источников
-- подтверждают этот факт" было нечем. claim_sources фиксирует КАЖДОЕ такое
-- подтверждение (и на создании нового claim'а, и на каждом дубле).
--
-- sources.reach_estimate — best-effort оценка охвата источника (сумма
-- views+likes для YouTube-результатов Агента 1, 0 для всего остального, где
-- таких чисел просто нет) — заполняется один раз при создании строки sources.
--
-- digests — один снимок дайджеста на прогон, формат facts/contradictions/meta
-- зеркалит analysis_digest из "5. ТЗ.md" §3.2 — уже готов для выдачи через
-- MCP в следующем слайсе, пересчитывать по запросу не нужно.

CREATE TABLE IF NOT EXISTS information_analysis_agent.claim_sources (
  claim_id   UUID NOT NULL REFERENCES information_analysis_agent.claims(id),
  source_id  UUID NOT NULL REFERENCES information_analysis_agent.sources(id),
  linked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (claim_id, source_id)
);

ALTER TABLE information_analysis_agent.sources
  ADD COLUMN IF NOT EXISTS reach_estimate NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS information_analysis_agent.digests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES information_analysis_agent.runs(id),
  run_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  facts          JSONB NOT NULL DEFAULT '[]',
  contradictions JSONB NOT NULL DEFAULT '[]',
  meta           JSONB NOT NULL DEFAULT '{}'
);

CREATE OR REPLACE FUNCTION information_analysis_agent.claim_source_stats(
  claim_ids uuid[]
)
RETURNS TABLE (claim_id uuid, sources_count bigint, reach_estimate numeric)
LANGUAGE sql STABLE
AS $$
  SELECT cs.claim_id, COUNT(*)::bigint AS sources_count, COALESCE(SUM(s.reach_estimate), 0) AS reach_estimate
  FROM information_analysis_agent.claim_sources cs
  JOIN information_analysis_agent.sources s ON s.id = cs.source_id
  WHERE cs.claim_id = ANY(claim_ids)
  GROUP BY cs.claim_id;
$$;

GRANT EXECUTE ON FUNCTION information_analysis_agent.claim_source_stats TO anon, authenticated, service_role;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/db/migration005.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/db/migrations/005_digest.sql" "Information analysis agent/Code/tests/db/migration005.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Миграция: claim_sources/reach_estimate/digests (Слайс 8) | v0.5.0

Задача 1 плана GlobalSynthesis. claim_sources — junction claim_id<->source_id,
закрывает реальный пробел: сейчас связь с подтверждающим источником при
дубле нигде не сохраняется, честного sources_count посчитать нечем.
sources.reach_estimate — best-effort охват (заполняется в задаче 3).
digests — снимок дайджеста на прогон, формат зеркалит analysis_digest из
ТЗ §3.2. claim_source_stats — RPC-функция для агрегации (COUNT/SUM по
claim_id), тот же паттерн, что match_entities/match_claims у dedup.
Миграция ещё не применена к живой БД — по плану, в конце слайса.
EOF
)"
```

---

### Task 2: `AnalysisState` — new `persistedFacts`/`persistedContradictions` channels

**Files:**
- Modify: `Information analysis agent/Code/src/graph/state.js`

**Interfaces:**
- Produces: `AnalysisState` gains `persistedFacts` and `persistedContradictions` (no-reducer/overwrite, single-writer from `persistResults`, consumed by `globalSynthesis` in Task 7).

This task has no tests of its own (no exported behavior to unit-test in isolation) — it's exercised by Task 5 and Task 7's tests. Skip the TDD red/green cycle; just make the change and verify the full suite still passes.

- [ ] **Step 1: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/graph/state.js`:

```javascript
// src/graph/state.js
import { Annotation } from '@langchain/langgraph';

function concatReducer(a, b) {
  return a.concat(b);
}

function sumReducer(a, b) {
  return a + b;
}

export const AnalysisState = Annotation.Root({
  items: Annotation(),
  reason: Annotation(),
  runId: Annotation(),
  status: Annotation(),
  claims: Annotation({
    reducer: concatReducer,
    default: () => []
  }),
  errors: Annotation({
    reducer: concatReducer,
    default: () => []
  }),
  costUsdAnalysis: Annotation({
    reducer: sumReducer,
    default: () => 0
  }),
  costUsdRetry: Annotation(),
  escalationsAuto: Annotation(),
  escalationsPendingUser: Annotation(),
  costCapReached: Annotation(),
  persistedFacts: Annotation(),
  persistedContradictions: Annotation()
});
```

- [ ] **Step 2: Run the full test suite to check nothing broke**

Run (from `Information analysis agent\Code`): `npm test`
Expected: PASS, all tests green (no test reads these new channels yet, so nothing should be affected).

- [ ] **Step 3: Commit**

```bash
git add "Information analysis agent/Code/src/graph/state.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | AnalysisState — каналы persistedFacts/persistedContradictions | v0.5.0

Задача 2 плана GlobalSynthesis (Слайс 8). Оба канала — без reducer,
пишутся один раз узлом persistResults (задача 5 этого же плана): список
claim'ов, реально затронутых этим прогоном (и новых, и подтверждённых
дублей), с реальными id из БД. Узел globalSynthesis (задача 7) читает их,
чтобы собрать дайджест без повторного обхода state.claims.
EOF
)"
```

---

### Task 3: `normalize.js` — best-effort `reachEstimate` from YouTube results

**Files:**
- Modify: `Information analysis agent/Code/src/ingestion/normalize.js`
- Modify: `Information analysis agent/Code/tests/ingestion/normalize.test.js`

**Interfaces:**
- Produces: `normalizeItem(item)` return value gains a `reachEstimate: number` field. `0` unless `item.agent === 1` and `item.result.raw.youtube` is a non-empty array, in which case it's `sum(views + likes)` across all entries. Task 4 (`extractClaims` node) reads `item.reachEstimate`.

- [ ] **Step 1: Write the failing tests**

Add these tests to the end of `Information analysis agent/Code/tests/ingestion/normalize.test.js` (existing tests stay unchanged):

```javascript
test('defaults reachEstimate to 0 when there is no youtube data', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 1, content_type: 'search', result: { raw: {} } });
  assert.equal(result.reachEstimate, 0);
});

test('defaults reachEstimate to 0 for Agent 2 items regardless of result shape', () => {
  const result = normalizeItem({
    job_id: 'abc',
    agent: 2,
    content_type: 'video',
    result: { raw: { youtube: [{ views: 1000, likes: 50 }] } }
  });
  assert.equal(result.reachEstimate, 0);
});

test('sums views + likes across all youtube entries for Agent 1 items', () => {
  const result = normalizeItem({
    job_id: 'abc',
    agent: 1,
    content_type: 'search',
    result: {
      raw: {
        youtube: [
          { title: 'A', views: 1000, likes: 50, url: 'https://a', channel: 'x', description: '' },
          { title: 'B', views: 2000, likes: 100, url: 'https://b', channel: 'y', description: '' }
        ]
      }
    }
  });
  assert.equal(result.reachEstimate, 1000 + 50 + 2000 + 100);
});

test('treats missing views/likes on individual youtube entries as 0, not NaN', () => {
  const result = normalizeItem({
    job_id: 'abc',
    agent: 1,
    content_type: 'search',
    result: { raw: { youtube: [{ title: 'A', url: 'https://a' }] } }
  });
  assert.equal(result.reachEstimate, 0);
});

test('defaults reachEstimate to 0 when result itself is null', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 1, content_type: 'search' });
  assert.equal(result.reachEstimate, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ingestion/normalize.test.js`
Expected: FAIL — `result.reachEstimate` is `undefined`, `assert.equal(undefined, 0)` fails.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/ingestion/normalize.js`:

```javascript
const DEFAULT_CONFIDENCE = Object.freeze({
  level: 'низкая',
  explanation: 'confidence не указан источником'
});

function defaultMeta() {
  return {
    tools_used: [],
    cost_usd: null,
    duration_sec: null
  };
}

// Best-effort: сырые числа охвата (views/likes) сейчас реально есть только у
// YouTube-результатов Агента 1 (Code/src/agents/scout/index.js собирает их
// как views/likes уже в этом виде, Code/src/orchestrator/index.js кладёт
// массив в result.raw.youtube). Для всего остального (Firecrawl-текст,
// любой content_type Агента 2) таких чисел просто нет — 0, не оценка "на
// глаз". Расширяется по мере появления числовых метрик у других источников.
function computeReachEstimate(item) {
  if (item.agent !== 1) return 0;
  const youtube = item.result?.raw?.youtube;
  if (!Array.isArray(youtube)) return 0;
  return youtube.reduce((sum, video) => sum + (video.views ?? 0) + (video.likes ?? 0), 0);
}

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
    content_ref: item.content_ref ?? null,
    result: item.result ?? null,
    confidence: item.confidence?.level ? item.confidence : DEFAULT_CONFIDENCE,
    meta: item.meta ?? defaultMeta(),
    created_at: item.created_at ?? null,
    reachEstimate: computeReachEstimate(item)
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ingestion/normalize.test.js`
Expected: PASS (all tests, including the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/ingestion/normalize.js" "Information analysis agent/Code/tests/ingestion/normalize.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | normalize — best-effort reachEstimate из YouTube-результатов | v0.5.0

Задача 3 плана GlobalSynthesis (Слайс 8). reachEstimate = сумма views+likes
по всем result.raw.youtube[] у Агента 1 (те же поля, что реально собирает
Code/src/agents/scout/index.js) — 0 для всего остального, где таких чисел
нет вообще (не оценка "на глаз", честный 0). Используется узлом
globalSynthesis (позже в этом же плане) через sources.reach_estimate.
EOF
)"
```

---

### Task 4: `extractClaims` graph node — thread `reachEstimate` into `claim.source`

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/extractClaims.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/extractClaims.test.js`

**Interfaces:**
- Consumes: `item.reachEstimate` (Task 3).
- Produces: `claim.source` gains a `reachEstimate` field: `{ agent, jobId, refType, reachEstimate }`. Task 5 (`persistResults.js`) reads `claim.source.reachEstimate` when creating a `sources` row.

- [ ] **Step 1: Write the failing test**

Add this test to `Information analysis agent/Code/tests/graph/nodes/extractClaims.test.js` (existing tests stay unchanged):

```javascript
test('threads item.reachEstimate through into each claim.source', async () => {
  const fakeExtract = async () => ({
    claims: [{ subject: 'A', predicate: 'B', object_value: 'C', confidence_level: 'высокая', confidence_explanation: 'D' }],
    costUsd: 0.00001
  });
  const node = createExtractClaimsNode(fakeExtract);
  const item = { job_id: 'job-5', agent: 1, content_type: 'search', reachEstimate: 15000 };

  const result = await node({ item });

  assert.equal(result.claims[0].source.reachEstimate, 15000);
});

test('defaults claim.source.reachEstimate to 0 when the item has no reachEstimate', async () => {
  const fakeExtract = async () => ({
    claims: [{ subject: 'A', predicate: 'B', object_value: 'C', confidence_level: 'высокая', confidence_explanation: 'D' }],
    costUsd: 0
  });
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-6', agent: 2, content_type: 'video' } });

  assert.equal(result.claims[0].source.reachEstimate, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/extractClaims.test.js`
Expected: FAIL — `result.claims[0].source.reachEstimate` is `undefined`.

- [ ] **Step 3: Update the implementation**

In `Information analysis agent/Code/src/graph/nodes/extractClaims.js`, modify the `source` object inside the success path:

```javascript
export function createExtractClaimsNode(extractClaims) {
  return async function extractClaimsNode({ item }) {
    try {
      const { claims: rawClaims, costUsd } = await extractClaims(item);
      const claims = rawClaims.map((claim) => ({
        ...claim,
        source: { agent: item.agent, jobId: item.job_id, refType: item.content_type, reachEstimate: item.reachEstimate ?? 0 }
      }));
      return { claims, costUsdAnalysis: costUsd };
    } catch (err) {
      return {
        errors: [`item ${item.job_id}: ${err.message}`],
        ...(err.costUsd ? { costUsdAnalysis: err.costUsd } : {})
      };
    }
  };
}
```

(Only the `source` object literal changes — everything else in the file stays exactly as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/extractClaims.test.js`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/extractClaims.js" "Information analysis agent/Code/tests/graph/nodes/extractClaims.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Узел extractClaims — прокидывает reachEstimate в claim.source | v0.5.0

Задача 4 плана GlobalSynthesis (Слайс 8). item.reachEstimate (задача 3
этого же плана) теперь доступен на каждом claim.source — понадобится
persistResults.js (задача 5) при создании строки sources.
EOF
)"
```

---

### Task 5: `persistResults.js` — `claim_sources` writes, `sources.reach_estimate`, `persistedFacts`/`persistedContradictions`

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/persistResults.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/persistResults.test.js`

**Interfaces:**
- Consumes: `claim.source.reachEstimate` (Task 4).
- Produces: `createPersistResultsNode({db}) -> persistResultsNode(state) -> Promise<{runId, status, persistedFacts, persistedContradictions}>` — two new return fields. `persistedFacts: [{claimId, subject, predicate, object_value, confidence_level}]` — one entry per claim actually linked to a source this run (both newly-inserted claims and duplicate-confirmations). `persistedContradictions: [{claimAId, claimBId, explanation}]` — one entry per claim marked `hasContradiction`. Also now writes `sources.reach_estimate` on source creation, and inserts one row into `claim_sources` per claim-source link. Task 7 (`globalSynthesis.js` node) consumes both new fields.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `Information analysis agent/Code/tests/graph/nodes/persistResults.test.js`:

```javascript
// tests/graph/nodes/persistResults.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistResultsNode } from '../../../src/graph/nodes/persistResults.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function claim(overrides = {}) {
  return {
    subject: 'Subject',
    predicate: 'predicate',
    object_value: 'value',
    confidence_level: 'высокая',
    confidence_explanation: 'ok',
    source: { agent: 1, jobId: 'job-1', refType: 'search', reachEstimate: 0 },
    isDuplicate: false,
    subjectEntityId: null,
    subjectEmbedding: [0.1, 0.2],
    claimEmbedding: [0.3, 0.4],
    batchEntityKey: 'subject',
    ...overrides
  };
}

test('creates a run, one source per unique job, one entity+claim per claim, status ok', async () => {
  let entityCounter = 0;
  const inserted = { sources: [], entities: [], claims: [], claimSources: [] };
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-1' }, error: null };
      if (state.operation === 'update') return { error: null };
      throw new Error('unexpected runs operation');
    },
    sources: (state) => {
      inserted.sources.push(state.payload);
      return { data: { id: 'src-1' }, error: null };
    },
    entities: (state) => {
      entityCounter += 1;
      inserted.entities.push(state.payload);
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => {
      inserted.claims.push(state.payload);
      return { data: { id: `claim-${inserted.claims.length}` }, error: null };
    },
    claim_sources: (state) => {
      inserted.claimSources.push(state.payload);
      return { error: null };
    }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [
      claim({ subject: 'A', batchEntityKey: 'a' }),
      claim({ subject: 'B', batchEntityKey: 'b' })
    ],
    errors: []
  };

  const result = await node(state);

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(inserted.sources.length, 1, 'one source for the one unique (agent, jobId) pair');
  assert.equal(inserted.entities.length, 2, 'one entity per claim, no dedup');
  assert.equal(inserted.claims.length, 2);
  assert.equal(inserted.claims[0].subject_entity_id, 'ent-1');
  assert.equal(inserted.claims[0].source_id, 'src-1');
  assert.equal(inserted.claimSources.length, 2, 'one claim_sources row per persisted claim');
  assert.deepEqual(inserted.claimSources[0], { claim_id: 'claim-1', source_id: 'src-1' });
});

test('status is partial when state.errors is non-empty', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-2' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }, { job_id: 'job-2' }],
    claims: [claim()],
    errors: ['item job-2: LLM timeout']
  };

  const result = await node(state);

  assert.equal(result.status, 'partial');
});

test('creates a run with no writes when there are no claims at all', async () => {
  let sourcesCalled = false;
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-3' }, error: null } : { error: null }),
    sources: () => { sourcesCalled = true; return { data: { id: 'src-1' }, error: null }; }
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [], claims: [], errors: [] };

  const result = await node(state);

  assert.equal(result.runId, 'run-3');
  assert.equal(result.status, 'ok');
  assert.equal(sourcesCalled, false);
  assert.deepEqual(result.persistedFacts, []);
  assert.deepEqual(result.persistedContradictions, []);
});

test('creates one source per distinct (agent, jobId) pair when claims come from different sources', async () => {
  let entityCounter = 0;
  let sourceCounter = 0;
  const inserted = { sources: [], entities: [], claims: [] };
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-5' }, error: null } : { error: null }),
    sources: (state) => {
      sourceCounter += 1;
      inserted.sources.push(state.payload);
      return { data: { id: `src-${sourceCounter}` }, error: null };
    },
    entities: (state) => {
      entityCounter += 1;
      inserted.entities.push(state.payload);
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => {
      inserted.claims.push(state.payload);
      return { data: { id: `claim-${inserted.claims.length}` }, error: null };
    },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }, { job_id: 'job-2' }],
    claims: [
      claim({ subject: 'A', source: { agent: 1, jobId: 'job-1', refType: 'search', reachEstimate: 0 } }),
      claim({ subject: 'B', source: { agent: 2, jobId: 'job-2', refType: 'video', reachEstimate: 0 } })
    ],
    errors: []
  };

  const result = await node(state);

  assert.equal(result.status, 'ok');
  assert.equal(inserted.sources.length, 2, 'two distinct (agent, jobId) pairs produce two source rows');
  assert.equal(inserted.claims.length, 2);
  assert.equal(inserted.claims[0].source_id, 'src-1');
  assert.equal(inserted.claims[1].source_id, 'src-2');
});

test('sets run status to error and rethrows when a write fails partway through', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-4' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: null, error: { message: 'constraint violation' } })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  await assert.rejects(() => node(state), /failed to create entity/);
  assert.equal(runUpdatePayload.status, 'error');
});

test('reusing an existing entity does not insert a new entities row, and updates its last_seen_at', async () => {
  const entityUpdates = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-6' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => {
      if (state.operation === 'update') {
        entityUpdates.push(state.payload);
        return { error: null };
      }
      throw new Error('should not insert a new entity when subjectEntityId is already resolved');
    },
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ subjectEntityId: 'ent-existing', subjectEmbedding: null, batchEntityKey: null })],
    errors: []
  };

  await node(state);

  assert.equal(entityUpdates.length, 1);
  assert.ok(entityUpdates[0].last_seen_at);
});

test('two claims sharing a batchEntityKey (both new) create only one entity, reused for both claims', async () => {
  let entityInsertCount = 0;
  const insertedClaims = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-7' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => {
      entityInsertCount += 1;
      return { data: { id: `ent-${entityInsertCount}` }, error: null };
    },
    claims: (state) => {
      insertedClaims.push(state.payload);
      return { data: { id: `claim-${insertedClaims.length}` }, error: null };
    },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [
      claim({ subject: 'Same Subject', batchEntityKey: 'same subject' }),
      claim({ subject: 'Same Subject', object_value: 'other value', batchEntityKey: 'same subject' })
    ],
    errors: []
  };

  await node(state);

  assert.equal(entityInsertCount, 1);
  assert.equal(insertedClaims.length, 2);
  assert.equal(insertedClaims[0].subject_entity_id, 'ent-1');
  assert.equal(insertedClaims[1].subject_entity_id, 'ent-1');
});

test('a claim marked isDuplicate updates the existing claim instead of inserting a new one, and links claim_sources to the existing claim id', async () => {
  let claimsInsertCalled = false;
  let claimsUpdatePayload = null;
  const claimSourceLinks = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-8' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    claims: (state) => {
      if (state.operation === 'insert') { claimsInsertCalled = true; return { error: null }; }
      claimsUpdatePayload = state.payload;
      return { error: null };
    },
    claim_sources: (state) => { claimSourceLinks.push(state.payload); return { error: null }; }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({
      isDuplicate: true,
      duplicateOfClaimId: 'claim-existing',
      bumpedConfidenceLevel: 'средняя',
      bumpedConfidenceExplanation: 'ok Подтверждено дополнительным источником (agent 1, job job-1).',
      subjectEntityId: 'ent-existing'
    })],
    errors: []
  };

  const result = await node(state);

  assert.equal(claimsInsertCalled, false);
  assert.equal(claimsUpdatePayload.confidence_level, 'средняя');
  assert.match(claimsUpdatePayload.confidence_explanation, /Подтверждено дополнительным источником/);
  assert.equal(claimSourceLinks.length, 1);
  assert.deepEqual(claimSourceLinks[0], { claim_id: 'claim-existing', source_id: 'src-1' });
  assert.equal(result.persistedFacts.length, 1);
  assert.equal(result.persistedFacts[0].claimId, 'claim-existing');
  assert.equal(result.persistedFacts[0].confidence_level, 'средняя');
});

test('new entities and claims are created with their embedding column populated', async () => {
  const insertedEntities = [];
  const insertedClaims = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-9' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => { insertedEntities.push(state.payload); return { data: { id: 'ent-1' }, error: null }; },
    claims: (state) => { insertedClaims.push(state.payload); return { data: { id: 'claim-1' }, error: null }; },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  await node(state);

  assert.deepEqual(insertedEntities[0].embedding, [0.1, 0.2]);
  assert.deepEqual(insertedClaims[0].embedding, [0.3, 0.4]);
});

test('sources row is created with the reach_estimate from claim.source.reachEstimate', async () => {
  const insertedSources = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-17' }, error: null } : { error: null }),
    sources: (state) => { insertedSources.push(state.payload); return { data: { id: 'src-1' }, error: null }; },
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ source: { agent: 1, jobId: 'job-1', refType: 'search', reachEstimate: 45000 } })],
    errors: []
  };

  await node(state);

  assert.equal(insertedSources[0].reach_estimate, 45000);
});

test('a claim with a null claimEmbedding (dedup error-fallback) is skipped for the claims insert, but its entity is still created, and it does not appear in persistedFacts', async () => {
  const insertedEntities = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-10' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => { insertedEntities.push(state.payload); return { data: { id: 'ent-1' }, error: null }; },
    claims: () => { throw new Error('should not insert a claims row for a claim with a null claimEmbedding'); }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ claimEmbedding: null, isDuplicate: false })],
    errors: ['dedup failed for claim subject "Subject": embedding error']
  };

  const result = await node(state);

  assert.equal(insertedEntities.length, 1, 'entity grouping/creation still happens even when the claim itself is skipped');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.persistedFacts, []);
});

test('a claim marked hasContradiction inserts a contradictions row after the claim, and appears in persistedContradictions', async () => {
  const insertedContradictions = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-11' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => {
      if (state.operation === 'insert') return { data: { id: 'claim-new-1' }, error: null };
      throw new Error('unexpected claims update in this test');
    },
    contradictions: (state) => {
      insertedContradictions.push(state.payload);
      return { error: null };
    },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({
      hasContradiction: true,
      contradictsClaimId: 'claim-existing-1',
      contradictionRawLabel: 'contradict',
      contradictionConfidenceLevel: 'высокая',
      contradictionExplanation: 'разные суммы'
    })],
    errors: []
  };

  const result = await node(state);

  assert.equal(insertedContradictions.length, 1);
  assert.equal(insertedContradictions[0].claim_a_id, 'claim-new-1');
  assert.equal(insertedContradictions[0].claim_b_id, 'claim-existing-1');
  assert.equal(result.persistedContradictions.length, 1);
  assert.deepEqual(result.persistedContradictions[0], {
    claimAId: 'claim-new-1',
    claimBId: 'claim-existing-1',
    explanation: 'разные суммы'
  });
});

test('a claim without hasContradiction does not touch the contradictions table, and persistedContradictions stays empty', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-12' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-new-2' }, error: null } : { error: null }),
    contradictions: () => { throw new Error('should not write to contradictions when hasContradiction is not true'); },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  const result = await node(state);

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.persistedContradictions, []);
});

test('writes cost_usd/cost_usd_analysis/cost_usd_retry/escalations_auto/escalations_pending_user on the final status update', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-13' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim()],
    errors: [],
    costUsdAnalysis: 0.03,
    costUsdRetry: 0.02,
    escalationsAuto: 2,
    escalationsPendingUser: 1
  };

  await node(state);

  assert.equal(runUpdatePayload.cost_usd, 0.05);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0.03);
  assert.equal(runUpdatePayload.cost_usd_retry, 0.02);
  assert.equal(runUpdatePayload.escalations_auto, 2);
  assert.equal(runUpdatePayload.escalations_pending_user, 1);
});

test('defaults cost/escalation fields to 0 when the state does not set them (backward compatible with pre-escalation runs)', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-14' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  await node(state);

  assert.equal(runUpdatePayload.cost_usd, 0);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0);
  assert.equal(runUpdatePayload.cost_usd_retry, 0);
  assert.equal(runUpdatePayload.escalations_auto, 0);
  assert.equal(runUpdatePayload.escalations_pending_user, 0);
});

test('status is cost_cap_reached when state.costCapReached is true, overriding ok/partial', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-15' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [], costCapReached: true };

  const result = await node(state);

  assert.equal(result.status, 'cost_cap_reached');
  assert.equal(runUpdatePayload.status, 'cost_cap_reached');
});

test('status is still partial (not cost_cap_reached) when costCapReached is false but there are errors', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-16' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: ['some error'], costCapReached: false };

  const result = await node(state);

  assert.equal(result.status, 'partial');
});

test('a failure inserting a claim_sources row is logged, not thrown (does not crash the whole run)', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-18' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: { message: 'constraint violation' } })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  const result = await node(state);

  assert.equal(result.status, 'ok');
  assert.equal(result.persistedFacts.length, 1, 'claim_sources failure does not prevent the fact from being reported');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/persistResults.test.js`
Expected: FAIL — the implementation doesn't write `claim_sources`, doesn't write `sources.reach_estimate`, and doesn't return `persistedFacts`/`persistedContradictions`.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/graph/nodes/persistResults.js`:

```javascript
// src/graph/nodes/persistResults.js

export function createPersistResultsNode({ db }) {
  return async function persistResultsNode(state) {
    const { data: runRow, error: runError } = await db
      .from('runs')
      .insert({ status: 'running', items_processed: state.items.length, cost_usd: 0 })
      .select()
      .single();

    if (runError) {
      throw new Error(`persistResults: failed to create run: ${runError.message}`);
    }

    const runId = runRow.id;

    try {
      const sourceIds = new Map();
      for (const claim of state.claims) {
        const sourceKey = `${claim.source.agent}:${claim.source.jobId}`;
        if (!sourceIds.has(sourceKey)) {
          const { data: sourceRow, error: sourceError } = await db
            .from('sources')
            .insert({
              agent: claim.source.agent,
              source_type: claim.source.refType,
              raw_job_id: claim.source.jobId,
              reach_estimate: claim.source.reachEstimate ?? 0
            })
            .select()
            .single();
          if (sourceError) {
            throw new Error(`persistResults: failed to create source: ${sourceError.message}`);
          }
          sourceIds.set(sourceKey, sourceRow.id);
        }
      }

      const newEntityIds = new Map();
      for (const claim of state.claims) {
        if (claim.isDuplicate) continue;
        if (claim.subjectEntityId) {
          const { error: touchError } = await db
            .from('entities')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('id', claim.subjectEntityId);
          if (touchError) {
            throw new Error(`persistResults: failed to update entity last_seen_at: ${touchError.message}`);
          }
          continue;
        }
        if (!newEntityIds.has(claim.batchEntityKey)) {
          const { data: entityRow, error: entityError } = await db
            .from('entities')
            .insert({ name: claim.subject, embedding: claim.subjectEmbedding })
            .select()
            .single();
          if (entityError) {
            throw new Error(`persistResults: failed to create entity: ${entityError.message}`);
          }
          newEntityIds.set(claim.batchEntityKey, entityRow.id);
        }
      }

      const persistedFacts = [];
      const persistedContradictions = [];

      for (const claim of state.claims) {
        const sourceKey = `${claim.source.agent}:${claim.source.jobId}`;
        const sourceId = sourceIds.get(sourceKey);

        if (claim.isDuplicate) {
          const { error: updateError } = await db
            .from('claims')
            .update({
              confidence_level: claim.bumpedConfidenceLevel,
              confidence_explanation: claim.bumpedConfidenceExplanation
            })
            .eq('id', claim.duplicateOfClaimId);
          if (updateError) {
            throw new Error(`persistResults: failed to update duplicate claim: ${updateError.message}`);
          }

          await linkClaimSource(db, claim.duplicateOfClaimId, sourceId);
          persistedFacts.push({
            claimId: claim.duplicateOfClaimId,
            subject: claim.subject,
            predicate: claim.predicate,
            object_value: claim.object_value,
            confidence_level: claim.bumpedConfidenceLevel
          });
          continue;
        }

        // dedup.js's error-fallback path (embedText/judgeDuplicate/RPC threw for
        // this claim) leaves claimEmbedding null — the claim couldn't be
        // resolved at all, and the failure is already recorded in
        // state.errors. Skip persisting a claims row for it: inserting one
        // with a null embedding would either violate the vector column or
        // silently create a claim unfindable by future dedup lookups.
        if (claim.claimEmbedding == null) continue;

        const subjectEntityId = claim.subjectEntityId ?? newEntityIds.get(claim.batchEntityKey);

        const { data: claimRow, error: claimError } = await db
          .from('claims')
          .insert({
            subject_entity_id: subjectEntityId,
            predicate: claim.predicate,
            object_value: claim.object_value,
            confidence_level: claim.confidence_level,
            confidence_explanation: claim.confidence_explanation,
            source_id: sourceId,
            embedding: claim.claimEmbedding
          })
          .select()
          .single();
        if (claimError) {
          throw new Error(`persistResults: failed to create claim: ${claimError.message}`);
        }

        await linkClaimSource(db, claimRow.id, sourceId);
        persistedFacts.push({
          claimId: claimRow.id,
          subject: claim.subject,
          predicate: claim.predicate,
          object_value: claim.object_value,
          confidence_level: claim.confidence_level
        });

        if (claim.hasContradiction) {
          const { error: contradictionError } = await db
            .from('contradictions')
            .insert({
              claim_a_id: claimRow.id,
              claim_b_id: claim.contradictsClaimId,
              label: claim.contradictionRawLabel,
              confidence_level: claim.contradictionConfidenceLevel,
              explanation: claim.contradictionExplanation
            });
          if (contradictionError) {
            console.error(`persistResults: failed to record contradiction for claim ${claimRow.id}:`, contradictionError.message);
          } else {
            persistedContradictions.push({
              claimAId: claimRow.id,
              claimBId: claim.contradictsClaimId,
              explanation: claim.contradictionExplanation
            });
          }
        }
      }

      const finalStatus = state.costCapReached ? 'cost_cap_reached' : (state.errors.length > 0 ? 'partial' : 'ok');
      const { error: statusUpdateError } = await db
        .from('runs')
        .update({
          status: finalStatus,
          cost_usd: (state.costUsdAnalysis ?? 0) + (state.costUsdRetry ?? 0),
          cost_usd_analysis: state.costUsdAnalysis ?? 0,
          cost_usd_retry: state.costUsdRetry ?? 0,
          escalations_auto: state.escalationsAuto ?? 0,
          escalations_pending_user: state.escalationsPendingUser ?? 0
        })
        .eq('id', runId);
      if (statusUpdateError) {
        console.error(`persistResults: failed to update run status to "${finalStatus}":`, statusUpdateError.message);
      }

      return { runId, status: finalStatus, persistedFacts, persistedContradictions };
    } catch (err) {
      const { error: rollbackError } = await db.from('runs').update({ status: 'error' }).eq('id', runId);
      if (rollbackError) {
        console.error('persistResults: failed to update run status to "error" during rollback:', rollbackError.message);
      }
      throw err;
    }
  };
}

// claim_sources — задел для честного sources_count в дайджесте (Слайс 8).
// Сбой этой записи не должен ронять прогон: сама claims/entities/sources
// запись уже успешно прошла, теряется только вспомогательная метрика.
async function linkClaimSource(db, claimId, sourceId) {
  const { error } = await db.from('claim_sources').insert({ claim_id: claimId, source_id: sourceId });
  if (error) {
    console.error(`persistResults: failed to link claim_sources for claim ${claimId}:`, error.message);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/persistResults.test.js`
Expected: PASS (18 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/persistResults.js" "Information analysis agent/Code/tests/graph/nodes/persistResults.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | persistResults — claim_sources, reach_estimate, persistedFacts/Contradictions | v0.5.0

Задача 5 плана GlobalSynthesis (Слайс 8). Каждый персистнутый claim (и
новый, и подтверждённый дубль) теперь получает строку в claim_sources —
закрывает реальный пробел: раньше подтверждение дубля новым источником
нигде не сохранялось, честного sources_count посчитать было нечем. Новая
строка sources теперь пишет reach_estimate из claim.source.reachEstimate
(задача 4 этого плана). Узел возвращает persistedFacts (claim_id + текст
факта + confidence — и для новых claim'ов, и для подтверждённых дублей,
у которых confidence уже поднят) и persistedContradictions (claim_a_id/
claim_b_id/explanation для уже вставленных в contradictions строк) —
следующий узел globalSynthesis (этот же план) читает оба поля вместо
повторного обхода state.claims. Сбой записи в claim_sources логируется,
не роняет прогон — основная запись (claims/entities/sources) уже прошла.

18/18 тестов проходят.
EOF
)"
```

---

### Task 6: `src/llm/globalSynthesis.js` — `synthesizeDigest` via `claude-sonnet-4-6`

**Files:**
- Create: `Information analysis agent/Code/src/llm/globalSynthesis.js`
- Create: `Information analysis agent/Code/tests/llm/globalSynthesis.test.js`

**Interfaces:**
- Produces: `createGlobalSynthesisJudge({apiKey, model, heliconeApiKey, fetchImpl}) -> synthesizeDigest(facts: [{claimId, subject, predicate, object_value, confidence_level}]) -> Promise<{statements: [{claimId, statement}], costUsd: number}>`. Task 7 (`globalSynthesis.js` node) consumes `synthesizeDigest`.

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/llm/globalSynthesis.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalSynthesisJudge } from '../../src/llm/globalSynthesis.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fact(overrides = {}) {
  return {
    claimId: 'claim-1',
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    confidence_level: 'высокая',
    ...overrides
  };
}

test('throws when apiKey is missing', () => {
  assert.throws(() => createGlobalSynthesisJudge({}), /apiKey is required/);
});

test('returns empty statements and costUsd 0 without calling fetch when facts is empty', async () => {
  const fetchImpl = fakeFetch({});
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([]);

  assert.deepEqual(result, { statements: [], costUsd: 0 });
  assert.equal(fetchImpl.calls.length, 0);
});

test('builds the request with the correct URL, model, all claim_ids in the prompt, and usage:{include:true}', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "Компания X подняла 5 млн."}]' } }],
    usage: { cost: 0.0004 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'secret-key', fetchImpl });

  await synthesizeDigest([fact()]);

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-sonnet-4-6');
  assert.deepEqual(body.usage, { include: true });
  assert.match(body.messages[0].content, /claim-1/);
  assert.match(body.messages[0].content, /Компания X/);
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "ok"}]' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await synthesizeDigest([fact()]);

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses statements for multiple facts', async () => {
  const fetchImpl = fakeFetch({
    choices: [{
      message: {
        content: JSON.stringify([
          { claim_id: 'claim-1', statement: 'Факт один.' },
          { claim_id: 'claim-2', statement: 'Факт два.' }
        ])
      }
    }],
    usage: { cost: 0.0006 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact(), fact({ claimId: 'claim-2', subject: 'Компания Y' })]);

  assert.equal(result.statements.length, 2);
  assert.equal(result.statements[0].claimId, 'claim-1');
  assert.equal(result.statements[0].statement, 'Факт один.');
  assert.equal(result.statements[1].claimId, 'claim-2');
});

test('returns the real cost from usage.cost', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "ok"}]' } }],
    usage: { cost: 0.00051 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact()]);

  assert.equal(result.costUsd, 0.00051);
});

test('defaults costUsd to 0 when the response has no usage.cost field', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "ok"}]' } }] });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact()]);

  assert.equal(result.costUsd, 0);
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '```json\n[{"claim_id": "claim-1", "statement": "ok"}]\n```' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact()]);

  assert.equal(result.statements[0].statement, 'ok');
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }] });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /invalid JSON/);
});

test('attaches the real already-incurred costUsd to the thrown error when parsing fails after a successful paid HTTP call', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }], usage: { cost: 0.0008 } });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  try {
    await synthesizeDigest([fact()]);
    assert.fail('expected synthesizeDigest to throw');
  } catch (err) {
    assert.equal(err.costUsd, 0.0008);
  }
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /HTTP 500/);
});

test('throws a descriptive error when a statement references an unknown claim_id', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-unknown", "statement": "ok"}]' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /unknown claim_id/);
});

test('throws a descriptive error when a statement entry is missing statement text', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1"}]' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /missing statement/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/llm/globalSynthesis.test.js`
Expected: FAIL — module `src/llm/globalSynthesis.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/llm/globalSynthesis.js`:

```javascript
export function createGlobalSynthesisJudge({ apiKey, model = 'anthropic/claude-sonnet-4-6', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createGlobalSynthesisJudge: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function synthesizeDigest(facts) {
    if (facts.length === 0) {
      return { statements: [], costUsd: 0 };
    }

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vanquish.information-analysis-agent',
        'X-Title': 'Information Analysis Agent',
        ...(heliconeApiKey ? { 'Helicone-Auth': `Bearer ${heliconeApiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildPrompt(facts) }],
        max_tokens: 4000,
        usage: { include: true }
      })
    });

    if (!response.ok) {
      throw new Error(`synthesizeDigest: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('synthesizeDigest: LLM returned no content');
    }

    const costUsd = data.usage?.cost ?? 0;
    try {
      return { statements: parseStatements(content, facts), costUsd };
    } catch (err) {
      err.costUsd = costUsd;
      throw err;
    }
  };
}

function buildPrompt(facts) {
  const factsList = facts
    .map((f) => `- claim_id: ${f.claimId}\n  ${f.subject}: ${f.predicate}: ${f.object_value ?? ''} (confidence: ${f.confidence_level})`)
    .join('\n');

  return `Ты — аналитик, который формулирует связный читаемый текст факта для дайджеста.

ФАКТЫ (subject/predicate/object_value):
${factsList}

Для каждого факта сформулируй одно связное предложение (statement) на основе его subject/predicate/object_value.
Ответь строго JSON-массивом объектов, без пояснений и без markdown-обёртки:
[{"claim_id": "...", "statement": "..."}]`;
}

function parseStatements(content, facts) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`synthesizeDigest: LLM returned invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('synthesizeDigest: LLM response is not a JSON array');
  }

  const knownIds = new Set(facts.map((f) => f.claimId));
  return parsed.map((raw, index) => {
    if (!raw.claim_id || !knownIds.has(raw.claim_id)) {
      throw new Error(`synthesizeDigest: statement at index ${index} has unknown claim_id "${raw.claim_id}"`);
    }
    if (!raw.statement) {
      throw new Error(`synthesizeDigest: statement at index ${index} missing statement text`);
    }
    return { claimId: raw.claim_id, statement: raw.statement };
  });
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/llm/globalSynthesis.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/llm/globalSynthesis.js" "Information analysis agent/Code/tests/llm/globalSynthesis.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | globalSynthesis LLM — synthesizeDigest через claude-sonnet-4-6 | v0.5.0

Задача 6 плана GlobalSynthesis (Слайс 8). Новая модель, впервые в проекте
не claude-haiku-4-5 — claude-sonnet-4-6 (см. "4. Технологический стек.md"),
тот же паттерн вызова OpenRouter/Helicone/usage:{include:true}, что у
остальных LLM-файлов. LLM делает только одно: формулирует связный
statement по каждому факту (subject/predicate/object_value) — числа
(sources_count/reach_estimate/агрегаты) LLM не передаются и не считаются
здесь, это забота узла globalSynthesis (следующая задача этого плана).
Пустой список facts не делает сетевой вызов вообще (costUsd: 0).
costUsd прикрепляется к брошенной ошибке при сбое парсинга после
успешного платного HTTP-вызова — тот же паттерн, что в остальных
LLM-файлах проекта (Слайс 7).

14/14 тестов проходят.
EOF
)"
```

---

### Task 7: `src/graph/nodes/globalSynthesis.js` — new graph node (assembles and saves the digest)

**Files:**
- Create: `Information analysis agent/Code/src/graph/nodes/globalSynthesis.js`
- Create: `Information analysis agent/Code/tests/graph/nodes/globalSynthesis.test.js`

**Interfaces:**
- Consumes: `state.persistedFacts`/`state.persistedContradictions` (Task 5), `synthesizeDigest` (Task 6), `db.rpc('claim_source_stats', {claim_ids})` (Task 1).
- Produces: `createGlobalSynthesisNode({db, synthesizeDigest}) -> globalSynthesisNode(state) -> Promise<{}>` — no state channels written (last node before `END`); side effects only (`INSERT digests`, `UPDATE runs`).

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/graph/nodes/globalSynthesis.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalSynthesisNode } from '../../../src/graph/nodes/globalSynthesis.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function fact(overrides = {}) {
  return {
    claimId: 'claim-1',
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    confidence_level: 'высокая',
    ...overrides
  };
}

function baseState(overrides = {}) {
  return {
    runId: 'run-1',
    items: [{ job_id: 'job-1' }],
    escalationsAuto: 0,
    escalationsPendingUser: 0,
    costUsdAnalysis: 0.01,
    costUsdRetry: 0,
    persistedFacts: [fact()],
    persistedContradictions: [],
    ...overrides
  };
}

test('does nothing (no digest, no run update) when persistedFacts is empty', async () => {
  const db = makeFakeDb({});
  const synthesizeDigest = async () => { throw new Error('should not be called'); };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState({ persistedFacts: [] }));

  assert.deepEqual(result, {});
});

test('queries claim_source_stats for every persisted claim_id', async () => {
  const rpcCalls = [];
  const db = makeFakeDb({
    claim_source_stats: (params) => { rpcCalls.push(params); return { data: [{ claim_id: 'claim-1', sources_count: 2, reach_estimate: 5000 }], error: null }; },
    digests: () => ({ error: null }),
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(rpcCalls[0], { claim_ids: ['claim-1'] });
});

test('assembles facts[] with statement, confidence, and detail_ref from stats + LLM statements', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [{ claim_id: 'claim-1', sources_count: 3, reach_estimate: 12000 }], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'Компания X подняла 5 млн.' }], costUsd: 0.0005 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.equal(insertedDigest.facts.length, 1);
  assert.equal(insertedDigest.facts[0].claim_id, 'claim-1');
  assert.equal(insertedDigest.facts[0].statement, 'Компания X подняла 5 млн.');
  assert.deepEqual(insertedDigest.facts[0].confidence, { level: 'высокая', sources_count: 3, reach_estimate: 12000 });
  assert.equal(insertedDigest.facts[0].detail_ref, 'claim-1');
});

test('falls back to a template statement (subject: predicate: object_value) when the LLM omits a claim_id', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.equal(insertedDigest.facts[0].statement, 'Компания X: подняла раунд: 5 млн');
});

test('defaults sources_count/reach_estimate to 0 when claim_source_stats has no row for a claim', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.deepEqual(insertedDigest.facts[0].confidence, { level: 'высокая', sources_count: 0, reach_estimate: 0 });
});

test('maps persistedContradictions into the digest contradictions[] shape', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({
    persistedContradictions: [{ claimAId: 'claim-1', claimBId: 'claim-existing-1', explanation: 'разные суммы' }]
  }));

  assert.deepEqual(insertedDigest.contradictions, [
    { claim_a_id: 'claim-1', claim_b_id: 'claim-existing-1', explanation: 'разные суммы' }
  ]);
});

test('assembles meta from state (items_processed/escalations/cost_usd)', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0.0005 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ escalationsAuto: 2, escalationsPendingUser: 1, costUsdAnalysis: 0.03, costUsdRetry: 0.02 }));

  assert.equal(insertedDigest.meta.items_processed, 1);
  assert.equal(insertedDigest.meta.escalations_auto, 2);
  assert.equal(insertedDigest.meta.escalations_pending_user, 1);
  assert.equal(insertedDigest.meta.cost_usd, 0.03 + 0.02 + 0.0005);
});

test('inserts the digest row linked to state.runId', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ runId: 'run-42' }));

  assert.equal(insertedDigest.run_id, 'run-42');
});

test('adds the synthesis costUsd on top of the cost persistResults already wrote to runs', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: () => ({ error: null }),
    runs: (state) => { runUpdatePayload = state.payload; return { error: null }; }
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0.0007 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ costUsdAnalysis: 0.03, costUsdRetry: 0.02 }));

  assert.equal(runUpdatePayload.cost_usd, 0.03 + 0.02 + 0.0007);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0.03 + 0.0007);
});

test('a synthesizeDigest failure is caught and logged, does not throw, and skips saving a digest', async () => {
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: () => { throw new Error('should not be called after synthesizeDigest fails'); }
  });
  const synthesizeDigest = async () => { throw new Error('LLM timeout'); };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState());

  assert.deepEqual(result, {});
});

test('a claim_source_stats RPC failure is caught and logged, does not throw', async () => {
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: null, error: { message: 'function error' } })
  });
  const synthesizeDigest = async () => { throw new Error('should not be called'); };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState());

  assert.deepEqual(result, {});
});

test('a digests insert failure is caught and logged, does not throw, and skips the runs cost update', async () => {
  let runsUpdateCalled = false;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: () => ({ error: { message: 'constraint violation' } }),
    runs: () => { runsUpdateCalled = true; return { error: null }; }
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0.0005 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState());

  assert.deepEqual(result, {});
  assert.equal(runsUpdateCalled, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/globalSynthesis.test.js`
Expected: FAIL — module `src/graph/nodes/globalSynthesis.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/graph/nodes/globalSynthesis.js`:

```javascript
// src/graph/nodes/globalSynthesis.js

export function createGlobalSynthesisNode({ db, synthesizeDigest }) {
  return async function globalSynthesisNode(state) {
    const persistedFacts = state.persistedFacts ?? [];
    const persistedContradictions = state.persistedContradictions ?? [];

    if (persistedFacts.length === 0) {
      return {};
    }

    const { data: statsRows, error: statsError } = await db.rpc('claim_source_stats', {
      claim_ids: persistedFacts.map((f) => f.claimId)
    });
    if (statsError) {
      console.error('globalSynthesis: failed to compute claim source stats:', statsError.message);
      return {};
    }
    const statsByClaimId = new Map((statsRows ?? []).map((row) => [row.claim_id, row]));

    let statements;
    let synthesisCostUsd;
    try {
      const result = await synthesizeDigest(persistedFacts);
      statements = result.statements;
      synthesisCostUsd = result.costUsd;
    } catch (err) {
      console.error('globalSynthesis: synthesizeDigest failed:', err.message);
      return {};
    }
    const statementByClaimId = new Map(statements.map((s) => [s.claimId, s.statement]));

    const facts = persistedFacts.map((fact) => {
      const stats = statsByClaimId.get(fact.claimId) ?? { sources_count: 0, reach_estimate: 0 };
      return {
        claim_id: fact.claimId,
        statement: statementByClaimId.get(fact.claimId) ?? `${fact.subject}: ${fact.predicate}: ${fact.object_value ?? ''}`,
        confidence: {
          level: fact.confidence_level,
          sources_count: Number(stats.sources_count),
          reach_estimate: Number(stats.reach_estimate)
        },
        detail_ref: fact.claimId
      };
    });

    const contradictions = persistedContradictions.map((c) => ({
      claim_a_id: c.claimAId,
      claim_b_id: c.claimBId,
      explanation: c.explanation
    }));

    const costUsdAnalysis = state.costUsdAnalysis ?? 0;
    const costUsdRetry = state.costUsdRetry ?? 0;
    const meta = {
      items_processed: state.items.length,
      escalations_auto: state.escalationsAuto ?? 0,
      escalations_pending_user: state.escalationsPendingUser ?? 0,
      // duration_sec: узел не имеет доступа к моменту старта прогона — задел
      // под "5. ТЗ.md" §3.2, реальное значение появится, когда где-то в
      // графе начнёт трекаться startedAt (не в этом слайсе).
      duration_sec: null,
      cost_usd: costUsdAnalysis + costUsdRetry + synthesisCostUsd
    };

    const { error: digestError } = await db.from('digests').insert({
      run_id: state.runId,
      facts,
      contradictions,
      meta
    });
    if (digestError) {
      console.error('globalSynthesis: failed to save digest:', digestError.message);
      return {};
    }

    // persistResults уже записал "финальную" cost_usd/cost_usd_analysis до
    // того, как этот узел вообще запустился — стоимость самого синтеза
    // добавляется отдельным маленьким UPDATE поверх уже записанного, а не
    // переделкой уже проверенной логики persistResults.
    const { error: costUpdateError } = await db
      .from('runs')
      .update({
        cost_usd: costUsdAnalysis + costUsdRetry + synthesisCostUsd,
        cost_usd_analysis: costUsdAnalysis + synthesisCostUsd
      })
      .eq('id', state.runId);
    if (costUpdateError) {
      console.error('globalSynthesis: failed to add synthesis cost to run:', costUpdateError.message);
    }

    return {};
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/globalSynthesis.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/globalSynthesis.js" "Information analysis agent/Code/tests/graph/nodes/globalSynthesis.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Узел globalSynthesis — собирает и сохраняет дайджест | v0.5.0

Задача 7 плана GlobalSynthesis (Слайс 8). Последний узел графа: берёт
persistedFacts/persistedContradictions (задача 5 этого плана), запрашивает
claim_source_stats (задача 1) для честных sources_count/reach_estimate,
вызывает synthesizeDigest (задача 6) один раз на весь пакет фактов,
собирает facts[]/contradictions[]/meta в формате analysis_digest из
"5. ТЗ.md" §3.2 и сохраняет одной строкой в digests. Если LLM не назвала
statement для какого-то claim_id — используется шаблонный текст
(subject: predicate: object_value) вместо пустой строки.

Отдельным UPDATE после успешной вставки дайджеста добавляет стоимость
самого синтеза поверх уже записанной persistResults'ом cost_usd/
cost_usd_analysis (persistResults пишет "финальную" стоимость раньше, чем
этот узел вообще запускается). Любая ошибка на любом шаге (RPC, LLM,
вставка дайджеста) логируется и не роняет прогон — узел просто ничего не
сохраняет и не трогает runs.status, выставленный persistResults.

12/12 тестов проходят.
EOF
)"
```

---

### Task 8: Wire `globalSynthesis` into the graph

**Files:**
- Modify: `Information analysis agent/Code/src/graph/index.js`
- Modify: `Information analysis agent/Code/tests/graph/index.test.js`

**Interfaces:**
- Consumes: `createGlobalSynthesisNode` (Task 7).
- Produces: `createAnalysisGraph({db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest})` — one new required dependency. Graph order becomes `escalation → dispatcher → Send(extractClaims) → reducer → dedup → contradiction → persistResults → globalSynthesis → END`. `runAnalysis` return shape unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `Information analysis agent/Code/tests/graph/index.test.js`:

```javascript
// tests/graph/index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisGraph } from '../../src/graph/index.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

function makeDb() {
  let entityCounter = 0;
  let claimCounter = 0;
  return makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-1' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => {
      entityCounter += 1;
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => {
      if (state.operation !== 'insert') return { error: null };
      claimCounter += 1;
      return { data: { id: `claim-${claimCounter}` }, error: null };
    },
    claim_sources: () => ({ error: null }),
    contradictions: () => ({ error: null }),
    pending_user_decisions: () => ({ error: null }),
    digests: () => ({ error: null }),
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null }),
    claim_source_stats: () => ({ data: [], error: null })
  });
}

const fakeEmbedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0 });
const fakeJudgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
const fakeJudgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok', costUsd: 0 });
const fakeRetryParse = async () => { throw new Error('should not be called unless an item has low confidence'); };
const fakeSynthesizeDigest = async (facts) => ({
  statements: facts.map((f) => ({ claimId: f.claimId, statement: `${f.subject} ${f.predicate}` })),
  costUsd: 0
});

test('throws when db is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ extractClaims: async () => ({ claims: [], costUsd: 0 }) }),
    /db is required/
  );
});

test('throws when extractClaims is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb() }),
    /extractClaims must be a function/
  );
});

test('runs the full graph for a non-empty batch: extracts, reduces, persists, synthesizes', async () => {
  const extractClaims = async (item) => ({
    claims: [{ subject: `subject-${item.job_id}`, predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } },
     { job_id: 'job-2', agent: 2, content_type: 'video', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 2);
  assert.deepEqual(result.errors, []);
});

test('isolates a per-item extraction failure: run still completes with status partial', async () => {
  const extractClaims = async (item) => {
    if (item.job_id === 'job-bad') throw new Error('LLM timeout');
    return { claims: [{ subject: 'ok', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }], costUsd: 0.001 };
  };
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-good', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } },
     { job_id: 'job-bad', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.claimsWritten, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /job-bad/);
});

test('runs for an empty batch (FORCED_CEILING with nothing accumulated): still records a run', async () => {
  const extractClaims = async () => ({ claims: [], costUsd: 0 });
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis([], { reason: 'ceiling' });

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 0);
});

test('throws when embedText is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest }),
    /embedText must be a function/
  );
});

test('throws when judgeDuplicate is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest }),
    /judgeDuplicate must be a function/
  );
});

test('throws when judgeContradiction is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest }),
    /judgeContradiction must be a function/
  );
});

test('throws when retryParse is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, synthesizeDigest: fakeSynthesizeDigest }),
    /retryParse must be a function/
  );
});

test('throws when synthesizeDigest is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse }),
    /synthesizeDigest must be a function/
  );
});

test('end-to-end: a contradicting claim gets flagged, persisted, and included in the saved digest', async () => {
  const insertedContradictions = [];
  let insertedDigest = null;
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-2' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-new-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null }),
    contradictions: (state) => { insertedContradictions.push(state.payload); return { error: null }; },
    pending_user_decisions: () => ({ error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Компания X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-existing-1', predicate: 'подняла раунд', object_value: '3 млн',
        confidence_level: 'средняя', confidence_explanation: 'ok', similarity: 0.9
      }],
      error: null
    }),
    claim_source_stats: () => ({ data: [{ claim_id: 'claim-new-1', sources_count: 1, reach_estimate: 0 }], error: null })
  });

  const extractClaims = async () => ({
    claims: [{ subject: 'Компания X', predicate: 'подняла раунд', object_value: '5 млн', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true, costUsd: 0 } : { isDuplicate: false, costUsd: 0 });
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы', costUsd: 0 });

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate, judgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'ok');
  assert.equal(insertedContradictions.length, 1);
  assert.equal(insertedContradictions[0].claim_a_id, 'claim-new-1');
  assert.equal(insertedContradictions[0].claim_b_id, 'claim-existing-1');
  assert.ok(insertedDigest, 'a digest row was saved');
  assert.equal(insertedDigest.contradictions.length, 1);
  assert.equal(insertedDigest.contradictions[0].claim_a_id, 'claim-new-1');
});

test('end-to-end: a low-confidence item with content_ref is retried before extraction', async () => {
  const db = makeDb();
  const extractClaims = async (item) => ({
    claims: [{ subject: item.result.transcript, predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const retryParse = async ({ contentRef, contentType }) => {
    assert.equal(contentRef, 'https://example.com/audio.mp3');
    assert.equal(contentType, 'audio');
    return { result: { transcript: 'улучшенный текст' }, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 0.03 } };
  };

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 2, content_type: 'audio', content_ref: 'https://example.com/audio.mp3', result: { transcript: 'слабо' }, confidence: { level: 'низкая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/index.test.js`
Expected: FAIL — `createAnalysisGraph` doesn't validate/use `synthesizeDigest` yet, and there is no `globalSynthesis` node in the graph.

- [ ] **Step 3: Update `graph/index.js`**

Replace the full contents of `Information analysis agent/Code/src/graph/index.js`:

```javascript
// src/graph/index.js
import { StateGraph, START, END } from '@langchain/langgraph';
import { AnalysisState } from './state.js';
import { createEscalationNode } from './nodes/escalation.js';
import { dispatchToExtraction } from './nodes/dispatcher.js';
import { createExtractClaimsNode } from './nodes/extractClaims.js';
import { reducerNode } from './nodes/reducer.js';
import { createDedupNode } from './nodes/dedup.js';
import { createContradictionNode } from './nodes/contradiction.js';
import { createPersistResultsNode } from './nodes/persistResults.js';
import { createGlobalSynthesisNode } from './nodes/globalSynthesis.js';

export function createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest } = {}) {
  if (!db) {
    throw new Error('createAnalysisGraph: db is required');
  }
  if (typeof extractClaims !== 'function') {
    throw new Error('createAnalysisGraph: extractClaims must be a function');
  }
  if (typeof embedText !== 'function') {
    throw new Error('createAnalysisGraph: embedText must be a function');
  }
  if (typeof judgeDuplicate !== 'function') {
    throw new Error('createAnalysisGraph: judgeDuplicate must be a function');
  }
  if (typeof judgeContradiction !== 'function') {
    throw new Error('createAnalysisGraph: judgeContradiction must be a function');
  }
  if (typeof retryParse !== 'function') {
    throw new Error('createAnalysisGraph: retryParse must be a function');
  }
  if (typeof synthesizeDigest !== 'function') {
    throw new Error('createAnalysisGraph: synthesizeDigest must be a function');
  }

  const escalationNode = createEscalationNode({ db, retryParse });
  const extractClaimsNode = createExtractClaimsNode(extractClaims);
  const dedupNode = createDedupNode({ db, embedText, judgeDuplicate });
  const contradictionNode = createContradictionNode({ judgeContradiction });
  const persistResultsNode = createPersistResultsNode({ db });
  const globalSynthesisNode = createGlobalSynthesisNode({ db, synthesizeDigest });

  const compiledGraph = new StateGraph(AnalysisState)
    .addNode('escalation', escalationNode)
    .addNode('extractClaims', extractClaimsNode)
    .addNode('reducer', reducerNode)
    .addNode('dedup', dedupNode)
    .addNode('contradiction', contradictionNode)
    .addNode('persistResults', persistResultsNode)
    .addNode('globalSynthesis', globalSynthesisNode)
    .addEdge(START, 'escalation')
    .addConditionalEdges('escalation', dispatchToExtraction)
    .addEdge('extractClaims', 'reducer')
    .addEdge('reducer', 'dedup')
    .addEdge('dedup', 'contradiction')
    .addEdge('contradiction', 'persistResults')
    .addEdge('persistResults', 'globalSynthesis')
    .addEdge('globalSynthesis', END)
    .compile();

  return async function runAnalysis(items, { reason } = {}) {
    const result = await compiledGraph.invoke({ items, reason: reason ?? null });
    return {
      runId: result.runId,
      status: result.status,
      claimsWritten: result.claims.length,
      errors: result.errors
    };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/index.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/index.js" "Information analysis agent/Code/tests/graph/index.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Граф: узел globalSynthesis последним, после persistResults | v0.5.0

Задача 8 плана GlobalSynthesis (Слайс 8). createAnalysisGraph получает
новую обязательную зависимость synthesizeDigest (задача 6 этого плана).
Порядок узлов: escalation → dispatcher → Send(extractClaims) → reducer →
dedup → contradiction → persistResults → globalSynthesis → END.

Интеграционный тест графа обновлён под новую обязательную зависимость и
новые таблицы фейковой БД (claim_sources/digests/claim_source_stats),
плюс новый end-to-end тест: противоречие, найденное этим прогоном, реально
попадает в сохранённый дайджест, не только в таблицу contradictions.
EOF
)"
```

---

### Task 9: Wire `synthesizeDigest` into `src/index.js`

**Files:**
- Modify: `Information analysis agent/Code/src/index.js`

**Interfaces:**
- Consumes: `createGlobalSynthesisJudge` (Task 6).
- Produces: real application entry point constructs `synthesizeDigest` and passes it into `createAnalysisGraph`, matching every other dependency already wired there.

**IMPORTANT — this exact class of bug has happened repeatedly in this project** (dedup slice: `embedText`/`judgeDuplicate` never wired; escalation slice: `retryParse` wiring was the one thing given a mandatory grep check). Do not let it happen again — Step 3 below is mandatory, not optional.

- [ ] **Step 1: Update `src/index.js`**

Add the import (alongside the existing `createDeepParsingClient` import):

```javascript
import { createGlobalSynthesisJudge } from './llm/globalSynthesis.js';
```

Add the construction (alongside the existing `retryParse` construction, after `heliconeApiKey` is defined):

```javascript
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: requireEnv('OPENROUTER_API_KEY'), heliconeApiKey });
```

Replace the existing `createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse })` call:

```javascript
  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest });
```

- [ ] **Step 2: Run the full test suite**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green (`src/index.js` itself has no direct test file — it's a real entry point, verified by the grep check below).

- [ ] **Step 3: Verify the wiring by grep — mandatory, do not skip**

Run: `grep -n "createGlobalSynthesisJudge\|synthesizeDigest\|createAnalysisGraph(" "Information analysis agent/Code/src/index.js"`

Expected output includes all three of:
1. The import line (`createGlobalSynthesisJudge`)
2. The `const synthesizeDigest = createGlobalSynthesisJudge(...)` construction line
3. `synthesizeDigest` appearing inside the `createAnalysisGraph({ ... })` call

If any of these is missing, `src/index.js` will throw `createAnalysisGraph: synthesizeDigest must be a function` at startup — do not mark this task done until all three are confirmed present.

- [ ] **Step 4: Bump the package version**

`Information analysis agent/Code/package.json` currently reads `"version": "0.4.0"` — this plan's commits use `v0.5.0` (new slice, matching this project's existing convention of bumping the minor version per completed slice). In `Information analysis agent/Code/package.json`, change:

```json
  "version": "0.4.0",
```

to:

```json
  "version": "0.5.0",
```

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/index.js" "Information analysis agent/Code/package.json"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | src/index.js — подключает synthesizeDigest (globalSynthesis) | v0.5.0

Завершает план GlobalSynthesis (Слайс 8). Реальная точка входа теперь
конструирует synthesizeDigest (задача 6 этого плана, claude-sonnet-4-6
через OpenRouter) и передаёт его в createAnalysisGraph вместе с остальными
зависимостями. Проверено явным grep по трём ожидаемым строкам — тот же
класс бага (новая зависимость графа не прокинута в реальный entry point)
уже случался в этом проекте несколько раз.

package.json: 0.4.0 -> 0.5.0 (новый завершённый слайс).
EOF
)"
```

---

## After all tasks: final whole-branch review

Once all 9 tasks are complete and committed, dispatch a final whole-branch review over the full commit range for this plan (from Task 1's first commit to Task 9's last commit) — per the controller's standing instruction for this project, this is the ONLY review pass for this plan (no per-task reviews were run). Points the reviewer should specifically check:

- The full `normalize.js` → `extractClaims` node → `persistResults` → `globalSynthesis` chain for `reachEstimate`/`sources_count` — trace that numbers aren't silently dropped or double-counted, especially for duplicate-confirmed claims (which contribute a `claim_sources` row but not a new `claims` row).
- Schema cross-check: `claim_sources`/`sources.reach_estimate`/`digests` columns match exactly what `persistResults.js`/`globalSynthesis.js` write; `claim_source_stats` RPC signature matches what `globalSynthesis.js` calls.
- `runs.cost_usd`/`cost_usd_analysis` after `globalSynthesis`'s follow-up `UPDATE` — confirm the two-step write (`persistResults` then `globalSynthesis`) never double-adds or drops the synthesis cost, including on the error paths where `globalSynthesis` skips its `UPDATE` entirely.
- `src/index.js` genuinely wires `synthesizeDigest` all the way through (re-verify independently, per the Task 9 note).
- Plan-alignment / scope-creep check against `docs/superpowers/specs/2026-07-09-global-synthesis-design.md` — confirm MCP tool exposure and Telegram notifications were NOT touched (out of scope, separate slices).

Per the standing project instruction, do **not** apply migration `005_digest.sql` to the live database or run any live smoke test until this review (and any resulting fixes) is complete.
