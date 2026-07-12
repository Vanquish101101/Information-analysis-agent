# Agent 3 — Analysis Graph Step 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the LangGraph analysis graph's basic mechanics (Шаг 4 of Agent 3's MVP roadmap) —
Dispatcher → Send×N → Reducer → persistResults — with **real** claim extraction via OpenRouter and
**real** writes to the live `information_analysis_agent` Supabase schema. No deduplication, no
contradiction detection, no cost tracking, no GlobalSynthesis — those are separate later slices.

**Architecture:** `@langchain/langgraph`'s `StateGraph` with `Annotation.Root` state and the `Send` API
for parallel fan-out (map step), a concatenating reducer channel for `claims`/`errors` (fan-in). Both
the LLM call and the Supabase client are dependency-injected into the graph factory — same DI pattern
used everywhere else in this codebase — so every node is unit-testable with fakes, no live API/DB
calls in `npm test`.

**Tech Stack:** Adds `@langchain/langgraph`, `@langchain/core`, `zod` to the existing Node.js ESM
stack. LLM calls use plain `fetch` to OpenRouter (same pattern as
`Intelligence agent/Code/src/agents/transcriber/index.js`), not a heavier SDK. Testing stays on
Node's built-in `node:test` + `node:assert/strict`.

## Global Constraints

- **Git repo root is `Information analysis agent/`, not `Information analysis agent/Code/`** — every
  `git add`/commit runs from the repo root with the `Code/` prefix.
- **Commit message format:** `Information Analysis Agent | <краткое описание на русском> | vX.Y.Z` —
  use `v0.2.0` for every commit in this plan (matches the current `package.json` version; the next
  version bump happens once, at the end of this slice, same convention as the batch-scheduler plan).
- **Do not push to `origin`** — commits stay local until the human partner explicitly asks for a push.
- LLM model: the literal string `'anthropic/claude-haiku-4-5'` — same model Agent 1 already uses for
  a similarly-scoped per-item analysis call (`Intelligence agent/Code/src/agents/transcriber/index.js:54`).
- OpenRouter request shape matches the existing convention in this codebase: POST to
  `https://openrouter.ai/api/v1/chat/completions`, headers `Authorization: Bearer <apiKey>`,
  `Content-Type: application/json`, `HTTP-Referer`, `X-Title`; body `{ model, messages, max_tokens }`.
