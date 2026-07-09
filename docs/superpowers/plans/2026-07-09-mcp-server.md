# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Agent 3's analysis results to Agent 4 (and manual inspection) through a read-only MCP server with three tools — `analysis_digest`, `analysis_detail`, `analysis_status` — reachable over Streamable HTTP inside the shared Docker network.

**Architecture:** Mirrors Agent 2's already-working MCP server (`Deep parsing agent/Code/src/mcp-server/`) — low-level `Server` from `@modelcontextprotocol/sdk`, `WebStandardStreamableHTTPServerTransport`, stateless per-request server instances, `GET /health`. Differs in one way: it runs inside the same process as the existing scheduler (`src/index.js`), not as a separate container/entry point, so `http.js` exports a factory instead of self-executing. Query logic lives in its own file (`queries.js`), separate from MCP protocol wiring (`server.js`), so it can be unit-tested directly against `fakeSupabase` without touching the SDK's `Server` internals.

**Tech Stack:** Node.js ESM, `node:test`, `@modelcontextprotocol/sdk` (`^1.12.1`, already a dependency since Слайс 7), Supabase/Postgres (schema `information_analysis_agent`), global `fetch` (Node ≥18) for HTTP-layer tests.

## Global Constraints

- Read-only: no write tools, no auth beyond Docker network membership — matches Agent 2's `Deep parsing agent/Code/src/mcp-server/http.js` precedent exactly.
- Port `7302` (`MCP_HTTP_PORT` env var), following Agent 2's `7301` convention.
- `excerpt` in `analysis_detail.sources[]` is always `null` — no data source for it exists anywhere in the schema (confirmed across migrations 001-005); do not fabricate or omit the field, return `null` explicitly.
- `sources[].confidence` reuses the claim's own `confidence_level` for every source — there is no per-(claim,source)-link confidence stored in `claim_sources`.
- `pending_user_decisions` in `analysis_status` must filter `status = 'pending'` — the table has `status CHECK IN ('pending', 'resolved')`; resolved rows must not appear.
- Any new required dependency added to `src/index.js`'s startup wiring must be grep-verified before the task is done — this bug class (new dependency never wired into the real entry point) has recurred multiple times in this project.

---

### Task 1: `src/mcp-server/queries.js` — data access for all three tools

**Files:**
- Create: `Information analysis agent/Code/src/mcp-server/queries.js`
- Create: `Information analysis agent/Code/tests/mcp-server/queries.test.js`

**Interfaces:**
- Produces: `getDigest(db, runId) -> Promise<{digest_id, run_at, facts, contradictions, meta}>`; `getClaimDetail(db, claimId) -> Promise<{claim_id, statement, sources, reasoning, history} | null>`; `getStatus(db) -> Promise<{last_run_at, status, items_processed, cost_usd, pending_user_decisions}>`. Task 2 (`server.js`) consumes all three.
- These functions do multiple separate `db.from(table)...` calls and combine results in JS — this codebase's `fakeSupabase` helper (`tests/helpers/fakeSupabase.js`) does not model Supabase's embedded-resource `select('*, table(*)')` join syntax, and no existing file in this project uses it; every existing multi-table read (e.g. `persistResults.js`) already does N separate calls. Follow that pattern here too.
- None of these functions call `.single()`/`.maybeSingle()` on the Supabase query builder — `fakeSupabase`'s fake has no `.maybeSingle()`, and real `.single()` errors on zero rows (which is a valid, expected outcome here — "no digest yet", "claim not found"). Instead, treat every `data` result as an array and take `data?.[0] ?? null`.

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/mcp-server/queries.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDigest, getClaimDetail, getStatus } from '../../src/mcp-server/queries.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('getDigest returns the most recent digest when no run_id is given', async () => {
  const db = makeFakeDb({
    digests: () => ({
      data: [{ id: 'digest-1', run_id: 'run-1', run_at: '2026-07-09T10:00:00Z', facts: [{ claim_id: 'c1' }], contradictions: [], meta: { items_processed: 1 } }],
      error: null
    })
  });

  const result = await getDigest(db, null);

  assert.equal(result.digest_id, 'digest-1');
  assert.equal(result.run_at, '2026-07-09T10:00:00Z');
  assert.deepEqual(result.facts, [{ claim_id: 'c1' }]);
  assert.deepEqual(result.meta, { items_processed: 1 });
});

