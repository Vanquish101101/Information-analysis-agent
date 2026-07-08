# Contradiction Detection (Шаг 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `contradiction` graph node between `dedup` and `persistResults` that detects when a new claim conflicts with an existing claim about the same entity, using an LLM judge (with self-consistency voting for high-confidence existing facts), and records confirmed contradictions in a new `contradictions` table.

**Architecture:** `dedup.js` is modified to carry forward the nearest existing-claim candidate it already fetches (currently discarded when judged "not a duplicate") as `contradictionCandidate` on each resolved claim. The new `contradiction` node consumes that field — no new DB candidate lookup. For each claim with a candidate, it asks a new LLM judge (`judgeContradiction`) whether the two facts agree, contradict, or are unclear; `unclear` is treated as `contradict`. If the candidate's own `confidence_level` is `высокая`, the judge is called 3 times and the majority label wins (3-way tie → `unclear`). Confirmed contradictions are marked on the claim object; `persistResults.js` writes a `contradictions` row referencing both claim ids once the new claim has been inserted (and thus has a real id).

**Tech Stack:** Node.js ESM, `node:test`/`node:assert/strict`, `@langchain/langgraph` (`Overwrite`), Supabase (`information_analysis_agent` schema), OpenRouter (`anthropic/claude-haiku-4-5`), optional Helicone proxy.

## Global Constraints

- Every external integration is a DI factory function (injectable client/fetchImpl, defaulting to the real one) — zero live calls in `npm test`.
- OpenRouter calls use model `anthropic/claude-haiku-4-5`, headers `Authorization: Bearer`, `HTTP-Referer: 'https://vanquish.information-analysis-agent'`, `X-Title: 'Information Analysis Agent'`, and support an optional `heliconeApiKey` that routes through `https://openrouter.helicone.ai/api/v1/chat/completions` with an added `Helicone-Auth: Bearer <key>` header (same pattern as `extractClaims.js`/`judgeDuplicate.js`).
- Confidence vocabulary is always the three strings `высокая`/`средняя`/`низкая` — never a numeric scale.
- Supabase schema is `information_analysis_agent`; new tables need explicit `GRANT ALL ... TO anon, authenticated, service_role` and `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` (the blanket grant in migration 001 only covered tables that existed at the time it ran).
- `Overwrite` (from `@langchain/langgraph`) must wrap any node's return value for the `claims` channel — it uses a concat reducer for `Send` fan-in, so a plain array return would double claims on every subsequent node. `errors` is a concat-reducer channel and must NOT be wrapped — return a plain array so it appends.
- Migrations are written and tested (regex assertions against the SQL file) but **not applied to the live DB** as part of this plan — that happens after this slice is fully implemented and reviewed, per standing project convention.
- Commit message format: `Information Analysis Agent | <russian description> | v0.4.0`.
- Design reference: `docs/superpowers/specs/2026-07-08-contradiction-detection-design.md`.

---

### Task 1: Migration — `contradictions` table

**Files:**
- Create: `Information analysis agent/Code/src/db/migrations/003_contradictions.sql`
- Create: `Information analysis agent/Code/tests/db/migration003.test.js`

**Interfaces:**
- Produces: table `information_analysis_agent.contradictions` with columns `id uuid`, `claim_a_id uuid`, `claim_b_id uuid`, `label text` (CHECK IN `contradict`, `unclear`), `confidence_level text` (CHECK IN `высокая`, `средняя`, `низкая`), `explanation text`, `detected_at timestamptz`.

- [ ] **Step 1: Write the failing test**

