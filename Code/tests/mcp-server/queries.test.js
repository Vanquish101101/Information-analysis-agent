import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDigest, getClaimDetail, getStatus } from '../../src/mcp-server/queries.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('getDigest returns the most recent digest when no run_id is given', async () => {
  const db = makeFakeDb({
    digests: () => ({
      data: [{ id: 'digest-1', run_id: 'run-1', run_at: '2026-07-09T10:00:00Z', facts: [{ claim_id: 'c1' }], contradictions: [], meta: { items_processed: 1 } }],
      error: null
    })
  });

  const result = await getDigest(db, null);

  assert.equal(result.digest_id, 'digest-1');
  assert.equal(result.run_at, '2026-07-09T10:00:00Z');
  assert.deepEqual(result.facts, [{ claim_id: 'c1' }]);
  assert.deepEqual(result.meta, { items_processed: 1 });
});

test('getDigest returns the digest for a specific run_id when given', async () => {
  let filteredRunId = null;
  const db = makeFakeDb({
    digests: (state) => {
      filteredRunId = state.filters.run_id;
      return { data: [{ id: 'digest-2', run_id: state.filters.run_id, run_at: '2026-07-08T10:00:00Z', facts: [], contradictions: [], meta: {} }], error: null };
    }
  });

  const result = await getDigest(db, 'run-42');

  assert.equal(filteredRunId, 'run-42');
  assert.equal(result.digest_id, 'digest-2');
});

test('getDigest returns an empty-shaped result when no digest exists yet', async () => {
  const db = makeFakeDb({ digests: () => ({ data: [], error: null }) });

  const result = await getDigest(db, null);

  assert.deepEqual(result, { digest_id: null, run_at: null, facts: [], contradictions: [], meta: null });
});

test('getDigest throws a descriptive error when the query fails', async () => {
  const db = makeFakeDb({ digests: () => ({ data: null, error: { message: 'connection lost' } }) });

  await assert.rejects(() => getDigest(db, null), /connection lost/);
});

test('getClaimDetail assembles statement/sources/reasoning from claims+entities+claim_sources+sources', async () => {
  const db = makeFakeDb({
    claims: () => ({ data: [{ id: 'claim-1', subject_entity_id: 'ent-1', predicate: 'подняла раунд', object_value: '5 млн', confidence_level: 'высокая', confidence_explanation: 'два независимых источника' }], error: null }),
    entities: () => ({ data: [{ id: 'ent-1', name: 'Компания X' }], error: null }),
    claim_sources: () => ({ data: [{ claim_id: 'claim-1', source_id: 'src-1' }], error: null }),
    sources: () => ({ data: [{ id: 'src-1', source_type: 'search', raw_job_id: 'job-1' }], error: null })
  });

  const result = await getClaimDetail(db, 'claim-1');

  assert.equal(result.claim_id, 'claim-1');
  assert.equal(result.statement, 'Компания X: подняла раунд: 5 млн');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].source_id, 'src-1');
  assert.equal(result.sources[0].type, 'search');
  assert.equal(result.sources[0].ref, 'job-1');
  assert.equal(result.sources[0].excerpt, null);
  assert.equal(result.sources[0].confidence, 'высокая');
  assert.equal(result.reasoning, 'два независимых источника');
  assert.deepEqual(result.history, []);
});

test('getClaimDetail returns null when the claim does not exist', async () => {
  const db = makeFakeDb({ claims: () => ({ data: [], error: null }) });

  const result = await getClaimDetail(db, 'claim-missing');

  assert.equal(result, null);
});

test('getClaimDetail handles multiple confirming sources', async () => {
  let sourceCallCount = 0;
  const db = makeFakeDb({
    claims: () => ({ data: [{ id: 'claim-1', subject_entity_id: 'ent-1', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }], error: null }),
    entities: () => ({ data: [{ id: 'ent-1', name: 'X' }], error: null }),
    claim_sources: () => ({ data: [{ claim_id: 'claim-1', source_id: 'src-1' }, { claim_id: 'claim-1', source_id: 'src-2' }], error: null }),
    sources: (state) => {
      sourceCallCount += 1;
      return { data: [{ id: state.filters.id, source_type: 'video', raw_job_id: `job-${state.filters.id}` }], error: null };
    }
  });

  const result = await getClaimDetail(db, 'claim-1');

  assert.equal(sourceCallCount, 2);
  assert.equal(result.sources.length, 2);
});

test('getStatus returns the latest run plus only pending (not resolved) escalations', async () => {
  let pendingFilter = null;
  const db = makeFakeDb({
    runs: () => ({ data: [{ run_at: '2026-07-09T10:00:00Z', status: 'ok', items_processed: 3, cost_usd: 0.05 }], error: null }),
    pending_user_decisions: (state) => {
      pendingFilter = state.filters.status;
      return { data: [{ job_id: 'job-1', question: 'дорого?', estimated_cost_usd: 0.15 }], error: null };
    }
  });

  const result = await getStatus(db);

  assert.equal(pendingFilter, 'pending');
  assert.equal(result.status, 'ok');
  assert.equal(result.items_processed, 3);
  assert.equal(result.cost_usd, 0.05);
  assert.equal(result.pending_user_decisions.length, 1);
  assert.equal(result.pending_user_decisions[0].job_id, 'job-1');
});

test('getStatus returns nulls/zeros gracefully when there are no runs yet', async () => {
  const db = makeFakeDb({
    runs: () => ({ data: [], error: null }),
    pending_user_decisions: () => ({ data: [], error: null })
  });

  const result = await getStatus(db);

  assert.equal(result.last_run_at, null);
  assert.equal(result.status, null);
  assert.equal(result.items_processed, 0);
  assert.equal(result.cost_usd, 0);
  assert.deepEqual(result.pending_user_decisions, []);
});
