# MCP-сервер (выход) — дизайн (Слайс 9)

## 1. Назначение и границы

Читающий MCP-интерфейс Агента 3 для Агента 4 (создание контента, ещё не построен) и
для ручной проверки. Три инструмента из `5. ТЗ.md` §3.2 (шаг "Выход"):
`analysis_digest`, `analysis_detail`, `analysis_status`. Только чтение — никаких
write-инструментов.

**Не в этом слайсе:**
- Сам Агент 4 (не существует, интеграция проверяется только вручную/смоук-тестом).
- Реальные данные для `excerpt` в `analysis_detail.sources[]` — столбца с сырым
  текстом источника нигде в схеме нет (проверено по всем миграциям 001-005), поле
  возвращается `null` до отдельной будущей работы по прокидке цитат через весь
  пайплайн (аналогично `reach_estimate` в Слайсе 8, но больше объёмом).
- Telegram-уведомления (§3.3 ТЗ) — отдельный Слайс 10.

## 2. Транспорт и место в процессе

Полностью зеркалит уже работающий MCP-сервер Агента 2
(`Deep parsing agent/Code/src/mcp-server/http.js`/`server.js`):
- Низкоуровневый `Server` из `@modelcontextprotocol/sdk/server/index.js` (не
  `McpServer`), `capabilities: { tools: {} }`.
- `WebStandardStreamableHTTPServerTransport` (Request/Response), не
  Node-обёртка `StreamableHTTPServerTransport` — та тянет `@hono/node-server`,
  который на Node v24 ломается на пустых 202-ответах (тот же баг, что Агент 2
  уже обошёл и задокументировал).
- **Stateless**: `sessionIdGenerator: undefined`, новый `Server`+transport на
  каждый запрос (SDK требует этого в stateless-режиме).
- `GET /health` — служебный healthcheck-роут.
- Без авторизации — доступ ограничен только членством в Docker-сети
  `marketing-agency-net` (тот же паттерн, что у Агента 2; порт также
  публикуется на хост "для проверки", как у Агента 2).
- Порт: `7302` (переменная `MCP_HTTP_PORT`, по аналогии с Агентом 2 — `7301`).

**Отличие от Агента 2**: у Агента 2 `http.js` — самостоятельный entry point
контейнера (`docker-compose.yml` → `node src/mcp-server/http.js`). У Агента 3
HTTP MCP-сервер запускается **в том же процессе**, что и уже существующий
планировщик батчей — `src/index.js` вызывает и `scheduler.start(...)`, и запуск
MCP HTTP-сервера, оба асинхронно сосуществуют в одном event loop (планировщик
не блокирует, весь I/O уже async). Поэтому `src/mcp-server/http.js` у Агента 3
экспортирует фабрику (`createMcpHttpServer(deps) -> httpServer`, не запускается
сам при импорте), а не является самозапускающимся скриптом, как у Агента 2.

## 3. Инструменты — источники данных и точные ответы

### `analysis_digest(run_id?)`

Читает одну строку из `digests` (Слайс 8): по `run_id`, если передан, иначе
последнюю по `run_at DESC`. Формат уже посчитан и сохранён в нужной форме в
Слайсе 8 — трансформация минимальна:

```json
{
  "digest_id": "<digests.id>",
  "run_at": "<digests.run_at>",
  "facts": "<digests.facts как есть>",
  "contradictions": "<digests.contradictions как есть>",
  "meta": "<digests.meta как есть>"
}
```

Если строк нет вообще (свежая БД/ещё не было ни одного прогона с claims) —
возвращает `null`-эквивалент (пустой объект с `facts: [], contradictions: [],
meta: null` — точная форма фиксируется в плане, не архитектурное решение).

### `analysis_detail(claim_id)`

