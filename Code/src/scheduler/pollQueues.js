import { fetchAgent1Items } from '../ingestion/agent1Reader.js';
import { fetchAgent2Items } from '../ingestion/agent2Reader.js';

// Ни agent1Reader, ни agent2Reader не умеют фильтровать "новее X" на уровне SQL —
// оба всегда берут последние `limit` строк. Фильтруем по created_at на стороне
// клиента (см. Global Constraints плана про формат timestamp). Ошибка чтения одного
// источника не должна блокировать другой — частичный результат лучше отказа тика.
export async function pollQueues(db, { telegramId, sinceTimestamp = null } = {}) {
  const [agent1Result, agent2Result] = await Promise.allSettled([
    fetchAgent1Items(db, { telegramId }),
    fetchAgent2Items(db)
  ]);

  const items = [];

  if (agent1Result.status === 'fulfilled') {
    items.push(...agent1Result.value);
  } else {
    console.error('pollQueues: Agent 1 read failed:', agent1Result.reason.message);
  }

  if (agent2Result.status === 'fulfilled') {
    items.push(...agent2Result.value);
  } else {
    console.error('pollQueues: Agent 2 read failed:', agent2Result.reason.message);
  }

  const filtered = sinceTimestamp
    ? items.filter((item) => item.created_at && item.created_at > sinceTimestamp)
    : items;

  const newestSeenAt = filtered.reduce(
    (max, item) => (item.created_at && (!max || item.created_at > max) ? item.created_at : max),
    null
  );

  return { items: filtered, newestSeenAt };
}
