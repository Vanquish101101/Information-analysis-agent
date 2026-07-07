// tests/smoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner is working', () => {
  assert.equal(1 + 1, 2);
});
