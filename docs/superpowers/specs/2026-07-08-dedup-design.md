# Дизайн: Дедупликация claims/entities (Шаг 5)

**Дата:** 2026-07-08
**Статус:** Approved
**Соответствует:** `План разработки/3. Брейншторминг.md` §1/§5, `План разработки/7. Архитектура (Бекенд).md` §5.1, `8. Разработка.md` §4 Шаг 5

## Контекст

Граф анализа (Шаг 4) уже реально извлекает claims через LLM и пишет их в Supabase, но с намеренным
упрощением: каждый claim создаёт **новую** запись `entities`, без проверки на дубли — консолидация
была явно отложена до этого слайса. Задача Шага 5: "дедупликация на уровне смысла, а не текста"
(разные формулировки одного факта от Агента 1/2 должны схлопываться) — через embedding similarity
≥ 0.85 + LLM-judge подтверждение перед слиянием, не автослияние по чистой дистанции.

Перед дизайном проверен реальный API Gemini Embedding (ключ уже существует в `.env` Агента 2,
тот же аккаунт переиспользуется): модель `gemini-embedding-001` по умолчанию отдаёт 3072 измерения,
но поддерживает параметр `outputDimensionality: 768`, который реально возвращает ровно 768 —
существующие колонки `vector(768)` в схеме подходят без изменений схемы. Это закрывает TODO,
оставленный в комментарии оригинальной миграции.

Область поиска дублей — **вся накопленная история в БД**, не только текущий батч (иначе дубли между
разными прогонами продолжали бы копиться, что и было причиной откладывания этой задачи).

## Решение

```
Reducer → Dedup (новый узел) → persistResults
```

### 1. Новая миграция: SQL-функции векторного поиска

Supabase JS-клиент не поддерживает `<=>`-операторы pgvector через обычный fluent-API — нужны две
SQL-функции, вызываемые через `db.rpc(...)`:

```sql
CREATE OR REPLACE FUNCTION information_analysis_agent.match_entities(
  query_embedding vector(768),
  match_threshold float,
  match_count int DEFAULT 3
)
RETURNS TABLE (id uuid, name text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT id, name, 1 - (embedding <=> query_embedding) AS similarity
  FROM information_analysis_agent.entities
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) >= match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION information_analysis_agent.match_claims(
  query_embedding vector(768),
  match_threshold float,
  for_subject_entity_id uuid,
  match_count int DEFAULT 3
)
RETURNS TABLE (id uuid, predicate text, object_value text, confidence_level text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT id, predicate, object_value, confidence_level,
         1 - (embedding <=> query_embedding) AS similarity
  FROM information_analysis_agent.claims
  WHERE embedding IS NOT NULL
    AND subject_entity_id = for_subject_entity_id
    AND 1 - (embedding <=> query_embedding) >= match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

`match_claims` намеренно ограничен `for_subject_entity_id` — сравнение claims имеет смысл только в
рамках уже резолвленной сущности (иначе поиск похожих формулировок по всей таблице claims шумит и
стоит дороже без пользы).

### 2. `src/embeddings/embedText.js`

```js
createGeminiEmbedder({ apiKey, fetchImpl = fetch }) -> embedText(text) -> Promise<number[]>
```

Реальный вызов `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=...`
с `outputDimensionality: 768` в теле запроса. `fetchImpl` инжектируется — тесты без живого ключа,
тот же паттерн, что `extractClaims.js`.

### 3. `src/llm/judgeDuplicate.js`

```js
createDuplicateJudge({ apiKey, model = 'anthropic/claude-haiku-4-5', fetchImpl = fetch })
  -> judgeDuplicate({ kind: 'entity'|'claim', new: string, candidate: string })
  -> Promise<{ isDuplicate: boolean, reasoning: string }>