Create `Information analysis agent/Code/tests/db/migration003.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/003_contradictions.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('creates the contradictions table with the expected columns', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS information_analysis_agent\.contradictions/);
  assert.match(sql, /claim_a_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.claims\(id\)/);
  assert.match(sql, /claim_b_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.claims\(id\)/);
  assert.match(sql, /detected_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

test('label is constrained to contradict or unclear', () => {
  const tableBlock = sql.split('CREATE TABLE')[1];
  assert.match(tableBlock, /label\s+TEXT NOT NULL CHECK \(label IN \('contradict', 'unclear'\)\)/);
});

test('confidence_level is constrained to the three-value vocabulary', () => {
  const tableBlock = sql.split('CREATE TABLE')[1];
  assert.match(tableBlock, /confidence_level\s+TEXT NOT NULL CHECK \(confidence_level IN \('высокая', 'средняя', 'низкая'\)\)/);
});

test('grants access and disables RLS, matching the other tables in this schema', () => {
  assert.match(sql, /GRANT ALL ON information_analysis_agent\.contradictions TO anon, authenticated, service_role/);
  assert.match(sql, /ALTER TABLE information_analysis_agent\.contradictions DISABLE ROW LEVEL SECURITY/);
});

test('indexes both claim id columns', () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS contradictions_claim_a_idx ON information_analysis_agent\.contradictions\(claim_a_id\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS contradictions_claim_b_idx ON information_analysis_agent\.contradictions\(claim_b_id\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `Information analysis agent/Code`): `node --test tests/db/migration003.test.js`
Expected: FAIL — `ENOENT` reading the migration file (it doesn't exist yet).

- [ ] **Step 3: Write the migration file**

Create `Information analysis agent/Code/src/db/migrations/003_contradictions.sql`:

```sql
-- src/db/migrations/003_contradictions.sql
-- Таблица противоречий (Шаг 6): пара claims с одинаковым subject_entity_id
-- (через ближайшего кандидата, найденного dedup-узлом), которые LLM-judge
-- счёл конфликтующими. unclear трактуется как противоречие узлом-потребителем
-- (см. дизайн-спеку contradiction-detection), но исходная метка сохраняется
-- в label для будущего использования (например, менее настойчивый показ
-- unclear-случаев в дайджесте Шага 8).

CREATE TABLE IF NOT EXISTS information_analysis_agent.contradictions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_a_id        UUID NOT NULL REFERENCES information_analysis_agent.claims(id),
  claim_b_id        UUID NOT NULL REFERENCES information_analysis_agent.claims(id),
  label             TEXT NOT NULL CHECK (label IN ('contradict', 'unclear')),
  confidence_level  TEXT NOT NULL CHECK (confidence_level IN ('высокая', 'средняя', 'низкая')),
  explanation       TEXT,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contradictions_claim_a_idx ON information_analysis_agent.contradictions(claim_a_id);
CREATE INDEX IF NOT EXISTS contradictions_claim_b_idx ON information_analysis_agent.contradictions(claim_b_id);

GRANT ALL ON information_analysis_agent.contradictions TO anon, authenticated, service_role;
ALTER TABLE information_analysis_agent.contradictions DISABLE ROW LEVEL SECURITY;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db/migration003.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/db/migrations/003_contradictions.sql" "Information analysis agent/Code/tests/db/migration003.test.js"
git commit -m "Information Analysis Agent | Миграция: таблица contradictions | v0.4.0"
```

---

### Task 2: `judgeContradiction` LLM judge

**Files:**
- Create: `Information analysis agent/Code/src/llm/judgeContradiction.js`
- Create: `Information analysis agent/Code/tests/llm/judgeContradiction.test.js`

**Interfaces:**
- Produces: `createContradictionJudge({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch }) -> judgeContradiction({ newClaimText: string, existingClaimText: string }) -> Promise<{ label: 'agree'|'contradict'|'unclear', confidenceLevel: 'высокая'|'средняя'|'низкая', explanation: string|null }>`

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/llm/judgeContradiction.test.js`:

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

test('builds the request with the correct URL, model, and both claim texts in the prompt', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "средняя", "explanation": "ok"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'secret-key', fetchImpl });

  await judgeContradiction({ newClaimText: 'X: подняла: 5 млн', existingClaimText: 'подняла: 3 млн' });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
  assert.match(body.messages[0].content, /5 млн/);
  assert.match(body.messages[0].content, /3 млн/);
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "средняя", "explanation": "ok"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses an agree verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "высокая", "explanation": "совместимо"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'agree');
  assert.equal(result.confidenceLevel, 'высокая');
  assert.equal(result.explanation, 'совместимо');
});

test('parses a contradict verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "contradict", "confidence_level": "средняя", "explanation": "разные суммы"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'contradict');
});

