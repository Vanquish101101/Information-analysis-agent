# Telegram Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one consolidated Telegram message per analysis run when (and only when) the run hit an escalation, the $5 cost cap, or a contradiction with a previously high-confidence fact — per ТЗ §3.3.

**Architecture:** A new graph node (`notifications`) runs last, after `globalSynthesis`. It reads data two existing nodes already compute but don't currently expose far enough: `escalation.js` gains a new state channel (`pendingDecisionMessages`, mirroring what it already inserts into `pending_user_decisions`) and `contradiction.js` gains one new field per resolved claim (`contradictedClaimHistoricalConfidence`, the pre-existing conflicting fact's own confidence level, which the node already reads internally but currently discards). `notifications` builds one message from these plus the existing `costCapReached` flag, and sends it via a new `src/telegram/notify.js` (plain `fetch` to the Telegram Bot API — no library, matching every other external call in this codebase).

**Tech Stack:** Node.js ESM, `node:test`, global `fetch`, Telegram Bot API (`https://api.telegram.org/bot<token>/sendMessage`).

## Global Constraints

- No library (no `telegraf`) — Agent 3 only sends outbound messages, never receives/handles commands; a raw `fetch` call matches this codebase's established pattern for every other external HTTP call (OpenRouter, Gemini, Telegram).
- Reuses Agent 1's existing `TELEGRAM_BOT_TOKEN` — not a new bot registration. The real value (for the eventual live smoke test, not for any committed file) is in `Intelligence agent/Code/.env`.
- Reuses the existing `TELEGRAM_ALLOWED_USER_ID` env var (already in Agent 3's `.env`/`.env.example` since Слайс 1) as the `chat_id` for `sendMessage` — no new recipient-identifying env var.
- Exactly one Telegram message per run, sent at the very end (after `globalSynthesis`), never mid-run from `escalation`/`contradiction` directly — a later node failing (`persistResults` throwing, run ending in `status: error`) must never have already sent a "here's what went wrong" message about a run that didn't actually complete as described.
- If there is nothing to report (no escalations, no cost cap, no high-confidence-contradicted contradictions), no message is sent at all — silence, not an empty/reassuring "all good" message (ТЗ only specifies problem notifications, not routine confirmations).
- A failed Telegram send (network error, bad token) is logged and does not throw — matches every other node in this graph.
- Any new required dependency added to `src/index.js`'s startup wiring must be grep-verified before the task is done — this bug class has recurred multiple times in this project.

---

### Task 1: `src/telegram/notify.js` — `createTelegramNotifier`

**Files:**
- Create: `Information analysis agent/Code/src/telegram/notify.js`
- Create: `Information analysis agent/Code/tests/telegram/notify.test.js`

**Interfaces:**
- Produces: `createTelegramNotifier({botToken, chatId, fetchImpl}) -> sendNotification(text: string) -> Promise<object>` (resolves to Telegram's parsed JSON response on success, throws a descriptive error on HTTP failure). Task 5 (`notifications.js` node) consumes `sendNotification`.

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/telegram/notify.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramNotifier } from '../../src/telegram/notify.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody)
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws when botToken is missing', () => {
  assert.throws(() => createTelegramNotifier({ chatId: '123456' }), /botToken is required/);
});

test('throws when chatId is missing', () => {
  assert.throws(() => createTelegramNotifier({ botToken: 'test-token' }), /chatId is required/);
});

test('sends a POST to the correct Telegram sendMessage URL with chat_id/text/parse_mode', async () => {
  const fetchImpl = fakeFetch({ ok: true, result: { message_id: 1 } });
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  await sendNotification('Привет, это тест');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(options.body);
  assert.equal(body.chat_id, '123456');
  assert.equal(body.text, 'Привет, это тест');
  assert.equal(body.parse_mode, 'Markdown');
});

