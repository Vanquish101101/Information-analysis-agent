# Дизайн: Детекция противоречий (Шаг 6)

**Дата:** 2026-07-08
**Статус:** Approved
**Соответствует:** `План разработки/5. ТЗ.md` §2.2 шаг 5, §2.4

## Контекст

Граф анализа уже резолвит дубли claims/entities (Слайс 5): `dedup`-узел ищет ближайший
существующий claim по embedding similarity (≥ 0.85) и подтверждает через LLM-judge, схлопывает
подтверждённые дубли. Но claims, которые judge признал **не дублем** (разные факты об одном и
том же subject+predicate — например, разная сумма инвестиций или разная дата) сейчас просто
персистятся как новые записи без анализа — противоречие никак не фиксируется, хотя ТЗ явно
требует: заметное предупреждение, а не тихая новая запись рядом со старой.

Область этого слайса — только **детекция и сохранение** противоречий. Отправка алерта в Telegram —
отдельный, ещё не начатый Слайс 10. Показ противоречий в итоговом дайджесте — Слайс 8
(GlobalSynthesis). Здесь только находим, оцениваем и записываем в БД.

## Решение

```
Reducer → Dedup → Contradiction (новый узел) → persistResults
```

### 1. Переиспользование кандидата из `dedup.js`

`dedup.js` уже вызывает `match_claims` и `judgeDuplicate` для каждого claim с резолвленной
существующей entity. Сейчас при вердикте "не дубль" кандидат просто отбрасывается. Меняем
`resolveClaimDuplicate` — при вердикте "не дубль" возвращать не `null`, а сам кандидат с пометкой
`judgedDuplicate: false`, чтобы `resolveClaim` мог передать его дальше на резолвленном claim как
`contradictionCandidate` (объект `{id, predicate, object_value, confidence_level,
confidence_explanation, similarity}` — то же, что уже возвращает `match_claims`, второй RPC/embedding
вызов не нужен).

Если кандидата не было вовсе (entity новая, или похожих claims в БД не нашлось) —
`contradictionCandidate: null`, `contradiction`-узел для такого claim ничего не делает.

**Явное ограничение:** кандидат для проверки на противоречие — только тот же самый ближайший
кандидат, что уже нашёл dedup по embedding similarity ≥ 0.85. Если два факта об одном и том же
subject+predicate сформулированы настолько по-разному, что их полный embedding (`subject:
predicate: object_value`) не попадает в этот порог — противоречие в MVP не будет замечено. Приемлемый
компромисс: экономит вызовы, и в реальном сквозном прогоне Слайса 5 подтверждено, что близкие по
смыслу факты (несмотря на разную формулировку) дают высокую embedding similarity.

### 2. `src/llm/judgeContradiction.js` — новый LLM-judge

```js
createContradictionJudge({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch })
  -> judgeContradiction({ newClaimText: string, existingClaimText: string })
  -> Promise<{ label: 'agree'|'contradict'|'unclear', confidenceLevel: 'высокая'|'средняя'|'низкая', explanation: string }>
```

Тот же OpenRouter-паттерн, что `judgeDuplicate.js` (включая опциональный `heliconeApiKey`, см.
Слайс наблюдаемости) — отдельный файл, а не переиспользование `judgeDuplicate`, так как вопрос
судье принципиально другой ("согласуются или противоречат", а не "одно и то же ли это"), и
возвращаемая форма другая. `confidenceLevel` — те же три строки `высокая/средняя/низкая`, что и
везде в системе (не числовая шкала — консистентность словаря).

**Вердикт `unclear` трактуется как `contradict`** узлом-потребителем (не самим judge) — решение
уже принято в брейншторминге: если судья не уверен, что факты согласуются — безопаснее показать
пользователю, чем тихо пропустить.

### 3. `src/graph/nodes/contradiction.js` — новый узел

Для каждого claim с непустым `contradictionCandidate`:

1. Получение сырого вердикта:
   - Если `contradictionCandidate.confidence_level === 'высокая'` — **self-consistency**: 3
     независимых вызова `judgeContradiction` (реальные отдельные LLM-вызовы, без кеширования).
     Голосование большинством по трём меткам `agree`/`contradict`/`unclear` **как есть** (без
     нормализации на этом шаге). При ничьей между тремя разными метками (1-1-1) — итоговая сырая
     метка `unclear`.
   - Иначе — один вызов `judgeContradiction`, его `label` — сразу итоговый сырой вердикт.
2. **Нормализация** (применяется одинаково к обоим путям выше, отдельным шагом после получения
   сырого вердикта): если сырой вердикт — `unclear`, для целей алерта он трактуется как `contradict`
   (решение из брейншторминга). Итоговая переменная `effectiveLabel` = `contradict`, если сырой
   вердикт `contradict` или `unclear`; `agree` — иначе.
