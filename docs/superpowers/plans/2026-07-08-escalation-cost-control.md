# Escalation & Cost Control (Шаг 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Per explicit controller instruction for this plan: do NOT dispatch a task-reviewer after each task — implement all tasks back-to-back, then a single final whole-branch review runs once after the last task.**

**Goal:** Add automatic low-confidence retry escalation (via Agent 2's `deepparsing_parse` MCP tool) with a per-retry cost threshold and a per-run cost cap, and make `runs.cost_usd` a real, computed total across the whole pipeline instead of a hardcoded `0`.

**Architecture:** A new `escalation` node runs first in the graph (before the dispatcher), inspecting raw items for low confidence and either retrying via a new MCP client (Agent 2, `mode: 'deep'`) or recording a `pending_user_decisions` row. Every LLM/embedding call site (`extractClaims`, `judgeDuplicate`, `judgeContradiction`, `embedText`) now also returns its real (OpenRouter) or estimated (Gemini) dollar cost; these flow through two new `AnalysisState` channels (`costUsdAnalysis`, summed; `costUsdRetry`, set once) into `persistResults`, which writes them to two new `runs` columns plus the existing `cost_usd`/`escalations_auto`/`escalations_pending_user` columns.

**Tech Stack:** Node.js ESM, `node:test`/`node:assert/strict`, `@langchain/langgraph` (`Overwrite`, `Annotation`), Supabase (`information_analysis_agent` schema), OpenRouter (`anthropic/claude-haiku-4-5`), Gemini (`gemini-embedding-001`), `@modelcontextprotocol/sdk` (`^1.12.1`, new dependency, same version already used by Agent 1/2).

## Global Constraints

- Every external integration is a DI factory function (injectable client/fetchImpl/SDK classes, defaulting to the real one) — zero live calls in `npm test`.
- OpenRouter calls use model `anthropic/claude-haiku-4-5`, headers `Authorization: Bearer`, `HTTP-Referer: 'https://vanquish.information-analysis-agent'`, `X-Title: 'Information Analysis Agent'`, optional `heliconeApiKey` routing through `https://openrouter.helicone.ai/api/v1/chat/completions` with `Helicone-Auth: Bearer <key>` (same pattern as `extractClaims.js`/`judgeDuplicate.js`/`judgeContradiction.js`).
- Real per-call OpenRouter cost: request body must include `usage: { include: true }`; the response then includes `usage.cost` (a number in USD) — verified via a real live call in this plan's design phase.
- Gemini `embedContent` gives no cost/usage field at all — embedding cost is always an ESTIMATE: `Math.ceil(text.length / 4)` as the token-count approximation, `estimatedTokens / 1_000_000 * 0.15` as the USD estimate (published `gemini-embedding-001` standard rate, $0.15/1M input tokens).
- Confidence vocabulary is always the three strings `высокая`/`средняя`/`низкая`.
- Supabase schema is `information_analysis_agent`; new/altered tables need explicit `GRANT`/RLS handling consistent with existing migrations.
- `Overwrite` (from `@langchain/langgraph`) must wrap any node's return value for the `claims` channel (concat reducer, used for `Send` fan-in) — a plain array return would double claims. `errors` is also a concat-reducer channel and must NOT be wrapped (plain array, so it appends). `costUsdAnalysis` is a new **numeric sum reducer** channel — nodes contribute a plain number, never wrapped.
- `items`, `costUsdRetry`, `escalationsAuto`, `escalationsPendingUser`, `costCapReached` have NO reducer (single-writer, overwrite semantics) — only the `escalation` node ever sets these, so plain values are correct, no `Overwrite` needed.
- Retry always uses `mode: 'deep'` when calling Agent 2 — never re-issue the exact same request.
- Migrations are written and tested (regex assertions against the SQL file) but **not applied to the live DB** as part of this plan.
- Commit message format: `Information Analysis Agent | <короткое русское описание> | v0.4.0` — title short, but per standing instruction, write an expansive, detailed body every commit (not just milestones): what changed, why, and relevant context.
- Design reference: `docs/superpowers/specs/2026-07-08-escalation-cost-control-design.md`.

---

### Task 1: Migration — `cost_usd_retry`/`cost_usd_analysis` columns on `runs`

**Files:**
- Create: `Information analysis agent/Code/src/db/migrations/004_cost_columns.sql`
- Create: `Information analysis agent/Code/tests/db/migration004.test.js`

**Interfaces:**
- Produces: `information_analysis_agent.runs` gains `cost_usd_retry NUMERIC(10,4) NOT NULL DEFAULT 0` and `cost_usd_analysis NUMERIC(10,4) NOT NULL DEFAULT 0`. Existing `cost_usd` column is unchanged (still the grand total, written by Task 13's `persistResults.js` as `cost_usd_analysis + cost_usd_retry`).

- [ ] **Step 1: Write the failing test**

Create `Information analysis agent/Code/tests/db/migration004.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/004_cost_columns.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('adds cost_usd_retry column to runs', () => {
  assert.match(sql, /ALTER TABLE information_analysis_agent\.runs/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS cost_usd_retry\s+NUMERIC\(10,\s*4\)\s+NOT NULL DEFAULT 0/);
});

test('adds cost_usd_analysis column to runs', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS cost_usd_analysis\s+NUMERIC\(10,\s*4\)\s+NOT NULL DEFAULT 0/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `Information analysis agent/Code`): `node --test tests/db/migration004.test.js`
Expected: FAIL — `ENOENT` reading the migration file.

- [ ] **Step 3: Write the migration file**

Create `Information analysis agent/Code/src/db/migrations/004_cost_columns.sql`:

```sql
-- src/db/migrations/004_cost_columns.sql
-- Шаг 7 (эскалация/контроль стоимости): runs.cost_usd становится реальной
-- суммой вместо жёсткого 0. Разбивка на "стоимость повторов через Агента 2"
-- и "стоимость собственной работы Агента 3" хранится отдельно — задел под
-- будущую разбивку в дайджесте/дашборде расходов (Шаг 8 / v1.5/v2.0),
-- cost_usd остаётся суммой обеих колонок для обратной совместимости.

ALTER TABLE information_analysis_agent.runs
  ADD COLUMN IF NOT EXISTS cost_usd_retry    NUMERIC(10, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_usd_analysis NUMERIC(10, 4) NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db/migration004.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/db/migrations/004_cost_columns.sql" "Information analysis agent/Code/tests/db/migration004.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Миграция: cost_usd_retry/cost_usd_analysis на runs | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). Готовит схему для
реального учёта расходов: раньше runs.cost_usd везде был жёстко 0. Две
новые колонки хранят стоимость раздельно (повторы через Агента 2 vs
собственная работа Агента 3 — извлечение/дедуп/противоречия), чтобы позже
можно было показать разбивку в дайджесте или дашборде расходов, не
восстанавливая её задним числом. cost_usd остаётся суммой обеих колонок.
EOF
)"
```

---

### Task 2: Thread `content_ref` through ingestion (needed for Agent 2 retries)

**Files:**
- Modify: `Information analysis agent/Code/src/ingestion/normalize.js`
- Modify: `Information analysis agent/Code/src/ingestion/agent2Reader.js`
- Modify: `Information analysis agent/Code/tests/ingestion/normalize.test.js`
- Modify: `Information analysis agent/Code/tests/ingestion/agent2Reader.test.js`

**Interfaces:**
- Produces: `normalizeItem(item)` now includes `content_ref: string|null` in its returned object (`null` when not provided — always the case for Agent 1 items, which have no single content reference). `fetchAgent2Items` now populates `content_ref` from `deep_parsing_agent.parsing_jobs.content_ref` (a real column, confirmed to exist via live schema inspection during design — Agent 3 just wasn't reading it). Task 12 (`escalation.js`) consumes `item.content_ref` to decide whether an Agent 2 retry is possible.

- [ ] **Step 1: Write the failing tests**

In `Information analysis agent/Code/tests/ingestion/normalize.test.js`, add at the end of the file:

```javascript
test('defaults content_ref to null when missing', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 1, content_type: 'search' });
  assert.equal(result.content_ref, null);
});

test('preserves a provided content_ref as-is', () => {
  const result = normalizeItem({ job_id: 'abc', agent: 2, content_type: 'video', content_ref: 'https://example.com/video.mp4' });
  assert.equal(result.content_ref, 'https://example.com/video.mp4');
});
```

In `Information analysis agent/Code/tests/ingestion/agent2Reader.test.js`, modify the first test (`'joins handoff_queue -> parsing_results -> parsing_jobs into a normalized item'`) — change the `parsing_jobs` handler and add one assertion:

```javascript
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
      return { data: { content_type: 'video', content_ref: 'https://example.com/video.mp4' }, error: null };
    }
  });

  const items = await fetchAgent2Items(db);

  assert.equal(items.length, 1);
  assert.equal(items[0].job_id, 'job-9');
  assert.equal(items[0].agent, 2);
  assert.equal(items[0].content_type, 'video');
  assert.equal(items[0].content_ref, 'https://example.com/video.mp4');
  assert.deepEqual(items[0].result, { transcript: 'текст видео' });
  assert.equal(items[0].confidence.level, 'средняя');
  assert.equal(items[0].handoff_queue_id, 'hq-1');
  assert.equal(items[0].created_at, '2026-07-07T09:00:00Z');
});
```

Leave every other test in both files unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ingestion/normalize.test.js tests/ingestion/agent2Reader.test.js`
Expected: FAIL — `result.content_ref`/`items[0].content_ref` is `undefined`, not `null`/the expected string.

- [ ] **Step 3: Update `normalize.js`**

In `Information analysis agent/Code/src/ingestion/normalize.js`, add `content_ref` to the returned object:

```javascript
  return {
    job_id: item.job_id,
    agent: item.agent,
    content_type: item.content_type ?? 'unknown',
    content_ref: item.content_ref ?? null,
    result: item.result ?? null,
    confidence: item.confidence?.level ? item.confidence : DEFAULT_CONFIDENCE,
    meta: item.meta ?? defaultMeta(),
    created_at: item.created_at ?? null
  };
```

(This replaces the existing `return { ... }` block — every other line of the file stays the same.)

- [ ] **Step 4: Update `agent2Reader.js`**

In `Information analysis agent/Code/src/ingestion/agent2Reader.js`, change the `parsing_jobs` query and the `normalizeItem` call:

```javascript
    const { data: jobRow } = await db
      .from('parsing_jobs')
      .select('content_type, content_ref')
      .eq('id', row.job_id)
      .single();

    const normalized = normalizeItem({
      job_id: row.job_id,
      agent: 2,
      content_type: jobRow?.content_type ?? null,
      content_ref: jobRow?.content_ref ?? null,
      result: resultRow.result_json ?? null,
      confidence: { level: resultRow.confidence_level, explanation: resultRow.confidence_text },
      created_at: row.created_at
    });
```

Everything else in the file (the `agent3_handoff_queue`/`parsing_results` queries, the `items.push`/return) stays the same.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/ingestion/normalize.test.js tests/ingestion/agent2Reader.test.js`
Expected: PASS (9 + 6 = 15 tests).

- [ ] **Step 6: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 7: Commit**

```bash
git add "Information analysis agent/Code/src/ingestion/normalize.js" "Information analysis agent/Code/src/ingestion/agent2Reader.js" "Information analysis agent/Code/tests/ingestion/normalize.test.js" "Information analysis agent/Code/tests/ingestion/agent2Reader.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Ингест: пробрасываем content_ref от Агента 2 | v0.4.0