- `RawClaim` shape (the LLM extraction's output element): `{ subject, predicate, object_value,
  confidence_level, confidence_explanation }`. `confidence_level` must be one of the literal Russian
  strings `'высокая' | 'средняя' | 'низкая'` — same enum already enforced by the `claims` table's
  CHECK constraint (`Code/src/db/migrations/001_information_analysis_agent_schema.sql`).
- **Resolving the design spec's two open questions** (`docs/superpowers/specs/2026-07-08-analysis-graph-step4-design.md`,
  "Открытые вопросы"):
  1. An LLM response that is a syntactically valid, empty JSON array (`[]`) is a **valid** result
     meaning "no claims found" — it does **not** throw. Only a non-JSON / non-array response throws
     (this refines the design doc's literal wording, which listed "empty array" alongside "non-JSON"
     as an error case — that reading would contradict the extraction prompt's own instruction to
     return `[]` when there is nothing to extract, so the plan treats `[]` as success).
  2. When a `NormalizedItem` has no analyzable text (`item.result == null` and no
     `item.telegram_text_fallback`), `extractClaims` returns `[]` **without calling the LLM at all**
     (no wasted API cost on empty input).
- `cost_usd` on the `runs` row stays `0` in this slice — real cost tracking is Шаг 7 (Эскалация), not
  this slice.
- `object_entity_id` on `claims` is **not** populated in this slice — every claim's `object_value` is
  stored as free text only.
- **No deduplication** — every extracted claim creates a **new** `entities` row for its `subject`,
  even if an entity with that name already exists. Consolidating duplicates is Шаг 5, which already
  has an embedding-similarity plan for it.
- **Verified LangGraph behavior (tested directly against the installed `@langchain/langgraph@1.4.7`,
  not assumed from docs):** when the `Send`-dispatching conditional-edge function returns an empty
  array (i.e. `state.items` is empty), nodes reachable **only** through edges from the `Send` target
  (here: `extractClaims` → `reducer` → `persistResults`) never run at all — the graph completes with
  none of them executing. Since the batch scheduler can legitimately trigger with an empty batch
  (`FORCED_CEILING` with no accumulated items — see `tests/scheduler/index.test.js`, the ceiling
  test), the dispatcher **must** special-case the empty-items case by returning the literal array
  `['reducer']` (a direct node-name target, not a `Send`) instead of an empty `Send` array, so
  `reducer` → `persistResults` still run and a `runs` row still gets recorded for an empty trigger.
  This was confirmed by direct experimentation before writing this plan — Task 3 below encodes it.
- `tests/helpers/fakeSupabase.js` is **extended** in this plan (Task 6) to support `.insert(payload)`
  and `.update(payload)` in addition to the existing `.select/.eq/.order/.limit/.single` chain — all
  53 existing tests that use the old read-only surface must keep passing unmodified after the
  extension (purely additive, no existing method's behavior changes).
- No LangGraph checkpointing/persistence configured in this slice (matches the batch scheduler's
  "in-memory now, Redis later" precedent) — `.compile()` is called with no checkpointer argument.
- New `package.json` dependencies: `"@langchain/langgraph": "^1.4.7"`, `"@langchain/core": "^1.2.1"`,
  `"zod": "^4.4.3"` — exact versions confirmed by installing them in a scratch directory before
  writing this plan (not guessed).

---

### Task 1: LLM claim extraction (`extractClaims.js`)

**Files:**
- Create: `Information analysis agent/Code/src/llm/extractClaims.js`
- Test: `Information analysis agent/Code/tests/llm/extractClaims.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses `NormalizedItem`'s existing shape from
  `src/ingestion/normalize.js`: `{ job_id, agent, content_type, result, confidence, meta, created_at }`,
  plus the optional `telegram_text_fallback` field `agent1Reader.js` adds).
- Produces: `createOpenRouterExtractor({ apiKey, model, fetchImpl } = {}) -> extractClaims(item) -> Promise<RawClaim[]>`.
  Task 4's graph node calls this function (injected, not called directly by Task 4's own module).

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/llm/extractClaims.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterExtractor } from '../../src/llm/extractClaims.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      json: async () => responseBody
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws when apiKey is missing', () => {
  assert.throws(
    () => createOpenRouterExtractor({}),
    /apiKey is required/
  );
});

test('returns [] without calling fetch when item has no result and no fallback text', async () => {
  const fetchImpl = fakeFetch({});
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-1', agent: 1, result: null });

  assert.deepEqual(claims, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('uses telegram_text_fallback when result is null but fallback is present', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[]' } }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({
    job_id: 'job-2',
    agent: 1,
    result: null,
    telegram_text_fallback: 'только текстовый отчёт'
  });

  assert.deepEqual(claims, []);
  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.match(body.messages[0].content, /только текстовый отчёт/);
});

test('builds the request with the correct URL, model, and headers', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'secret-key', fetchImpl });

  await extractClaims({ job_id: 'job-3', agent: 1, result: { summary: 'тест' } });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
});

