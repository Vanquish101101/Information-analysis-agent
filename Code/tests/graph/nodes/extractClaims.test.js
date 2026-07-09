import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractClaimsNode } from '../../../src/graph/nodes/extractClaims.js';

test('attaches source metadata to each claim returned by the injected extractClaims, and forwards costUsd as costUsdAnalysis', async () => {
  const fakeExtract = async () => ({
    claims: [
      { subject: 'A', predicate: 'B', object_value: 'C', confidence_level: 'высокая', confidence_explanation: 'D' },
      { subject: 'E', predicate: 'F', object_value: 'G', confidence_level: 'средняя', confidence_explanation: 'H' }
    ],
    costUsd: 0.00004
  });
  const node = createExtractClaimsNode(fakeExtract);
  const item = { job_id: 'job-1', agent: 1, content_type: 'search' };

  const result = await node({ item });

  assert.equal(result.claims.length, 2);
  assert.deepEqual(result.claims[0].source, { agent: 1, jobId: 'job-1', refType: 'search' });
  assert.deepEqual(result.claims[1].source, { agent: 1, jobId: 'job-1', refType: 'search' });
  assert.equal(result.claims[0].subject, 'A');
  assert.equal(result.costUsdAnalysis, 0.00004);
});

test('returns an empty claims array and costUsdAnalysis 0 when the injected extractClaims returns no claims', async () => {
  const fakeExtract = async () => ({ claims: [], costUsd: 0 });
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-2', agent: 2, content_type: 'video' } });

  assert.deepEqual(result, { claims: [], costUsdAnalysis: 0 });
});

test('isolates a failure: returns errors, not claims, and does not throw', async () => {
  const fakeExtract = async () => { throw new Error('LLM timeout'); };
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-3', agent: 1, content_type: 'search' } });

  assert.deepEqual(result.errors, ['item job-3: LLM timeout']);
  assert.equal(result.claims, undefined);
  assert.equal(result.costUsdAnalysis, undefined);
});

test('a failure that already incurred real cost (err.costUsd set) still contributes that cost, not undefined', async () => {
  const fakeExtract = async () => {
    const err = new Error('LLM returned invalid JSON');
    err.costUsd = 0.00007;
    throw err;
  };
  const node = createExtractClaimsNode(fakeExtract);

  const result = await node({ item: { job_id: 'job-4', agent: 1, content_type: 'search' } });

  assert.equal(result.costUsdAnalysis, 0.00007);
});
