import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Send } from '@langchain/langgraph';
import { dispatchToExtraction } from '../../../src/graph/nodes/dispatcher.js';

test('returns one Send per item, targeting the extractClaims node', () => {
  const state = { items: [{ job_id: 'a' }, { job_id: 'b' }] };

  const result = dispatchToExtraction(state);

  assert.equal(result.length, 2);
  assert.ok(result[0] instanceof Send);
  assert.equal(result[0].node, 'extractClaims');
  assert.deepEqual(result[0].args, { item: { job_id: 'a' } });
  assert.deepEqual(result[1].args, { item: { job_id: 'b' } });
});

test('returns ["reducer"] directly when items is empty, instead of zero Sends', () => {
  const state = { items: [] };

  const result = dispatchToExtraction(state);

  assert.deepEqual(result, ['reducer']);
});
