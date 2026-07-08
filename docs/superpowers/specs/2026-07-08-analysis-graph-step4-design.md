# Дизайн: Граф анализа LangGraph — Шаг 4 (механика графа, реальные вызовы)

**Дата:** 2026-07-08
**Статус:** Approved
**Соответствует:** `План разработки/8. Разработка.md` §4 Шаг 4, `План разработки/7. Архитектура (Бекенд).md` §5

## Контекст

Ingestion-слой и планировщик батча (`docs/superpowers/specs/2026-07-08-batch-scheduler-design.md`) уже
готовы и протестированы (54/54 тестов). Следующий компонент по дорожной карте MVP — граф анализа
LangGraph. Роадмап явно выделяет Шаг 4 как "Dispatcher → Send → Reducer — просто собрать claims без
дедупа/сверки, проверить механику графа", оставляя Дедупликацию (Шаг 5), Детекцию противоречий
(Шаг 6), Эскалацию (Шаг 7) и GlobalSynthesis (Шаг 8) отдельными последующими слайсами.

В отличие от первоначального предположения ("механика графа" через заглушку без реального
извлечения), по решению пользователя этот слайс делает **реальное** извлечение claims через LLM
(OpenRouter) и **реальную** запись результата в Supabase — обе интеграции впервые появляются в
кодовой базе Агента 3. Юнит-тестируемость сохраняется тем же способом, что и везде в проекте:
зависимости (LLM-вызов, Supabase-клиент) инжектируются, в тестах подставляются фейки.

Перед началом дизайна проверено и подготовлено реальное окружение:
- Миграция `001_information_analysis_agent_schema.sql` применена к живому проекту Supabase
  `Marketing agency` (id `wklecdbujgdwnbmfmggi`) — все 5 таблиц схемы `information_analysis_agent`
  существуют.
- `Code/.env` создан с реальными `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (тот же проект, что у
  Агента 1/2) и `OPENROUTER_API_KEY` (тот же ключ, что уже используют Агент 1 и Агент 2).
- Отдельно зафиксировано (не блокирует эту работу): RLS отключён на всех новых таблицах — тот же
  компромисс, что уже принят для Агента 1/2 в этом проекте; отдельный вопрос безопасности по всей
  цепочке агентов, не предмет этого слайса.

## Решение

Строим граф как 4 связанных модуля + один узел для реального LLM-вызова, все — на инжектируемых
зависимостях:

```
Dispatcher → Send×N (extractClaims, реальный вызов OpenRouter) → Reducer → persistResults (запись в Supabase) → END
```

Пакет: `@langchain/langgraph` (`^1.4.7`, пир-зависимости `@langchain/core ^1.1.48`, `zod`).

## Компоненты

### 1. `src/llm/extractClaims.js`

```js
createOpenRouterExtractor({ apiKey, model = 'anthropic/claude-haiku-4-5', fetchImpl = fetch })
  → extractClaims(item: NormalizedItem) → Promise<RawClaim[]>
```

где `RawClaim = { subject, predicate, object_value, confidence_level, confidence_explanation }`
(`confidence_level` — одна из литеральных строк `'высокая' | 'средняя' | 'низкая'`, как в схеме БД).

- Модель `anthropic/claude-haiku-4-5` — та же, что уже использует Агент 1 для похожей по духу задачи
  (точечный анализ через OpenRouter, см. `Intelligence agent/Code/src/agents/transcriber/index.js`)
  — дешёвая модель для точечного извлечения, не для синтеза (тот — Шаг 8, другая модель).
  Обращение — `fetch('https://openrouter.ai/api/v1/chat/completions', ...)` с теми же заголовками,
  что уже используются в проекте (`Authorization: Bearer`, `HTTP-Referer`, `X-Title`), тело —
  `model`, `messages`, промпт с требованием строгого JSON-массива на выходе.
- `fetchImpl` инжектируется отдельно от `apiKey` — в тестах подставляется фейковый `fetch`, реальный
  ключ не нужен для юнит-тестов этого модуля.
- Парсинг ответа — строгий (`JSON.parse` на извлечённом тексте). Если LLM вернул не-JSON или пустой
  массив — функция бросает описательную ошибку; вызывающий узел графа сам решает, что с этим делать
  (см. "Обработка ошибок" ниже) — сама функция не проглатывает ошибки молча.

### 2. `src/graph/state.js`

Аннотация состояния LangGraph (`Annotation.Root`):

- `items: NormalizedItem[]` — вход батча (без reducer, задаётся один раз в начале).
- `reason: 'idle' | 'ceiling'` — из `onBatchReady`, без reducer.
- `runId: string` — генерируется в `persistResults` при создании строки `runs`, без reducer.
- `claims: RawClaim[]` (с `source`-метаданными, добавленными на этапе extractClaims) — reducer:
  конкатенация массивов со всех параллельных веток `Send`.
- `errors: string[]` — reducer: конкатенация, по одной записи на упавший item.

### 3. `src/graph/nodes/dispatcher.js`

Читает `state.items`, возвращает массив `Send('extractClaims', { item })` — один на каждый элемент
батча (fan-out).

### 4. `src/graph/nodes/extractClaims.js`

Узел-цель `Send`. Получает `{ item }`, вызывает инжектированный `extractClaims(item)`. Оборачивает
вызов в `try/catch`: при ошибке — не роняет весь прогон, добавляет запись в `errors[]`
(`` `item ${item.job_id}: ${err.message}` ``), возвращает `{ claims: [] }` для этой ветки. При успехе
— к каждому `RawClaim` добавляется `source: { agent: item.agent, jobId: item.job_id, refType: item.content_type }`
(нужно `persistResults`, чтобы создать строку `sources`), возвращает `{ claims: [...] }`.

### 5. `src/graph/nodes/reducer.js`

Явный узел после параллельного сбора (сам сбор уже сделан механизмом `Send`/reducer состояния LangGraph) —
фиксирует агрегаты (`claimCount = state.claims.length`) для передачи дальше и для логирования; не
меняет состав `claims`/`errors`.

### 6. `src/graph/nodes/persistResults.js`

Пишет в Supabase через инжектированный `db` (тот же клиент, что у `agent1Reader`/`agent2Reader`):

1. Создаёт строку `runs` (`status: 'running'`, `items_processed: state.items.length`, `cost_usd: 0`).
2. Для каждого уникального `(agent, jobId)` из `claims[].source` — одна строка `sources`
   (`agent`, `source_type: refType`, `raw_job_id: jobId`).
3. Для каждого `RawClaim` — **новая** строка `entities` на `subject` (без дедупа/поиска существующей
   — намеренное упрощение этого слайса, консолидация дублей будет в Шаге 5, где уже есть план по
   embedding-схожести), затем строка `claims` со `subject_entity_id` на неё, `object_value` как
   текст (**`object_entity_id` в этом слайсе не заполняется** — надёжное сопоставление object'а с
   entity требует более зрелой схемы predicate'ов, отложено), `confidence_level`/`confidence_explanation`
   из `RawClaim`, `source_id` на соответствующую строку `sources`.
4. Обновляет `runs.status`: `'ok'`, если `errors` пуст, иначе `'partial'`. Если сама запись в
   Supabase падает на любом шаге — `runs.status` выставляется в `'error'` (если строка `runs` вообще
   успела создаться), ошибка пробрасывается наверх из `persistResults`.

### 7. `src/graph/index.js`

```js
createAnalysisGraph({ db, extractClaims, now = () => new Date() })
  → runAnalysis(items: NormalizedItem[], { reason }) → Promise<{ runId, status, claimsWritten, errors }>
