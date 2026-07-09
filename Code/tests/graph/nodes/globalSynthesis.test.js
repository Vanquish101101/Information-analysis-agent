import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalSynthesisNode } from '../../../src/graph/nodes/globalSynthesis.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function fact(overrides = {}) {
  return {
    claimId: 'claim-1',
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    confidence_level: 'высокая',
    ...overrides
  };
}

function baseState(overrides = {}) {
  return {
    runId: 'run-1',
    items: [{ job_id: 'job-1' }],
    escalationsAuto: 0,
    escalationsPendingUser: 0,
    costUsdAnalysis: 0.01,
    costUsdRetry: 0,
    persistedFacts: [fact()],
    persistedContradictions: [],
    ...overrides
  };
}

test('does nothing (no digest, no run update) when persistedFacts is empty', async () => {
  const db = makeFakeDb({});
  const synthesizeDigest = async () => { throw new Error('should not be called'); };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState({ persistedFacts: [] }));

  assert.deepEqual(result, {});
});

test('queries claim_source_stats for every persisted claim_id', async () => {
  const rpcCalls = [];
  const db = makeFakeDb({
    claim_source_stats: (params) => { rpcCalls.push(params); return { data: [{ claim_id: 'claim-1', sources_count: 2, reach_estimate: 5000 }], error: null }; },
    digests: () => ({ error: null }),
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(rpcCalls[0], { claim_ids: ['claim-1'] });
});

test('assembles facts[] with statement, confidence, and detail_ref from stats + LLM statements', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [{ claim_id: 'claim-1', sources_count: 3, reach_estimate: 12000 }], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'Компания X подняла 5 млн.' }], costUsd: 0.0005 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.equal(insertedDigest.facts.length, 1);
  assert.equal(insertedDigest.facts[0].claim_id, 'claim-1');
  assert.equal(insertedDigest.facts[0].statement, 'Компания X подняла 5 млн.');
  assert.deepEqual(insertedDigest.facts[0].confidence, { level: 'высокая', sources_count: 3, reach_estimate: 12000 });
  assert.equal(insertedDigest.facts[0].detail_ref, 'claim-1');
});

test('falls back to a template statement (subject: predicate: object_value) when the LLM omits a claim_id', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.equal(insertedDigest.facts[0].statement, 'Компания X: подняла раунд: 5 млн');
});

test('defaults sources_count/reach_estimate to 0 when claim_source_stats has no row for a claim', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState());

  assert.deepEqual(insertedDigest.facts[0].confidence, { level: 'высокая', sources_count: 0, reach_estimate: 0 });
});

test('maps persistedContradictions into the digest contradictions[] shape', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({
    persistedContradictions: [{ claimAId: 'claim-1', claimBId: 'claim-existing-1', explanation: 'разные суммы' }]
  }));

  assert.deepEqual(insertedDigest.contradictions, [
    { claim_a_id: 'claim-1', claim_b_id: 'claim-existing-1', explanation: 'разные суммы' }
  ]);
});

test('assembles meta from state (items_processed/escalations/cost_usd)', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0.0005 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ escalationsAuto: 2, escalationsPendingUser: 1, costUsdAnalysis: 0.03, costUsdRetry: 0.02 }));

  assert.equal(insertedDigest.meta.items_processed, 1);
  assert.equal(insertedDigest.meta.escalations_auto, 2);
  assert.equal(insertedDigest.meta.escalations_pending_user, 1);
  assert.equal(insertedDigest.meta.cost_usd, 0.03 + 0.02 + 0.0005);
});

test('inserts the digest row linked to state.runId', async () => {
  let insertedDigest = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ runId: 'run-42' }));

  assert.equal(insertedDigest.run_id, 'run-42');
});

test('adds the synthesis costUsd on top of the cost persistResults already wrote to runs', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: () => ({ error: null }),
    runs: (state) => { runUpdatePayload = state.payload; return { error: null }; }
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0.0007 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ costUsdAnalysis: 0.03, costUsdRetry: 0.02 }));

  assert.equal(runUpdatePayload.cost_usd, 0.03 + 0.02 + 0.0007);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0.03 + 0.0007);
});

test('a synthesizeDigest failure is caught and logged, does not throw, and skips saving a digest', async () => {
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: () => { throw new Error('should not be called after synthesizeDigest fails'); },
    runs: () => ({ error: null })
  });
  const synthesizeDigest = async () => { throw new Error('LLM timeout'); };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState());

  assert.deepEqual(result, {});
});

test('a synthesizeDigest failure still adds any already-incurred costUsd (attached to the error) to runs', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    runs: (state) => { runUpdatePayload = state.payload; return { error: null }; }
  });
  const synthesizeDigest = async () => {
    const err = new Error('LLM returned invalid JSON');
    err.costUsd = 0.0004;
    throw err;
  };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ costUsdAnalysis: 0.03, costUsdRetry: 0.02 }));

  assert.equal(runUpdatePayload.cost_usd, 0.03 + 0.02 + 0.0004);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0.03 + 0.0004);
});

test('a synthesizeDigest failure with no err.costUsd (e.g. HTTP error before any cost was incurred) adds 0, not undefined', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    runs: (state) => { runUpdatePayload = state.payload; return { error: null }; }
  });
  const synthesizeDigest = async () => { throw new Error('LLM HTTP 500'); };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  await node(baseState({ costUsdAnalysis: 0.03, costUsdRetry: 0.02 }));

  assert.equal(runUpdatePayload.cost_usd, 0.03 + 0.02);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0.03);
});

test('a claim_source_stats RPC failure is caught and logged, does not throw', async () => {
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: null, error: { message: 'function error' } })
  });
  const synthesizeDigest = async () => { throw new Error('should not be called'); };
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState());

  assert.deepEqual(result, {});
});

test('a digests insert failure is caught and logged, does not throw, but still adds the already-incurred synthesis cost to runs', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    claim_source_stats: () => ({ data: [], error: null }),
    digests: () => ({ error: { message: 'constraint violation' } }),
    runs: (state) => { runUpdatePayload = state.payload; return { error: null }; }
  });
  const synthesizeDigest = async () => ({ statements: [{ claimId: 'claim-1', statement: 'ok' }], costUsd: 0.0005 });
  const node = createGlobalSynthesisNode({ db, synthesizeDigest });

  const result = await node(baseState({ costUsdAnalysis: 0.03, costUsdRetry: 0.02 }));

  assert.deepEqual(result, {});
  assert.equal(runUpdatePayload.cost_usd, 0.03 + 0.02 + 0.0005);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0.03 + 0.0005);
});
