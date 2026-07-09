-- src/db/migrations/005_digest.sql
-- Слайс 8 (GlobalSynthesis, Шаг 7-8 ТЗ).
--
-- claim_sources — junction, которого раньше не было: claims.source_id хранит
-- только ОДИН (первый) источник claim'а. Когда dedup.js находит дубль и
-- confidence существующего claim'а поднимается, связь с новым подтверждающим
-- источником нигде не сохранялась — честно посчитать "сколько источников
-- подтверждают этот факт" было нечем. claim_sources фиксирует КАЖДОЕ такое
-- подтверждение (и на создании нового claim'а, и на каждом дубле).
--
-- sources.reach_estimate — best-effort оценка охвата источника (сумма
-- views+likes для YouTube-результатов Агента 1, 0 для всего остального, где
-- таких чисел просто нет) — заполняется один раз при создании строки sources.
--
-- digests — один снимок дайджеста на прогон, формат facts/contradictions/meta
-- зеркалит analysis_digest из "5. ТЗ.md" §3.2 — уже готов для выдачи через
-- MCP в следующем слайсе, пересчитывать по запросу не нужно.

CREATE TABLE IF NOT EXISTS information_analysis_agent.claim_sources (
  claim_id   UUID NOT NULL REFERENCES information_analysis_agent.claims(id),
  source_id  UUID NOT NULL REFERENCES information_analysis_agent.sources(id),
  linked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (claim_id, source_id)
);

ALTER TABLE information_analysis_agent.sources
  ADD COLUMN IF NOT EXISTS reach_estimate NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS information_analysis_agent.digests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES information_analysis_agent.runs(id),
  run_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  facts          JSONB NOT NULL DEFAULT '[]',
  contradictions JSONB NOT NULL DEFAULT '[]',
  meta           JSONB NOT NULL DEFAULT '{}'
);

CREATE OR REPLACE FUNCTION information_analysis_agent.claim_source_stats(
  claim_ids uuid[]
)
RETURNS TABLE (claim_id uuid, sources_count bigint, reach_estimate numeric)
LANGUAGE sql STABLE
AS $$
  SELECT cs.claim_id, COUNT(*)::bigint AS sources_count, COALESCE(SUM(s.reach_estimate), 0) AS reach_estimate
  FROM information_analysis_agent.claim_sources cs
  JOIN information_analysis_agent.sources s ON s.id = cs.source_id
  WHERE cs.claim_id = ANY(claim_ids)
  GROUP BY cs.claim_id;
$$;

GRANT EXECUTE ON FUNCTION information_analysis_agent.claim_source_stats TO anon, authenticated, service_role;

-- 001's "GRANT ALL ON ALL TABLES" only covered tables that existed at the time
-- it ran — every migration since (see 003_contradictions.sql) has had to grant
-- its own new tables explicitly. Missed here originally; caught by a live
-- smoke test failing with "permission denied for table claim_sources/digests".
GRANT ALL ON information_analysis_agent.claim_sources TO anon, authenticated, service_role;
GRANT ALL ON information_analysis_agent.digests TO anon, authenticated, service_role;
