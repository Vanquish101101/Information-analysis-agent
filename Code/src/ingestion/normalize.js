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
    created_at: item.created_at ?? null
  };
}