test('returns the parsed JSON response on success', async () => {
  const fetchImpl = fakeFetch({ ok: true, result: { message_id: 42 } });
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  const result = await sendNotification('x');

  assert.equal(result.result.message_id, 42);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({ ok: false, description: 'chat not found' }, { ok: false, status: 400 });
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  await assert.rejects(() => sendNotification('x'), /HTTP 400/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/telegram/notify.test.js`
Expected: FAIL — module `src/telegram/notify.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/telegram/notify.js`:

```javascript
// src/telegram/notify.js
export function createTelegramNotifier({ botToken, chatId, fetchImpl = fetch } = {}) {
  if (!botToken) {
    throw new Error('createTelegramNotifier: botToken is required');
  }
  if (!chatId) {
    throw new Error('createTelegramNotifier: chatId is required');
  }

  return async function sendNotification(text) {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`sendNotification: Telegram HTTP ${response.status}: ${body}`);
    }

    return response.json();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/telegram/notify.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add "Code/src/telegram/notify.js" "Code/tests/telegram/notify.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | telegram/notify — createTelegramNotifier | v0.6.0

Задача 1 плана Telegram-уведомлений (Слайс 10). Обычный fetch к
https://api.telegram.org/bot<token>/sendMessage — без библиотеки: Агенту 1
нужен полноценный интерактивный бот (диалоги, команды), там telegraf;
Агенту 3 нужна только простая исходящая отправка, тот же паттерн, что у
всех остальных внешних вызовов в проекте (OpenRouter/Gemini — прямой
fetch, без SDK-обёрток).

6/6 тестов проходят.
EOF
)"
```

(Run this command from the repo root: `C:\Users\Unknown\Documents\Projects\Marketing agency Project\Information analysis agent` — note the paths use plain `Code/...`, not `Information analysis agent/Code/...`: this repo's root IS the `Information analysis agent` directory.)

---

### Task 2: `AnalysisState` — new `pendingDecisionMessages` channel

**Files:**
- Modify: `Information analysis agent/Code/src/graph/state.js`

**Interfaces:**
- Produces: `AnalysisState` gains `pendingDecisionMessages` (no-reducer/overwrite, single-writer from `escalation`, consumed by `notifications` in Task 5).

This task has no tests of its own. Skip the TDD red/green cycle; just make the change and verify the full suite still passes.

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
  persistedContradictions: Annotation(),
  pendingDecisionMessages: Annotation()
});
```

- [ ] **Step 2: Run the full test suite to check nothing broke**

Run (from `Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 3: Commit**

```bash
git add "Code/src/graph/state.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | AnalysisState — канал pendingDecisionMessages | v0.6.0

Задача 2 плана Telegram-уведомлений (Слайс 10). Без reducer, пишется один
раз узлом escalation (задача 3 этого плана): те же объекты
{job_id, question, estimated_cost_usd}, что escalation.js уже вставляет в
pending_user_decisions, просто ещё и в state — узел notifications (задача
5) читает их напрямую, без повторного похода в БД.
EOF
)"
```

---

### Task 3: `escalation.js` — expose `pendingDecisionMessages`

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/escalation.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/escalation.test.js`

**Interfaces:**
- Produces: `escalationNode(state) -> Promise<{items, escalationsAuto, escalationsPendingUser, costUsdRetry, costCapReached, pendingDecisionMessages}>` — one new field, `pendingDecisionMessages: [{job_id, question, estimated_cost_usd}]`, the exact same array already built for the `pending_user_decisions` insert loop (no new logic, just also returning what was already computed).

- [ ] **Step 1: Write the failing tests**

Add these tests to the end of `Information analysis agent/Code/tests/graph/nodes/escalation.test.js` (existing tests stay unchanged):

```javascript
test('returns pendingDecisionMessages mirroring exactly what was inserted into pending_user_decisions', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: null }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ agent: 1, content_ref: null })] });

  assert.equal(result.pendingDecisionMessages.length, 1);
  assert.equal(result.pendingDecisionMessages[0].job_id, 'job-1');
  assert.match(result.pendingDecisionMessages[0].question, /content_ref/);
});

test('pendingDecisionMessages is an empty array when there are no escalations', async () => {
  const db = makeFakeDb({});
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ confidence: { level: 'высокая', explanation: 'ok' } })] });

  assert.deepEqual(result.pendingDecisionMessages, []);
});

test('pendingDecisionMessages includes the estimated_cost_usd for a cost-threshold escalation', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: null }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'video' })] }); // video estimate = $0.15 > $0.10

  assert.equal(result.pendingDecisionMessages[0].estimated_cost_usd, 0.15);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/escalation.test.js`
Expected: FAIL — `result.pendingDecisionMessages` is `undefined`.

- [ ] **Step 3: Update the implementation**

In `Information analysis agent/Code/src/graph/nodes/escalation.js`, add `pendingDecisionMessages: pendingDecisions` to the final return object:

```javascript
    return {
      items: resolvedItems,
      escalationsAuto,
      escalationsPendingUser,
      costUsdRetry,
      costCapReached,
      pendingDecisionMessages: pendingDecisions
    };
```

(Only this return statement changes — everything else in the file, including the `for (const decision of pendingDecisions)` insert loop above it, stays exactly as-is. `pendingDecisions` already holds exactly the array of `{job_id, question, estimated_cost_usd}` objects being inserted.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/escalation.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add "Code/src/graph/nodes/escalation.js" "Code/tests/graph/nodes/escalation.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Узел escalation — возвращает pendingDecisionMessages | v0.6.0

Задача 3 плана Telegram-уведомлений (Слайс 10). pendingDecisions (уже
собираемый для вставки в pending_user_decisions) теперь также
возвращается в state как pendingDecisionMessages — узел notifications
(задача 5 этого плана) читает готовые {job_id, question,
estimated_cost_usd} без повторного похода в БД. Никакой новой логики,
только дополнительное поле в уже существующем return.

12/12 тестов проходят.
EOF
)"
```

---

### Task 4: `contradiction.js` — expose `contradictedClaimHistoricalConfidence`

**Files:**
- Modify: `Information analysis agent/Code/src/graph/nodes/contradiction.js`
- Modify: `Information analysis agent/Code/tests/graph/nodes/contradiction.test.js`

**Interfaces:**
- Produces: a resolved claim with `hasContradiction: true` now also carries `contradictedClaimHistoricalConfidence: string` — the pre-existing conflicting claim's own `confidence_level` (`candidate.confidence_level`), the same value the node already reads internally to decide self-consistency sample count, now also preserved on the output. Consumed by `notifications` node (Task 5) to implement the ТЗ's "устоявшийся (высокий исторический confidence) факт" filter.

- [ ] **Step 1: Write the failing tests**

Add these tests to the end of `Information analysis agent/Code/tests/graph/nodes/contradiction.test.js` (existing tests stay unchanged):

```javascript
test('a contradict verdict against a HIGH-confidence historical candidate includes contradictedClaimHistoricalConfidence: высокая', async () => {
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы', costUsd: 0.01 });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(result.claims.value[0].contradictedClaimHistoricalConfidence, 'высокая');
});

test('a contradict verdict against a MEDIUM-confidence historical candidate includes contradictedClaimHistoricalConfidence: средняя, not always высокая', async () => {
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'средняя', explanation: 'разные суммы', costUsd: 0.01 });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  assert.equal(result.claims.value[0].contradictedClaimHistoricalConfidence, 'средняя');
});

