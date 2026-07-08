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