Готовит данные для механизма автоповтора (Шаг 7): у Агент 2 в
parsing_jobs уже есть колонка content_ref (ссылка/путь на исходный
контент), но Агент 3 раньше читал только content_type — content_ref
никуда не попадал. Без него узел escalation не сможет попросить Агента 2
перепарсить конкретный job ещё раз. Agent 1 items content_ref не имеют
(поисковый агрегат, не один URL) — normalizeItem по умолчанию ставит null,
это ожидаемо и обрабатывается явно в escalation.js.
EOF
)"
```

---

### Task 3: Real cost in `extractClaims.js`

**Files:**
- Modify: `Information analysis agent/Code/src/llm/extractClaims.js`
- Modify: `Information analysis agent/Code/tests/llm/extractClaims.test.js`

**Interfaces:**
- Consumes: OpenRouter's `usage.cost` field (present when the request body includes `usage: { include: true }` — verified via a real live call).
- Produces: `createOpenRouterExtractor(...) -> extractClaims(item) -> Promise<{ claims: RawClaim[], costUsd: number }>` (**breaking change** — was `Promise<RawClaim[]>`). `claims` is unchanged in shape/content. Task 8 (`extractClaims` graph node) consumes the new shape.

- [ ] **Step 1: Write the failing tests**

In `Information analysis agent/Code/tests/llm/extractClaims.test.js`, every existing test that calls `extractClaims(...)` and asserts directly on the result (`claims`) needs its assertions updated for the new `{claims, costUsd}` wrapper. Replace the ENTIRE file with:

```javascript
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

test('returns claims: [] and costUsd: 0 without calling fetch when item has no result and no fallback text', async () => {
  const fetchImpl = fakeFetch({});
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const result = await extractClaims({ job_id: 'job-1', agent: 1, result: null });

  assert.deepEqual(result.claims, []);
  assert.equal(result.costUsd, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('uses telegram_text_fallback when result is null but fallback is present', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[]' } }],
    usage: { cost: 0.00012 }
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const result = await extractClaims({
    job_id: 'job-2',
    agent: 1,
    result: null,
    telegram_text_fallback: 'только текстовый отчёт'
  });

  assert.deepEqual(result.claims, []);
  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.match(body.messages[0].content, /только текстовый отчёт/);
});

test('builds the request with the correct URL, model, headers, and usage:{include:true}', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }], usage: { cost: 0.00005 } });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'secret-key', fetchImpl });

  await extractClaims({ job_id: 'job-3', agent: 1, result: { summary: 'тест' } });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
  assert.deepEqual(body.usage, { include: true });
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }], usage: { cost: 0.00005 } });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await extractClaims({ job_id: 'job-helicone', agent: 1, result: { summary: 'тест' } });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('returns the real cost from usage.cost', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }], usage: { cost: 0.000029 } });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const result = await extractClaims({ job_id: 'job-cost', agent: 1, result: { summary: 'тест' } });

  assert.equal(result.costUsd, 0.000029);
});

test('defaults costUsd to 0 when the response has no usage.cost field', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const result = await extractClaims({ job_id: 'job-nocost', agent: 1, result: { summary: 'тест' } });

  assert.equal(result.costUsd, 0);
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
    }],
    usage: { cost: 0.00003 }
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const result = await extractClaims({ job_id: 'job-4', agent: 1, result: { summary: 'тест' } });

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].subject, 'Продукт X');
  assert.equal(result.claims[0].confidence_level, 'высокая');
});

test('treats a valid empty JSON array response as zero claims, not an error', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }], usage: { cost: 0.00001 } });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const result = await extractClaims({ job_id: 'job-5', agent: 1, result: { summary: 'ничего нет' } });

  assert.deepEqual(result.claims, []);
});

test('strips a ```json code fence around the response before parsing', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '```json\n[{"subject":"A","predicate":"B","object_value":"C","confidence_level":"средняя","confidence_explanation":"D"}]\n```' } }],
    usage: { cost: 0.00002 }
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const result = await extractClaims({ job_id: 'job-6', agent: 1, result: { summary: 'тест' } });

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].subject, 'A');
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
    }],
    usage: { cost: 0.00001 }
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(
    () => extractClaims({ job_id: 'job-9', agent: 1, result: { summary: 'тест' } }),
    /invalid confidence_level/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/llm/extractClaims.test.js`
Expected: FAIL — `extractClaims(...)` still returns a plain array, so `result.claims`/`result.costUsd` are `undefined`, and the request body has no `usage` field.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/llm/extractClaims.js`:

```javascript
const CONFIDENCE_LEVELS = ['высокая', 'средняя', 'низкая'];

export function createOpenRouterExtractor({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createOpenRouterExtractor: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function extractClaims(item) {
    const text = extractableText(item);
    if (!text) {
      return { claims: [], costUsd: 0 };
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
        messages: [{ role: 'user', content: buildPrompt(text) }],
        max_tokens: 800,
        usage: { include: true }
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

    return { claims: parseClaims(content), costUsd: data.usage?.cost ?? 0 };
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

Run: `node --test tests/llm/extractClaims.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/llm/extractClaims.js" "Information analysis agent/Code/tests/llm/extractClaims.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | extractClaims — реальная стоимость через usage:{include:true} | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). OpenRouter отдаёт
точную цену вызова в USD в поле usage.cost, если явно запросить её через
usage:{include:true} в теле запроса — проверено живым вызовом перед
реализацией. extractClaims теперь возвращает {claims, costUsd} вместо
голого массива claims (breaking change для потребителей — обновляются в
следующих задачах этого же слайса). costUsd по умолчанию 0, если поле
usage.cost в ответе отсутствует — не должно ронять извлечение фактов
из-за проблемы с учётом стоимости.
EOF
)"
```

---

### Task 4: Real cost in `judgeDuplicate.js`

**Files:**
- Modify: `Information analysis agent/Code/src/llm/judgeDuplicate.js`
- Modify: `Information analysis agent/Code/tests/llm/judgeDuplicate.test.js`

**Interfaces:**
- Produces: `judgeDuplicate(...) -> Promise<{ isDuplicate, reasoning, costUsd }>` (adds `costUsd`, existing fields unchanged). Task 9 (`dedup.js`) consumes the new `costUsd` field.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `Information analysis agent/Code/tests/llm/judgeDuplicate.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDuplicateJudge } from '../../src/llm/judgeDuplicate.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws when apiKey is missing', () => {
  assert.throws(() => createDuplicateJudge({}), /apiKey is required/);
});

test('builds the request with the correct URL, model, both texts in the prompt, and usage:{include:true}', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "разные"}' } }], usage: { cost: 0.00001 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'secret-key', fetchImpl });

  await judgeDuplicate({ kind: 'entity', new: 'Продукт X', candidate: 'Продукт Y' });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
  assert.deepEqual(body.usage, { include: true });
  assert.match(body.messages[0].content, /Продукт X/);
  assert.match(body.messages[0].content, /Продукт Y/);
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "ok"}' } }], usage: { cost: 0.00001 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses a positive verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": true, "reasoning": "то же самое"}' } }], usage: { cost: 0.00002 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'claim', new: 'A: B: C', candidate: 'A: B: C (иначе)' });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.reasoning, 'то же самое');
});

test('parses a negative verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "разное"}' } }], usage: { cost: 0.00002 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  assert.equal(result.isDuplicate, false);
});

test('returns the real cost from usage.cost', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "ok"}' } }], usage: { cost: 0.000015 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  assert.equal(result.costUsd, 0.000015);
});

test('defaults costUsd to 0 when the response has no usage.cost field', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "ok"}' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  assert.equal(result.costUsd, 0);
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '```json\n{"is_duplicate": true, "reasoning": "ok"}\n```' } }], usage: { cost: 0.00001 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'X' });

  assert.equal(result.isDuplicate, true);
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' }), /invalid JSON/);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' }), /HTTP 500/);
});

test('throws a descriptive error when is_duplicate is missing or not boolean', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"reasoning": "no verdict field"}' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' }), /missing boolean is_duplicate/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/llm/judgeDuplicate.test.js`
Expected: FAIL — no `usage` field in request bodies, `result.costUsd` is `undefined`.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/llm/judgeDuplicate.js`:

```javascript
export function createDuplicateJudge({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createDuplicateJudge: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function judgeDuplicate({ kind, new: newText, candidate }) {
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
        messages: [{ role: 'user', content: buildPrompt(kind, newText, candidate) }],
        max_tokens: 300,
        usage: { include: true }
      })
    });

    if (!response.ok) {
      throw new Error(`judgeDuplicate: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('judgeDuplicate: LLM returned no content');
    }

    return { ...parseVerdict(content), costUsd: data.usage?.cost ?? 0 };
  };
}

function buildPrompt(kind, newText, candidate) {
  const subject = kind === 'entity' ? 'сущности (entity)' : 'факта (claim)';
  return `Ты — судья, определяющий дубликаты ${subject}.

НОВОЕ: ${newText}
СУЩЕСТВУЮЩЕЕ: ${candidate}

Это одно и то же (с учётом разных формулировок/языка), или разные вещи?
Ответь строго JSON-объектом без пояснений вокруг:
{"is_duplicate": true|false, "reasoning": "краткое обоснование"}`;
}

function parseVerdict(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`judgeDuplicate: LLM returned invalid JSON: ${err.message}`);
  }
  if (typeof parsed.is_duplicate !== 'boolean') {
    throw new Error('judgeDuplicate: LLM response missing boolean is_duplicate');
  }
  return {
    isDuplicate: parsed.is_duplicate,
    reasoning: parsed.reasoning ?? null
  };
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/llm/judgeDuplicate.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/llm/judgeDuplicate.js" "Information analysis agent/Code/tests/llm/judgeDuplicate.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | judgeDuplicate — добавлен реальный costUsd | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7), тот же паттерн, что
и extractClaims: usage:{include:true} в теле запроса, usage.cost из ответа
OpenRouter пробрасывается как новое поле costUsd в возвращаемом объекте
{isDuplicate, reasoning, costUsd}. dedup.js (следующая задача этого слайса)
суммирует эти costUsd по всем вызовам judgeDuplicate/embedText на claim.
EOF
)"
```

---

### Task 5: Real cost in `judgeContradiction.js`

**Files:**
- Modify: `Information analysis agent/Code/src/llm/judgeContradiction.js`
- Modify: `Information analysis agent/Code/tests/llm/judgeContradiction.test.js`

**Interfaces:**
- Produces: `judgeContradiction(...) -> Promise<{ label, confidenceLevel, explanation, costUsd }>` (adds `costUsd`). Task 10 (`contradiction.js`) consumes the new `costUsd` field.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `Information analysis agent/Code/tests/llm/judgeContradiction.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContradictionJudge } from '../../src/llm/judgeContradiction.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws when apiKey is missing', () => {
  assert.throws(() => createContradictionJudge({}), /apiKey is required/);
});