test('an agree verdict does not set contradictedClaimHistoricalConfidence (no contradiction to report)', async () => {
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'совместимо', costUsd: 0.01 });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(result.claims.value[0].contradictedClaimHistoricalConfidence, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/contradiction.test.js`
Expected: FAIL — `contradictedClaimHistoricalConfidence` is `undefined` in the contradict-verdict cases.

- [ ] **Step 3: Update the implementation**

In `Information analysis agent/Code/src/graph/nodes/contradiction.js`, in the `resolveContradiction` function, add `contradictedClaimHistoricalConfidence: candidate.confidence_level` to the contradiction-marked return object:

```javascript
  const primary = verdicts.find((v) => v.label === rawLabel) ?? verdicts[0];
  return {
    ...claim,
    hasContradiction: true,
    contradictsClaimId: candidate.id,
    contradictionRawLabel: rawLabel,
    contradictionConfidenceLevel: primary.confidenceLevel,
    contradictionExplanation: primary.explanation,
    contradictedClaimHistoricalConfidence: candidate.confidence_level
  };
```

(Only this object literal changes — the `agree` early-return branch above it, and everything else in the file, stays exactly as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/contradiction.test.js`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add "Code/src/graph/nodes/contradiction.js" "Code/tests/graph/nodes/contradiction.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Узел contradiction — сохраняет contradictedClaimHistoricalConfidence | v0.6.0

Задача 4 плана Telegram-уведомлений (Слайс 10). candidate.confidence_level
(историческая уверенность существовавшего факта, с которым конфликтует
новый) узел уже читал внутри себя — только чтобы решить, делать ли 3
самоконсистентных замера вместо одного — но никуда не сохранял на
возвращаемом claim'е. Теперь сохраняется как
contradictedClaimHistoricalConfidence — узел notifications (задача 5
этого плана) фильтрует по этому полю, реализуя требование ТЗ "противоречие
с устоявшимся (высокий исторический confidence) фактом", а не с любым
новым противоречием.

17/17 тестов проходят.
EOF
)"
```

---

### Task 5: `src/graph/nodes/notifications.js` — new graph node (assembles and sends the message)

**Files:**
- Create: `Information analysis agent/Code/src/graph/nodes/notifications.js`
- Create: `Information analysis agent/Code/tests/graph/nodes/notifications.test.js`

**Interfaces:**
- Consumes: `state.pendingDecisionMessages` (Task 3), `state.claims[].contradictedClaimHistoricalConfidence`/`hasContradiction` (Task 4), `state.costCapReached` (existing, Слайс 7), `sendNotification` (Task 1).
- Produces: `createNotificationsNode({sendNotification}) -> notificationsNode(state) -> Promise<{}>` — no state channels written (last node before `END`); side effect only (one Telegram message, or none).

- [ ] **Step 1: Write the failing tests**

Create `Information analysis agent/Code/tests/graph/nodes/notifications.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationsNode } from '../../../src/graph/nodes/notifications.js';

