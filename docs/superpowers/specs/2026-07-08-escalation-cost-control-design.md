# Дизайн: Эскалация / контроль стоимости (Шаг 7)

**Дата:** 2026-07-08
**Статус:** Approved
**Соответствует:** `План разработки/5. ТЗ.md` §2.2 шаг 6, §2.3, §2.4 (реальный `cost_usd`)

## Контекст

Граф анализа сейчас не делает ничего с тем, что item пришёл от Агента 1/2 с низкой уверенностью —
он просто анализируется как есть, наравне с уверенными данными. ТЗ требует логику эскалации:
автоматический повтор разбора (с лимитом), эскалацию пользователю при дорогом/повторном случае, и
жёсткий потолок трат на повторы за прогон. Кроме того, `runs.cost_usd` везде жёстко `0` — реальная
стоимость нигде не считается, хотя API это позволяют.

Перед дизайном проверено вживую:
- OpenRouter отдаёт точную стоимость вызова в USD, если запросить `usage: {include: true}` в теле
  запроса — поле `usage.cost` в ответе. Подтверждено реальным вызовом.
- Gemini `embedContent` стоимость вообще не сообщает (только `embedding`, без `usageMetadata`) —
  цену эмбеддинга нельзя узнать точно, только оценить по официальному тарифу ($0.15 за 1М входных
  токенов для `gemini-embedding-001`, стандартный тариф).
- У Агента 2 в `deep_parsing_agent.parsing_jobs` есть колонка `content_ref` (Агент 3 её пока не
  читает — читает только `content_type`) — то есть повтор через Агента 2 физически возможен для
  item'ов с `agent === 2`, если начать читать эту колонку.
- Агент 2 в проде поднимает MCP Streamable HTTP на `/mcp` (порт `MCP_HTTP_PORT`, по умолчанию
  `7301`), пакет `@modelcontextprotocol/sdk` (`^1.12.1`, та же версия, что уже используется в Агенте
  1/2) — официальный клиент этого SDK, а не ручной fetch, корректно работает с этим транспортом.

## Решение

```
START → escalation (новый узел) → dispatcher → Send(extractClaims) → reducer → dedup → contradiction → persistResults → END
```

### 1. Механизм повтора — только для item'ов от Агента 2

Item от Агента 1 (поисковый агрегат — `result.raw.perplexity`/`youtube`/`firecrawl` сразу, не один
URL) физически нельзя "перепарсить ещё раз" через Агента 2 — у него нет единого `content_ref`.
Если такой item пришёл с низкой уверенностью — сразу эскалация в `pending_user_decisions`, повтор
не пытается. Только item'ы от Агента 2 (`agent === 2`, есть `content_ref`) могут пройти автоповтор.

Повтор всегда идёт с `mode: 'deep'` (принципиально более тщательный разбор Агентом 2), а не
буквальное повторение того же запроса — иначе нет причин ожидать другого результата.

### 2. `src/mcp-clients/deepParsingClient.js` — новый MCP-клиент

```js
createDeepParsingClient({ baseUrl, ClientImpl = Client, TransportImpl = StreamableHTTPClientTransport })
  -> retryParse({ contentRef, contentType }) -> Promise<{ result: object, confidence: {level, explanation}, meta: {cost_usd, ...} }>
```

`ClientImpl`/`TransportImpl` инжектируются (по умолчанию — реальные классы из
`@modelcontextprotocol/sdk`) специально для тестов: фейковый `ClientImpl` — простой класс с
`connect()`/`callTool()`/`close()`, без сети. Вызывает инструмент `deepparsing_parse` Агента 2 с
`{ content_ref: contentRef, content_type: contentType, mode: 'deep' }`, парсит JSON из
`response.content[0].text` (MCP-инструменты возвращают контент как текстовый блок, см. `server.js`
Агента 2 — `JSON.stringify(result, null, 2)` внутри `content: [{type: 'text', text: ...}]`).

### 3. `src/graph/nodes/escalation.js` — новый узел (первый в графе)