3. Если `effectiveLabel === 'contradict'` — помечает claim: `hasContradiction: true,
   contradictsClaimId: candidate.id, contradictionRawLabel` (сырая метка — `contradict` или
   `unclear`, для колонки `label` в БД), `contradictionConfidenceLevel`, `contradictionExplanation`.
4. Если `effectiveLabel === 'agree'` — ничего не помечает, claim обрабатывается как обычно.

Как и `dedup.js` — ошибка на одном claim (сбой LLM-вызова) не должна ронять весь батч: claim
трактуется как без противоречия (`hasContradiction: false`), ошибка добавляется в `state.errors`.

Узел возвращает `{ claims: new Overwrite(resolvedClaims), errors: newErrors }` — тот же паттерн
работы с reducer-каналами, что и `dedup.js` (см. заметку про `Overwrite` в дизайне Слайса 5).

### 4. Новая таблица `contradictions` (миграция)

```sql
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
```

`label` хранит исходный вердикт judge (`contradict` или `unclear`, изначальный `agree` строк не
создаёт) — сохраняем нюанс на будущее (например, для Слайса 8 могло бы иметь смысл показывать
`unclear`-случаи менее настойчиво, чем подтверждённый `contradict`), даже если в MVP оба ведут себя
одинаково (алерт/запись).

### 5. Изменения в `persistResults.js`

`claim_a_id` — это ещё не вставленная новая claim, у неё нет id до момента INSERT. Порядок:

1. Как и раньше — вставляет `claims` для claim'ов, не являющихся дублями (`isDuplicate: false`,
   `claimEmbedding != null`).
2. **После** успешной вставки — если у claim было `hasContradiction: true`, вставляет строку в
   `contradictions`: `claim_a_id = только что созданный id`, `claim_b_id = contradictsClaimId`,
   `label = contradictionRawLabel`, `confidence_level = contradictionConfidenceLevel`,
   `explanation = contradictionExplanation`.
3. Ошибка вставки в `contradictions` — не должна откатывать уже вставленный claim (сам факт
   останется в базе корректно, потеряется только пометка о противоречии) — логируется через
   `console.error`, не бросает исключение (тот же принцип "не роняем прогон из-за вторичной
   записи", что уже применяется к `runs.update()` на статус).

## Обработка ошибок

- Сбой `judgeContradiction` (в т.ч. в self-consistency — сбой одного из 3 вызовов) — весь claim
  трактуется как без противоречия, ошибка добавляется в `errors[]`, остальные claims не
  затрагиваются.
- Сбой записи в `contradictions` в `persistResults.js` — логируется, не бросает исключение, не
  влияет на уже вставленный claim.

## Тестирование

Полностью через DI + фейки, без живых вызовов в `npm test` (как и во всех предыдущих слайсах):

- `judgeContradiction.js` — фейковый `fetchImpl`: URL/заголовки (включая Helicone-путь), парсинг
  трёх вариантов вердикта, обработка невалидного JSON/HTTP-ошибки.
- `dedup.js` — обновляются существующие тесты под новую форму возврата `resolveClaimDuplicate`
  (кандидат вместо `null` при "не дубль"); новый тест: claim без кандидата → `contradictionCandidate:
  null`.
- `contradiction.js` — фейковые `judgeContradiction`/данные кандидата: нет кандидата (пропуск),
  `agree` (не помечает), `contradict` (помечает), `unclear` (трактуется как `contradict`),
  self-consistency срабатывает только при `confidence_level: 'высокая'` у кандидата (проверить, что
  при других уровнях — ровно 1 вызов judge, при "высокая" — ровно 3), голосование большинством,
  ошибка на одном claim не роняет остальные.
- `persistResults.js` — новый тест: claim с `hasContradiction: true` создаёт строку в
  `contradictions` с правильными `claim_a_id`/`claim_b_id` после вставки claim'а; существующие
  тесты (без противоречий) не должны сломаться.

## Явно не входит в этот слайс

- Отправка Telegram-алерта при обнаружении противоречия (ТЗ §3.3) — Слайс 10.
- Отображение `contradictions` в `analysis_digest` — Слайс 8 (GlobalSynthesis) и Слайс 9 (MCP-сервер).
- Контроль стоимости доп. LLM-вызовов (self-consistency = до 3 вызовов на claim) — `cost_usd`
  по-прежнему не считается реально (Слайс 7).
- Ретроактивная проверка уже существующих в БД claims друг против друга — механизм работает только
  вперёд, для новых claims с этого момента (тот же принцип, что и в Слайсе 5 про дедупликацию).

## Открытые вопросы

Нет — все решения приняты в ходе брейншторминга (см. диалог перед этим документом).
