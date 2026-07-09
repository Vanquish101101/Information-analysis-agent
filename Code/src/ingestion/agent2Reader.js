import { normalizeItem } from './normalize.js';

// Читает deep_parsing_agent.agent3_handoff_queue и джойнит parsing_results/parsing_jobs
// вручную (три отдельных запроса — не foreign-table join, схемы разные). Эти таблицы
// принадлежат схеме deep_parsing_agent, а не схеме этого проекта (information_analysis_agent),
// под которую пинован db-клиент по умолчанию — .schema('deep_parsing_agent') на каждом вызове
// обязателен, без него supabase-js резолвит .from() против дефолтной схемы клиента и падает
// с PGRST205 "table not found" (подтверждено живым запросом к проду 2026-07-09). Точная
// структура подтверждена чтением исходников Агента 2: Code/src/queue/index.js и
// Code/src/router/index.js. ВАЖНО: parsing_results пока не хранит meta (cost_usd/tools_used/
// duration_sec) — см. Global Constraints этого плана. agent3_handoff_queue НЕ имеет колонки
// created_at (проверено живой схемой 2026-07-09: id/job_id/result_ref/attempt_count/
// last_attempt_at/status) — created_at берётся из parsing_jobs, которая его реально хранит.
export async function fetchAgent2Items(db, { limit = 100 } = {}) {
  const { data: handoffRows, error: handoffError } = await db
    .schema('deep_parsing_agent')
    .from('agent3_handoff_queue')
    .select('id, job_id, result_ref, attempt_count, status')
    .eq('status', 'pending')
    .limit(limit);

  if (handoffError) {
    throw new Error(`fetchAgent2Items: ${handoffError.message}`);
  }

  const items = [];
  for (const row of handoffRows ?? []) {
    if (row.result_ref == null) continue;

    const { data: resultRow, error: resultError } = await db
      .schema('deep_parsing_agent')
      .from('parsing_results')
      .select('job_id, module, result_json, confidence_level, confidence_text')
      .eq('id', row.result_ref)
      .single();

    if (resultError || !resultRow) continue;

    const { data: jobRow } = await db
      .schema('deep_parsing_agent')
      .from('parsing_jobs')
      .select('content_type, content_ref, created_at')
      .eq('id', row.job_id)
      .single();

    const normalized = normalizeItem({
      job_id: row.job_id,
      agent: 2,
      content_type: jobRow?.content_type ?? null,
      content_ref: jobRow?.content_ref ?? null,
      result: resultRow.result_json ?? null,
      confidence: { level: resultRow.confidence_level, explanation: resultRow.confidence_text },
      created_at: jobRow?.created_at ?? null
    });
    items.push({ ...normalized, handoff_queue_id: row.id });
  }
  return items;
}
