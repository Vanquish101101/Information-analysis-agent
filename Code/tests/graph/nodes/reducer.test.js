import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reducerNode } from '../../../src/graph/nodes/reducer.js';

test('returns an empty update without throwing when claims/errors are present', () => {
  const state = { claims: [{ subject: 'A' }, { subject: 'B' }], errors: ['item x: failed'] };
  const result = reducerNode(state);
  assert.deepEqual(result, {});
});

test('returns an empty update when claims/errors are both empty', () => {
  const state = { claims: [], errors: [] };
  const result = reducerNode(state);
  assert.deepEqual(result, {});
});