test('parses an unclear verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "unclear", "confidence_level": "низкая", "explanation": "не уверен"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'unclear');
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '```json\n{"label": "agree", "confidence_level": "высокая", "explanation": "ok"}\n```' } }] });
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
Expected: FAIL — module `src/llm/judgeContradiction.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/llm/judgeContradiction.js`:

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
        max_tokens: 300
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

    return parseVerdict(content);
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
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/llm/judgeContradiction.js" "Information analysis agent/Code/tests/llm/judgeContradiction.test.js"
git commit -m "Information Analysis Agent | judgeContradiction — LLM-judge для детекции противоречий | v0.4.0"
```

---

### Task 3: Carry the near-miss candidate through `dedup.js`

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/dedup.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/dedup.test.js`

**Interfaces:**
- Consumes: existing `resolveClaim`/`resolveClaimDuplicate` internals (no external signature change to `createDedupNode({ db, embedText, judgeDuplicate })`).
- Produces: every claim returned by `dedupNode` now has a `contradictionCandidate` field — `null` when there is no near-existing-claim candidate (new entity, no candidate found, or resolution errored), or the raw `match_claims` row (`{ id, predicate, object_value, confidence_level, confidence_explanation, similarity }`) when a candidate existed but `judgeDuplicate` said it was NOT a duplicate. Task 4's `contradiction.js` consumes this field.

- [ ] **Step 1: Write the failing tests**

In `Information analysis agent/Code/tests/graph/nodes/dedup.test.js`, add these three tests (after the existing `'claim candidate confirmed by judge...'` test, before `'confidence bump caps...'`):

```javascript
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
  const embedText = async () => [0.1, 0.2];
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true } : { isDuplicate: false });
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
  const embedText = async () => [0.1, 0.2];
  const judgeDuplicate = async () => ({ isDuplicate: true });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].contradictionCandidate, null);
});

test('new (unresolved) entity: contradictionCandidate is null (no existing claims possible)', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => [0.1];
  const judgeDuplicate = async () => ({ isDuplicate: false });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].contradictionCandidate, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/dedup.test.js`