Новый запрос, не переиспользует `digests` (искать конкретный `claim_id` внутри
JSONB-массива `facts` по всем прошлым дайджестам не нужно — данные для ответа
и так лежат в реляционных таблицах):
- `claims` (по `id = claim_id`) + join на `entities` (имя сущности) — даёт
  `subject`/`predicate`/`object_value`/`confidence_level`/`confidence_explanation`.
- `claim_sources` JOIN `sources` (по `claim_id`) — даёт список подтверждающих
  источников.

```json
{
  "claim_id": "uuid",
  "statement": "<subject>: <predicate>: <object_value> — тот же шаблон, что fallback-текст в globalSynthesis.js (не хранит LLM-формулировку из конкретного дайджеста, это отдельный конкретный факт, а не срез одного прогона)",
  "sources": [
    {
      "source_id": "uuid",
      "type": "<sources.source_type>",
      "ref": "<sources.raw_job_id> (единственное реально заполняемое поле-идентификатор источника сейчас — sources.ref никогда не записывается persistResults.js, проверено)",
      "excerpt": null,
      "confidence": "<claims.confidence_level> (одно значение на claim, не per-источник — в модели данных нет отдельного confidence на связь claim_sources)"
    }
  ],
  "reasoning": "<claims.confidence_explanation>",
  "history": []
}
```

Если `claim_id` не найден — явная ошибка инструмента (`isError: true` с текстом),
не пустой объект.

### `analysis_status()`

```json
{
  "last_run_at": "<runs.run_at последней строки>",
  "status": "<runs.status>",
  "items_processed": "<runs.items_processed>",
  "cost_usd": "<runs.cost_usd>",
  "pending_user_decisions": [
    { "job_id": "...", "question": "...", "estimated_cost_usd": "..." }
  ]
}
```
`pending_user_decisions` — только строки со `status = 'pending'` (таблица
имеет `status CHECK IN ('pending', 'resolved')`; уже отвеченные пользователем
решения не актуальны для "текущего статуса" и не должны засорять ответ).
Не привязаны к конкретному `run_id` в текущей схеме — отдаются все
непринятые решения по всем прогонам.

## 4. Файловая структура

- `Code/src/mcp-server/server.js` — `createMcpServer({db}) -> Server` (фабрика,
  как у Агента 2, но с `db`-зависимостью для запросов).
- `Code/src/mcp-server/queries.js` — три функции запроса к БД
  (`getDigest`/`getClaimDetail`/`getStatus`), отдельно от MCP-обвязки для
  прямого юнит-тестирования с `fakeSupabase`.
- `Code/src/mcp-server/http.js` — `createMcpHttpServer({db}) -> http.Server`
  (не самозапускающийся).
- `Code/src/index.js` — вызывает `createMcpHttpServer({db}).listen(MCP_HTTP_PORT)`
  рядом с существующим `scheduler.start(...)`.

## 5. Docker

- `Code/docker-compose.yml`: добавить `ports: ["7302:7302"]` и
  `MCP_HTTP_PORT=7302` в `environment`.
- `Инфраструктура (Docker)/docker-compose.yml`: раскомментировать строку
  `- path: ../Information analysis agent/Code/docker-compose.yml`.

## 6. Тестирование

Юнит-тесты `queries.js` с `fakeSupabase` (три функции запроса, включая
пустые/не-найденные случаи). Юнит-тест `server.js` — что `ListToolsRequestSchema`
отдаёт три инструмента с ожидаемыми `inputSchema`, `CallToolRequestSchema`
маршрутизирует по имени и оборачивает ошибки в `isError: true` (тот же паттерн
проверки, что уже есть у Агента 2's `server.js`, только тестами, которых у
Агента 2 просто нет — этот проект тестирует то, что делает). Финальный живой
смоук-тест — реальный HTTP-запрос к поднятому в Docker контейнеру Агента 3 на
`http://localhost:7302/mcp` (или изнутри сети `marketing-agency-net`) с
реальными данными в БД от предыдущих слайсов.