test('builds the request with the correct URL, model, both claim texts in the prompt, and usage:{include:true}', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "средняя", "explanation": "ok"}' } }], usage: { cost: 0.00001 } });
  const judgeContradiction = createContradictionJudge({ apiKey: 'secret-key', fetchImpl });

  await judgeContradiction({ newClaimText: 'X: подняла: 5 млн', existingClaimText: 'подняла: 3 млн' });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
  assert.deepEqual(body.usage, { include: true });
  assert.match(body.messages[0].content, /5 млн/);
  assert.match(body.messages[0].content, /3 млн/);
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "средняя", "explanation": "ok"}' } }], usage: { cost: 0.00001 } });
  const judgeContradiction = createContradictionJudge({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses an agree verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "высокая", "explanation": "совместимо"}' } }], usage: { cost: 0.00002 } });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'agree');
  assert.equal(result.confidenceLevel, 'высокая');
  assert.equal(result.explanation, 'совместимо');
});

test('parses a contradict verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "contradict", "confidence_level": "средняя", "explanation": "разные суммы"}' } }], usage: { cost: 0.00002 } });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'contradict');
});

test('parses an unclear verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "unclear", "confidence_level": "низкая", "explanation": "не уверен"}' } }], usage: { cost: 0.00002 } });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'unclear');
});

test('returns the real cost from usage.cost', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "высокая", "explanation": "ok"}' } }], usage: { cost: 0.000018 } });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.costUsd, 0.000018);
});

test('defaults costUsd to 0 when the response has no usage.cost field', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "высокая", "explanation": "ok"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.costUsd, 0);
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '```json\n{"label": "agree", "confidence_level": "высокая", "explanation": "ok"}\n```' } }], usage: { cost: 0.00001 } });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'agree');
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /invalid JSON/);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /HTTP 500/);
});

test('throws a descriptive error when label is missing or invalid', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"confidence_level": "высокая", "explanation": "no label field"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /invalid label/);
});

test('throws a descriptive error when confidence_level is missing or invalid', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "unknown", "explanation": "x"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /invalid confidence_level/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/llm/judgeContradiction.test.js`
Expected: FAIL — no `usage` field in request bodies, `result.costUsd` is `undefined`.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/llm/judgeContradiction.js`:

```javascript
const LABELS = ['agree', 'contradict', 'unclear'];
const CONFIDENCE_LEVELS = ['высокая', 'средняя', 'низкая'];

export function createContradictionJudge({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createContradictionJudge: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function judgeContradiction({ newClaimText, existingClaimText }) {
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
        messages: [{ role: 'user', content: buildPrompt(newClaimText, existingClaimText) }],
        max_tokens: 300,
        usage: { include: true }
      })
    });

    if (!response.ok) {
      throw new Error(`judgeContradiction: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('judgeContradiction: LLM returned no content');
    }

    return { ...parseVerdict(content), costUsd: data.usage?.cost ?? 0 };
  };
}

function buildPrompt(newClaimText, existingClaimText) {
  return `Ты — судья, определяющий, противоречат ли друг другу два факта об одном и том же предмете.

НОВЫЙ ФАКТ: ${newClaimText}
СУЩЕСТВУЮЩИЙ ФАКТ: ${existingClaimText}

Согласуются ли эти факты (уточняют или дополняют друг друга), явно противоречат друг другу
(взаимоисключающие утверждения), или непонятно?
Ответь строго JSON-объектом без пояснений вокруг:
{"label": "agree"|"contradict"|"unclear", "confidence_level": "высокая"|"средняя"|"низкая", "explanation": "краткое обоснование"}`;
}

function parseVerdict(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`judgeContradiction: LLM returned invalid JSON: ${err.message}`);
  }
  if (!LABELS.includes(parsed.label)) {
    throw new Error(`judgeContradiction: invalid label "${parsed.label}"`);
  }
  if (!CONFIDENCE_LEVELS.includes(parsed.confidence_level)) {
    throw new Error(`judgeContradiction: invalid confidence_level "${parsed.confidence_level}"`);
  }
  return {
    label: parsed.label,
    confidenceLevel: parsed.confidence_level,
    explanation: parsed.explanation ?? null
  };
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/llm/judgeContradiction.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/llm/judgeContradiction.js" "Information analysis agent/Code/tests/llm/judgeContradiction.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | judgeContradiction — добавлен реальный costUsd | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7), тот же паттерн, что
и extractClaims/judgeDuplicate: usage:{include:true} в теле запроса,
usage.cost из ответа пробрасывается как costUsd в возвращаемом объекте
{label, confidenceLevel, explanation, costUsd}. contradiction.js (следующая
задача этого слайса) суммирует costUsd по всем 1-3 вызовам на claim
(self-consistency).
EOF
)"
```

---

### Task 6: Real (estimated) cost in `embedText.js`

**Files:**
- Modify: `Information analysis agent/Code/src/embeddings/embedText.js`
- Modify: `Information analysis agent/Code/tests/embeddings/embedText.test.js`

**Interfaces:**
- Produces: `embedText(text) -> Promise<{ embedding: number[], costUsd: number }>` (**breaking change** — was `Promise<number[]>`). `costUsd` is always an ESTIMATE (`Math.ceil(text.length / 4) / 1_000_000 * 0.15`) since Gemini's API reports no real cost/usage. Task 9 (`dedup.js`) consumes the new shape.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `Information analysis agent/Code/tests/embeddings/embedText.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiEmbedder } from '../../src/embeddings/embedText.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function embeddingOf(length, fill = 0.01) {
  return Array.from({ length }, () => fill);
}

test('throws when apiKey is missing', () => {
  assert.throws(() => createGeminiEmbedder({}), /apiKey is required/);
});

test('requests outputDimensionality: 768 and hits the embedContent endpoint', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await embedText('some text');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.match(url, /gemini-embedding-001:embedContent\?key=test-key$/);
  const body = JSON.parse(options.body);
  assert.equal(body.outputDimensionality, 768);
  assert.equal(body.content.parts[0].text, 'some text');
});

test('routes through Helicone gateway with target-URL header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await embedText('some text');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://gateway.helicone.ai/v1beta/models/gemini-embedding-001:embedContent?key=test-key');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
  assert.equal(options.headers['Helicone-Target-URL'], 'https://generativelanguage.googleapis.com');
});

test('returns the embedding array on success', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768, 0.5) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  const result = await embedText('some text');

  assert.equal(result.embedding.length, 768);
  assert.equal(result.embedding[0], 0.5);
});

test('estimates costUsd from text length ($0.15 per 1M tokens, ~4 chars/token)', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  const text = 'a'.repeat(4000); // ~1000 estimated tokens
  const result = await embedText(text);

  const expectedTokens = Math.ceil(text.length / 4);
  const expectedCostUsd = (expectedTokens / 1_000_000) * 0.15;
  assert.equal(result.costUsd, expectedCostUsd);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 429 });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => embedText('x'), /HTTP 429/);
});

test('throws a descriptive error when the response has no embedding values', async () => {
  const fetchImpl = fakeFetch({});
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => embedText('x'), /missing embedding values/);
});

test('throws a descriptive error when the dimension is not 768', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(3072) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => embedText('x'), /expected 768 dimensions, got 3072/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/embeddings/embedText.test.js`
Expected: FAIL — `embedText(...)` still returns a plain array, so `result.embedding`/`result.costUsd` are `undefined`.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/embeddings/embedText.js`:

```javascript
const GEMINI_EMBEDDING_COST_PER_MILLION_TOKENS = 0.15;

export function createGeminiEmbedder({ apiKey, model = 'gemini-embedding-001', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createGeminiEmbedder: apiKey is required');
  }

  const baseUrl = heliconeApiKey
    ? 'https://gateway.helicone.ai/v1beta/models'
    : 'https://generativelanguage.googleapis.com/v1beta/models';

  return async function embedText(text) {
    const response = await fetchImpl(
      `${baseUrl}/${model}:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(heliconeApiKey
            ? {
                'Helicone-Auth': `Bearer ${heliconeApiKey}`,
                'Helicone-Target-URL': 'https://generativelanguage.googleapis.com'
              }
            : {})
        },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: 768
        })
      }
    );

    if (!response.ok) {
      throw new Error(`embedText: Gemini HTTP ${response.status}`);
    }

    const data = await response.json();
    const values = data.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error('embedText: Gemini response missing embedding values');
    }
    if (values.length !== 768) {
      throw new Error(`embedText: expected 768 dimensions, got ${values.length}`);
    }

    return { embedding: values, costUsd: estimateCostUsd(text) };
  };
}

// Gemini embedContent сообщает только embedding, без токенов/стоимости —
// это ВСЕГДА оценка (не точная цена, в отличие от OpenRouter usage.cost),
// по официальному тарифу $0.15/1М входных токенов, ~4 символа на токен.
function estimateCostUsd(text) {
  const estimatedTokens = Math.ceil(text.length / 4);
  return (estimatedTokens / 1_000_000) * GEMINI_EMBEDDING_COST_PER_MILLION_TOKENS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/embeddings/embedText.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/embeddings/embedText.js" "Information analysis agent/Code/tests/embeddings/embedText.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | embedText — оценка costUsd (Gemini не сообщает реальную цену) | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). В отличие от
OpenRouter, Gemini embedContent вообще не возвращает usage/токены/цену —
проверено живым вызовом перед реализацией. costUsd здесь поэтому всегда
ОЦЕНКА: длина текста / 4 как грубая аппроксимация числа токенов, умноженная
на официальный тариф $0.15 за 1М входных токенов gemini-embedding-001.
embedText теперь возвращает {embedding, costUsd} вместо голого массива
embedding (breaking change для потребителей — dedup.js обновляется в
следующей задаче этого же слайса).
EOF
)"
```

---

### Task 7: `AnalysisState` — new cost/escalation channels

**Files:**
- Modify: `Information analysis agent/Code/src/graph/state.js`

**Interfaces:**
- Produces: `AnalysisState` gains `costUsdAnalysis` (numeric sum reducer, default `0`), `costUsdRetry`, `escalationsAuto`, `escalationsPendingUser`, `costCapReached` (all no-reducer/overwrite, single-writer from the `escalation` node built in Task 12). Task 8/9/10 write to `costUsdAnalysis`; Task 12 writes to the other four; Task 13 (`persistResults.js`) reads all five.

This task has no tests of its own (no exported behavior to unit-test in isolation) — it's exercised by every later task's tests. Skip the TDD red/green cycle; just make the change and verify the full suite still passes.

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
  costCapReached: Annotation()
});
```

- [ ] **Step 2: Run the full test suite to check nothing broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green (no test reads these new channels yet, so nothing should be affected).

- [ ] **Step 3: Commit**

```bash
git add "Information analysis agent/Code/src/graph/state.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | AnalysisState — новые каналы для стоимости и эскалаций | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). costUsdAnalysis —
числовой sum-reducer (несколько узлов/параллельных Send-веток вносят свою
долю: extractClaims, dedup, contradiction). costUsdRetry/escalationsAuto/
escalationsPendingUser/costCapReached — без reducer (пишутся один раз
узлом escalation, который выполняется последовательно, не через Send, до
диспетчера). Сам узел escalation и потребители этих каналов реализуются в
следующих задачах этого же слайса.
EOF
)"
```

---

