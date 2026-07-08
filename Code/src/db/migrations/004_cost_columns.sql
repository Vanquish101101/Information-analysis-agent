-- src/db/migrations/004_cost_columns.sql
-- Шаг 7 (эскалация/контроль стоимости): runs.cost_usd становится реальной
-- суммой вместо жёсткого 0. Разбивка на "стоимость повторов через Агента 2"
-- и "стоимость собственной работы Агента 3" хранится отдельно — задел под
-- будущую разбивку в дайджесте/дашборде расходов (Шаг 8 / v1.5/v2.0),
-- cost_usd остаётся суммой обеих колонок для обратной совместимости.

ALTER TABLE information_analysis_agent.runs
  ADD COLUMN IF NOT EXISTS cost_usd_retry    NUMERIC(10, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_usd_analysis NUMERIC(10, 4) NOT NULL DEFAULT 0;