```

Тот же OpenRouter-паттерн, что `extractClaims.js` — промпт запрашивает строгий JSON
`{is_duplicate, reasoning}`. Вызывается **только когда есть кандидат** выше порога 0.85 — не на
каждый claim, экономия на пустых случаях (архитектурный принцип "дёшево — сам, дорого — спроси" уже
применялся к эскалации, здесь тот же дух: не тратим LLM-вызов, если сравнивать не с чем).

### 4. `src/graph/nodes/dedup.js`

Обрабатывает `state.claims` **последовательно** (не параллельно) — нужен доступ к решениям,
принятым для более ранних claims в этом же батче, до того как они попадут в БД:

Для каждого claim:
1. `embedText(claim.subject)` → subject-эмбеддинг
2. Сначала проверка **внутри батча**: есть ли уже резолвленная в этом прогоне entity с тем же
   именем/близким эмбеддингом (простое сравнение по уже накопленной в узле карте
   `subjectText -> {entityId, embedding}` за этот прогон, до похода в БД) — предотвращает дубли
   внутри одного батча, которые иначе появятся снова при следующем прогоне.
3. Если не найдено внутри батча — `db.rpc('match_entities', {query_embedding, match_threshold: 0.85})`.
   Если кандидат есть — `judgeDuplicate({kind: 'entity', new: subject, candidate: match.name})`.
   Если `isDuplicate` — переиспользуем `match.id` как `subjectEntityId`. Иначе (нет кандидата, или
   LLM сказал "не то же самое") — помечаем claim как "нужна новая entity", несём дальше
   subject-эмбеддинг для записи при создании.
4. То же самое для самого claim'а целиком (`subject: predicate: object_value` в одну строку для
   эмбеддинга) — поиск через `match_claims`, ограниченный уже резолвленным `subjectEntityId`.
5. Если claim признан дублем существующего — помечает его `duplicateOfClaimId` и вычисляет новый
   `confidence_level` для старого claim'а (см. правило ниже), **не создаёт новую строку claims**.
6. Возвращает обогащённые claims: каждый либо `{ ...claim, subjectEntityId (существующий),
   isDuplicate: true, duplicateOfClaimId, bumpedConfidenceLevel }`, либо
   `{ ...claim, subjectEntityId: null, subjectEmbedding, claimEmbedding }` (новая entity/claim,
   персистятся в `persistResults` как раньше, но теперь с эмбеддингом).

**Правило повышения confidence при дубле:** `низкая → средняя → высокая`, не выше `высокая`, не
понижается никогда. `confidence_explanation` дополняется припиской вида
`" Подтверждено дополнительным источником (agent {agent}, job {jobId})."`.

### 5. Изменения в `persistResults.js`

- При создании **новой** entity — теперь пишет `embedding` (полученный от Dedup), не только `name`.
- При создании **новой** claim — то же самое для `embedding`.
- Для claims, помеченных `isDuplicate: true` — не создаёт новую строку `claims`, вместо этого
  `UPDATE claims SET confidence_level = ..., confidence_explanation = ... WHERE id = duplicateOfClaimId`.
- Подсчёт `sources`/сущностей для статистики прогона (`items_processed` и т.п.) не меняется.

## Обработка ошибок

- Ошибка эмбеддинга или LLM-judge для одного claim — не должна ронять обработку остальных claims в
  батче (та же партиционная устойчивость, что уже в `extractClaims`-узле графа): при сбое — claim
  просто трактуется как "новый" (без резолва дубля), в `errors[]` добавляется запись, обработка
  батча продолжается.
- Ошибка самого RPC-вызова (`match_entities`/`match_claims`) — так же трактуется как "кандидатов не
  найдено", не как фатальная ошибка узла.

## Тестирование

Полностью через DI + фейки, без живых вызовов в `npm test`:

- `embedText.js` — фейковый `fetchImpl`, проверка `outputDimensionality: 768` в теле запроса,
  парсинг ответа, обработка ошибок.
- `judgeDuplicate.js` — фейковый `fetchImpl`, аналогично `extractClaims.js`.
- `dedup.js` — фейковые `embedText`/`judgeDuplicate`/`db.rpc`, покрытие: нет кандидата (создаём
  новое), кандидат есть но LLM говорит "не то же" (создаём новое), кандидат подтверждён (переиспользуем
  entity/помечаем claim дублем), дубль внутри одного батча (без похода в БД), ошибка на одном claim
  не роняет остальные.
- `persistResults.js` — добавляются тесты на запись `embedding` при создании и на `UPDATE` вместо
  `INSERT` при дубле claim'а; существующие тесты (запись без дублей) не должны сломаться.

## Явно не входит в этот слайс

- Детекция противоречий (Шаг 6) — отдельный последующий слайс.
- Контроль стоимости/эскалация (Шаг 7), реальный `cost_usd` — эмбеддинги и LLM-judge вызовы в этом
  слайсе тоже не считаются в `cost_usd` (остаётся `0`, как и раньше).
- GlobalSynthesis (Шаг 8).
- Изменение `object_entity_id` (по-прежнему не заполняется — сопоставление object'а с entity вне
  области этого слайса).
- Ретроактивная дедупликация уже существующих в БД дублей (созданных в Шаге 4 до этого слайса) —
  новый механизм работает только вперёд, для новых claims с этого момента.

## Открытые вопросы

- Порог 0.85 — предварительное значение из архитектурного документа, точная калибровка (v1.5 по
  роадмапу) — не предмет этого слайса.
- Формат текста для эмбеддинга claim'а целиком (`"subject: predicate: object_value"` конкатенация) —
  фиксируется на этапе написания плана реализации, не архитектурное решение.