test('parses a valid JSON array response into RawClaim objects', async () => {
  const fetchImpl = fakeFetch({
    choices: [{
      message: {
        content: JSON.stringify([
          {
            subject: 'Продукт X',
            predicate: 'имеет цену',
            object_value: '999 руб',
            confidence_level: 'высокая',
            confidence_explanation: 'Указано явно в источнике'
          }
        ])
      }
    }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-4', agent: 1, result: { summary: 'тест' } });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].subject, 'Продукт X');
  assert.equal(claims[0].confidence_level, 'высокая');
});

test('treats a valid empty JSON array response as zero claims, not an error', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-5', agent: 1, result: { summary: 'ничего нет' } });

  assert.deepEqual(claims, []);
});

test('strips a ```json code fence around the response before parsing', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '```json\n[{"subject":"A","predicate":"B","object_value":"C","confidence_level":"средняя","confidence_explanation":"D"}]\n```' } }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-6', agent: 1, result: { summary: 'тест' } });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].subject, 'A');
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'это не JSON вообще' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(
    () => extractClaims({ job_id: 'job-7', agent: 1, result: { summary: 'тест' } }),
    /invalid JSON/
  );
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 429 });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(
    () => extractClaims({ job_id: 'job-8', agent: 1, result: { summary: 'тест' } }),
    /HTTP 429/
  );
});