### Task 8: `extractClaims` graph node — consume new shape, contribute cost

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/extractClaims.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/extractClaims.test.js`

**Interfaces:**
- Consumes: `extractClaims(item) -> Promise<{ claims: RawClaim[], costUsd: number }>` (Task 3).
- Produces: `createExtractClaimsNode(extractClaims) -> extractClaimsNode({item}) -> Promise<{claims, costUsdAnalysis}|{errors}>` — unchanged external shape except the new `costUsdAnalysis` field on the success path (summed by the `costUsdAnalysis` reducer across all parallel `Send` branches).

- [ ] **Step 1: Write the failing tests**

`Information analysis agent/Code/tests/graph/nodes/extractClaims.test.js` already exists (from an earlier slice) with 3 tests using the OLD `extractClaims(item) -> Promise<RawClaim[]>` shape. Replace its full contents:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractClaimsNode } from '../../../src/graph/nodes/extractClaims.js';

test('attaches source metadata to each claim returned by the injected extractClaims, and forwards costUsd as costUsdAnalysis', async () => {
  const fakeExtract = async () => ({
    claims: [
      { subject: 'A', predicate: 'B', object_value: 'C', confidence_level: 'высокая', confidence_explanation: 'D' },
      { subject: 'E', predicate: 'F', object_value: 'G', confidence_level: 'средняя', confidence_explanation: 'H' }
    ],
    costUsd: 0.00004
  });
  const node = createExtractClaimsNode(fakeExtract);
  const item = { job_id: 'job-1', agent: 1, content_type: 'search' };

  const result = await node({ item });

  assert.equal(result.claims.length, 2);
  assert.deepEqual(result.claims[0].source, { agent: 1, jobId: 'job-1', refType: 'search' });
  assert.deepEqual(result.claims[1].source, { agent: 1, jobId: 'job-1', refType: 'search' });
  assert.equal(result.claims[0].subject, 'A');
  assert.equal(result.costUsdAnalysis, 0.00004);
});

test('returns an empty claims array and costUsdAnalysis 0 when the injected extractClaims returns no claims', async () => {
  const fakeExtract = async () => ({ claims: [], costUsd: 0 });
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-2', agent: 2, content_type: 'video' } });

  assert.deepEqual(result, { claims: [], costUsdAnalysis: 0 });
});

test('isolates a failure: returns errors, not claims, and does not throw', async () => {
  const fakeExtract = async () => { throw new Error('LLM timeout'); };
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-3', agent: 1, content_type: 'search' } });

  assert.deepEqual(result.errors, ['item job-3: LLM timeout']);
  assert.equal(result.claims, undefined);
  assert.equal(result.costUsdAnalysis, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/extractClaims.test.js`
Expected: FAIL — `extractClaimsNode` still calls `extractClaims(item)` expecting a plain array back, so `.map` on a `{claims, costUsd}` object throws (or `result.costUsdAnalysis` is `undefined`).

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/graph/nodes/extractClaims.js`:

```javascript
export function createExtractClaimsNode(extractClaims) {
  return async function extractClaimsNode({ item }) {
    try {
      const { claims: rawClaims, costUsd } = await extractClaims(item);
      const claims = rawClaims.map((claim) => ({
        ...claim,
        source: { agent: item.agent, jobId: item.job_id, refType: item.content_type }
      }));
      return { claims, costUsdAnalysis: costUsd };
    } catch (err) {
      return { errors: [`item ${item.job_id}: ${err.message}`] };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/extractClaims.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/extractClaims.js" "Information analysis agent/Code/tests/graph/nodes/extractClaims.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Узел extractClaims — принимает {claims, costUsd}, вносит costUsdAnalysis | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). extractClaims.js
(Task 3 этого же слайса) теперь возвращает {claims, costUsd} вместо
голого массива — узел распаковывает это и добавляет costUsd в state как
costUsdAnalysis, суммируемый sum-reducer'ом по всем параллельным
Send-веткам извлечения. Ошибка извлечения по-прежнему не вносит вклад в
стоимость (costUsdAnalysis остаётся undefined для этой ветки, reducer
просто не получает вклада от неё).
EOF
)"
```

---

### Task 9: `dedup.js` — consume new `embedText`/`judgeDuplicate` shapes, sum cost

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/dedup.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/dedup.test.js`

**Interfaces:**
- Consumes: `embedText(text) -> Promise<{embedding, costUsd}>` (Task 6), `judgeDuplicate(...) -> Promise<{isDuplicate, reasoning, costUsd}>` (Task 4).
- Produces: `createDedupNode({db, embedText, judgeDuplicate}) -> dedupNode(state) -> Promise<{claims: Overwrite, errors: string[], costUsdAnalysis: number}>` — the node now also returns a `costUsdAnalysis` number (sum of every `embedText`/`judgeDuplicate` call made while resolving every claim in this node invocation).

- [ ] **Step 1: Write the failing tests**

In `Information analysis agent/Code/tests/graph/nodes/dedup.test.js`, every fake `embedText`/`judgeDuplicate` must now return the wrapped shape. Replace the full file contents:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDedupNode } from '../../../src/graph/nodes/dedup.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function claim(overrides = {}) {
  return {
    subject: 'Продукт X',
    predicate: 'имеет цену',
    object_value: '999 руб',
    confidence_level: 'высокая',
    confidence_explanation: 'ok',
    source: { agent: 1, jobId: 'job-1', refType: 'search' },
    ...overrides
  };
}

test('no entity candidate: creates a new entity path with embeddings and a batchEntityKey', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async (text) => ({ embedding: text.includes('Продукт X') ? [0.1, 0.2] : [0.3, 0.4], costUsd: 0.00001 });
  const judgeDuplicate = async () => { throw new Error('should not be called when there is no candidate'); };
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value.length, 1);
  const resolved = result.claims.value[0];
  assert.equal(resolved.isDuplicate, false);
  assert.equal(resolved.subjectEntityId, null);
  assert.equal(resolved.batchEntityKey, 'продукт x');
  assert.ok(Array.isArray(resolved.subjectEmbedding));
  assert.ok(Array.isArray(resolved.claimEmbedding));
});

test('entity candidate confirmed by judge: reuses existing entity, no new-entity fields set', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0.00001 });
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true, reasoning: 'same', costUsd: 0.00002 } : { isDuplicate: false, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.subjectEntityId, 'ent-1');
  assert.equal(resolved.subjectEmbedding, null);
  assert.equal(resolved.isDuplicate, false);
});

test('entity candidate rejected by judge: falls back to new-entity path', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Something else', similarity: 0.86 }], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0.00001 });
  const judgeDuplicate = async () => ({ isDuplicate: false, reasoning: 'different', costUsd: 0.00002 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.subjectEntityId, null);
  assert.ok(Array.isArray(resolved.subjectEmbedding));
});

test('claim candidate confirmed by judge on a resolved entity: marks as duplicate with bumped confidence', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-1', predicate: 'имеет цену', object_value: '999 руб',
        confidence_level: 'низкая', confidence_explanation: 'из одного источника', similarity: 0.9
      }],
      error: null
    })
  });
  const embedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0.00001 });
  const judgeDuplicate = async () => ({ isDuplicate: true, reasoning: 'same fact', costUsd: 0.00002 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim({ source: { agent: 2, jobId: 'job-9', refType: 'video' } })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.isDuplicate, true);
  assert.equal(resolved.duplicateOfClaimId, 'claim-1');
  assert.equal(resolved.bumpedConfidenceLevel, 'средняя');
  assert.match(resolved.bumpedConfidenceExplanation, /из одного источника/);
  assert.match(resolved.bumpedConfidenceExplanation, /agent 2, job job-9/);
});

test('confidence bump caps at высокая and never decreases', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{ id: 'claim-1', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e', similarity: 0.9 }],
      error: null
    })
  });
  const embedText = async () => ({ embedding: [0.1], costUsd: 0 });
  const judgeDuplicate = async () => ({ isDuplicate: true, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].bumpedConfidenceLevel, 'высокая');
});

test('a new (unresolved) entity skips the claim-duplicate check entirely (no existing claims possible)', async () => {
  let matchClaimsCalled = false;
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => { matchClaimsCalled = true; return { data: [], error: null }; }
  });
  const embedText = async () => ({ embedding: [0.1], costUsd: 0 });
  const judgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  await node({ claims: [claim()], errors: [] });

  assert.equal(matchClaimsCalled, false);
});

test('a failure resolving one claim does not crash the node: falls back to new-entity path and records an error', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => { throw new Error('Gemini timeout'); };
  const judgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim({ subject: 'job-x-subject' })], errors: [] });

  assert.equal(result.claims.value.length, 1);
  assert.equal(result.claims.value[0].isDuplicate, false);
  assert.equal(result.claims.value[0].subjectEntityId, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /job-x-subject/);
});

test('claims channel is wrapped in Overwrite, not a plain array (must replace, not concat)', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => ({ embedding: [0.1], costUsd: 0 });
  const judgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.constructor.name, 'Overwrite');
});

test('claim candidate exists but judge rejects duplicate: contradictionCandidate carries the rejected candidate through', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-1', predicate: 'имеет цену', object_value: '899 руб',
        confidence_level: 'высокая', confidence_explanation: 'другой источник', similarity: 0.87
      }],
      error: null
    })
  });
  const embedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0 });
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true, costUsd: 0 } : { isDuplicate: false, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.isDuplicate, false);
  assert.ok(resolved.contradictionCandidate);
  assert.equal(resolved.contradictionCandidate.id, 'claim-1');
  assert.equal(resolved.contradictionCandidate.confidence_level, 'высокая');
});

test('no claim candidate at all: contradictionCandidate is null', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0 });
  const judgeDuplicate = async () => ({ isDuplicate: true, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].contradictionCandidate, null);
});

test('new (unresolved) entity: contradictionCandidate is null (no existing claims possible)', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => ({ embedding: [0.1], costUsd: 0 });
  const judgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].contradictionCandidate, null);
});

test('sums costUsd from every embedText/judgeDuplicate call into costUsdAnalysis', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  // Called twice: subject embedding + claim embedding (entity resolved, no claim candidate → no claim-duplicate judge call)
  const embedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0.01 });
  // Called once: entity judge
  const judgeDuplicate = async () => ({ isDuplicate: true, costUsd: 0.02 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.costUsdAnalysis, 0.01 + 0.01 + 0.02);
});

