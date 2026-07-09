-- src/db/migrations/006_agent4_handoff.sql
-- Слайс 11 — push-хендофф Агенту 4.
--
-- Быстрый слой: Redis pub/sub (notifications:agent4) — уведомляет Агента 4
-- немедленно, при недоступности Redis сообщение теряется без последствий.
--
-- Надёжный слой (эта таблица): запись не теряется при перезапуске контейнера
-- или временной недоступности Агента 4. Агент 4 читает отсюда при старте или
-- по таймеру и забирает незамеченные дайджесты.
-- По образцу deep_parsing_agent.agent3_handoff_queue.

CREATE TABLE IF NOT EXISTS information_analysis_agent.agent4_handoff_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          TEXT NOT NULL,          -- = run_id из таблицы runs
  result_ref      TEXT,                   -- run_id повторяется явно: Агент 4 вызывает analysis_digest(run_id) через MCP
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE information_analysis_agent.agent4_handoff_queue ENABLE ROW LEVEL SECURITY;

GRANT ALL ON information_analysis_agent.agent4_handoff_queue TO anon, authenticated, service_role;