function contradictedClaim(overrides = {}) {
  return {
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    hasContradiction: true,
    contradictedClaimHistoricalConfidence: 'высокая',
    contradictionExplanation: 'разные суммы',
    ...overrides
  };
}

function baseState(overrides = {}) {
  return {
    claims: [],
    pendingDecisionMessages: [],
    costCapReached: false,
    ...overrides
  };
}

test('sends nothing when there are no escalations, no cost cap, and no high-confidence contradictions', async () => {
  const sendNotification = async () => { throw new Error('should not be called'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState());

  assert.deepEqual(result, {});
});

test('sends a message listing pending decisions when there are escalations', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({
    pendingDecisionMessages: [{ job_id: 'job-1', question: 'Ожидаемая стоимость повтора $0.15 превышает порог $0.1', estimated_cost_usd: 0.15 }]
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Ожидаемая стоимость повтора/);
  assert.match(sent[0], /0.15/);
});

test('sends a message about the cost cap when costCapReached is true', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({ costCapReached: true }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /\$5/);
});

test('sends a message about a contradiction only when the historical candidate had высокая confidence', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({ claims: [contradictedClaim({ contradictedClaimHistoricalConfidence: 'высокая' })] }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Компания X/);
  assert.match(sent[0], /разные суммы/);
});