test('throws a descriptive error when a claim has an invalid confidence_level', async () => {
  const fetchImpl = fakeFetch({
    choices: [{
      message: {
        content: JSON.stringify([{ subject: 'A', predicate: 'B', object_value: 'C', confidence_level: 'unknown', confidence_explanation: 'D' }])
      }
    }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(
    () => extractClaims({ job_id: 'job-9', agent: 1, result: { summary: 'тест' } }),
    /invalid confidence_level/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/llm/extractClaims.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/llm/extractClaims.js

const CONFIDENCE_LEVELS = ['высокая', 'средняя', 'низкая'];

export function createOpenRouterExtractor({ apiKey, model = 'anthropic/claude-haiku-4-5', fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createOpenRouterExtractor: apiKey is required');
  }

  return async function extractClaims(item) {
    const text = extractableText(item);
    if (!text) {
      return [];
    }

    const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vanquish.information-analysis-agent',
        'X-Title': 'Information Analysis Agent'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildPrompt(text) }],
        max_tokens: 800
      })
    });

    if (!response.ok) {
      throw new Error(`extractClaims: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('extractClaims: LLM returned no content');
    }

    return parseClaims(content);
  };
}

function extractableText(item) {
  if (item.result != null) {
    return JSON.stringify(item.result);
  }
  return item.telegram_text_fallback ?? null;
}

function buildPrompt(text) {
  return `Ты — аналитик, который извлекает проверяемые факты (claims) из текста.

ТЕКСТ:
${text.slice(0, 4000)}

Извлеки список фактов в виде строгого JSON-массива, без пояснений и без markdown-обёртки.
Каждый элемент массива — объект с полями:
- subject (строка, о чём/о ком факт)
- predicate (строка, что утверждается)
- object_value (строка, значение/детали)
- confidence_level (одна из строк: "высокая", "средняя", "низкая")
- confidence_explanation (строка, короткое обоснование уровня доверия)

Если фактов нет — верни пустой массив [].
Ответ — только JSON-массив, ничего больше.`;
}

function parseClaims(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`extractClaims: LLM returned invalid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('extractClaims: LLM response is not a JSON array');
  }

  return parsed.map((raw, index) => {
    if (!raw.subject || !raw.predicate) {
      throw new Error(`extractClaims: claim at index ${index} missing subject/predicate`);
    }
    if (!CONFIDENCE_LEVELS.includes(raw.confidence_level)) {
      throw new Error(`extractClaims: claim at index ${index} has invalid confidence_level "${raw.confidence_level}"`);
    }
    return {
      subject: raw.subject,
      predicate: raw.predicate,
      object_value: raw.object_value ?? null,
      confidence_level: raw.confidence_level,
      confidence_explanation: raw.confidence_explanation ?? null
    };
  });
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 10 tests in `tests/llm/extractClaims.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/llm/extractClaims.js Code/tests/llm/extractClaims.test.js
git commit -m "Information Analysis Agent | extractClaims — извлечение claims через OpenRouter | v0.2.0"
```

---

### Task 2: Graph state (`state.js`)

**Files:**
- Modify: `Information analysis agent/Code/package.json` (add dependencies)
- Create: `Information analysis agent/Code/src/graph/state.js`

**Interfaces:**
- Consumes: `Annotation` from `@langchain/langgraph`.
- Produces: `AnalysisState` (an `Annotation.Root` instance) exported from `src/graph/state.js`, with
  fields `items`, `reason`, `runId`, `status` (no reducer — last value wins) and `claims`, `errors`
  (concatenating reducer, default `[]`). Tasks 3–7 all build on this state shape.

- [ ] **Step 1: Add the new dependencies**

Edit `package.json`'s `"dependencies"` block to add these three entries (keep existing
`@supabase/supabase-js` and `dotenv` entries as they are):

```json
    "@langchain/core": "^1.2.1",
    "@langchain/langgraph": "^1.4.7",
    "zod": "^4.4.3"
```

Run (working directory `Information analysis agent/Code/`): `npm install`
Expected: install succeeds, `node_modules/@langchain/langgraph` exists.

- [ ] **Step 2: Write `state.js` (no dedicated test file — this is declarative configuration,
  exercised indirectly by every later task's tests, same convention as `tests/helpers/fakeSupabase.js`
  having no test file of its own)**

```javascript
// src/graph/state.js
import { Annotation } from '@langchain/langgraph';

function concatReducer(a, b) {
  return a.concat(b);
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
  })
});
```

- [ ] **Step 3: Run the full suite to confirm nothing broke**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 64 existing tests still green (this task adds no new tests of its own).

- [ ] **Step 4: Commit**

```bash
git add Code/package.json Code/package-lock.json Code/src/graph/state.js
git commit -m "Information Analysis Agent | AnalysisState + зависимости LangGraph | v0.2.0"
```

---

### Task 3: Dispatcher (`nodes/dispatcher.js`)

**Files:**
- Create: `Information analysis agent/Code/src/graph/nodes/dispatcher.js`
- Test: `Information analysis agent/Code/tests/graph/nodes/dispatcher.test.js`

**Interfaces:**
- Consumes: `Send` from `@langchain/langgraph`.
- Produces: `dispatchToExtraction(state) -> (Send | string)[]` — used as the path function for
  `addConditionalEdges(START, dispatchToExtraction)` in Task 7. Returns one `Send('extractClaims', { item })`
  per item in `state.items`, or the literal array `['reducer']` when `state.items` is empty (see the
  Global Constraints note on verified LangGraph empty-dispatch behavior — this is not optional, it is
  required for the empty-batch/`FORCED_CEILING` case to still produce a `runs` row).

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/graph/nodes/dispatcher.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Send } from '@langchain/langgraph';
import { dispatchToExtraction } from '../../../src/graph/nodes/dispatcher.js';

test('returns one Send per item, targeting the extractClaims node', () => {
  const state = { items: [{ job_id: 'a' }, { job_id: 'b' }] };

  const result = dispatchToExtraction(state);

  assert.equal(result.length, 2);
  assert.ok(result[0] instanceof Send);
  assert.equal(result[0].node, 'extractClaims');
  assert.deepEqual(result[0].args, { item: { job_id: 'a' } });
  assert.deepEqual(result[1].args, { item: { job_id: 'b' } });
});

test('returns ["reducer"] directly when items is empty, instead of zero Sends', () => {
  const state = { items: [] };

  const result = dispatchToExtraction(state);

  assert.deepEqual(result, ['reducer']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../../src/graph/nodes/dispatcher.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/graph/nodes/dispatcher.js
import { Send } from '@langchain/langgraph';

// Пустой items[] (например, FORCED_CEILING без накопленных элементов) не должен
// давать ноль Send — иначе reducer/persistResults вообще не выполнятся, и прогон
// не попадёт в runs. Проверено напрямую на установленной версии @langchain/langgraph.
export function dispatchToExtraction(state) {
  if (state.items.length === 0) {
    return ['reducer'];
  }
  return state.items.map((item) => new Send('extractClaims', { item }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — both tests in `tests/graph/nodes/dispatcher.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/graph/nodes/dispatcher.js Code/tests/graph/nodes/dispatcher.test.js
git commit -m "Information Analysis Agent | dispatchToExtraction — Send fan-out + обработка пустого батча | v0.2.0"
```

---

### Task 4: Extraction node (`nodes/extractClaims.js`)

**Files:**
- Create: `Information analysis agent/Code/src/graph/nodes/extractClaims.js`
- Test: `Information analysis agent/Code/tests/graph/nodes/extractClaims.test.js`

**Interfaces:**
- Consumes: nothing concrete from earlier tasks (takes an injected `extractClaims` function matching
  Task 1's `createOpenRouterExtractor(...)`'s return type — in tests, a plain fake function).
- Produces: `createExtractClaimsNode(extractClaims) -> extractClaimsNode({ item }) -> Promise<{ claims: RawClaimWithSource[] } | { errors: string[] }>`
  where `RawClaimWithSource` is a `RawClaim` (Task 1) plus a `source: { agent, jobId, refType }` field.
  This is the `Send` target node registered as `'extractClaims'` in Task 7.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/graph/nodes/extractClaims.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractClaimsNode } from '../../../src/graph/nodes/extractClaims.js';

test('attaches source metadata to each claim returned by the injected extractClaims', async () => {
  const fakeExtract = async () => ([
    { subject: 'A', predicate: 'B', object_value: 'C', confidence_level: 'высокая', confidence_explanation: 'D' },
    { subject: 'E', predicate: 'F', object_value: 'G', confidence_level: 'средняя', confidence_explanation: 'H' }
  ]);
  const node = createExtractClaimsNode(fakeExtract);
  const item = { job_id: 'job-1', agent: 1, content_type: 'search' };

  const result = await node({ item });

  assert.equal(result.claims.length, 2);
  assert.deepEqual(result.claims[0].source, { agent: 1, jobId: 'job-1', refType: 'search' });
  assert.deepEqual(result.claims[1].source, { agent: 1, jobId: 'job-1', refType: 'search' });
  assert.equal(result.claims[0].subject, 'A');
});

test('returns an empty claims array when the injected extractClaims returns []', async () => {
  const fakeExtract = async () => [];
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-2', agent: 2, content_type: 'video' } });

  assert.deepEqual(result, { claims: [] });
});

test('isolates a failure: returns errors, not claims, and does not throw', async () => {
  const fakeExtract = async () => { throw new Error('LLM timeout'); };
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-3', agent: 1, content_type: 'search' } });

  assert.deepEqual(result.errors, ['item job-3: LLM timeout']);
  assert.equal(result.claims, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../../src/graph/nodes/extractClaims.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/graph/nodes/extractClaims.js

export function createExtractClaimsNode(extractClaims) {
  return async function extractClaimsNode({ item }) {
    try {
      const rawClaims = await extractClaims(item);
      const claims = rawClaims.map((claim) => ({
        ...claim,
        source: { agent: item.agent, jobId: item.job_id, refType: item.content_type }
      }));
      return { claims };
    } catch (err) {
      return { errors: [`item ${item.job_id}: ${err.message}`] };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 3 tests in `tests/graph/nodes/extractClaims.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/graph/nodes/extractClaims.js Code/tests/graph/nodes/extractClaims.test.js
git commit -m "Information Analysis Agent | extractClaims-узел графа — источник claim + изоляция ошибок | v0.2.0"
```

---

### Task 5: Reducer node (`nodes/reducer.js`)

**Files:**
- Create: `Information analysis agent/Code/src/graph/nodes/reducer.js`
- Test: `Information analysis agent/Code/tests/graph/nodes/reducer.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `reducerNode(state) -> {}` (a no-op state update — the actual collection already happened
  via `AnalysisState`'s `claims`/`errors` reducers; this node exists to match the architecture doc's
  named "Reducer" step and to log the collected counts). Registered as `'reducer'` in Task 7.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/graph/nodes/reducer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reducerNode } from '../../../src/graph/nodes/reducer.js';

test('returns an empty update without throwing when claims/errors are present', () => {
  const state = { claims: [{ subject: 'A' }, { subject: 'B' }], errors: ['item x: failed'] };
  const result = reducerNode(state);
  assert.deepEqual(result, {});
});

test('returns an empty update when claims/errors are both empty', () => {
  const state = { claims: [], errors: [] };
  const result = reducerNode(state);
  assert.deepEqual(result, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../../src/graph/nodes/reducer.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/graph/nodes/reducer.js

export function reducerNode(state) {
  console.log(`analysis graph: reducer collected ${state.claims.length} claims, ${state.errors.length} errors`);
  return {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — both tests in `tests/graph/nodes/reducer.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add Code/src/graph/nodes/reducer.js Code/tests/graph/nodes/reducer.test.js
git commit -m "Information Analysis Agent | reducer-узел графа — фиксация агрегатов | v0.2.0"
```

---

### Task 6: Persist results (`nodes/persistResults.js`)

**Files:**
- Modify: `Information analysis agent/Code/tests/helpers/fakeSupabase.js` (add `.insert()`/`.update()`
  support, additive only — existing `.select/.eq/.order/.limit/.single` behavior must not change)
- Create: `Information analysis agent/Code/src/graph/nodes/persistResults.js`
- Test: `Information analysis agent/Code/tests/graph/nodes/persistResults.test.js`

**Interfaces:**
- Consumes: `makeFakeDb` from `tests/helpers/fakeSupabase.js` (tests only, after this task's extension).
- Produces: `createPersistResultsNode({ db, now }) -> persistResultsNode(state) -> Promise<{ runId, status }>`.
  Registered as `'persistResults'` in Task 7. Writes one `runs` row, one `sources` row per unique
  `(agent, jobId)` pair seen across `state.claims`, one new `entities` row per claim (no dedup — see
  Global Constraints), and one `claims` row per claim referencing them.

- [ ] **Step 1: Extend `fakeSupabase.js` with `.insert()`/`.update()`**

Replace the full contents of `tests/helpers/fakeSupabase.js` with:

```javascript
// tests/helpers/fakeSupabase.js

// Minimal fake for the subset of the Supabase query-builder chain this
// project uses: .from(table).select().eq().order().limit() / .single()
// and .from(table).insert(payload) / .update(payload).eq() — both read and
// write chains are thenables, matching real supabase-js: `await query`
// resolves to `{ data, error }` without an explicit `.then()` call.
// `state.operation` ('select' | 'insert' | 'update') and `state.payload` let
// a test's handler distinguish which operation is in progress.
export function makeFakeDb(handlers) {
  return {
    from(table) {
      const state = { table, filters: {}, operation: 'select', payload: undefined };
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
        insert(payload) {
          state.operation = 'insert';
          state.payload = payload;
          return builder;
        },
        update(payload) {
          state.operation = 'update';
          state.payload = payload;
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

- [ ] **Step 2: Run the full suite to confirm the extension is backward-compatible**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 69 existing tests (from Tasks 1–5 plus the pre-existing 54) still green; this
step adds no new test file of its own, it only changes shared test infrastructure.

- [ ] **Step 3: Write the failing tests for `persistResults.js`**

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
    source: { agent: 1, jobId: 'job-1', refType: 'search' },
    ...overrides
  };
}

test('creates a run, one source per unique job, one entity+claim per claim, status ok', async () => {
  let entityCounter = 0;
  const inserted = { sources: [], entities: [], claims: [] };
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
      return { error: null };
    }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ subject: 'A' }), claim({ subject: 'B' })],
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
});

test('status is partial when state.errors is non-empty', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-2' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ error: null })
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../../src/graph/nodes/persistResults.js'`

- [ ] **Step 5: Write the implementation**

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
              raw_job_id: claim.source.jobId
            })
            .select()
            .single();
          if (sourceError) {
            throw new Error(`persistResults: failed to create source: ${sourceError.message}`);
          }
          sourceIds.set(sourceKey, sourceRow.id);
        }
      }

      for (const claim of state.claims) {
        const sourceKey = `${claim.source.agent}:${claim.source.jobId}`;
        const sourceId = sourceIds.get(sourceKey);

        const { data: entityRow, error: entityError } = await db
          .from('entities')
          .insert({ name: claim.subject })
          .select()
          .single();
        if (entityError) {
          throw new Error(`persistResults: failed to create entity: ${entityError.message}`);
        }

        const { error: claimError } = await db
          .from('claims')
          .insert({
            subject_entity_id: entityRow.id,
            predicate: claim.predicate,
            object_value: claim.object_value,
            confidence_level: claim.confidence_level,
            confidence_explanation: claim.confidence_explanation,
            source_id: sourceId
          });
        if (claimError) {
          throw new Error(`persistResults: failed to create claim: ${claimError.message}`);
        }
      }

      const finalStatus = state.errors.length > 0 ? 'partial' : 'ok';
      await db.from('runs').update({ status: finalStatus }).eq('id', runId);

      return { runId, status: finalStatus };
    } catch (err) {
      await db.from('runs').update({ status: 'error' }).eq('id', runId);
      throw err;
    }
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 4 tests in `tests/graph/nodes/persistResults.test.js` green, full suite still green.

- [ ] **Step 7: Commit**

```bash
git add Code/tests/helpers/fakeSupabase.js Code/src/graph/nodes/persistResults.js Code/tests/graph/nodes/persistResults.test.js
git commit -m "Information Analysis Agent | persistResults — запись runs/sources/entities/claims + insert/update в fakeSupabase | v0.2.0"
```

---

### Task 7: Graph assembly (`graph/index.js`)

**Files:**
- Create: `Information analysis agent/Code/src/graph/index.js`
- Test: `Information analysis agent/Code/tests/graph/index.test.js`

**Interfaces:**
- Consumes: `AnalysisState` (Task 2), `dispatchToExtraction` (Task 3), `createExtractClaimsNode`
  (Task 4), `reducerNode` (Task 5), `createPersistResultsNode` (Task 6).
- Produces: `createAnalysisGraph({ db, extractClaims, now }) -> runAnalysis(items, { reason }) -> Promise<{ runId, status, claimsWritten, errors }>`.
  This signature is intentionally identical to the `onBatchReady` callback the batch scheduler expects
  (`docs/superpowers/specs/2026-07-08-batch-scheduler-design.md`) — wiring `runAnalysis` in as the
  real `onBatchReady` is a separate future slice, not part of this task.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/graph/index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisGraph } from '../../src/graph/index.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

function makeDb() {
  let entityCounter = 0;
  return makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-1' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => {
      entityCounter += 1;
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: () => ({ error: null })
  });
}

test('throws when db is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ extractClaims: async () => [] }),
    /db is required/
  );
});

test('throws when extractClaims is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb() }),
    /extractClaims must be a function/
  );
});

