// src/handoff/agent4Handoff.js
// Push-уведомление Агенту 4 о готовности дайджеста.
// Два слоя: Redis pub/sub (быстрый, best-effort) + Supabase (надёжный, с ретраями).
// Вызывается из globalSynthesis.js fire-and-forget после успешного сохранения digest.

import Redis from 'ioredis';

const AGENT4_CHANNEL = 'notifications:agent4';
const RETRY_DELAYS_MS = [500, 2000, 8000];

async function withRetry(fn, delays = RETRY_DELAYS_MS) {
  let lastErr;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < delays.length) {
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  }
  throw lastErr;
}

export function createAgent4Notifier({ db, redisUrl, _redis } = {}) {
  const redis = _redis ?? (redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 0, connectTimeout: 3000 }) : null);

  return async function notifyAgent4(runId) {
    // Надёжный слой: Supabase insert с ретраями/бэкоффом
    try {
      await withRetry(async () => {
        const { error } = await db.from('agent4_handoff_queue').insert({
          job_id: runId,
          result_ref: runId,
          attempt_count: 0,
          status: 'pending'
        });
        if (error) throw new Error(error.message);
      });
    } catch (err) {
      console.error('[agent4Handoff] Supabase insert failed after retries:', err.message);
    }

    // Быстрый слой: Redis pub/sub (best-effort, некритичная ошибка)
    if (redis) {
      try {
        await redis.publish(AGENT4_CHANNEL, JSON.stringify({
          event: 'digest_ready',
          run_id: runId,
          timestamp: new Date().toISOString()
        }));
      } catch (err) {
        console.error('[agent4Handoff] Redis publish failed:', err.message);
      }
    }
  };
}