test('a failed embedText call contributes 0 cost for that claim (does not crash cost accounting)', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => { throw new Error('Gemini timeout'); };
  const judgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.costUsdAnalysis, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/dedup.test.js`
Expected: FAIL — `dedup.js` still expects `embedText`/`judgeDuplicate` to return plain values, so calling `.length`/property access on the wrapped objects breaks entity/claim resolution, and `result.costUsdAnalysis` is `undefined`.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/graph/nodes/dedup.js`:

```javascript
// src/graph/nodes/dedup.js
import { Overwrite } from '@langchain/langgraph';

const SIMILARITY_THRESHOLD = 0.85;
const CONFIDENCE_ORDER = ['низкая', 'средняя', 'высокая'];

export function createDedupNode({ db, embedText, judgeDuplicate }) {
  return async function dedupNode(state) {
    const resolvedClaims = [];
    const newErrors = [];
    let costUsdAnalysis = 0;

    for (const claim of state.claims) {
      try {
        const { resolvedClaim, costUsd } = await resolveClaim({ db, embedText, judgeDuplicate, claim });
        resolvedClaims.push(resolvedClaim);
        costUsdAnalysis += costUsd;
      } catch (err) {
        newErrors.push(`dedup failed for claim subject "${claim.subject}": ${err.message}`);
        resolvedClaims.push({
          ...claim,
          isDuplicate: false,
          subjectEntityId: null,
          subjectEmbedding: null,
          claimEmbedding: null,
          batchEntityKey: normalizeKey(claim.subject),
          contradictionCandidate: null
        });
      }
    }

    return {
      claims: new Overwrite(resolvedClaims),
      errors: newErrors,
      costUsdAnalysis
    };
  };
}

async function resolveClaim({ db, embedText, judgeDuplicate, claim }) {
  let costUsd = 0;

  const subjectEmbedded = await embedText(claim.subject);
  costUsd += subjectEmbedded.costUsd;
  const { entityId: subjectEntityId, costUsd: entityCost } = await resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding: subjectEmbedded.embedding });
  costUsd += entityCost;

  if (subjectEntityId) {
    const claimText = buildClaimText(claim);
    const claimEmbedded = await embedText(claimText);
    costUsd += claimEmbedded.costUsd;
    const { candidate, isDuplicate, costUsd: duplicateCost } = await resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding: claimEmbedded.embedding, subjectEntityId });
    costUsd += duplicateCost;

    if (isDuplicate) {
      return {
        costUsd,
        resolvedClaim: {
          ...claim,
          isDuplicate: true,
          duplicateOfClaimId: candidate.id,
          bumpedConfidenceLevel: bumpConfidence(candidate.confidence_level),
          bumpedConfidenceExplanation: buildBumpedExplanation(candidate.confidence_explanation, claim),
          subjectEntityId,
          contradictionCandidate: null
        }
      };
    }

    return {
      costUsd,
      resolvedClaim: {
        ...claim,
        isDuplicate: false,
        subjectEntityId,
        subjectEmbedding: null,
        claimEmbedding: claimEmbedded.embedding,
        batchEntityKey: null,
        contradictionCandidate: candidate
      }
    };
  }

  // Новая (ещё не существующая) сущность не может иметь существующих claims —
  // проверка на дубль claim'а не нужна, экономим вызов.
  const claimEmbedded = await embedText(buildClaimText(claim));
  costUsd += claimEmbedded.costUsd;
  return {
    costUsd,
    resolvedClaim: {
      ...claim,
      isDuplicate: false,
      subjectEntityId: null,
      subjectEmbedding: subjectEmbedded.embedding,
      claimEmbedding: claimEmbedded.embedding,
      batchEntityKey: normalizeKey(claim.subject),
      contradictionCandidate: null
    }
  };
}

async function resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding }) {
  const { data: candidates, error } = await db.rpc('match_entities', {
    query_embedding: subjectEmbedding,
    match_threshold: SIMILARITY_THRESHOLD
  });

  if (error || !candidates || candidates.length === 0) {
    return { entityId: null, costUsd: 0 };
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({ kind: 'entity', new: claim.subject, candidate: top.name });
  return { entityId: verdict.isDuplicate ? top.id : null, costUsd: verdict.costUsd };
}

async function resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding, subjectEntityId }) {
  const { data: candidates, error } = await db.rpc('match_claims', {
    query_embedding: claimEmbedding,
    match_threshold: SIMILARITY_THRESHOLD,
    for_subject_entity_id: subjectEntityId
  });

  if (error || !candidates || candidates.length === 0) {
    return { candidate: null, isDuplicate: false, costUsd: 0 };
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({
    kind: 'claim',
    new: buildClaimText(claim),
    candidate: `${top.predicate}: ${top.object_value ?? ''}`
  });
  return { candidate: top, isDuplicate: verdict.isDuplicate, costUsd: verdict.costUsd };
}

function buildClaimText(claim) {
  return `${claim.subject}: ${claim.predicate}: ${claim.object_value ?? ''}`;
}

function normalizeKey(subject) {
  return subject.trim().toLowerCase();
}

function bumpConfidence(level) {
  const index = CONFIDENCE_ORDER.indexOf(level);
  if (index === -1 || index === CONFIDENCE_ORDER.length - 1) {
    return level;
  }
  return CONFIDENCE_ORDER[index + 1];
}

function buildBumpedExplanation(oldExplanation, claim) {
  const suffix = `Подтверждено дополнительным источником (agent ${claim.source.agent}, job ${claim.source.jobId}).`;
  return `${oldExplanation ?? ''} ${suffix}`.trim();
}
```

Note: `resolveClaim`'s outer `try` in `createDedupNode` now wraps a call that returns `{resolvedClaim, costUsd}` — if `embedText`/`judgeDuplicate`/the RPC throws partway through, the whole `resolveClaim` call rejects (same as before this task), and the catch block's fallback contributes `0` to `costUsdAnalysis` (it never adds to `costUsdAnalysis` at all in that branch, matching the "a failed embedText call contributes 0 cost" test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/dedup.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/dedup.js" "Information analysis agent/Code/tests/graph/nodes/dedup.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | dedup — суммирует costUsd от embedText/judgeDuplicate | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). embedText.js и
judgeDuplicate.js (Tasks 6/4 этого же слайса) теперь возвращают costUsd
вместе с основным результатом — dedup.js суммирует его по всем вызовам,
сделанным при резолве одного claim (subject-эмбеддинг, entity-judge,
claim-эмбеддинг, claim-judge — до 4 вызовов), и возвращает суммарный
costUsdAnalysis за весь узел одним числом. Ошибка резолва claim'а
по-прежнему не роняет весь батч (существующее поведение не изменилось),
просто не вносит вклад в стоимость для этого claim'а.
EOF
)"
```

---

### Task 10: `contradiction.js` — consume new `judgeContradiction` shape, sum cost

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/contradiction.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/contradiction.test.js`

**Interfaces:**
- Consumes: `judgeContradiction(...) -> Promise<{label, confidenceLevel, explanation, costUsd}>` (Task 5).
- Produces: `createContradictionNode({judgeContradiction}) -> contradictionNode(state) -> Promise<{claims: Overwrite, errors: string[], costUsdAnalysis: number}>` — adds `costUsdAnalysis` (sum of every `judgeContradiction` call across all claims processed by this node invocation, including all 1-3 self-consistency samples).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `Information analysis agent/Code/tests/graph/nodes/contradiction.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContradictionNode } from '../../../src/graph/nodes/contradiction.js';

function claim(overrides = {}) {
  return {
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    confidence_level: 'высокая',
    confidence_explanation: 'ok',
    source: { agent: 1, jobId: 'job-1', refType: 'search' },
    isDuplicate: false,
    subjectEntityId: 'ent-1',
    contradictionCandidate: null,
    ...overrides
  };
}

function candidate(overrides = {}) {
  return {
    id: 'claim-existing',
    predicate: 'подняла раунд',
    object_value: '3 млн',
    confidence_level: 'средняя',
    confidence_explanation: 'ok',
    ...overrides
  };
}

test('claim with no contradictionCandidate passes through unchanged, no judge call', async () => {
  const judgeContradiction = async () => { throw new Error('should not be called'); };
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: null })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, undefined);
  assert.equal(result.costUsdAnalysis, 0);
});

test('low/medium-confidence candidate: exactly one judge call', async () => {
  let callCount = 0;
  const judgeContradiction = async () => { callCount += 1; return { label: 'contradict', confidenceLevel: 'средняя', explanation: 'конфликт', costUsd: 0.01 }; };
  const node = createContradictionNode({ judgeContradiction });

  await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  assert.equal(callCount, 1);
});

test('high-confidence candidate: exactly three judge calls (self-consistency)', async () => {
  let callCount = 0;
  const judgeContradiction = async () => { callCount += 1; return { label: 'contradict', confidenceLevel: 'высокая', explanation: 'конфликт', costUsd: 0.01 }; };
  const node = createContradictionNode({ judgeContradiction });

  await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(callCount, 3);
});

test('agree verdict: does not mark the claim as a contradiction', async () => {
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'совместимо', costUsd: 0.01 });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, false);
});

test('contradict verdict: marks the claim with contradiction fields', async () => {
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы', costUsd: 0.01 });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя', id: 'claim-42' }) })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.hasContradiction, true);
  assert.equal(resolved.contradictsClaimId, 'claim-42');
  assert.equal(resolved.contradictionRawLabel, 'contradict');
  assert.equal(resolved.contradictionConfidenceLevel, 'высокая');
  assert.equal(resolved.contradictionExplanation, 'разные суммы');
});

test('unclear verdict is treated as a contradiction (raw label preserved as "unclear")', async () => {
  const judgeContradiction = async () => ({ label: 'unclear', confidenceLevel: 'низкая', explanation: 'не уверен', costUsd: 0.01 });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.hasContradiction, true);
  assert.equal(resolved.contradictionRawLabel, 'unclear');
});

test('self-consistency majority vote: 2 contradict + 1 agree results in contradict', async () => {
  let call = 0;
  const responses = [
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'a', costUsd: 0.01 },
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'b', costUsd: 0.01 },
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'c', costUsd: 0.01 }
  ];
  const judgeContradiction = async () => responses[call++];
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, true);
  assert.equal(result.claims.value[0].contradictionRawLabel, 'contradict');
});

test('self-consistency: confidence/explanation come from a verdict matching the winning label, not just the first sample', async () => {
  let call = 0;
  const responses = [
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'суммы дополняют друг друга', costUsd: 0.01 },
    { label: 'contradict', confidenceLevel: 'средняя', explanation: 'разные суммы, конфликт', costUsd: 0.01 },
    { label: 'contradict', confidenceLevel: 'средняя', explanation: 'явное противоречие', costUsd: 0.01 }
  ];
  const judgeContradiction = async () => responses[call++];
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.contradictionRawLabel, 'contradict');
  assert.equal(resolved.contradictionConfidenceLevel, 'средняя');
  assert.match(resolved.contradictionExplanation, /конфликт|противоречие/);
});

test('self-consistency three-way tie (agree/contradict/unclear) resolves to unclear, treated as a contradiction', async () => {
  let call = 0;
  const responses = [
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'a', costUsd: 0.01 },
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'b', costUsd: 0.01 },
    { label: 'unclear', confidenceLevel: 'высокая', explanation: 'c', costUsd: 0.01 }
  ];
  const judgeContradiction = async () => responses[call++];
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, true);
  assert.equal(result.claims.value[0].contradictionRawLabel, 'unclear');
});

test('a judge failure for one claim does not crash the node: falls back to no-contradiction and records an error', async () => {
  const judgeContradiction = async () => { throw new Error('LLM timeout'); };
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ subject: 'job-y-subject', contradictionCandidate: candidate() })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /job-y-subject/);
});

test('claims channel is wrapped in Overwrite, not a plain array', async () => {
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok', costUsd: 0 });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.constructor.name, 'Overwrite');
});

test('sums costUsd across a single-call claim and a 3-sample self-consistency claim', async () => {
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok', costUsd: 0.01 });
  const node = createContradictionNode({ judgeContradiction });

  const claims = [
    claim({ subject: 'A', contradictionCandidate: candidate({ confidence_level: 'средняя' }) }), // 1 call
    claim({ subject: 'B', contradictionCandidate: candidate({ confidence_level: 'высокая' }) })  // 3 calls
  ];
  const result = await node({ claims, errors: [] });

  assert.equal(result.costUsdAnalysis, 0.01 * 4);
});

test('a judge failure contributes 0 cost for that claim', async () => {
  const judgeContradiction = async () => { throw new Error('LLM timeout'); };
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate() })], errors: [] });

  assert.equal(result.costUsdAnalysis, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/contradiction.test.js`