Expected: FAIL — `resolved.contradictionCandidate` is `undefined`, not `null`/the candidate object (the field doesn't exist yet).

- [ ] **Step 3: Update the implementation**

In `Information analysis agent/Code/src/graph/nodes/dedup.js`, replace `resolveClaim` and `resolveClaimDuplicate`:

```javascript
async function resolveClaim({ db, embedText, judgeDuplicate, claim }) {
  const subjectEmbedding = await embedText(claim.subject);
  const subjectEntityId = await resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding });

  if (subjectEntityId) {
    const claimText = buildClaimText(claim);
    const claimEmbedding = await embedText(claimText);
    const { candidate, isDuplicate } = await resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding, subjectEntityId });

    if (isDuplicate) {
      return {
        ...claim,
        isDuplicate: true,
        duplicateOfClaimId: candidate.id,
        bumpedConfidenceLevel: bumpConfidence(candidate.confidence_level),
        bumpedConfidenceExplanation: buildBumpedExplanation(candidate.confidence_explanation, claim),
        subjectEntityId,
        contradictionCandidate: null
      };
    }

    return {
      ...claim,
      isDuplicate: false,
      subjectEntityId,
      subjectEmbedding: null,
      claimEmbedding,
      batchEntityKey: null,
      contradictionCandidate: candidate
    };
  }

  // Новая (ещё не существующая) сущность не может иметь существующих claims —
  // проверка на дубль claim'а не нужна, экономим вызов.
  const claimEmbedding = await embedText(buildClaimText(claim));
  return {
    ...claim,
    isDuplicate: false,
    subjectEntityId: null,
    subjectEmbedding,
    claimEmbedding,
    batchEntityKey: normalizeKey(claim.subject),
    contradictionCandidate: null
  };
}

async function resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding }) {
  const { data: candidates, error } = await db.rpc('match_entities', {
    query_embedding: subjectEmbedding,
    match_threshold: SIMILARITY_THRESHOLD
  });

  if (error || !candidates || candidates.length === 0) {
    return null;
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({ kind: 'entity', new: claim.subject, candidate: top.name });
  return verdict.isDuplicate ? top.id : null;
}

async function resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding, subjectEntityId }) {
  const { data: candidates, error } = await db.rpc('match_claims', {
    query_embedding: claimEmbedding,
    match_threshold: SIMILARITY_THRESHOLD,
    for_subject_entity_id: subjectEntityId
  });

  if (error || !candidates || candidates.length === 0) {
    return { candidate: null, isDuplicate: false };
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({
    kind: 'claim',
    new: buildClaimText(claim),
    candidate: `${top.predicate}: ${top.object_value ?? ''}`
  });
  return { candidate: top, isDuplicate: verdict.isDuplicate };
}
```

`resolveEntity` is unchanged — reproduced above only so the surrounding context is unambiguous for the implementer; do not alter its body.

Also update the error-fallback push inside `createDedupNode`'s catch block (leave everything else in the file, including `buildClaimText`/`normalizeKey`/`bumpConfidence`/`buildBumpedExplanation`, untouched):

```javascript
        resolvedClaims.push({
          ...claim,
          isDuplicate: false,
          subjectEntityId: null,
          subjectEmbedding: null,
          claimEmbedding: null,
          batchEntityKey: normalizeKey(claim.subject),
          contradictionCandidate: null
        });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/dedup.test.js`
Expected: PASS (13 tests — 10 existing + 3 new).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green (no other file reads `resolveClaimDuplicate`'s return shape directly).

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/dedup.js" "Information analysis agent/Code/tests/graph/nodes/dedup.test.js"
git commit -m "Information Analysis Agent | dedup — прокидывает отклонённого кандидата как contradictionCandidate | v0.4.0"
```

---

### Task 4: `contradiction` graph node

**Files:**
- Create: `Information analysis agent/Code/src/graph/nodes/contradiction.js`
- Create: `Information analysis agent/Code/tests/graph/nodes/contradiction.test.js`

**Interfaces:**
- Consumes: `claim.contradictionCandidate` (from Task 3) — `null` or `{ id, predicate, object_value, confidence_level, confidence_explanation, similarity }`. `judgeContradiction` (from Task 2)'s signature `({ newClaimText, existingClaimText }) -> Promise<{ label, confidenceLevel, explanation }>`.
- Produces: `createContradictionNode({ judgeContradiction }) -> contradictionNode(state) -> Promise<{ claims: Overwrite, errors: string[] }>`. Each claim gains `hasContradiction: boolean`; when `true`, also `contradictsClaimId`, `contradictionRawLabel` (`'contradict'|'unclear'`), `contradictionConfidenceLevel`, `contradictionExplanation` — consumed by Task 5's `persistResults.js`.

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/graph/nodes/contradiction.test.js`:

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
});

test('low/medium-confidence candidate: exactly one judge call', async () => {
  let callCount = 0;
  const judgeContradiction = async () => { callCount += 1; return { label: 'contradict', confidenceLevel: 'средняя', explanation: 'конфликт' }; };
  const node = createContradictionNode({ judgeContradiction });

  await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  assert.equal(callCount, 1);
});

test('high-confidence candidate: exactly three judge calls (self-consistency)', async () => {
  let callCount = 0;
  const judgeContradiction = async () => { callCount += 1; return { label: 'contradict', confidenceLevel: 'высокая', explanation: 'конфликт' }; };
  const node = createContradictionNode({ judgeContradiction });

  await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(callCount, 3);
});

test('agree verdict: does not mark the claim as a contradiction', async () => {
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'совместимо' });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, false);
});

test('contradict verdict: marks the claim with contradiction fields', async () => {
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы' });
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
  const judgeContradiction = async () => ({ label: 'unclear', confidenceLevel: 'низкая', explanation: 'не уверен' });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.hasContradiction, true);
  assert.equal(resolved.contradictionRawLabel, 'unclear');
});

test('self-consistency majority vote: 2 contradict + 1 agree results in contradict', async () => {
  let call = 0;
  const responses = [
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'a' },
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'b' },
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'c' }
  ];
  const judgeContradiction = async () => responses[call++];
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, true);
  assert.equal(result.claims.value[0].contradictionRawLabel, 'contradict');
});