test('getDigest returns the digest for a specific run_id when given', async () => {
  let filteredRunId = null;
  const db = makeFakeDb({
    digests: (state) => {
      filteredRunId = state.filters.run_id;
      return { data: [{ id: 'digest-2', run_id: state.filters.run_id, run_at: '2026-07-08T10:00:00Z', facts: [], contradictions: [], meta: {} }], error: null };
    }
  });

  const result = await getDigest(db, 'run-42');

  assert.equal(filteredRunId, 'run-42');
  assert.equal(result.digest_id, 'digest-2');
});

test('getDigest returns an empty-shaped result when no digest exists yet', async () => {
  const db = makeFakeDb({ digests: () => ({ data: [], error: null }) });

  const result = await getDigest(db, null);

  assert.deepEqual(result, { digest_id: null, run_at: null, facts: [], contradictions: [], meta: null });
});

test('getDigest throws a descriptive error when the query fails', async () => {
  const db = makeFakeDb({ digests: () => ({ data: null, error: { message: 'connection lost' } }) });

  await assert.rejects(() => getDigest(db, null), /connection lost/);
});

test('getClaimDetail assembles statement/sources/reasoning from claims+entities+claim_sources+sources', async () => {
  const db = makeFakeDb({
    claims: () => ({ data: [{ id: 'claim-1', subject_entity_id: 'ent-1', predicate: 'подняла раунд', object_value: '5 млн', confidence_level: 'высокая', confidence_explanation: 'два независимых источника' }], error: null }),
    entities: () => ({ data: [{ id: 'ent-1', name: 'Компания X' }], error: null }),
    claim_sources: () => ({ data: [{ claim_id: 'claim-1', source_id: 'src-1' }], error: null }),
    sources: () => ({ data: [{ id: 'src-1', source_type: 'search', raw_job_id: 'job-1' }], error: null })
  });

  const result = await getClaimDetail(db, 'claim-1');

  assert.equal(result.claim_id, 'claim-1');
  assert.equal(result.statement, 'Компания X: подняла раунд: 5 млн');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].source_id, 'src-1');
  assert.equal(result.sources[0].type, 'search');
  assert.equal(result.sources[0].ref, 'job-1');
  assert.equal(result.sources[0].excerpt, null);
  assert.equal(result.sources[0].confidence, 'высокая');
  assert.equal(result.reasoning, 'два независимых источника');
  assert.deepEqual(result.history, []);
});

test('getClaimDetail returns null when the claim does not exist', async () => {
  const db = makeFakeDb({ claims: () => ({ data: [], error: null }) });

  const result = await getClaimDetail(db, 'claim-missing');

  assert.equal(result, null);
});

test('getClaimDetail handles multiple confirming sources', async () => {
  let sourceCallCount = 0;
  const db = makeFakeDb({
    claims: () => ({ data: [{ id: 'claim-1', subject_entity_id: 'ent-1', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }], error: null }),
    entities: () => ({ data: [{ id: 'ent-1', name: 'X' }], error: null }),
    claim_sources: () => ({ data: [{ claim_id: 'claim-1', source_id: 'src-1' }, { claim_id: 'claim-1', source_id: 'src-2' }], error: null }),
    sources: (state) => {
      sourceCallCount += 1;
      return { data: [{ id: state.filters.id, source_type: 'video', raw_job_id: `job-${state.filters.id}` }], error: null };
    }
  });

  const result = await getClaimDetail(db, 'claim-1');

  assert.equal(sourceCallCount, 2);
  assert.equal(result.sources.length, 2);
});

test('getStatus returns the latest run plus only pending (not resolved) escalations', async () => {
  let pendingFilter = null;
  const db = makeFakeDb({
    runs: () => ({ data: [{ run_at: '2026-07-09T10:00:00Z', status: 'ok', items_processed: 3, cost_usd: 0.05 }], error: null }),
    pending_user_decisions: (state) => {
      pendingFilter = state.filters.status;
      return { data: [{ job_id: 'job-1', question: 'дорого?', estimated_cost_usd: 0.15 }], error: null };
    }
  });

  const result = await getStatus(db);

  assert.equal(pendingFilter, 'pending');
  assert.equal(result.status, 'ok');
  assert.equal(result.items_processed, 3);
  assert.equal(result.cost_usd, 0.05);
  assert.equal(result.pending_user_decisions.length, 1);
  assert.equal(result.pending_user_decisions[0].job_id, 'job-1');
});