Expected: FAIL — `contradiction.js` doesn't track/return `costUsdAnalysis` yet.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `Information analysis agent/Code/src/graph/nodes/contradiction.js`:

```javascript
// src/graph/nodes/contradiction.js
import { Overwrite } from '@langchain/langgraph';

const HIGH_CONFIDENCE = 'высокая';
const SELF_CONSISTENCY_SAMPLES = 3;

export function createContradictionNode({ judgeContradiction }) {
  return async function contradictionNode(state) {
    const resolvedClaims = [];
    const newErrors = [];
    let costUsdAnalysis = 0;

    for (const claim of state.claims) {
      if (!claim.contradictionCandidate) {
        resolvedClaims.push(claim);
        continue;
      }

      try {
        const { resolvedClaim, costUsd } = await resolveContradiction({ judgeContradiction, claim });
        resolvedClaims.push(resolvedClaim);
        costUsdAnalysis += costUsd;
      } catch (err) {
        newErrors.push(`contradiction check failed for claim subject "${claim.subject}": ${err.message}`);
        resolvedClaims.push({ ...claim, hasContradiction: false });
      }
    }

    return {
      claims: new Overwrite(resolvedClaims),
      errors: newErrors,
      costUsdAnalysis
    };
  };
}

async function resolveContradiction({ judgeContradiction, claim }) {
  const candidate = claim.contradictionCandidate;
  const newClaimText = buildClaimText(claim);
  const existingClaimText = `${candidate.predicate}: ${candidate.object_value ?? ''}`;

  const sampleCount = candidate.confidence_level === HIGH_CONFIDENCE ? SELF_CONSISTENCY_SAMPLES : 1;
  const verdicts = [];
  let costUsd = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const verdict = await judgeContradiction({ newClaimText, existingClaimText });
    verdicts.push(verdict);
    costUsd += verdict.costUsd;
  }

  const rawLabel = majorityLabel(verdicts.map((v) => v.label));

  if (rawLabel === 'agree') {
    return { resolvedClaim: { ...claim, hasContradiction: false }, costUsd };
  }

  const primary = verdicts.find((v) => v.label === rawLabel) ?? verdicts[0];
  return {
    costUsd,
    resolvedClaim: {
      ...claim,
      hasContradiction: true,
      contradictsClaimId: candidate.id,
      contradictionRawLabel: rawLabel,
      contradictionConfidenceLevel: primary.confidenceLevel,
      contradictionExplanation: primary.explanation
    }
  };
}

function majorityLabel(labels) {
  const counts = {};
  for (const label of labels) {
    counts[label] = (counts[label] ?? 0) + 1;
  }

  const isThreeWayTie = labels.length === 3 && Object.keys(counts).length === 3;
  if (isThreeWayTie) {
    return 'unclear';
  }

  let winner = labels[0];
  let winnerCount = 0;
  for (const [label, count] of Object.entries(counts)) {
    if (count > winnerCount) {
      winner = label;
      winnerCount = count;
    }
  }
  return winner;
}

function buildClaimText(claim) {
  return `${claim.subject}: ${claim.predicate}: ${claim.object_value ?? ''}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/contradiction.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/contradiction.js" "Information analysis agent/Code/tests/graph/nodes/contradiction.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | contradiction — суммирует costUsd от judgeContradiction | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). judgeContradiction.js
(Task 5 этого же слайса) теперь возвращает costUsd вместе с вердиктом —
contradiction.js суммирует его по всем 1-3 вызовам на claim (self-consistency
для устоявшихся фактов делает 3 вызова вместо одного), возвращает суммарный
costUsdAnalysis за весь узел одним числом. Ошибка судьи по-прежнему не
роняет батч, просто не вносит вклад в стоимость для этого claim'а.
EOF
)"
```

---

### Task 11: `deepParsingClient.js` — new MCP client for Agent 2 retries

**Files:**
- Create: `Information analysis agent/Code/src/mcp-clients/deepParsingClient.js`
- Create: `Information analysis agent/Code/tests/mcp-clients/deepParsingClient.test.js`
- Modify: `Information analysis agent/Code/package.json` (new dependency)

**Interfaces:**
- Produces: `createDeepParsingClient({baseUrl, ClientImpl, TransportImpl}) -> retryParse({contentRef, contentType}) -> Promise<{result: object, confidence: {level, explanation}, meta: {cost_usd, ...}}>`. Task 12 (`escalation.js`) consumes `retryParse`.

- [ ] **Step 1: Add the dependency**

In `Information analysis agent/Code/package.json`, add to `"dependencies"` (alphabetical, matching existing style — insert after `@langchain/langgraph`, before `@supabase/supabase-js` if present, or in correct alphabetical position among existing deps):

```json
    "@modelcontextprotocol/sdk": "^1.12.1",
```

Run: `cd "Information analysis agent/Code" && npm install`

- [ ] **Step 2: Write the failing tests**

Create `Information analysis agent/Code/tests/mcp-clients/deepParsingClient.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepParsingClient } from '../../src/mcp-clients/deepParsingClient.js';

function fakeClientClasses(responsePayload, { callToolThrows = null } = {}) {
  const calls = { connect: [], callTool: [], close: 0 };

  class FakeTransport {
    constructor(url) {
      calls.transportUrl = url;
    }
  }

  class FakeClient {
    constructor(info, options) {
      calls.clientInfo = info;
      calls.clientOptions = options;
    }
    async connect(transport) {
      calls.connect.push(transport);
    }
    async callTool(args) {
      calls.callTool.push(args);
      if (callToolThrows) throw callToolThrows;
      return { content: [{ type: 'text', text: JSON.stringify(responsePayload) }] };
    }
    async close() {
      calls.close += 1;
    }
  }

  return { ClientImpl: FakeClient, TransportImpl: FakeTransport, calls };
}

test('throws when baseUrl is missing', () => {
  assert.throws(() => createDeepParsingClient({}), /baseUrl is required/);
});

test('connects to baseUrl + /mcp and calls deepparsing_parse with mode: deep', async () => {
  const { ClientImpl, TransportImpl, calls } = fakeClientClasses({
    result: { transcript: 'улучшенный разбор' },
    confidence: { level: 'высокая', explanation: 'deep mode' },
    meta: { cost_usd: 0.08 }
  });
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  await retryParse({ contentRef: 'https://example.com/video.mp4', contentType: 'video' });

  assert.equal(calls.transportUrl.toString(), 'http://deep-parsing-agent:7301/mcp');
  assert.equal(calls.callTool.length, 1);
  assert.deepEqual(calls.callTool[0], {
    name: 'deepparsing_parse',
    arguments: { content_ref: 'https://example.com/video.mp4', content_type: 'video', mode: 'deep' }
  });
});

test('returns the parsed JSON result on success, and closes the client', async () => {
  const { ClientImpl, TransportImpl, calls } = fakeClientClasses({
    result: { transcript: 'улучшенный разбор' },
    confidence: { level: 'высокая', explanation: 'deep mode' },
    meta: { cost_usd: 0.08 }
  });
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  const result = await retryParse({ contentRef: 'https://example.com/video.mp4', contentType: 'video' });

  assert.deepEqual(result.result, { transcript: 'улучшенный разбор' });
  assert.equal(result.confidence.level, 'высокая');
  assert.equal(result.meta.cost_usd, 0.08);
  assert.equal(calls.close, 1);
});

test('throws a descriptive error when the tool call rejects', async () => {
  const { ClientImpl, TransportImpl } = fakeClientClasses(null, { callToolThrows: new Error('connection refused') });
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  await assert.rejects(
    () => retryParse({ contentRef: 'x', contentType: 'video' }),
    /connection refused/
  );
});