test('self-consistency three-way tie (agree/contradict/unclear) resolves to unclear, treated as a contradiction', async () => {
  let call = 0;
  const responses = [
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'a' },
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'b' },
    { label: 'unclear', confidenceLevel: 'высокая', explanation: 'c' }
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
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok' });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.constructor.name, 'Overwrite');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/contradiction.test.js`
Expected: FAIL — module `src/graph/nodes/contradiction.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/graph/nodes/contradiction.js`:

```javascript
// src/graph/nodes/contradiction.js
import { Overwrite } from '@langchain/langgraph';

const HIGH_CONFIDENCE = 'высокая';
const SELF_CONSISTENCY_SAMPLES = 3;

export function createContradictionNode({ judgeContradiction }) {
  return async function contradictionNode(state) {
    const resolvedClaims = [];
    const newErrors = [];

    for (const claim of state.claims) {
      if (!claim.contradictionCandidate) {
        resolvedClaims.push(claim);
        continue;
      }

      try {
        resolvedClaims.push(await resolveContradiction({ judgeContradiction, claim }));
      } catch (err) {
        newErrors.push(`contradiction check failed for claim subject "${claim.subject}": ${err.message}`);
        resolvedClaims.push({ ...claim, hasContradiction: false });
      }
    }

    return {
      claims: new Overwrite(resolvedClaims),
      errors: newErrors
    };
  };
}

async function resolveContradiction({ judgeContradiction, claim }) {
  const candidate = claim.contradictionCandidate;
  const newClaimText = buildClaimText(claim);
  const existingClaimText = `${candidate.predicate}: ${candidate.object_value ?? ''}`;

  const sampleCount = candidate.confidence_level === HIGH_CONFIDENCE ? SELF_CONSISTENCY_SAMPLES : 1;
  const verdicts = [];
  for (let i = 0; i < sampleCount; i += 1) {
    verdicts.push(await judgeContradiction({ newClaimText, existingClaimText }));
  }

  const rawLabel = majorityLabel(verdicts.map((v) => v.label));

  if (rawLabel === 'agree') {
    return { ...claim, hasContradiction: false };
  }

  const primary = verdicts[0];
  return {
    ...claim,
    hasContradiction: true,
    contradictsClaimId: candidate.id,
    contradictionRawLabel: rawLabel,
    contradictionConfidenceLevel: primary.confidenceLevel,
    contradictionExplanation: primary.explanation
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
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/contradiction.js" "Information analysis agent/Code/tests/graph/nodes/contradiction.test.js"
git commit -m "Information Analysis Agent | Узел contradiction — self-consistency для устоявшихся фактов | v0.4.0"
```

---

### Task 5: Write contradictions in `persistResults.js`

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/persistResults.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/persistResults.test.js`

**Interfaces:**
- Consumes: `claim.hasContradiction`, `claim.contradictsClaimId`, `claim.contradictionRawLabel`, `claim.contradictionConfidenceLevel`, `claim.contradictionExplanation` (from Task 4).
- Produces: no change to `createPersistResultsNode({ db })`'s external signature or `{ runId, status }` return shape. New side effect: inserts a row into `db.from('contradictions')` after inserting a non-duplicate claim that has `hasContradiction: true`.

- [ ] **Step 1: Write the failing test**

In `Information analysis agent/Code/tests/graph/nodes/persistResults.test.js`, add this test at the end of the file:

```javascript
test('a claim marked hasContradiction inserts a contradictions row after the claim, referencing both claim ids', async () => {
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
    }
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

  await node(state);

  assert.equal(insertedContradictions.length, 1);
  assert.equal(insertedContradictions[0].claim_a_id, 'claim-new-1');
  assert.equal(insertedContradictions[0].claim_b_id, 'claim-existing-1');
  assert.equal(insertedContradictions[0].label, 'contradict');
  assert.equal(insertedContradictions[0].confidence_level, 'высокая');
  assert.equal(insertedContradictions[0].explanation, 'разные суммы');
});

