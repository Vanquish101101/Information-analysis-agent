const DEFAULT_CONFIDENCE = Object.freeze({
  level: 'низкая',
  explanation: 'confidence не указан источником'
});

function defaultMeta() {
  return {
    tools_used: [],
    cost_usd: null,
    duration_sec: null
  };
}

// Best-effort: сырые числа охвата (views/likes) сейчас реально есть только у
// YouTube-результатов Агента 1 (Code/src/agents/scout/index.js собирает их
// как views/likes уже в этом виде, Code/src/orchestrator/index.js кладёт
// массив в result.raw.youtube). Для всего остального (Firecrawl-текст,
// любой content_type Агента 2) таких чисел просто нет — 0, не оценка "на
// глаз". Расширяется по мере появления числовых метрик у других источников.
function computeReachEstimate(item) {
  if (item.agent !== 1) return 0;
  const youtube = item.result?.raw?.youtube;
  if (!Array.isArray(youtube)) return 0;
  return youtube.reduce((sum, video) => sum + (video.views ?? 0) + (video.likes ?? 0), 0);
}

export function normalizeItem(item) {
  if (item == null || typeof item !== 'object') {
    throw new TypeError('normalizeItem: item must be an object');
  }
  if (!item.job_id) {
    throw new Error('normalizeItem: job_id is required');
  }
  if (item.agent !== 1 && item.agent !== 2) {
    throw new Error('normalizeItem: agent must be 1 or 2');
  }

  return {
    job_id: item.job_id,
    agent: item.agent,
    content_type: item.content_type ?? 'unknown',
    content_ref: item.content_ref ?? null,
    result: item.result ?? null,
    confidence: item.confidence?.level ? item.confidence : DEFAULT_CONFIDENCE,
    meta: item.meta ?? defaultMeta(),
    created_at: item.created_at ?? null,
    reachEstimate: computeReachEstimate(item)
  };
}
