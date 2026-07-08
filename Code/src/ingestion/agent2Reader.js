import { normalizeItem } from './normalize.js';

// Читает deep_parsing_agent.agent3_handoff_queue и джойнит parsing_results/parsing_jobs
// вручную (три отдельных запроса — не foreign-table join, схемы разные проекты Supabase-клиента
// с фиксированной search_path на information_analysis_agent, эти таблицы принадлежат схеме
// deep_parsing_agent и запрашиваются тем же db-клиентом с явным .schema()/отдельным клиентом —
// уточняется на этапе интеграции). Точная структура подтверждена чтением исходников Агента 2:
// Code/src/queue/index.js и Code/src/router/index.js. ВАЖНО: parsing_results пока не хранит meta
// (cost_usd/tools_used/duration_sec) — см. Global Constraints этого плана.
export async function fetchAgent2Items(db, { limit = 100 } = {}) {
  const { data: handoffRows, error: handoffError } = await db
    .from('agent3_handoff_queue')
    .select('id, job_id, result_ref, attempt_count, status, created_at')
    .eq('status', 'pending')
    .limit(limit);

  if (handoffError) {
    throw new Error(`fetchAgent2Items: ${handoffError.message}`);
  }

  const items = [];
  for (const row of handoffRows ?? []) {
    if (row.result_ref == null) continue;

    const { data: resultRow, error: resultError } = await db
      .from('parsing_results')
      .select('job_id, module, result_json, confidence_level, confidence_text')
      .eq('id', row.result_ref)
      .single();

    if (resultError || !resultRow) continue;

    const { data: jobRow } = await db
      .from('parsing_jobs')
      .select('content_type, content_ref')
      .eq('id', row.job_id)
      .single();

    const normalized = normalizeItem({
      job_id: row.job_id,
      agent: 2,
      content_type: jobRow?.content_type ?? null,
      content_ref: jobRow?.content_ref ?? null,
      result: resultRow.result_json ?? null,
      confidence: { level: resultRow.confidence_level, explanation: resultRow.confidence_text },
      created_at: row.created_at
    });
    items.push({ ...normalized, handoff_queue_id: row.id });
  }
  return items;
}