test('a claim without hasContradiction does not touch the contradictions table', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-12' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-new-2' }, error: null } : { error: null }),
    contradictions: () => { throw new Error('should not write to contradictions when hasContradiction is not true'); }
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  const result = await node(state);

  assert.equal(result.status, 'ok');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/persistResults.test.js`
Expected: FAIL — `insertedContradictions.length` is `0` (no `contradictions` insert happens yet), and the current `claims` insert call doesn't chain `.select().single()` so `data` would be `undefined` even if it did.

- [ ] **Step 3: Update the implementation**

In `Information analysis agent/Code/src/graph/nodes/persistResults.js`, replace the final claims-writing loop (the one starting `for (const claim of state.claims) {` that handles both the `isDuplicate` update and the new-claim insert):

```javascript
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
          }
        }
      }
```

Everything else in the file (the `runs`/`sources`/`entities` handling before this loop, and the status-update/catch block after it) stays exactly as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/persistResults.test.js`
Expected: PASS (13 tests — 11 existing + 2 new).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Information analysis agent/Code/src/graph/nodes/persistResults.js" "Information analysis agent/Code/tests/graph/nodes/persistResults.test.js"
git commit -m "Information Analysis Agent | persistResults — запись contradictions после вставки claim | v0.4.0"
```

---

### Task 6: Wire `contradiction` into the graph and the entry point

**Files:**
- Modify: `Information analysis agent/Code/src/graph/index.js`
- Modify: `Information analysis agent/Code/tests/graph/index.test.js`
- Modify: `Information analysis agent/Code/src/index.js`

**Interfaces:**
- Consumes: `createContradictionNode` (Task 4), `createContradictionJudge` (Task 2).
- Produces: `createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction })` — one new required dependency. `runAnalysis` return shape (`{ runId, status, claimsWritten, errors }`) is unchanged.

**IMPORTANT — lesson from the previous slice:** when the dedup slice added `embedText`/`judgeDuplicate` as new `createAnalysisGraph` dependencies, `src/index.js` (the real application entry point) was not updated to pass them, and the app would have thrown at startup — this was only caught by a live smoke test after the fact, outside the plan's own review. Do not repeat this: this task explicitly includes updating `src/index.js`, and Step 6 below verifies it.

- [ ] **Step 1: Write the failing tests**

In `Information analysis agent/Code/tests/graph/index.test.js`:

1. Add a `contradictions` handler and a `fakeJudgeContradiction` near the top, and pass `judgeContradiction` into every existing `createAnalysisGraph(...)` call in the file:

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
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
}

const fakeEmbedText = async () => [0.1, 0.2];
const fakeJudgeDuplicate = async () => ({ isDuplicate: false });
const fakeJudgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok' });
```

(This replaces the existing `makeDb`/`fakeEmbedText`/`fakeJudgeDuplicate` block — note `claims` now returns `{ data: { id: 'claim-1' }, error: null }` on insert instead of just `{ error: null }`, needed because `persistResults.js` now chains `.select().single()`.)

Update every `createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate })` call in the existing tests to also pass `judgeContradiction: fakeJudgeContradiction`.

2. Add two new tests — a dependency-validation test and an end-to-end contradiction test — at the end of the file:

```javascript
test('throws when judgeContradiction is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => [], embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate }),
    /judgeContradiction must be a function/
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
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Компания X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-existing-1', predicate: 'подняла раунд', object_value: '3 млн',
        confidence_level: 'средняя', confidence_explanation: 'ok', similarity: 0.9
      }],
      error: null
    })
  });

  const extractClaims = async () => [
    { subject: 'Компания X', predicate: 'подняла раунд', object_value: '5 млн', confidence_level: 'высокая', confidence_explanation: 'e' }
  ];
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true } : { isDuplicate: false });
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы' });

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate, judgeContradiction });

  const result = await runAnalysis([{ job_id: 'job-1', agent: 1, content_type: 'search' }], { reason: 'idle' });

  assert.equal(result.status, 'ok');
  assert.equal(insertedContradictions.length, 1);
  assert.equal(insertedContradictions[0].claim_a_id, 'claim-new-1');
  assert.equal(insertedContradictions[0].claim_b_id, 'claim-existing-1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/index.test.js`
Expected: FAIL — `createAnalysisGraph` doesn't validate or use `judgeContradiction` yet, and there is no `contradiction` node in the graph.

- [ ] **Step 3: Update `graph/index.js`**

Replace the full contents of `Information analysis agent/Code/src/graph/index.js`:

