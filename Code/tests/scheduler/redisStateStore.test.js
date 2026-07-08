import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisStateStore } from '../../src/scheduler/redisStateStore.js';

function fakeRedisClient(initialData = {}) {
  const data = { ...initialData };
  const calls = { get: [], set: [], del: [] };
  return {
    calls,
    async get(key) {
      calls.get.push(key);
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async set(key, value) {
      calls.set.push([key, value]);
      data[key] = value;
    },
    async del(key) {
      calls.del.push(key);
      delete data[key];
    }
  };
}

test('get returns null when the key does not exist in Redis', async () => {
  const client = fakeRedisClient();
  const store = createRedisStateStore({ client });

  const value = await store.get('watchStartedAt');

  assert.equal(value, null);
});

test('get applies the scheduler:agent3: key prefix', async () => {
  const client = fakeRedisClient({ 'scheduler:agent3:watchStartedAt': '2026-07-08T08:00:00.000Z' });
  const store = createRedisStateStore({ client });

  const value = await store.get('watchStartedAt');

  assert.equal(value, '2026-07-08T08:00:00.000Z');
  assert.deepEqual(client.calls.get, ['scheduler:agent3:watchStartedAt']);
});

test('set with a string value calls client.set with the prefixed key', async () => {
  const client = fakeRedisClient();
  const store = createRedisStateStore({ client });

  await store.set('lastSeenAt', '2026-07-08T08:10:00Z');

  assert.deepEqual(client.calls.set, [['scheduler:agent3:lastSeenAt', '2026-07-08T08:10:00Z']]);
  assert.equal(client.calls.del.length, 0);
});

test('set with null deletes the key instead of writing the string "null"', async () => {
  const client = fakeRedisClient({ 'scheduler:agent3:watchStartedAt': '2026-07-08T08:00:00.000Z' });
  const store = createRedisStateStore({ client });

  await store.set('watchStartedAt', null);

  assert.deepEqual(client.calls.del, ['scheduler:agent3:watchStartedAt']);
  assert.equal(client.calls.set.length, 0);

  const value = await store.get('watchStartedAt');
  assert.equal(value, null);
});
