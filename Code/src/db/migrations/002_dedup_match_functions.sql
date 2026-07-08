-- src/db/migrations/002_dedup_match_functions.sql
-- Функции векторного поиска для дедупликации (Шаг 5). Supabase JS-клиент не
-- поддерживает операторы pgvector (<=>) через fluent-API — вызываются через
-- db.rpc(...).
--
-- Функция для поиска claims намеренно ограничена for_subject_entity_id — сравнение
-- имеет смысл только в рамках уже резолвленной сущности.

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
RETURNS TABLE (
  id uuid,
  predicate text,
  object_value text,
  confidence_level text,
  confidence_explanation text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT id, predicate, object_value, confidence_level, confidence_explanation,
         1 - (embedding <=> query_embedding) AS similarity
  FROM information_analysis_agent.claims
  WHERE embedding IS NOT NULL
    AND subject_entity_id = for_subject_entity_id
    AND 1 - (embedding <=> query_embedding) >= match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION information_analysis_agent.match_entities TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION information_analysis_agent.match_claims TO anon, authenticated, service_role;