test('does NOT send a notification for a contradiction against a средняя/низкая-confidence historical candidate', async () => {
  const sendNotification = async () => { throw new Error('should not be called'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState({ claims: [contradictedClaim({ contradictedClaimHistoricalConfidence: 'средняя' })] }));

  assert.deepEqual(result, {});
});

test('ignores claims where hasContradiction is false, even with contradictedClaimHistoricalConfidence set from an unrelated claim', async () => {
  const sendNotification = async () => { throw new Error('should not be called'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState({ claims: [contradictedClaim({ hasContradiction: false })] }));

  assert.deepEqual(result, {});
});

test('combines all three problem types into one single message, not three separate sends', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({
    pendingDecisionMessages: [{ job_id: 'job-1', question: 'дорого', estimated_cost_usd: 0.2 }],
    costCapReached: true,
    claims: [contradictedClaim()]
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /дорого/);
  assert.match(sent[0], /\$5/);
  assert.match(sent[0], /Компания X/);
});

test('a sendNotification failure is caught and logged, does not throw', async () => {
  const sendNotification = async () => { throw new Error('Telegram HTTP 400'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState({ costCapReached: true }));

  assert.deepEqual(result, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/nodes/notifications.test.js`
Expected: FAIL — module `src/graph/nodes/notifications.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `Information analysis agent/Code/src/graph/nodes/notifications.js`:

```javascript
// src/graph/nodes/notifications.js

const HIGH_CONFIDENCE = 'высокая';

export function createNotificationsNode({ sendNotification }) {
  return async function notificationsNode(state) {
    const pendingDecisions = state.pendingDecisionMessages ?? [];
    const contradictions = (state.claims ?? []).filter(
      (claim) => claim.hasContradiction && claim.contradictedClaimHistoricalConfidence === HIGH_CONFIDENCE
    );
    const costCapReached = state.costCapReached ?? false;

    if (pendingDecisions.length === 0 && contradictions.length === 0 && !costCapReached) {
      return {};
    }

    const message = buildMessage({ pendingDecisions, contradictions, costCapReached });

    try {
      await sendNotification(message);
    } catch (err) {
      console.error('notifications: failed to send Telegram notification:', err.message);
    }

    return {};
  };
}

function buildMessage({ pendingDecisions, contradictions, costCapReached }) {
  const sections = [];

  if (costCapReached) {
    sections.push('⚠️ Достигнут лимит трат на автоповторы за прогон ($5) — дальнейшие автоповторы остановлены.');
  }

  if (pendingDecisions.length > 0) {
    const lines = pendingDecisions.map(
      (d) => `• ${d.question}${d.estimated_cost_usd != null ? ` (≈$${d.estimated_cost_usd})` : ''}`
    );
    sections.push(`📋 Требуют решения (${pendingDecisions.length}):\n${lines.join('\n')}`);
  }

  if (contradictions.length > 0) {
    const lines = contradictions.map(
      (c) => `• ${c.subject}: ${c.predicate}: ${c.object_value ?? ''} — ${c.contradictionExplanation ?? 'противоречит устоявшемуся факту'}`
    );
    sections.push(`⚡ Противоречия с устоявшимися фактами (${contradictions.length}):\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/graph/nodes/notifications.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add "Code/src/graph/nodes/notifications.js" "Code/tests/graph/nodes/notifications.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Узел notifications — собирает и шлёт сводное Telegram-сообщение | v0.6.0

Задача 5 плана Telegram-уведомлений (Слайс 10). Последний узел графа: три
триггера из ТЗ §3.3 — эскалации (state.pendingDecisionMessages, задача 3),
cost cap $5 (state.costCapReached, уже существовал с Слайса 7),
противоречия с устоявшимся фактом (state.claims, отфильтрованные по
hasContradiction && contradictedClaimHistoricalConfidence === 'высокая',
задача 4) — собираются в ОДНО сводное сообщение и отправляются одним
вызовом sendNotification (задача 1), не по три отдельных сообщения. Если
ни одного триггера не сработало — сообщение не отправляется вообще
(тишина, а не "всё хорошо"). Сбой отправки логируется, не роняет прогон —
тот же принцип, что у каждого узла в этом графе.

8/8 тестов проходят.
EOF
)"
```

---

### Task 6: Wire `notifications` into the graph

**Files:**
- Modify: `Information analysis agent/Code/src/graph/index.js`
- Modify: `Information analysis agent/Code/tests/graph/index.test.js`

**Interfaces:**
- Consumes: `createNotificationsNode` (Task 5).
- Produces: `createAnalysisGraph({db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest, sendNotification})` — one new required dependency. Graph order becomes `... → persistResults → globalSynthesis → notifications → END`. `runAnalysis` return shape unchanged.

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
const fakeSendNotification = async () => { throw new Error('should not be called unless the run had something to report'); };

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
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification });

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
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification });

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
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification });

  const result = await runAnalysis([], { reason: 'ceiling' });

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 0);
});

test('throws when embedText is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification }),
    /embedText must be a function/
  );
});

test('throws when judgeDuplicate is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification }),
    /judgeDuplicate must be a function/
  );
});

test('throws when judgeContradiction is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification }),
    /judgeContradiction must be a function/
  );
});

test('throws when retryParse is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification }),
    /retryParse must be a function/
  );
});

test('throws when synthesizeDigest is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, sendNotification: fakeSendNotification }),
    /synthesizeDigest must be a function/
  );
});

test('throws when sendNotification is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest }),
    /sendNotification must be a function/
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

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate, judgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification });

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

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification: fakeSendNotification });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 2, content_type: 'audio', content_ref: 'https://example.com/audio.mp3', result: { transcript: 'слабо' }, confidence: { level: 'низкая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 1);
});

test('end-to-end: a contradiction against a HIGH-confidence historical fact triggers a real Telegram notification', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-3' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-new-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null }),
    contradictions: () => ({ error: null }),
    pending_user_decisions: () => ({ error: null }),
    digests: () => ({ error: null }),
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Компания X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-existing-1', predicate: 'подняла раунд', object_value: '3 млн',
        confidence_level: 'высокая', confidence_explanation: 'ok', similarity: 0.9
      }],
      error: null
    }),
    claim_source_stats: () => ({ data: [], error: null })
  });

  const extractClaims = async () => ({
    claims: [{ subject: 'Компания X', predicate: 'подняла раунд', object_value: '5 млн', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true, costUsd: 0 } : { isDuplicate: false, costUsd: 0 });
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы', costUsd: 0 });
  const sentNotifications = [];
  const sendNotification = async (text) => { sentNotifications.push(text); };

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate, judgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest, sendNotification });

  await runAnalysis(
    [{ job_id: 'job-1', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(sentNotifications.length, 1);
  assert.match(sentNotifications[0], /Компания X/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/graph/index.test.js`
Expected: FAIL — `createAnalysisGraph` doesn't validate/use `sendNotification` yet, and there is no `notifications` node in the graph.

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
import { createNotificationsNode } from './nodes/notifications.js';

export function createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest, sendNotification } = {}) {
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
  if (typeof sendNotification !== 'function') {
    throw new Error('createAnalysisGraph: sendNotification must be a function');
  }

  const escalationNode = createEscalationNode({ db, retryParse });
  const extractClaimsNode = createExtractClaimsNode(extractClaims);
  const dedupNode = createDedupNode({ db, embedText, judgeDuplicate });
  const contradictionNode = createContradictionNode({ judgeContradiction });
  const persistResultsNode = createPersistResultsNode({ db });
  const globalSynthesisNode = createGlobalSynthesisNode({ db, synthesizeDigest });
  const notificationsNode = createNotificationsNode({ sendNotification });

  const compiledGraph = new StateGraph(AnalysisState)
    .addNode('escalation', escalationNode)
    .addNode('extractClaims', extractClaimsNode)
    .addNode('reducer', reducerNode)
    .addNode('dedup', dedupNode)
    .addNode('contradiction', contradictionNode)
    .addNode('persistResults', persistResultsNode)
    .addNode('globalSynthesis', globalSynthesisNode)
    .addNode('notifications', notificationsNode)
    .addEdge(START, 'escalation')
    .addConditionalEdges('escalation', dispatchToExtraction)
    .addEdge('extractClaims', 'reducer')
    .addEdge('reducer', 'dedup')
    .addEdge('dedup', 'contradiction')
    .addEdge('contradiction', 'persistResults')
    .addEdge('persistResults', 'globalSynthesis')
    .addEdge('globalSynthesis', 'notifications')
    .addEdge('notifications', END)
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
Expected: PASS (14 tests).

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run (from `Code`): `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add "Code/src/graph/index.js" "Code/tests/graph/index.test.js"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | Граф: узел notifications последним, после globalSynthesis | v0.6.0

Задача 6 плана Telegram-уведомлений (Слайс 10). createAnalysisGraph
получает новую обязательную зависимость sendNotification (задача 1 этого
плана). Порядок узлов: escalation → dispatcher → Send(extractClaims) →
reducer → dedup → contradiction → persistResults → globalSynthesis →
notifications → END.

Интеграционный тест графа обновлён под новую обязательную зависимость,
плюс новый end-to-end тест: противоречие с историческим confidence
"высокая" реально доходит до настоящей отправки уведомления через весь
граф, не только на уровне отдельного узла.
EOF
)"
```

---

### Task 7: Wire `sendNotification` into `src/index.js`

**Files:**
- Modify: `Information analysis agent/Code/src/index.js`
- Modify: `Information analysis agent/Code/.env`
- Modify: `Information analysis agent/Code/.env.example`

**Interfaces:**
- Consumes: `createTelegramNotifier` (Task 1).
- Produces: real application entry point constructs `sendNotification` and passes it into `createAnalysisGraph`, matching every other dependency already wired there.

**IMPORTANT — this exact class of bug has happened repeatedly in this project.** Do not let it happen again — Step 4 below is mandatory, not optional.

- [ ] **Step 1: Add the new environment variable**

In `Information analysis agent/Code/.env.example`, add (after the `MCP_HTTP_PORT` line):

```
# Telegram-уведомления (Шаг 10) — переиспользует токен бота Агента 1 (общий бот на всю цепочку),
# не отдельная регистрация. TELEGRAM_ALLOWED_USER_ID уже есть выше — используется как chat_id.
TELEGRAM_BOT_TOKEN=
```

In `Information analysis agent/Code/.env` (real values, gitignored), add the same real token value already used by Agent 1 (read it from `Intelligence agent/Code/.env`'s `TELEGRAM_BOT_TOKEN` — do not hardcode a stale copy into this plan document; fetch the current live value at execution time):

```
TELEGRAM_BOT_TOKEN=<same value as Intelligence agent/Code/.env's TELEGRAM_BOT_TOKEN>
```

- [ ] **Step 2: Update `src/index.js`**

Add the import (alongside the existing `createMcpHttpServer` import):

```javascript
import { createTelegramNotifier } from './telegram/notify.js';
```

Add the construction (alongside the existing `telegramId` construction — reuse `TELEGRAM_ALLOWED_USER_ID` as both the existing ingestion filter AND the new notification `chatId`):

```javascript
  const sendNotification = createTelegramNotifier({
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    chatId: requireEnv('TELEGRAM_ALLOWED_USER_ID')
  });
```

Update the `createAnalysisGraph({...})` call to include `sendNotification`:

```javascript
  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest, sendNotification });
```

Note: `requireEnv('TELEGRAM_ALLOWED_USER_ID')` throws if unset, which is stricter than the existing `telegramId` construction a few lines below (`process.env.TELEGRAM_ALLOWED_USER_ID ? Number(...) : undefined`, which tolerates it being unset). This is intentional: `TELEGRAM_ALLOWED_USER_ID` is already required in practice for this deployment (it's set in the real `.env`), and `sendNotification` cannot function at all without a `chatId` — fail loudly at startup rather than silently construct a notifier that can never send anything.

- [ ] **Step 3: Run the full test suite**

Run (from `Code`): `npm test`
Expected: PASS, all tests green (`src/index.js` has no direct test file — verified by the grep check below).

- [ ] **Step 4: Verify the wiring by grep — mandatory, do not skip**

Run: `grep -n "createTelegramNotifier\|sendNotification\|TELEGRAM_BOT_TOKEN" "Code/src/index.js"`

Expected output includes all four of:
1. The import line (`createTelegramNotifier`)
2. The `const sendNotification = createTelegramNotifier(...)` construction line (which also references `TELEGRAM_BOT_TOKEN`)
3. `sendNotification` appearing inside the `createAnalysisGraph({...})` call
4. Nothing else calls `createAnalysisGraph` without `sendNotification`

If any of these is missing, `src/index.js` will throw `createAnalysisGraph: sendNotification must be a function` at startup — do not mark this task done until all four are confirmed present.

- [ ] **Step 5: Commit**

```bash
git add "Code/src/index.js" "Code/.env.example"
git commit -m "$(cat <<'EOF'
Information Analysis Agent | src/index.js — подключает sendNotification (Telegram) | v0.6.0

Завершает план Telegram-уведомлений (Слайс 10). Реальная точка входа
теперь конструирует sendNotification (задача 1 этого плана,
TELEGRAM_BOT_TOKEN переиспользован у Агента 1, TELEGRAM_ALLOWED_USER_ID —
как chat_id) и передаёт его в createAnalysisGraph вместе с остальными
зависимостями. Проверено явным grep по трём ожидаемым строкам — тот же
класс бага (новая зависимость графа не прокинута в реальный entry point)
уже случался в этом проекте несколько раз.
EOF
)"
```

Note: `package.json` version bump to `0.6.0` (already used in commit messages throughout this plan) — check `Information analysis agent/Code/package.json`'s `"version"` field; if it still reads `"0.5.0"`, update it to `"0.6.0"` in this same commit.

---

## After all tasks: final whole-branch review

Once all 7 tasks are complete and committed, dispatch a final whole-branch review over the full commit range for this plan — per the controller's standing instruction for this project, this is the ONLY review pass for this plan. Points the reviewer should specifically check:

- The full `escalation.js`/`contradiction.js` → `state` → `notifications.js` data chain for all three triggers — trace that nothing is silently dropped (e.g. a real cost-cap event that somehow doesn't produce a message, or a genuinely high-confidence contradiction that gets filtered out incorrectly).
- Confirm `notifications` truly never sends when there's nothing to report, and truly always sends exactly one consolidated message (not zero, not several) when there is.
- Confirm the node placement (`globalSynthesis → notifications → END`) means a run that ends in `status: error` (an exception in `persistResults`, which crashes the whole graph invocation before `notifications` is ever reached) genuinely never sends a notification about a run that didn't complete — re-verify this by reading the code, not just trusting the design doc's claim.
- `src/index.js` genuinely wires `sendNotification` all the way through (re-verify independently, per the Task 7 note — this is exactly the class of bug that has slipped through before).
- Plan-alignment / scope-creep check against `docs/superpowers/specs/2026-07-09-telegram-notifications-design.md` — confirm the unified Agent-1-routing vision the user described (out of scope, explicitly deferred) was NOT touched, and no `telegraf` dependency was added.

Per the standing project instruction, do **not** send any real live Telegram message until this review (and any resulting fixes) is complete, and confirm with the user before the live smoke test — it will send a REAL message to the real `TELEGRAM_ALLOWED_USER_ID` via the REAL shared bot token, unlike prior slices' live smoke tests which only touched Supabase/Docker.