test('runs the full graph for a non-empty batch: extracts, reduces, persists', async () => {
  const extractClaims = async (item) => [
    { subject: `subject-${item.job_id}`, predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }
  ];
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 1, content_type: 'search' }, { job_id: 'job-2', agent: 2, content_type: 'video' }],
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
    return [{ subject: 'ok', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }];
  };
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims });

  const result = await runAnalysis(
    [{ job_id: 'job-good', agent: 1, content_type: 'search' }, { job_id: 'job-bad', agent: 1, content_type: 'search' }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.claimsWritten, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /job-bad/);
});

test('runs for an empty batch (FORCED_CEILING with nothing accumulated): still records a run', async () => {
  const extractClaims = async () => [];
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims });

  const result = await runAnalysis([], { reason: 'ceiling' });

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/graph/index.js'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/graph/index.js
import { StateGraph, START, END } from '@langchain/langgraph';
import { AnalysisState } from './state.js';
import { dispatchToExtraction } from './nodes/dispatcher.js';
import { createExtractClaimsNode } from './nodes/extractClaims.js';
import { reducerNode } from './nodes/reducer.js';
import { createPersistResultsNode } from './nodes/persistResults.js';

export function createAnalysisGraph({ db, extractClaims } = {}) {
  if (!db) {
    throw new Error('createAnalysisGraph: db is required');
  }
  if (typeof extractClaims !== 'function') {
    throw new Error('createAnalysisGraph: extractClaims must be a function');
  }

  const extractClaimsNode = createExtractClaimsNode(extractClaims);
  const persistResultsNode = createPersistResultsNode({ db });

  const compiledGraph = new StateGraph(AnalysisState)
    .addNode('extractClaims', extractClaimsNode)
    .addNode('reducer', reducerNode)
    .addNode('persistResults', persistResultsNode)
    .addConditionalEdges(START, dispatchToExtraction)
    .addEdge('extractClaims', 'reducer')
    .addEdge('reducer', 'persistResults')
    .addEdge('persistResults', END)
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

Run (working directory `Information analysis agent/Code/`): `npm test`
Expected: PASS — all 6 tests in `tests/graph/index.test.js` green, full suite green (81 tests total:
54 pre-existing + 10 [Task 1] + 2 [Task 3] + 3 [Task 4] + 2 [Task 5] + 4 [Task 6] + 6 [Task 7] — exact
count confirmed by the implementer's actual `npm test` output, this is an arithmetic check, not a
requirement to match exactly if a task's final test count differs slightly during implementation).

- [ ] **Step 5: Commit**

```bash
git add Code/src/graph/index.js Code/tests/graph/index.test.js
git commit -m "Information Analysis Agent | createAnalysisGraph/runAnalysis — сборка графа Dispatcher-Send-Reducer-persistResults | v0.2.0"
```

---

## Self-Review

**Spec coverage:** Task 1 covers the design doc's `extractClaims.js` section (including both resolved
open questions — empty-array-is-valid, no-text-skips-LLM-call). Task 2 covers `state.js` and the new
dependencies. Tasks 3–6 cover `dispatcher.js`, the `extractClaims` node, `reducer.js`, and
`persistResults.js` respectively, including the entity-creation-without-dedup rule and the
`cost_usd: 0`/no-`object_entity_id` simplifications. Task 7 covers `graph/index.js` and confirms the
`runAnalysis` signature matches the future `onBatchReady` seam. The design doc's "Явно не входит в
этот слайс" items (dedup, contradictions, escalation/cost, GlobalSynthesis, scheduler wiring) have no
task here, matching the design's own scope boundary.

**Placeholder scan:** No TBD/TODO markers. Every step has complete, runnable code, including the
LangGraph empty-dispatch behavior, which was verified by direct experimentation (not assumed) before
this plan was written.

**Type consistency:** `RawClaim`'s five fields (`subject`, `predicate`, `object_value`,
`confidence_level`, `confidence_explanation`) are produced identically by Task 1 and consumed
identically by Task 4 (which adds `source` alongside them, not replacing any field) and Task 6 (which
reads `claim.subject`/`claim.predicate`/`claim.object_value`/`claim.confidence_level`/
`claim.confidence_explanation`/`claim.source.agent`/`claim.source.jobId`/`claim.source.refType` —
every field Task 4 attaches is actually read by Task 6, nothing renamed in between). `AnalysisState`'s
five channels (`items`, `reason`, `runId`, `status`, `claims`, `errors`) are used with the same names
across Tasks 3, 4, 5, 6, 7 — no drift.
