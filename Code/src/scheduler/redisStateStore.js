import Redis from 'ioredis';

const KEY_PREFIX = 'scheduler:agent3:';

// Ключи планировщика хранятся с префиксом, чтобы не пересекаться с ключами
// других агентов в общем Redis. set(key, null) удаляет ключ (DEL), а не
// пишет строку "null" — иначе следующий get() вернул бы truthy-строку
// вместо настоящего null, ломая проверки вида `!state.watchStartedAt`.
export function createRedisStateStore({ redisUrl, client } = {}) {
  const redis = client ?? new Redis(redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000 });

  return {
    async get(key) {
      const value = await redis.get(KEY_PREFIX + key);
      return value ?? null;
    },
    async set(key, value) {
      if (value === null || value === undefined) {
        await redis.del(KEY_PREFIX + key);
      } else {
        await redis.set(KEY_PREFIX + key, String(value));
      }
    }
  };
}
