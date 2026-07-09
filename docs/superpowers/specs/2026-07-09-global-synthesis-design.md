# GlobalSynthesis — дизайн (Слайс 8, Шаг 7-8 ТЗ)

## 1. Назначение и границы

Финальный узел графа анализа: собирает дайджест прогона (человекочитаемые факты + противоречия +
количественные агрегаты) и сохраняет его в Supabase. Реализует шаги 7-8 из `5. ТЗ.md` §2.2.

**В этом слайсе:**
- Узел `globalSynthesis` — последний в графе, использует `claude-sonnet-4-6` для формулировки текста
  факта по каждому claim'у.
- Исправление модели данных, без которого дайджест не может быть честным: связь claim↔source
  (сейчас теряется при подтверждении дубля) и хранение охвата (views/likes) источника.
- Таблица `digests` — хранилище собранного результата.

**Не в этом слайсе (сознательно, отдельные слайсы):**
- MCP-инструменты (`analysis_digest`/`analysis_detail`/`analysis_status`) — Слайс 9.
- Telegram-уведомления (§3.3 ТЗ) — Слайс 10.
- Полноценный охват для всех типов контента (сейчас только YouTube) — v2, доб��вляется по мере
  появления числовых метрик у других источников.
- Произвольный текстовый нарратив/саммари — схема `analysis_digest` в ТЗ такого поля не содержит,
  роль LLM ограничена формулировкой `statement` по каждому факту.

## 2. Место в графе и условие запуска

Граф становится: `escalation → dispatcher → Send(extractClaims) → reducer → dedup → contradiction
→ persistResults → globalSynthesis → END`.

`globalSynthesis` запускается для `status ∈ {ok, partial, cost_cap_reached}` — при этих статусах
claims уже реально сохранены в БД persistResults'ом, дайджест строится по тому, что есть.
Пропускается при `status === error` (там ничего не сохранено транзакционно, дайджест собирать не
из чего).

## 3. Изменения модели данных

Новая миграция `005_digest.sql`:

```sql
CREATE TABLE IF NOT EXISTS information_analysis_agent.claim_sources (
  claim_id   UUID NOT NULL REFERENCES information_analysis_agent.claims(id),
  source_id  UUID NOT NULL REFERENCES information_analysis_agent.sources(id),
  linked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (claim_id, source_id)
);

ALTER TABLE information_analysis_agent.sources
  ADD COLUMN IF NOT EXISTS reach_estimate NUMERIC DEFAULT 0;

CREATE TABLE IF NOT EXISTS information_analysis_agent.digests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES information_analysis_agent.runs(id),
  run_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  facts          JSONB NOT NULL DEFAULT '[]',
  contradictions JSONB NOT NULL DEFAULT '[]',
  meta           JSONB NOT NULL DEFAULT '{}'
);
```

**`claim_sources`** — фиксирует каждое подтверждение claim'а источником: и при создании нового
claim'а, и при каждом последующем подтверждении дубля (сейчас `persistResults.js` при дубле
обновляет только `confidence_level`/`confidence_explanation` существующего claim'а, связь с новым
подтверждающим источником никуда не пишется — это и есть тот пробел, который блокирует честный
`sources_count`). `sources_count` факта = `COUNT(*)` из `claim_sources` по `claim_id`.

**`sources.reach_estimate`** — числовая оценка охвата, заполняется один раз при создании строки
`sources` (не меняется задним числом при последующих дублях). `reach_estimate` факта в дайджесте =
`SUM(reach_estimate)` по всем `sources`, связанным с claim'ом через `claim_sources`.

**`digests`** — одна строка на прогон, привязана к `runs.id`. Формат `facts`/`contradictions`/`meta`
зеркалит выходную схему `analysis_digest` из §3.2 ТЗ (см. раздел 5 ниже) — это уже готовый снимок
для последующей выдачи через MCP в Слайсе 9, пересчитывать по запросу не нужно.

## 4. Оценка охвата (`reach_estimate`)