Обрабатывает `state.items` последовательно (не через `Send` — нужен доступ к накопленной трате на
повторы **между** item'ами того же прогона, до похода в БД):

Для каждого item:
1. `confidence.level !== 'низкая'` → пропускаем без изменений.
2. `agent === 1` (нет `content_ref`) → в `pending_user_decisions`
   (`question: 'Повтор невозможен: нет content_ref (результат поиска, не парсинга)'`), счётчик
   `escalationsPendingUser += 1`, item идёт дальше как есть.
3. Уже потрачено ≥ $5 на повторы в этом прогоне → `costCapReached = true`, в
   `pending_user_decisions` (`question` про достижение лимита), `escalationsPendingUser += 1`, item
   как есть, дальнейшие item'ы этого прогона тоже не пытаются повтор (тот же счётчик уже ≥ $5).
4. Ожидаемая стоимость повтора (см. ниже) > $0.10 → в `pending_user_decisions`
   (`estimated_cost_usd` заполнено), `escalationsPendingUser += 1`, item как есть.
5. Иначе — реальный вызов `retryParse({contentRef: item.content_ref, contentType: item.content_type})`.
   - Успех: заменяет `item.result`/`item.confidence` результатом повтора, прибавляет
     `retried.meta.cost_usd` к бегущей трате на повторы, `escalationsAuto += 1`.
   - Ошибка (сеть/таймаут/Агент 2 недоступен): не роняет узел — в `pending_user_decisions`
     (`question` с текстом ошибки), `escalationsPendingUser += 1`, item остаётся с исходными
     (неповторёнными) данными.

Оценка стоимости повтора (шаг 4) — статическая таблица по `content_type` (предварительные значения,
калибруются по факту, не архитектурное решение):

```js
const CONTENT_TYPE_RETRY_COST_ESTIMATES = {
  video: 0.15, audio: 0.05, document: 0.03, image: 0.02, text: 0.01
};
```

(`video` дороже порога $0.10 намеренно — по ТЗ такие ретраи чаще должны эскалироваться, а не
выполняться автоматически; остальные типы дешевле порога.)

Возвращает: `{ items: <обновлённый массив>, escalationsAuto, escalationsPendingUser, costUsdRetry,
costCapReached }`. Запись строк в `pending_user_decisions` происходит прямо в этом узле (не
откладывается до `persistResults`) — эскалации должны быть видны пользователю независимо от того,
чем закончится остальной прогон.

### 4. Реальный `cost_usd` по всему конвейеру

Раздельные бегущие суммы (не одна общая — см. ниже, зачем): **`costUsdRetry`** (только из
`escalation`-узла, повторы через Агента 2 — по сути "стоимость парсинга") и **`costUsdAnalysis`**
(извлечение + дедуп + противоречия — "стоимость анализа" внутри самого Агента 3). Разделены
намеренно: когда позже (Шаг 8 GlobalSynthesis или дашборд расходов v1.5/v2.0) понадобится показать
разбивку "стоимость парсинга / стоимость анализа / [в будущем] стоимость генерации контента у
Агента 4" — эти два числа уже будут посчитаны отдельно, не нужно будет восстанавливать разбивку
задним числом. Сама разбивка в вывод пользователю в этом слайсе не выводится — только считается и
пишется в БД.

Изменения возвращаемых значений (все — DI-функции, инжектируются как раньше, просто теперь
возвращают на одно поле больше):

- `extractClaims(item) -> Promise<{ claims: RawClaim[], costUsd: number }>` (было: `RawClaim[]`)
- `embedText(text) -> Promise<{ embedding: number[], costUsd: number }>` (было: `number[]`) —
  `costUsd` здесь ВСЕГДА оценка (Gemini не сообщает реальную цену): `estimatedTokens = Math.ceil(text.length / 4)`,
  `costUsd = estimatedTokens / 1_000_000 * 0.15`.
- `judgeDuplicate(...) -> Promise<{ isDuplicate, reasoning, costUsd }>` (было без `costUsd`)
- `judgeContradiction(...) -> Promise<{ label, confidenceLevel, explanation, costUsd }>` (было без `costUsd`)

Для OpenRouter-функций (`extractClaims`, `judgeDuplicate`, `judgeContradiction`) — добавить
`usage: { include: true }` в тело запроса, читать `data.usage.cost` (число в USD, уже проверено
живым вызовом), пробрасывать как `costUsd`.

Узлы-потребители обновляются под новую форму возврата:
- `extractClaimsNode` — распаковывает `{claims, costUsd}`, возвращает
  `{claims, errors, costUsdAnalysis: costUsd}` (per-item, суммируется реducer'ом по всем параллельным
  `Send`-веткам).
- `dedup.js` — суммирует `costUsd` от каждого вызова `embedText`/`judgeDuplicate` внутри обработки
  одного claim, возвращает суммарный `costUsdAnalysis` за весь узел одним числом.
- `contradiction.js` — суммирует `costUsd` от 1 или 3 вызовов `judgeContradiction` на claim,
  возвращает суммарный `costUsdAnalysis` за весь узел одним числом.

### 5. `AnalysisState` — новые каналы

```js
costUsdAnalysis: Annotation({ reducer: (a, b) => a + b, default: () => 0 }),  // сумма: extractClaims (по веткам Send) + dedup + contradiction
costUsdRetry: Annotation(),          // без reducer — пишется один раз узлом escalation
escalationsAuto: Annotation(),       // без reducer — пишется один раз узлом escalation
escalationsPendingUser: Annotation(),// без reducer — пишется один раз узлом escalation
costCapReached: Annotation()         // без reducer — пишется один раз узлом escalation
```

### 6. Новые колонки `runs` (миграция `004_cost_columns.sql`)

```sql
ALTER TABLE information_analysis_agent.runs
  ADD COLUMN IF NOT EXISTS cost_usd_retry    NUMERIC(10, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_usd_analysis NUMERIC(10, 4) NOT NULL DEFAULT 0;
```

`cost_usd` (уже существующая колонка) остаётся общей суммой (`cost_usd_retry + cost_usd_analysis`) —
обратная совместимость с уже написанным кодом/дашбордами, если такие появятся раньше разбивки.
`escalations_auto`/`escalations_pending_user` — колонки уже существуют с самого начала (Шаг 1),
просто не заполнялись.

### 7. Изменения в `persistResults.js`

При создании `runs` (начало) — без изменений (`cost_usd: 0` как раньше, реальные числа известны
только в конце). При финальном `UPDATE runs` (там же, где сейчас пишется `status`) — добавить:

```js
cost_usd: state.costUsdAnalysis + state.costUsdRetry,
cost_usd_analysis: state.costUsdAnalysis,
cost_usd_retry: state.costUsdRetry,
escalations_auto: state.escalationsAuto,
escalations_pending_user: state.escalationsPendingUser
```

Статус прогона: если `state.costCapReached === true` — `'cost_cap_reached'` (уже разрешено в схеме),
иначе — прежняя логика (`state.errors.length > 0 ? 'partial' : 'ok'`).

### 8. `graph/index.js` / `src/index.js`

`createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction,
retryParse })` — новая обязательная зависимость `retryParse`. Граф: `escalation` — первый узел
(до `dispatchToExtraction`), использует `db` (для `pending_user_decisions`) и `retryParse`.

`src/index.js` — конструирует `createDeepParsingClient({ baseUrl: requireEnv('DEEP_PARSING_AGENT_URL') })`,
передаёт `retryParse` в `createAnalysisGraph`. **Обязательно перепроверить после реализации** (тем же
способом, что и в прошлый раз — `grep` по трём ожидаемым строкам) — это ровно тот класс бага
(новая зависимость графа не прокинута в реальную точку входа), что уже дважды случался в этом
проекте.

Новая переменная окружения `DEEP_PARSING_AGENT_URL` — HTTP-адрes Агента 2 внутри Docker-сети
(`http://deep-parsing-agent:7301` по аналогии с `REDIS_URL=redis://redis:6379/0` — реальное значение
подтвердить при живой проверке, т.к. Docker сейчас не поднят).

## Обработка ошибок

- Сбой `retryParse` (сеть, таймаут, Агент 2 недоступен) — не роняет узел `escalation`, item
  эскалируется с исходными данными, ошибка НЕ пишется в `state.errors` (это не сбой анализа, а
  штатный сценарий эскалации — уже отражён через `pending_user_decisions`).
- Сбой записи `pending_user_decisions` — логируется (`console.error`), не бросает исключение, не
  должен ронять обработку остальных item'ов.
- Сбой одного из новых полей `costUsd` (например, `usage.cost` отсутствует в ответе OpenRouter) —
  трактуется как `costUsd: 0` для этого вызова (не должно ломать извлечение/дедуп/противоречия
  из-за проблемы с учётом стоимости — стоимость дополняет, а не блокирует основную логику).

## Тестирование

Полностью через DI + фейки, без живых вызовов в `npm test` (как и во всех предыдущих слайсах):

- `deepParsingClient.js` — фейковые `ClientImpl`/`TransportImpl`, проверка аргументов `callTool`,
  парсинг ответа, обработка ошибки вызова.
- `escalation.js` — фейковые `db`/`retryParse`: пропуск не-низкой уверенности, item от Агента 1 →
  эскалация без попытки повтора, превышение $0.10 → эскalация, превышение $5 суммарно → cost cap,
  успешный повтор → замена данных + прибавление реальной стоимости, сбой повтора → эскалация с
  исходными данными, запись в `pending_user_decisions` для каждого случая эскалации.
- `extractClaims.js`/`judgeDuplicate.js`/`judgeContradiction.js` — новые тесты на `usage: {include:
  true}` в теле запроса и парсинг `costUsd` из `usage.cost`; существующие тесты обновляются под
  новую форму возврата (`{claims, costUsd}` и т.д.).
- `embedText.js` — новый тест на оценку `costUsd` по формуле длины текста; существующие тесты
  обновляются под новую форму возврата (`{embedding, costUsd}`).
- `dedup.js`/`contradiction.js`/узел `extractClaims` — обновляются под новую форму возврата
  зависимостей, добавляется проверка суммирования `costUsdAnalysis`.
- `persistResults.js` — новые тесты на запись `cost_usd`/`cost_usd_analysis`/`cost_usd_retry`/
  `escalations_auto`/`escalations_pending_user`, и на статус `cost_cap_reached`.
- `graph/index.js` — обновляется под новую обязательную зависимость `retryParse`, новый узел в
  цепочке, сквозной тест на сценарий эскалации.
- Миграция `004_cost_columns.sql` — regex-тест по аналогии с существующими миграционными тестами.

## Явно не входит в этот слайс

- Отправка Telegram-уведомлений про эскалации/cost cap (ТЗ §3.3) — Слайс 10.
- Вывод разбивки "парсинг / анализ / генерация контента" пользователю (дайджест, дашборд) — Слайс 8
  и/или v1.5/v2.0 роадмап; в этом слайсе только считается и пишется в БД.
- Живая проверка вызова к Агенту 2 через Docker-сеть — Docker сейчас не поднят на этой машине;
  живой сквозной тест этого механизма откладывается до момента, когда оба контейнера будут подняты.
- Разрешение (resolution) записей `pending_user_decisions` пользователем и повторная попытка после
  этого — существующий, но нигде ещё не реализованный процесс (ни в этом слайсе, ни раньше); в этом
  слайсе только создаются записи, ничего их не обрабатывает.
- Точная калибровка `CONTENT_TYPE_RETRY_COST_ESTIMATES` — предварительные значения, не архитектурное
  решение.

## Открытые вопросы

Нет — все решения приняты в ходе брейншторминга (см. диалог перед этим документом).
