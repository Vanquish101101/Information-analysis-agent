// tests/scheduler/stateStore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryStateStore } from '../../src/scheduler/stateStore.js';

test('get returns null for a key that was never set', () => {
  const store = createInMemoryStateStore();
  assert.equal(store.get('missing'), null);
});

test('set then get returns the stored value', () => {
  const store = createInMemoryStateStore();
  store.set('watchStartedAt', '2026-07-08T08:00:00.000Z');
  assert.equal(store.get('watchStartedAt'), '2026-07-08T08:00:00.000Z');
});

test('set overwrites a previous value for the same key', () => {
  const store = createInMemoryStateStore();
  store.set('triggeredToday', false);
  store.set('triggeredToday', true);
  assert.equal(store.get('triggeredToday'), true);
});

test('distinct keys do not interfere with each other', () => {
  const store = createInMemoryStateStore();
  store.set('a', 1);
  store.set('b', 2);
  assert.equal(store.get('a'), 1);
  assert.equal(store.get('b'), 2);
});