Best-effort, только там, где реально есть числа: `normalize.js` при нормализации item'а от Агента 1
ищет `result.raw.youtube[]` и суммирует `views + likes` по всем видео в ответе (та же raw-структура,
которую собирает `Code/src/agents/scout/index.js` — `v.viewCount`/`v.likeCount`). Для всего
остального (Firecrawl-текст, Агент 2 любого content_type) — `0`, без попытки угадать.

Поток: `normalize.js` → `item.reachEstimate` → `extractClaims`-узел кладёт это в `claim.source`
(`{ agent, jobId, refType, reachEstimate }`) → `persistResults.js` пишет в `sources.reach_estimate`
при создании строки `sources` (один раз на уникальную пару `agent+jobId`, как и сейчас с остальными
полями `sources`).

## 5. Узел `globalSynthesis`

```
createGlobalSynthesisNode({ db, synthesizeDigest })
  -> globalSynthesisNode(state) -> Promise<{}>  // побочный эффект: пишет digests + докручивает runs.cost_usd
```

Шаги:
1. `persistResultsNode` дополнительно возвращает `persistedClaimIds: string[]` — реальные id
   claim'ов, тронутых этим прогоном (и новых, и подтверждённых дублей). Ориентироваться на
   временное окно прогона (`linked_at` в `claim_sources`) вместо явного списка id было бы хрупко —
   параллельных прогонов в системе не бывает (батч сериализован), но искусственно завязываться на
   это не нужно, когда есть прямой и однозначный способ передать список.
2. Для каждого claim'а посчитать `sources_count`/`reach_estimate` через `claim_sources` + `sources`.
3. Один вызов `synthesizeDigest` (обёртка над `claude-sonnet-4-6` через OpenRouter,
   `usage:{include:true}`, тот же паттерн, что `extractClaims`/`judgeDuplicate`/`judgeContradiction`)
   — на входе список фактов (subject/predicate/object_value/confidence), на выходе `statement` для
   каждого claim'а + `costUsd`.
4. Собрать `facts[]`/`contradictions[]`/`meta` (структура — §3.2 ТЗ, приведена в разделе 6 ниже).
5. `INSERT` в `digests`.
6. Дописать стоимость синтеза поверх уже записанной `persistResults`'ом: `UPDATE runs SET
   cost_usd = cost_usd + costUsd, cost_usd_analysis = cost_usd_analysis + costUsd WHERE id =
   runId` — `persistResults` пишет "финальную" стоимость до того, как `globalSynthesis` вообще
   запускается, поэтому стоимость самого синтеза требует отдельного маленького дозаписывающего
   UPDATE, а не переделки уже проверенной логики `persistResults`.

Ошибка на любом из шагов не должна ронять весь прогон (тот же принцип, что у остальных узлов) —
логируется, `digests`-строка в этом случае не создаётся, но `runs.status`, выставленный
`persistResults`, не откатывается.

## 6. Формат `digests.facts`/`contradictions`/`meta`

Совпадает с `analysis_digest` из §3.2 ТЗ:

```json
{
  "facts": [
    {
      "claim_id": "uuid",
      "statement": "текст факта от LLM",
      "confidence": { "level": "высокая", "sources_count": 3, "reach_estimate": 120000 },
      "detail_ref": "claim_id"
    }
  ],
  "contradictions": [
    { "claim_a_id": "uuid", "claim_b_id": "uuid", "explanation": "текст" }
  ],
  "meta": {
    "items_processed": 0,
    "escalations_auto": 0,
    "escalations_pending_user": 0,
    "cost_usd": 0.0,
    "duration_sec": 0
  }
}
```

## 7. Тестирование

Как и в предыдущих слайсах — юнит-тесты с фейковым `db`/фейковым LLM-клиентом на каждом уровне:
`claim_sources`-запись в `persistResults.js`, вычисление `reach_estimate` в `normalize.js`, сборка
`facts[]`/`contradictions[]`/`meta` в `globalSynthesis.js`, LLM-обёртка `synthesizeDigest` (реальный
`usage:{include:true}` паттерн, как у остальных LLM-файлов). Финальный ревью — один раз на весь
слайс, по действующему для проекта правилу.
