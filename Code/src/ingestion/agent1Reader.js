import { normalizeItem } from './normalize.js';

// Читает intelligence_agent.search_results — см. "1. Идея.md" за точной схемой
// (подтверждено чтением исходников Агента 1, Code/src/orchestrator/index.js
// + Code/src/db/migrations/002_search_results.sql).
export async function fetchAgent1Items(db, { telegramId, limit = 50 } = {}) {
  let query = db.from('search_results').select('*');
  if (telegramId != null) {
    query = query.eq('telegram_id', telegramId);
  }
  query = query.order('created_at', { ascending: false }).limit(limit);

  const { data, error } = await query;
  if (error) {
    throw new Error(`fetchAgent1Items: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const normalized = normalizeItem({
      job_id: row.job_id,
      agent: 1,
      content_type: 'search',
      result: row.result?.raw ?? null,
      confidence: row.confidence,
      meta: row.meta,
      created_at: row.created_at
    });
    // fallback только на случай пустого result.raw — см. "1. Идея.md" "Откуда берётся вход"
    return { ...normalized, telegram_text_fallback: row.telegram_text ?? null };
  });
}