test('getStatus returns nulls/zeros gracefully when there are no runs yet', async () => {
  const db = makeFakeDb({
    runs: () => ({ data: [], error: null }),
    pending_user_decisions: () => ({ data: [], error: null })
  });

  const result = await getStatus(db);

  assert.equal(result.last_run_at, null);
  assert.equal(result.status, null);
  assert.equal(result.items_processed, 0);
  assert.equal(result.cost_usd, 0);
  assert.deepEqual(result.pending_user_decisions, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/mcp-server/queries.test.js`
Expected: FAIL — module `src/mcp-server/queries.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/mcp-server/queries.js`:

```javascript
// src/mcp-server/queries.js

export async function getDigest(db, runId) {
  const query = runId
    ? db.from('digests').select().eq('run_id', runId)
    : db.from('digests').select().order('run_at', { ascending: false }).limit(1);
  const { data, error } = await query;
  if (error) {
    throw new Error(`getDigest: ${error.message}`);
  }
  const row = data?.[0];
  if (!row) {
    return { digest_id: null, run_at: null, facts: [], contradictions: [], meta: null };
  }
  return {
    digest_id: row.id,
    run_at: row.run_at,
    facts: row.facts,
    contradictions: row.contradictions,
    meta: row.meta
  };
}

export async function getClaimDetail(db, claimId) {
  const { data: claimRows, error: claimError } = await db.from('claims').select().eq('id', claimId);
  if (claimError) {
    throw new Error(`getClaimDetail: failed to read claim: ${claimError.message}`);
  }
  const claim = claimRows?.[0];
  if (!claim) {
    return null;
  }

  const { data: entityRows, error: entityError } = await db.from('entities').select().eq('id', claim.subject_entity_id);
  if (entityError) {
    throw new Error(`getClaimDetail: failed to read entity: ${entityError.message}`);
  }
  const subjectName = entityRows?.[0]?.name ?? '(неизвестно)';

  const { data: linkRows, error: linkError } = await db.from('claim_sources').select().eq('claim_id', claimId);
  if (linkError) {
    throw new Error(`getClaimDetail: failed to read claim_sources: ${linkError.message}`);
  }

  const sources = [];
  for (const link of linkRows ?? []) {
    const { data: sourceRows, error: sourceError } = await db.from('sources').select().eq('id', link.source_id);
    if (sourceError) {
      throw new Error(`getClaimDetail: failed to read source ${link.source_id}: ${sourceError.message}`);
    }
    const source = sourceRows?.[0];
    if (!source) {
      continue;
    }
    sources.push({
      source_id: source.id,
      type: source.source_type,
      ref: source.raw_job_id,
      excerpt: null,
      confidence: claim.confidence_level
    });
  }

  return {
    claim_id: claim.id,
    statement: `${subjectName}: ${claim.predicate}: ${claim.object_value ?? ''}`,
    sources,
    reasoning: claim.confidence_explanation,
    history: []
  };
}

export async function getStatus(db) {
  const { data: runRows, error: runError } = await db.from('runs').select().order('run_at', { ascending: false }).limit(1);
  if (runError) {
    throw new Error(`getStatus: failed to read runs: ${runError.message}`);
  }
  const run = runRows?.[0];

  const { data: pendingRows, error: pendingError } = await db.from('pending_user_decisions').select().eq('status', 'pending');
  if (pendingError) {
    throw new Error(`getStatus: failed to read pending_user_decisions: ${pendingError.message}`);
  }

  return {
    last_run_at: run?.run_at ?? null,
    status: run?.status ?? null,
    items_processed: run?.items_processed ?? 0,
    cost_usd: run?.cost_usd ?? 0,
    pending_user_decisions: (pendingRows ?? []).map((p) => ({
      job_id: p.job_id,
      question: p.question,
      estimated_cost_usd: p.estimated_cost_usd
    }))
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/mcp-server/queries.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/mcp-server/queries.js" "Information analysis agent/Code/tests/mcp-server/queries.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | mcp-server/queries — данные для трёх инструментов | v0.5.0

Задача 1 плана MCP-сервера (Слайс 9). getDigest читает уже готовую строку
из digests (Слайс 8) почти без трансформации. getClaimDetail — новый
запрос напрямую к claims/entities/claim_sources/sources (не через
JSONB-дайджест): statement собирается по тому же шаблону, что fallback в
globalSynthesis.js, excerpt всегда null (данных для него нет нигде в
схеме), confidence на источник берётся из confidence самого claim'а (per-
источник confidence в модели данных не хранится). getStatus фильтрует
pending_user_decisions по status='pending' — уже отвеченные решения не
должны попадать в текущий статус.

Ни одна функция не использует .single()/.maybeSingle() — fakeSupabase не
поддерживает .maybeSingle(), а реальный .single() кидает ошибку на 0
строк, что здесь как раз валидный исход ("дайджеста ещё нет", "claim не
найден"). Вместо этого data трактуется как массив, берётся data?.[0] ?? null.

9/9 тестов проходят.
EOF
)"
```

---

### Task 2: `src/mcp-server/server.js` — MCP protocol wiring (`listTools`/`callTool`/`createMcpServer`)

**Files:**
- Create: `Information analysis agent/Code/src/mcp-server/server.js`
- Create: `Information analysis agent/Code/tests/mcp-server/server.test.js`

**Interfaces:**
- Consumes: `getDigest`/`getClaimDetail`/`getStatus` (Task 1).
- Produces: `listTools() -> Promise<{tools: [...]}>` (no dependencies — static tool list); `callTool(db, request) -> Promise<{content: [{type: 'text', text: string}], isError?: true}>`; `createMcpServer({db}) -> Server` (wires the above two into a real `@modelcontextprotocol/sdk` `Server` instance). Task 3 (`http.js`) consumes `createMcpServer`.
- `listTools`/`callTool` are exported as **plain functions**, separate from the SDK `Server` instance, specifically so tests can call them directly without reaching into the SDK's internal request-handler registry (which is not a public API). `createMcpServer` just wires `server.setRequestHandler(ListToolsRequestSchema, listTools)` and `server.setRequestHandler(CallToolRequestSchema, (request) => callTool(db, request))`.

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/mcp-server/server.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTools, callTool, createMcpServer } from '../../src/mcp-server/server.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('listTools returns the three expected tools', async () => {
  const result = await listTools();

  const names = result.tools.map((t) => t.name);
  assert.deepEqual(names, ['analysis_digest', 'analysis_detail', 'analysis_status']);
});

test('analysis_digest tool schema does not require any parameters', async () => {
  const result = await listTools();
  const tool = result.tools.find((t) => t.name === 'analysis_digest');

  assert.equal(tool.inputSchema.required, undefined);
});

test('analysis_detail tool schema requires claim_id', async () => {
  const result = await listTools();
  const tool = result.tools.find((t) => t.name === 'analysis_detail');

  assert.deepEqual(tool.inputSchema.required, ['claim_id']);
});

test('callTool analysis_digest returns the digest as JSON text content', async () => {
  const db = makeFakeDb({ digests: () => ({ data: [{ id: 'digest-1', run_id: 'run-1', run_at: '2026-07-09T10:00:00Z', facts: [], contradictions: [], meta: {} }], error: null }) });

  const result = await callTool(db, { params: { name: 'analysis_digest', arguments: {} } });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.digest_id, 'digest-1');
});

test('callTool analysis_digest passes through a given run_id', async () => {
  let filters = null;
  const db = makeFakeDb({ digests: (state) => { filters = state.filters; return { data: [{ id: 'digest-2', run_id: state.filters.run_id, run_at: 'x', facts: [], contradictions: [], meta: {} }], error: null }; } });

  await callTool(db, { params: { name: 'analysis_digest', arguments: { run_id: 'run-99' } } });

  assert.equal(filters.run_id, 'run-99');
});

test('callTool analysis_detail returns a descriptive isError when claim_id is missing', async () => {
  const db = makeFakeDb({});

  const result = await callTool(db, { params: { name: 'analysis_detail', arguments: {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /claim_id is required/);
});

test('callTool analysis_detail returns a descriptive isError when the claim is not found', async () => {
  const db = makeFakeDb({ claims: () => ({ data: [], error: null }) });

  const result = await callTool(db, { params: { name: 'analysis_detail', arguments: { claim_id: 'claim-missing' } } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /claim-missing/);
  assert.match(result.content[0].text, /not found/);
});

test('callTool analysis_detail returns the claim detail as JSON text content on success', async () => {
  const db = makeFakeDb({
    claims: () => ({ data: [{ id: 'claim-1', subject_entity_id: 'ent-1', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }], error: null }),
    entities: () => ({ data: [{ id: 'ent-1', name: 'X' }], error: null }),
    claim_sources: () => ({ data: [], error: null })
  });

  const result = await callTool(db, { params: { name: 'analysis_detail', arguments: { claim_id: 'claim-1' } } });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.claim_id, 'claim-1');
});

test('callTool analysis_status returns the status as JSON text content', async () => {
  const db = makeFakeDb({
    runs: () => ({ data: [], error: null }),
    pending_user_decisions: () => ({ data: [], error: null })
  });

  const result = await callTool(db, { params: { name: 'analysis_status', arguments: {} } });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, null);
});

test('callTool returns a descriptive isError for an unknown tool name', async () => {
  const db = makeFakeDb({});

  const result = await callTool(db, { params: { name: 'unknown_tool', arguments: {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool/);
});

test('callTool wraps a query failure in isError rather than throwing', async () => {
  const db = makeFakeDb({ digests: () => ({ data: null, error: { message: 'connection lost' } }) });

  const result = await callTool(db, { params: { name: 'analysis_digest', arguments: {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /connection lost/);
});

test('createMcpServer returns a real Server instance wired with db', () => {
  const db = makeFakeDb({});
  const server = createMcpServer({ db });

  assert.ok(server);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/mcp-server/server.test.js`
Expected: FAIL — module `src/mcp-server/server.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/mcp-server/server.js`:

```javascript
// src/mcp-server/server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDigest, getClaimDetail, getStatus } from './queries.js';

export async function listTools() {
  return {
    tools: [
      {
        name: 'analysis_digest',
        description: 'Краткий дайджест последнего (или указанного) прогона анализа: факты, противоречия, количественные агрегаты.',
        inputSchema: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'Опционально: id конкретного прогона. По умолчанию — последний.' }
          }
        }
      },
      {
        name: 'analysis_detail',
        description: 'Полный разбор конкретного факта: источники, обоснование.',
        inputSchema: {
          type: 'object',
          properties: {
            claim_id: { type: 'string', description: 'id факта (claim), полученный из detail_ref в analysis_digest.' }
          },
          required: ['claim_id']
        }
      },
      {
        name: 'analysis_status',
        description: 'Текущее состояние последнего прогона и неразрешённые эскалации, ожидающие решения пользователя.',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  };
}

export async function callTool(db, request) {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'analysis_digest') {
      const digest = await getDigest(db, args?.run_id ?? null);
      return { content: [{ type: 'text', text: JSON.stringify(digest, null, 2) }] };
    }

    if (name === 'analysis_detail') {
      if (!args?.claim_id) {
        return { content: [{ type: 'text', text: 'analysis_detail: claim_id is required' }], isError: true };
      }
      const detail = await getClaimDetail(db, args.claim_id);
      if (!detail) {
        return { content: [{ type: 'text', text: `analysis_detail: claim ${args.claim_id} not found` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
    }

    if (name === 'analysis_status') {
      const status = await getStatus(db);
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `Ошибка: ${error.message}` }], isError: true };
  }
}

export function createMcpServer({ db }) {
  const server = new Server(
    { name: 'information-analysis-agent', version: '0.5.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(db, request));

  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/mcp-server/server.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/mcp-server/server.js" "Information analysis agent/Code/tests/mcp-server/server.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | mcp-server/server — три read-only инструмента | v0.5.0

Задача 2 плана MCP-сервера (Слайс 9). Тот же паттерн, что у Агента 2
(Deep parsing agent/Code/src/mcp-server/server.js): низкоуровневый Server
из @modelcontextprotocol/sdk, ListToolsRequestSchema/CallToolRequestSchema,
{content: [{type:'text', text: JSON.stringify(...)}]} на успех,
{..., isError: true} на ошибку/неизвестный инструмент.

listTools/callTool — отдельные экспортируемые функции, не завязанные на
внутренний реестр обработчиков Server (это приватная деталь SDK, не
публичный API) — тесты вызывают их напрямую, createMcpServer просто
подключает их к server.setRequestHandler.

12/12 тестов проходят.
EOF
)"
```

---

### Task 3: `src/mcp-server/http.js` — Streamable HTTP transport wrapper

**Files:**
- Create: `Information analysis agent/Code/src/mcp-server/http.js`
- Create: `Information analysis agent/Code/tests/mcp-server/http.test.js`

**Interfaces:**
- Consumes: `createMcpServer` (Task 2).
- Produces: `createMcpHttpServer({db, port}) -> http.Server` (not auto-started — caller calls `.listen(port, callback)`). Task 4 (`src/index.js`) consumes `createMcpHttpServer`.

This adapts `Deep parsing agent/Code/src/mcp-server/http.js` almost line-for-line (same `WebStandardStreamableHTTPServerTransport` workaround for the Node v24 `@hono/node-server` bug, same stateless-per-request `Server` instantiation, same `toWebRequest`/`writeWebResponse` Node-stream ↔ Web-stream bridging) — wrapped in a factory that takes `db`/`port` as parameters instead of reading them from module-scope constants, and does not call `.listen()` itself (Task 4 does that, alongside the existing scheduler).

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/mcp-server/http.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHttpServer } from '../../src/mcp-server/http.js';

function fakeDb() {
  return {};
}

test('GET /health returns 200 with service status', async () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await fetch(`http://localhost:${port}/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'information-analysis-agent');

  await new Promise((resolve) => server.close(resolve));
});

test('unknown routes return 404', async () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await fetch(`http://localhost:${port}/unknown`);

  assert.equal(res.status, 404);

  await new Promise((resolve) => server.close(resolve));
});

test('createMcpHttpServer returns a real http.Server instance, not started', () => {
  const server = createMcpHttpServer({ db: fakeDb(), port: 7302 });

  assert.ok(server);
  assert.equal(server.listening, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/mcp-server/http.test.js`
Expected: FAIL — module `src/mcp-server/http.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/mcp-server/http.js`:

```javascript
// src/mcp-server/http.js
import http from 'node:http';
import { Readable } from 'node:stream';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from './server.js';

// Тот же обход, что уже применён у Агента 2 (Deep parsing agent/Code/src/
// mcp-server/http.js): WebStandardStreamableHTTPServerTransport (Request/
// Response) напрямую, а не Node-обёртка StreamableHTTPServerTransport из
// того же SDK — та тянет @hono/node-server, который на Node v24 ломается
// на пустых 202-ответах (MCP-уведомления без тела).
function toWebRequest(req, port) {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers: new Headers(Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))),
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined
  });
}

async function writeWebResponse(webRes, res) {
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
  if (!webRes.body) {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    Readable.fromWeb(webRes.body).pipe(res).on('finish', resolve).on('error', reject);
  });
}

export function createMcpHttpServer({ db, port }) {
  return http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'information-analysis-agent' }));
      return;
    }

    if (req.url === '/mcp') {
      try {
        // Stateless-режим (sessionIdGenerator: undefined) — инструменты
        // read-only и не зависят от состояния HTTP-сессии, всё состояние в
        // Supabase. SDK в этом режиме требует НОВЫЙ Server+transport на
        // каждый запрос, поэтому createMcpServer() вызывается здесь, а не
        // один раз на весь процесс.
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        transport.onerror = (err) => console.error('[mcp transport error]', err.stack ?? err);
        await createMcpServer({ db }).connect(transport);
        const webRes = await transport.handleRequest(toWebRequest(req, port));
        await writeWebResponse(webRes, res);
      } catch (err) {
        console.error('[mcp http] request failed:', err.stack ?? err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/mcp-server/http.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/mcp-server/http.js" "Information analysis agent/Code/tests/mcp-server/http.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | mcp-server/http — Streamable HTTP транспорт | v0.5.0

Задача 3 плана MCP-сервера (Слайс 9). Адаптация Deep parsing agent/Code/
src/mcp-server/http.js почти один в один (тот же обход бага Node v24 в
@hono/node-server через WebStandardStreamableHTTPServerTransport, тот же
stateless-режим с новым Server на каждый /mcp-запрос) — но оформлена как
фабрика createMcpHttpServer({db, port}), не самозапускающийся скрипт: у
Агента 2 http.js — отдельный entry point контейнера, у Агента 3 сервер
будет запускаться в том же процессе, что и планировщик (задача 4 этого
плана), поэтому .listen() вызывает вызывающий код, не сам файл.

3/3 теста проходят, полный набор проходит без регрессий.
EOF
)"
```

---

### Task 4: Wire the MCP HTTP server into `src/index.js`

**Files:**
- Modify: `Information analysis agent/Code/src/index.js`
- Modify: `Information analysis agent/Code/.env`
- Modify: `Information analysis agent/Code/.env.example`

**Interfaces:**
- Consumes: `createMcpHttpServer` (Task 3).
- Produces: real application entry point starts the MCP HTTP server alongside the existing scheduler, both running concurrently in the same process.

**IMPORTANT — this exact class of bug has happened repeatedly in this project** (dedup slice: `embedText`/`judgeDuplicate` never wired; escalation slice: `retryParse` wiring got a mandatory grep check; GlobalSynthesis slice: `synthesizeDigest` wiring, also grep-checked). Do not let it happen again — Step 3 below is mandatory, not optional.

- [ ] **Step 1: Add the new environment variable**

In `Information analysis agent/Code/.env.example`, add (after the `DEEP_PARSING_AGENT_URL` line):

```
# MCP-сервер Агента 3 (выход для Агента 4) — Streamable HTTP, порт по умолчанию 7302.
MCP_HTTP_PORT=
```

In `Information analysis agent/Code/.env` (real values, gitignored), add:

```
MCP_HTTP_PORT=7302
```

- [ ] **Step 2: Update `src/index.js`**

Add the import (alongside the existing `createGlobalSynthesisJudge` import):

```javascript
import { createMcpHttpServer } from './mcp-server/http.js';
```

Add, after the existing `const scheduler = createScheduler({...});` block and before the final `scheduler.start(POLL_INTERVAL_MS);` line:

```javascript
  const mcpPort = Number(process.env.MCP_HTTP_PORT ?? 7302);
  const mcpHttpServer = createMcpHttpServer({ db, port: mcpPort });
  mcpHttpServer.listen(mcpPort, () => {
    console.log(`Information Analysis Agent: MCP server listening on http://0.0.0.0:${mcpPort}/mcp`);
  });

```

(The scheduler and the MCP HTTP server both run in the same Node.js event loop — the scheduler's polling is already fully async via `setInterval`/`await`, and `http.Server` is non-blocking, so neither interferes with the other.)

- [ ] **Step 3: Run the full test suite**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green (`src/index.js` itself has no direct test file — verified by the grep check below).

- [ ] **Step 4: Verify the wiring by grep — mandatory, do not skip**

Run: `grep -n "createMcpHttpServer\|mcpHttpServer\|MCP_HTTP_PORT" "Information analysis agent/Code/src/index.js"`

Expected output includes all three of:
1. The import line (`createMcpHttpServer`)
2. The `const mcpHttpServer = createMcpHttpServer(...)` construction line
3. The `mcpHttpServer.listen(...)` call

If any of these is missing, the real application will run the scheduler but never expose the MCP server at all (a silent gap, not a crash — arguably worse, since nothing would signal the failure at startup). Do not mark this task done until all three are confirmed present.

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/index.js" "Information analysis agent/Code/.env.example"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | src/index.js — запускает MCP HTTP-сервер рядом с планировщиком | v0.5.0

Завершает код-часть плана MCP-сервера (Слайс 9). Реальная точка входа
теперь запускает createMcpHttpServer (задача 3 этого плана) на порту
MCP_HTTP_PORT (по умолчанию 7302), одновременно с уже существующим
scheduler.start(...) — оба асинхронны и сосуществуют в одном event loop
без блокировки друг друга. Проверено явным grep по трём ожидаемым строкам
— тот же класс бага (новая зависимость не прокинута в реальный entry
point), что уже случался в этом проекте несколько раз, только на этот раз
результатом был бы не крэш, а тихое отсутствие MCP-сервера при рабочем
планировщике — сложнее заметить, поэтому проверка обязательна.
EOF
)"
```

---

### Task 5: Docker — expose the MCP port, connect Agent 3 to the shared infrastructure

**Files:**
- Modify: `Information analysis agent/Code/docker-compose.yml`
- Modify: `Инфраструктура (Docker)/docker-compose.yml`

**Interfaces:**
- Produces: Agent 3's container is reachable on `http://information-analysis-agent:7302/mcp` from other containers on `marketing-agency-net`, and on `http://localhost:7302/mcp` from the host — matching Agent 2's existing `deep-parsing-agent:7301`/`localhost:7301` pattern exactly.

- [ ] **Step 1: Update Agent 3's own compose file**

Replace the full contents of `Information analysis agent/Code/docker-compose.yml`:

```yaml
# Information analysis agent/Code/docker-compose.yml
name: information-analysis-agent

services:
  information-analysis-agent:
    build: .
    image: information-analysis-agent:v0.5.0
    container_name: information-analysis-agent
    restart: unless-stopped
    env_file: .env
    environment:
      # Переопределяет .env: внутри контейнера Redis доступен по имени сервиса
      # на общей сети, а не по localhost (тот — для локального запуска вне Docker).
      - REDIS_URL=redis://redis:6379/0
      - MCP_HTTP_PORT=7302
    ports:
      - "7302:7302"   # MCP Streamable HTTP — доступен и с хоста для проверки (тот же паттерн, что у Агента 2 на 7301)
    volumes:
      - ./logs:/app/logs
    networks:
      - marketing-agency-net

networks:
  marketing-agency-net:
    name: marketing-agency-net
    external: true
```

(Only `image` version, the new `MCP_HTTP_PORT` environment override, and the new `ports` block change — everything else stays as-is.)

- [ ] **Step 2: Connect Agent 3 to the shared infrastructure**

In `Инфраструктура (Docker)/docker-compose.yml`, uncomment the Agent 3 include line. Change:

```yaml
include:
  - path: ../Intelligence agent/Code/docker-compose.yml
  - path: ../Deep parsing agent/Code/docker-compose.yml
  # - path: ../Information analysis agent/Code/docker-compose.yml    # появится, когда начнётся разработка Агента 3
  # - path: ../Content creation agent/Code/docker-compose.yml        # появится, когда начнётся разработка Агента 4
```

to:

```yaml
include:
  - path: ../Intelligence agent/Code/docker-compose.yml
  - path: ../Deep parsing agent/Code/docker-compose.yml
  - path: ../Information analysis agent/Code/docker-compose.yml
  # - path: ../Content creation agent/Code/docker-compose.yml        # появится, когда начнётся разработка Агента 4
```

- [ ] **Step 3: Commit**

```bash
git add "Information analysis agent/Code/docker-compose.yml" "Инфраструктура (Docker)/docker-compose.yml"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Docker: MCP-порт 7302, подключение к общей инфраструктуре | v0.5.0

Задача 5 плана MCP-сервера (Слайс 9), последняя. Agent 3 теперь доступен
как http://information-analysis-agent:7302/mcp из общей сети
marketing-agency-net (и http://localhost:7302/mcp с хоста) — тот же
паттерн, что уже работает у Агента 2 на 7301. Строка подключения Агента 3
в мастер docker-compose.yml была закомментирована с самого начала проекта
с явным комментарием "появится, когда начнётся разработка Агента 3" —
раскомментирована сейчас, когда MCP-выход Агента 3 реально появился.

Живой сквозной прогон (после финального ревью слайса) потребует Docker
Desktop: docker compose up -d из Инфраструктура (Docker)/, затем реальный
HTTP-запрос к http://localhost:7302/mcp с рабочими данными в БД от
предыдущих слайсов.
EOF
)"
```

---

## After all tasks: final whole-branch review

Once all 5 tasks are complete and committed, dispatch a final whole-branch review over the full commit range for this plan (from Task 1's first commit to Task 5's last commit) — per the controller's standing instruction for this project, this is the ONLY review pass for this plan. Points the reviewer should specifically check:

- Every one of the three tools' response shapes against `docs/superpowers/specs/2026-07-09-mcp-server-design.md` §3 and `5. ТЗ.md` §3.2 — field-by-field, not just "roughly matches".
- `getClaimDetail`'s multi-query assembly (`claims` → `entities` → `claim_sources` → `sources`, N separate calls) for any case where a missing row at any step should degrade gracefully rather than throwing an unhandled exception that would surface as an unfriendly 500 instead of a clean `isError: true` MCP response.
- `src/index.js` genuinely starts the MCP HTTP server (re-verify independently, per the Task 4 note — this bug class has slipped through before).
- Docker: confirm `Code/docker-compose.yml`'s port mapping and the master compose file's uncommented include line are both syntactically correct (a broken YAML indent here would silently prevent the whole shared stack from starting, not just Agent 3).
- Plan-alignment / scope-creep check against `docs/superpowers/specs/2026-07-09-mcp-server-design.md` — confirm no write-capable tools were added, no auth was added (both explicitly out of scope, matching Agent 2's precedent), and Agent 4 itself was not touched (doesn't exist yet).

Per the standing project instruction, do **not** start the shared Docker stack or run any live smoke test until this review (and any resulting fixes) is complete. The live smoke test itself will need: Docker Desktop running, `docker compose up -d` from `Инфраструктура (Docker)/`, and a real HTTP request to `http://localhost:7302/mcp` (or a Streamable-HTTP-capable MCP client) against live data left over from a prior slice's own live testing, or a small amount of fresh live data produced by triggering a real analysis run first.
