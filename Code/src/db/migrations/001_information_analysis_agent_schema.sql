-- src/db/migrations/001_information_analysis_agent_schema.sql
-- Схема Агента 3 (Information Analysis Agent): сущности, факты, источники, история прогонов,
-- очередь решений пользователя. Применять в проекте "Marketing agency" (id: wklecdbujgdwnbmfmggi).
--
-- ПРИМЕЧАНИЕ: размерность vector(768) — предварительная, под Gemini Embedding 2. Проверить
-- реальную размерность ответа API перед первым использованием в продакшене (задача этапа
-- "интеграция эмбеддингов", отдельный план) — при расхождении потребуется отдельная миграция
-- на ALTER COLUMN.

CREATE SCHEMA IF NOT EXISTS information_analysis_agent;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS information_analysis_agent.entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          TEXT,
  embedding     vector(768),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent       SMALLINT NOT NULL CHECK (agent IN (1, 2)),
  source_type TEXT NOT NULL,
  ref         TEXT,
  raw_job_id  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.claims (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_entity_id      UUID REFERENCES information_analysis_agent.entities(id),
  predicate              TEXT NOT NULL,
  object_entity_id       UUID REFERENCES information_analysis_agent.entities(id),
  object_value           TEXT,
  confidence_level       TEXT NOT NULL CHECK (confidence_level IN ('высокая', 'средняя', 'низкая')),
  confidence_explanation TEXT,
  source_id              UUID REFERENCES information_analysis_agent.sources(id),
  embedding              vector(768),
  extracted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_by          UUID REFERENCES information_analysis_agent.claims(id)
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                   TEXT NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running', 'ok', 'partial', 'error', 'cost_cap_reached')),
  cost_usd                 NUMERIC(10, 4) NOT NULL DEFAULT 0,
  items_processed          INTEGER NOT NULL DEFAULT 0,
  escalations_auto         INTEGER NOT NULL DEFAULT 0,
  escalations_pending_user INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS information_analysis_agent.pending_user_decisions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID NOT NULL,
  question           TEXT NOT NULL,
  estimated_cost_usd NUMERIC(10, 4),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS claims_subject_predicate_idx     ON information_analysis_agent.claims(subject_entity_id, predicate);
CREATE INDEX IF NOT EXISTS claims_source_id_idx             ON information_analysis_agent.claims(source_id);
CREATE INDEX IF NOT EXISTS claims_extracted_at_idx          ON information_analysis_agent.claims(extracted_at DESC);
CREATE INDEX IF NOT EXISTS sources_agent_idx                ON information_analysis_agent.sources(agent);
CREATE INDEX IF NOT EXISTS runs_run_at_idx                  ON information_analysis_agent.runs(run_at DESC);
CREATE INDEX IF NOT EXISTS pending_user_decisions_status_idx ON information_analysis_agent.pending_user_decisions(status);

GRANT USAGE ON SCHEMA information_analysis_agent TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA information_analysis_agent TO anon, authenticated, service_role;

ALTER TABLE information_analysis_agent.entities DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.sources DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.claims DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.runs DISABLE ROW LEVEL SECURITY;
ALTER TABLE information_analysis_agent.pending_user_decisions DISABLE ROW LEVEL SECURITY;