```javascript
// src/graph/index.js
import { StateGraph, START, END } from '@langchain/langgraph';
import { AnalysisState } from './state.js';
import { dispatchToExtraction } from './nodes/dispatcher.js';
import { createExtractClaimsNode } from './nodes/extractClaims.js';
import { reducerNode } from './nodes/reducer.js';
import { createDedupNode } from './nodes/dedup.js';
import { createContradictionNode } from './nodes/contradiction.js';
import { createPersistResultsNode } from './nodes/persistResults.js';

export function createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction } = {}) {
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

  const extractClaimsNode = createExtractClaimsNode(extractClaims);
  const dedupNode = createDedupNode({ db, embedText, judgeDuplicate });
  const contradictionNode = createContradictionNode({ judgeContradiction });
  const persistResultsNode = createPersistResultsNode({ db });

  const compiledGraph = new StateGraph(AnalysisState)
    .addNode('extractClaims', extractClaimsNode)
    .addNode('reducer', reducerNode)
    .addNode('dedup', dedupNode)
    .addNode('contradiction', contradictionNode)
    .addNode('persistResults', persistResultsNode)
    .addConditionalEdges(START, dispatchToExtraction)
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/index.test.js`
Expected: PASS (9 tests — 7 existing + 2 new).

- [ ] **Step 5: Update `src/index.js`**

In `Information analysis agent/Code/src/index.js`, add the import and wire the dependency through — do not change anything else in the file:

```javascript
import { createContradictionJudge } from './llm/judgeContradiction.js';
```

(add alongside the existing `createDuplicateJudge`/`createGeminiEmbedder` imports)

```javascript
  const judgeContradiction = createContradictionJudge({ apiKey: requireEnv('OPENROUTER_API_KEY'), heliconeApiKey });
```

(add alongside the existing `judgeDuplicate`/`embedText` construction, after `heliconeApiKey` is defined)

```javascript
  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction });
```

(replaces the existing `createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate })` line)

- [ ] **Step 6: Verify `src/index.js` wiring by reading it back**

Run: `grep -n "judgeContradiction\|createAnalysisGraph(" "Information analysis agent/Code/src/index.js"`
Expected output includes all three of: the import line, the `createContradictionJudge(...)` construction line, and a `createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction })` call. If any is missing, `src/index.js` will throw at startup — this is the exact bug from the previous slice; do not proceed until all three are present.

- [ ] **Step 7: Run the full test suite**

Run (from `Information analysis agent/Code`): `npm test`
Expected: PASS, all tests green (target: 142 total — 122 before this plan + 5 migration + 11 judgeContradiction + 3 dedup + 11 contradiction + 2 persistResults + 2 graph/index, minus none removed — recount from actual `npm test` output, this figure is only a sanity-check estimate, not an assertion).

- [ ] **Step 8: Commit**

```bash
git add "Information analysis agent/Code/src/graph/index.js" "Information analysis agent/Code/tests/graph/index.test.js" "Information analysis agent/Code/src/index.js"
git commit -m "Information Analysis Agent | Граф: узел contradiction между dedup и persistResults | v0.4.0"
```

---

## After all tasks: final whole-branch review

Once all 6 tasks are complete and committed, dispatch a final whole-branch review over the full commit range for this plan (from Task 1's first commit to Task 6's last commit), same process as every previous slice. Points the reviewer should specifically check:

- The `dedup.js` → `contradiction.js` → `persistResults.js` interface, end-to-end, across all shapes (`contradictionCandidate: null`, candidate present + `agree`, candidate present + `contradict`, candidate present + `unclear`, self-consistency 3-way tie).
- `contradictions` table columns match what `persistResults.js` writes.
- `src/index.js` genuinely wires `judgeContradiction` all the way through (see Task 6 Step 6 — re-verify at final review too, since that is exactly the class of bug that slipped through last time).
- Cost/latency flag: self-consistency adds up to 3 extra LLM calls per contradiction candidate, on top of dedup's existing embedding/judge calls — flag for awareness, not a defect.

Per the standing project instruction, do **not** apply migration `003_contradictions.sql` to the live database or run any live smoke test until this review (and any resulting fixes) is complete.