```

Собирает `StateGraph` (Dispatcher → `Send` → Reducer → persistResults → END), компилирует один раз
при создании. `runAnalysis` — сигнатура **идентична** `onBatchReady`, ожидаемой планировщиком
(`docs/superpowers/specs/2026-07-08-batch-scheduler-design.md`) — это и есть будущий колбэк, просто
подключение к `createScheduler(...)` — отдельный маленький слайс после этого (нужен `.env` с
`REDIS_URL`/production entry point, здесь не рассматривается).

## Обработка ошибок и стоимость

- Ошибка извлечения на одном item не роняет весь прогон (см. `extractClaims.js` узел выше) —
  партиционная устойчивость, тот же принцип, что в `pollQueues`.
- `cost_usd` в `runs` остаётся `0` в этом слайсе. Реальный подсчёт стоимости за прогон и cost cap —
  явно предмет Шага 7 (Эскалация/контроль качества), не этого слайса.
- Ошибка самой записи в Supabase (`persistResults`) не перехватывается на уровне графа — пробрасывается
  вызывающему коду `runAnalysis`, чтобы не потерять сигнал о реальном сбое записи результата.

## Тестирование

Полностью через DI + фейки, без живых вызовов в `npm test`:

- `extractClaims.js` — фейковый `fetchImpl`, проверка формирования запроса (модель, заголовки),
  парсинга валидного JSON-ответа, и явной ошибки на невалидном/пустом ответе.
- Каждый узел графа (`dispatcher`, `extractClaims`-узел, `reducer`, `persistResults`) —
  тестируется как обычная функция с фейковыми `db`/`extractClaims`, без сборки полного графа.
- `graph/index.js` (`createAnalysisGraph`/`runAnalysis`) — интеграционный тест на уровне модуля:
  фейковые `db` + `extractClaims`, несколько items (включая один, где `extractClaims` бросает
  ошибку — проверка партиционной устойчивости), проверка итоговых `runs`/`entities`/`sources`/`claims`
  через фейковый `db`, проверка возвращаемого `{ runId, status, claimsWritten, errors }`.

## Явно не входит в этот слайс

- Дедупликация entities/claims (embedding + LLM-judge подтверждение) — Шаг 5.
- Детекция противоречий — Шаг 6.
- Контроль стоимости / эскалация через video-pipeline MCP, реальный `cost_usd` — Шаг 7.
- GlobalSynthesis (дайджест) — Шаг 8.
- Подключение `runAnalysis` как реального `onBatchReady` в `createScheduler` (production entry point,
  Redis, `docker-compose.yml`) — отдельный маленький слайс после этого.
- `object_entity_id` заполнение (сопоставление object'а с существующей/новой entity).

## Открытые вопросы

- Точный промпт для `extractClaims` (формулировка, температура, ограничение длины `result` в
  промпте) — фиксируется на этапе написания плана реализации, не архитектурное решение.
- Поведение при пустом `result` (например, `NormalizedItem.result === null`, fallback только
  `telegram_text_fallback`) — `extractClaims` должен либо использовать fallback-текст, либо
  осмысленно вернуть пустой список claims без ошибки; уточняется в плане реализации.