test('throws a descriptive error when the response has no text content', async () => {
  class FakeTransport { constructor() {} }
  class FakeClient {
    async connect() {}
    async callTool() { return { content: [] }; }
    async close() {}
  }
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl: FakeClient, TransportImpl: FakeTransport });

  await assert.rejects(
    () => retryParse({ contentRef: 'x', contentType: 'video' }),
    /empty response/
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/mcp-clients/deepParsingClient.test.js`
Expected: FAIL — module `src/mcp-clients/deepParsingClient.js` does not exist.

- [ ] **Step 4: Write the implementation**

Create `Information analysis agent/Code/src/mcp-clients/deepParsingClient.js`:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Клиент к MCP-серверу Агента 2 (Deep Parsing Agent) — используется узлом
// escalation для автоповтора низкоуверенных item'ов через deepparsing_parse
// с mode: 'deep'. ClientImpl/TransportImpl инжектируются для тестов (по
// умолчанию — реальные классы из @modelcontextprotocol/sdk, той же версии,
// что уже используется Агентом 1/2).
export function createDeepParsingClient({ baseUrl, ClientImpl = Client, TransportImpl = StreamableHTTPClientTransport } = {}) {
  if (!baseUrl) {
    throw new Error('createDeepParsingClient: baseUrl is required');
  }

  return async function retryParse({ contentRef, contentType }) {
    const transport = new TransportImpl(new URL(`${baseUrl}/mcp`));
    const client = new ClientImpl(
      { name: 'information-analysis-agent', version: '0.5.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
    try {
      const response = await client.callTool({
        name: 'deepparsing_parse',
        arguments: { content_ref: contentRef, content_type: contentType, mode: 'deep' }
      });

      const text = response.content?.[0]?.text;
      if (!text) {
        throw new Error('deepParsingClient: empty response from deepparsing_parse');
      }
      return JSON.parse(text);
    } finally {
      await client.close();
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/mcp-clients/deepParsingClient.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 7: Commit**

```bash
git add "Information analysis agent/Code/package.json" "Information analysis agent/Code/package-lock.json" "Information analysis agent/Code/src/mcp-clients/deepParsingClient.js" "Information analysis agent/Code/tests/mcp-clients/deepParsingClient.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | deepParsingClient — MCP-клиент к Агенту 2 для повторного разбора | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). Новая зависимость
@modelcontextprotocol/sdk (^1.12.1, та же версия, что уже использует Агент
1/2) — официальный клиент MCP Streamable HTTP, а не ручной fetch, корректно
работает с транспортом, который Агент 2 уже поднимает в проде на /mcp.
retryParse всегда вызывает deepparsing_parse с mode: 'deep' — принципиально
более тщательный разбор, а не буквальное повторение того же запроса.
ClientImpl/TransportImpl инжектируются, тесты не делают реальных сетевых
вызовов. Используется узлом escalation (следующая задача этого слайса).
EOF
)"
```

---

### Task 12: `escalation.js` — new graph node (first in the graph)

**Files:**
- Create: `Information analysis agent/Code/src/graph/nodes/escalation.js`
- Create: `Information analysis agent/Code/tests/graph/nodes/escalation.test.js`

**Interfaces:**
- Consumes: `retryParse({contentRef, contentType}) -> Promise<{result, confidence, meta: {cost_usd}}>` (Task 11). `db.from('pending_user_decisions').insert(...)`.
- Produces: `createEscalationNode({db, retryParse}) -> escalationNode(state) -> Promise<{items: object[], escalationsAuto: number, escalationsPendingUser: number, costUsdRetry: number, costCapReached: boolean}>`. Task 14 (`graph/index.js`) wires this as the first node, before the dispatcher.

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/graph/nodes/escalation.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEscalationNode } from '../../../src/graph/nodes/escalation.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function item(overrides = {}) {
  return {
    job_id: 'job-1',
    agent: 2,
    content_type: 'video',
    content_ref: 'https://example.com/video.mp4',
    result: { transcript: 'слабый разбор' },
    confidence: { level: 'низкая', explanation: 'автосубтитры' },
    ...overrides
  };
}

test('an item with non-low confidence passes through unchanged, no retry attempted', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: null }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ confidence: { level: 'высокая', explanation: 'ok' } })] });

  assert.deepEqual(result.items[0].confidence, { level: 'высокая', explanation: 'ok' });
  assert.equal(result.escalationsAuto, 0);
  assert.equal(result.escalationsPendingUser, 0);
});

test('a low-confidence item from Agent 1 (no content_ref) escalates without attempting retry', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ agent: 1, content_ref: null })] });

  assert.equal(result.escalationsPendingUser, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].job_id, 'job-1');
  assert.match(inserted[0].question, /content_ref/);
});

test('estimated retry cost above $0.10 escalates without attempting retry', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'video' })] }); // video estimate = $0.15 > $0.10

  assert.equal(result.escalationsPendingUser, 1);
  assert.equal(inserted[0].estimated_cost_usd, 0.15);
});

test('estimated retry cost at or below $0.10 attempts a real retry', async () => {
  const db = makeFakeDb({});
  const retryParse = async ({ contentRef, contentType }) => {
    assert.equal(contentRef, 'https://example.com/audio.mp3');
    assert.equal(contentType, 'audio');
    return { result: { transcript: 'улучшено' }, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 0.04 } };
  };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'audio', content_ref: 'https://example.com/audio.mp3' })] }); // audio estimate = $0.05

  assert.equal(result.items[0].result.transcript, 'улучшено');
  assert.equal(result.items[0].confidence.level, 'высокая');
  assert.equal(result.escalationsAuto, 1);
  assert.equal(result.costUsdRetry, 0.04);
});

test('a failed retry escalates with the original item data intact', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  const retryParse = async () => { throw new Error('Agent 2 unreachable'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'audio' })] });

  assert.deepEqual(result.items[0].result, { transcript: 'слабый разбор' });
  assert.equal(result.escalationsPendingUser, 1);
  assert.match(inserted[0].question, /Agent 2 unreachable/);
});

test('once cumulative retry spend reaches $5, further items skip retry and escalate directly', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  let retryCallCount = 0;
  const retryParse = async () => {
    retryCallCount += 1;
    return { result: {}, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 5 } };
  };
  const node = createEscalationNode({ db, retryParse });

  const items = [
    item({ job_id: 'job-a', content_type: 'audio' }),
    item({ job_id: 'job-b', content_type: 'audio' })
  ];
  const result = await node({ items });

  assert.equal(retryCallCount, 1); // only the first item retries; that alone reaches the $5 cap
  assert.equal(result.costCapReached, true);
  assert.equal(result.escalationsAuto, 1);
  assert.equal(result.escalationsPendingUser, 1);
  assert.match(inserted[0].question, /лимит/);
});

test('sums costUsdRetry across multiple successful retries', async () => {
  const db = makeFakeDb({});
  const retryParse = async () => ({ result: {}, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 0.02 } });
  const node = createEscalationNode({ db, retryParse });

  const items = [
    item({ job_id: 'job-a', content_type: 'audio' }),
    item({ job_id: 'job-b', content_type: 'document' })
  ];
  const result = await node({ items });

  assert.equal(result.costUsdRetry, 0.04);
  assert.equal(result.escalationsAuto, 2);
});

test('a failure inserting a pending_user_decisions row is logged, not thrown', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: { message: 'constraint violation' } }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ agent: 1, content_ref: null })] });

  assert.equal(result.escalationsPendingUser, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/escalation.test.js`
Expected: FAIL — module `src/graph/nodes/escalation.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/graph/nodes/escalation.js`:

```javascript
// src/graph/nodes/escalation.js

const LOW_CONFIDENCE = 'низкая';
const RETRY_COST_THRESHOLD_USD = 0.10;
const RETRY_COST_CAP_USD = 5;

// Предварительные оценки — калибруются по факту, не архитектурное решение.
// video намеренно дороже порога: по ТЗ такие ретраи чаще должны
// эскалироваться пользователю, а не выполняться автоматически.
const CONTENT_TYPE_RETRY_COST_ESTIMATES = {
  video: 0.15,
  audio: 0.05,
  document: 0.03,
  image: 0.02,
  text: 0.01
};

export function createEscalationNode({ db, retryParse }) {
  return async function escalationNode(state) {
    const resolvedItems = [];
    const pendingDecisions = [];
    let costUsdRetry = 0;
    let escalationsAuto = 0;
    let escalationsPendingUser = 0;
    let costCapReached = false;

    for (const item of state.items) {
      if (item.confidence?.level !== LOW_CONFIDENCE) {
        resolvedItems.push(item);
        continue;
      }

      if (!item.content_ref) {
        pendingDecisions.push(buildPendingDecision(item, 'Повтор невозможен: нет content_ref (результат поиска, не парсинга)'));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
        continue;
      }

      if (costUsdRetry >= RETRY_COST_CAP_USD) {
        costCapReached = true;
        pendingDecisions.push(buildPendingDecision(item, 'Достигнут лимит трат на автоповторы за прогон ($5)'));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
        continue;
      }

      const estimatedCost = CONTENT_TYPE_RETRY_COST_ESTIMATES[item.content_type] ?? RETRY_COST_THRESHOLD_USD;
      if (estimatedCost > RETRY_COST_THRESHOLD_USD) {
        pendingDecisions.push(buildPendingDecision(
          item,
          `Ожидаемая стоимость повтора $${estimatedCost} превышает порог $${RETRY_COST_THRESHOLD_USD}`,
          estimatedCost
        ));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
        continue;
      }

      try {
        const retried = await retryParse({ contentRef: item.content_ref, contentType: item.content_type });
        costUsdRetry += retried.meta?.cost_usd ?? 0;
        escalationsAuto += 1;
        resolvedItems.push({ ...item, result: retried.result, confidence: retried.confidence });
      } catch (err) {
        pendingDecisions.push(buildPendingDecision(item, `Автоповтор не удался: ${err.message}`));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
      }
    }

    for (const decision of pendingDecisions) {
      const { error } = await db.from('pending_user_decisions').insert(decision);
      if (error) {
        console.error('escalation: failed to record pending_user_decisions row:', error.message);
      }
    }

    return {
      items: resolvedItems,
      escalationsAuto,
      escalationsPendingUser,
      costUsdRetry,
      costCapReached
    };
  };
}

function buildPendingDecision(item, question, estimatedCostUsd = null) {
  return {
    job_id: item.job_id,
    question,
    estimated_cost_usd: estimatedCostUsd
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/escalation.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/escalation.js" "Information analysis agent/Code/tests/graph/nodes/escalation.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Узел escalation — автоповтор через Агента 2 + лимиты | v0.4.0

Новый первый узел графа (до dispatcher), реализует Шаг 6/7 ТЗ. Для каждого
item'а с confidence.level === 'низкая': item от Агента 1 (нет content_ref,
поисковый агрегат, не один URL) сразу эскалируется в pending_user_decisions;
если уже потрачено $5 на повторы за прогон — тоже эскалация без попытки;
если ожидаемая стоимость повтора (статическая оценка по content_type)
больше $0.10 — тоже эскалация; иначе реальный вызов retryParse (Агент 2,
mode: 'deep') — успех заменяет данные item'а и добавляет реальную
стоимость к счётчику, неудача не роняет узел, эскалирует с исходными
данными. Обрабатывает items последовательно (не через Send) — нужен
доступ к бегущей сумме трат на повтор между item'ами одного прогона.
EOF
)"
```

---

### Task 13: `persistResults.js` — write cost/escalation columns and `cost_cap_reached` status

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/persistResults.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/persistResults.test.js`

**Interfaces:**
- Consumes: `state.costUsdAnalysis`, `state.costUsdRetry`, `state.escalationsAuto`, `state.escalationsPendingUser`, `state.costCapReached` (from Tasks 7-12).
- Produces: no change to `createPersistResultsNode({db})`'s external signature or `{runId, status}` return shape. The final `UPDATE runs` now also writes `cost_usd`, `cost_usd_analysis`, `cost_usd_retry`, `escalations_auto`, `escalations_pending_user`; `status` becomes `'cost_cap_reached'` when `state.costCapReached` is `true` (taking priority over the existing `ok`/`partial` logic).

- [ ] **Step 1: Write the failing tests**

In `Information analysis agent/Code/tests/graph/nodes/persistResults.test.js`, add these tests at the end of the file (the existing `claim(...)` helper and all existing tests stay unchanged — every existing test's `state` object simply won't set the new fields, which is fine since they're read with `?? 0`/`?? false` defaults):

```javascript
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
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null })
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
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null })
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
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null })
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
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: ['some error'], costCapReached: false };

  const result = await node(state);

  assert.equal(result.status, 'partial');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/persistResults.test.js`
Expected: FAIL — the final `UPDATE runs` call currently only writes `{status}`, no cost/escalation fields, and never produces `'cost_cap_reached'`.

- [ ] **Step 3: Update the implementation**

In `Information analysis agent/Code/src/graph/nodes/persistResults.js`, replace the final status-update block (the lines starting `const finalStatus = ...` through the `return { runId, status: finalStatus };`):

```javascript
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

      return { runId, status: finalStatus };
```

Every other part of the file (run creation, `sources`/`entities`/`claims` writing, the `contradictions` insert, the outer `catch` rollback block) stays exactly as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/persistResults.test.js`
Expected: PASS (17 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/persistResults.js" "Information analysis agent/Code/tests/graph/nodes/persistResults.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | persistResults — пишет реальный cost_usd + счётчики эскалаций | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). runs.cost_usd
больше не жёстко 0 — финальный UPDATE теперь пишет реальную сумму
(costUsdAnalysis + costUsdRetry из state, накопленных предыдущими
задачами этого слайса), плюс раздельные cost_usd_analysis/cost_usd_retry
(Task 1 этого слайса) и escalations_auto/escalations_pending_user (колонки
существовали с самого начала, просто не заполнялись). Статус прогона
становится cost_cap_reached, когда узел escalation исчерпал лимит $5 на
повторы — приоритетнее обычной ok/partial логики. Обратная совместимость:
все новые поля читаются с ?? 0 по умолчанию, старые тесты без этих полей
в state продолжают работать.
EOF
)"
```

---

### Task 14: Wire `escalation` into the graph

**Files:**
- Modify: `Information analysis agent/Code/src/graph/index.js`
- Modify: `Information analysis agent/Code/tests/graph/index.test.js`

**Interfaces:**
- Consumes: `createEscalationNode` (Task 12).
- Produces: `createAnalysisGraph({db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse})` — one new required dependency. Graph order becomes `escalation → dispatcher → Send(extractClaims) → reducer → dedup → contradiction → persistResults`. `runAnalysis` return shape unchanged.

- [ ] **Step 1: Write the failing tests**

In `Information analysis agent/Code/tests/graph/index.test.js`:

1. Update `makeDb()` to add a `pending_user_decisions` handler, and add `fakeRetryParse` near the top (after `fakeJudgeContradiction`):

```javascript
function makeDb() {
  let entityCounter = 0;
  return makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-1' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => {
      entityCounter += 1;
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    contradictions: () => ({ error: null }),
    pending_user_decisions: () => ({ error: null }),
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
}

const fakeEmbedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0 });
const fakeJudgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
const fakeJudgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok', costUsd: 0 });
const fakeRetryParse = async () => { throw new Error('should not be called unless an item has low confidence'); };
```

2. Update every existing `extractClaims` fake in the file to return the new `{claims, costUsd}` shape, and pass `retryParse: fakeRetryParse` into every existing `createAnalysisGraph(...)` call. Replace the full file contents:

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
    entities: (state) => {
      entityCounter += 1;
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    contradictions: () => ({ error: null }),
    pending_user_decisions: () => ({ error: null }),
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
}

const fakeEmbedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0 });
const fakeJudgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
const fakeJudgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok', costUsd: 0 });
const fakeRetryParse = async () => { throw new Error('should not be called unless an item has low confidence'); };

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

test('runs the full graph for a non-empty batch: extracts, reduces, persists', async () => {
  const extractClaims = async (item) => ({
    claims: [{ subject: `subject-${item.job_id}`, predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse });

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
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse });

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
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse });

  const result = await runAnalysis([], { reason: 'ceiling' });

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 0);
});

test('throws when embedText is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse }),
    /embedText must be a function/
  );
});

test('throws when judgeDuplicate is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, retryParse: fakeRetryParse }),
    /judgeDuplicate must be a function/
  );
});

test('throws when judgeContradiction is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse }),
    /judgeContradiction must be a function/
  );
});

test('throws when retryParse is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction }),
    /retryParse must be a function/
  );
});

test('end-to-end: a contradicting claim gets flagged and persisted with a contradictions row', async () => {
  const insertedContradictions = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-2' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-new-1' }, error: null } : { error: null }),
    contradictions: (state) => { insertedContradictions.push(state.payload); return { error: null }; },
    pending_user_decisions: () => ({ error: null }),
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Компания X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-existing-1', predicate: 'подняла раунд', object_value: '3 млн',
        confidence_level: 'средняя', confidence_explanation: 'ok', similarity: 0.9
      }],
      error: null
    })
  });

  const extractClaims = async () => ({
    claims: [{ subject: 'Компания X', predicate: 'подняла раунд', object_value: '5 млн', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true, costUsd: 0 } : { isDuplicate: false, costUsd: 0 });
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы', costUsd: 0 });

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate, judgeContradiction, retryParse: fakeRetryParse });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'ok');
  assert.equal(insertedContradictions.length, 1);
  assert.equal(insertedContradictions[0].claim_a_id, 'claim-new-1');
  assert.equal(insertedContradictions[0].claim_b_id, 'claim-existing-1');
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

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse });

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
Expected: FAIL — `createAnalysisGraph` doesn't validate/use `retryParse` yet, and there is no `escalation` node in the graph, and `extractClaims` fakes return the new shape that the not-yet-updated `extractClaims` node can't handle (this will actually already be fixed by Task 8 — if Tasks are applied in order, only the `retryParse`-related assertions should fail at this point).

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

export function createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse } = {}) {
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

  const escalationNode = createEscalationNode({ db, retryParse });
  const extractClaimsNode = createExtractClaimsNode(extractClaims);
  const dedupNode = createDedupNode({ db, embedText, judgeDuplicate });
  const contradictionNode = createContradictionNode({ judgeContradiction });
  const persistResultsNode = createPersistResultsNode({ db });

  const compiledGraph = new StateGraph(AnalysisState)
    .addNode('escalation', escalationNode)
    .addNode('extractClaims', extractClaimsNode)
    .addNode('reducer', reducerNode)
    .addNode('dedup', dedupNode)
    .addNode('contradiction', contradictionNode)
    .addNode('persistResults', persistResultsNode)
    .addEdge(START, 'escalation')
    .addConditionalEdges('escalation', dispatchToExtraction)
    .addEdge('extractClaims', 'reducer')
    .addEdge('reducer', 'dedup')
    .addEdge('dedup', 'contradiction')
    .addEdge('contradiction', 'persistResults')
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

Note: `dispatchToExtraction` (unchanged, from `dispatcher.js`) reads `state.items` to build its `Send` list — since `escalation` now runs first and returns a (possibly modified) `items` array before `dispatchToExtraction` runs, this wiring is correct without touching `dispatcher.js` itself.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/index.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/index.js" "Information analysis agent/Code/tests/graph/index.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Граф: узел escalation первым, до dispatcher | v0.4.0

Часть слайса "Эскалация / контроль стоимости" (Шаг 7). createAnalysisGraph
получает новую обязательную зависимость retryParse (Task 11 этого слайса,
MCP-клиент к Агенту 2). Порядок узлов: escalation → dispatcher →
Send(extractClaims) → reducer → dedup → contradiction → persistResults.
escalation обрабатывает сырые items (проверка confidence, попытка
автоповтора) до того, как dispatchToExtraction решает, как разбить их на
параллельные Send-ветки извлечения — dispatcher.js не менялся, просто
теперь читает items уже после возможной замены escalation'ом.
EOF
)"
```

---

### Task 15: Wire `deepParsingClient` into `src/index.js`

**Files:**
- Modify: `Information analysis agent/Code/src/index.js`
- Modify: `Information analysis agent/Code/.env`
- Modify: `Information analysis agent/Code/.env.example`

**Interfaces:**
- Consumes: `createDeepParsingClient` (Task 11).
- Produces: real application entry point constructs `retryParse` and passes it into `createAnalysisGraph`, matching every other dependency already wired there.

**IMPORTANT — this exact class of bug has happened TWICE already in this project** (dedup slice: `embedText`/`judgeDuplicate` never wired into `src/index.js`; caught only by a live smoke test after the fact). Do not let it happen a third time — Step 4 below is a mandatory verification, not optional.

- [ ] **Step 1: Add the new environment variable**

In `Information analysis agent/Code/.env.example`, add (near the other integration URLs, e.g. after the Redis section):

```
# Агент 2 (Deep Parsing Agent) — MCP Streamable HTTP, для автоповтора низкоуверенных item'ов (Шаг 7).
# Внутри Docker-сети: http://deep-parsing-agent:7301 (подтвердить при живой проверке).
DEEP_PARSING_AGENT_URL=
```

In `Information analysis agent/Code/.env` (real values, gitignored), add:

```
DEEP_PARSING_AGENT_URL=http://deep-parsing-agent:7301
```

- [ ] **Step 2: Update `src/index.js`**

Add the import (alongside the existing `createContradictionJudge`/`createGeminiEmbedder` imports):

```javascript
import { createDeepParsingClient } from './mcp-clients/deepParsingClient.js';
```

Add the construction (alongside the existing `judgeContradiction`/`embedText` construction, after `heliconeApiKey` is defined):

```javascript
  const retryParse = createDeepParsingClient({ baseUrl: requireEnv('DEEP_PARSING_AGENT_URL') });
```

Replace the existing `createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction })` call:

```javascript
  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse });
```

- [ ] **Step 3: Run the full test suite**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green (`src/index.js` itself has no direct test file — it's a real entry point, verified by the grep check below, matching the pattern established for the dedup slice's equivalent fix).

- [ ] **Step 4: Verify the wiring by grep — mandatory, do not skip**

Run: `grep -n "createDeepParsingClient\|retryParse\|createAnalysisGraph(" "Information analysis agent/Code/src/index.js"`

Expected output includes all four of:
1. The import line (`createDeepParsingClient`)
2. The `const retryParse = createDeepParsingClient(...)` construction line
3. `retryParse` appearing inside the `createAnalysisGraph({ ... })` call
4. Nothing else calls `createAnalysisGraph` without `retryParse`

If any of these is missing, `src/index.js` will throw `createAnalysisGraph: retryParse must be a function` at startup — do not mark this task done until all four are confirmed present.

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/index.js" "Information analysis agent/Code/.env.example"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | src/index.js — подключает deepParsingClient (retryParse) | v0.4.0

Завершает слайс "Эскалация / контроль стоимости" (Шаг 7): реальная точка
входа теперь конструирует retryParse (Task 11 этого слайса, MCP-клиент к
Агенту 2 по DEEP_PARSING_AGENT_URL) и передаёт его в createAnalysisGraph
вместе с остальными зависимостями. Проверено явным grep по трём ожидаемым
строкам — тот же класс бага (новая зависимость графа не прокинута в
реальный entry point) уже дважды случался в этом проекте, в этот раз
проверка встроена в саму задачу, а не оставлена на будущий живой
смоук-тест.
EOF
)"
```

Note: `.env` itself is gitignored and not committed — only `.env.example` (with the empty placeholder) is tracked.

---

## After all tasks: final whole-branch review

Once all 15 tasks are complete and committed, dispatch a final whole-branch review over the full commit range for this plan (from Task 1's first commit to Task 15's last commit) — per the controller's standing instruction for this project, this is the ONLY review pass for this plan (no per-task reviews were run). Points the reviewer should specifically check:

- The full `content_ref` → `escalation` → (possibly retried) `items` → `dispatchToExtraction` → `extractClaims` chain, end-to-end.
- Every `costUsd`/`costUsdAnalysis`/`costUsdRetry` contribution point — trace that nothing is double-counted or silently dropped, especially across the `Send` fan-out in extraction (parallel branches) vs. the sequential `dedup`/`contradiction`/`escalation` nodes.
- `runs.cost_usd = cost_usd_analysis + cost_usd_retry` invariant holds in `persistResults.js`.
- Schema cross-check: `cost_usd_retry`/`cost_usd_analysis` columns match what `persistResults.js` writes; `pending_user_decisions` columns match what `escalation.js` writes.
- `src/index.js` genuinely wires `retryParse` all the way through (re-verify independently, per the Task 15 note — this is exactly the class of bug that has slipped through twice already).
- Cost/operational flag: `escalation` now adds a real network dependency on Agent 2 being reachable at `DEEP_PARSING_AGENT_URL` — if Agent 2 is down, every low-confidence Agent-2-sourced item falls back to escalation (not a crash, but worth flagging as an operational coupling).
- Plan-alignment / scope-creep check against the design spec.

Per the standing project instruction, do **not** apply migration `004_cost_columns.sql` to the live database or run any live smoke test until this review (and any resulting fixes) is complete — and note that a real smoke test of the `escalation` → Agent 2 retry path additionally requires both Agent 2's and Agent 3's Docker containers running on `marketing-agency-net` (Docker Desktop was not running on this machine during design — confirm it's up before attempting that specific live check).
