// tests/graph/nodes/persistResults.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistResultsNode } from '../../../src/graph/nodes/persistResults.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function claim(overrides = {}) {
  return {
    subject: 'Subject',
    predicate: 'predicate',
    object_value: 'value',
    confidence_level: 'высокая',
    confidence_explanation: 'ok',
    source: { agent: 1, jobId: 'job-1', refType: 'search', reachEstimate: 0 },
    isDuplicate: false,
    subjectEntityId: null,
    subjectEmbedding: [0.1, 0.2],
    claimEmbedding: [0.3, 0.4],
    batchEntityKey: 'subject',
    ...overrides
  };
}

test('creates a run, one source per unique job, one entity+claim per claim, status ok', async () => {
  let entityCounter = 0;
  const inserted = { sources: [], entities: [], claims: [], claimSources: [] };
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-1' }, error: null };
      if (state.operation === 'update') return { error: null };
      throw new Error('unexpected runs operation');
    },
    sources: (state) => {
      inserted.sources.push(state.payload);
      return { data: { id: 'src-1' }, error: null };
    },
    entities: (state) => {
      entityCounter += 1;
      inserted.entities.push(state.payload);
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => {
      inserted.claims.push(state.payload);
      return { data: { id: `claim-${inserted.claims.length}` }, error: null };
    },
    claim_sources: (state) => {
      inserted.claimSources.push(state.payload);
      return { error: null };
    }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [
      claim({ subject: 'A', batchEntityKey: 'a' }),
      claim({ subject: 'B', batchEntityKey: 'b' })
    ],
    errors: []
  };

  const result = await node(state);

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(inserted.sources.length, 1, 'one source for the one unique (agent, jobId) pair');
  assert.equal(inserted.entities.length, 2, 'one entity per claim, no dedup');
  assert.equal(inserted.claims.length, 2);
  assert.equal(inserted.claims[0].subject_entity_id, 'ent-1');
  assert.equal(inserted.claims[0].source_id, 'src-1');
  assert.equal(inserted.claimSources.length, 2, 'one claim_sources row per persisted claim');
  assert.deepEqual(inserted.claimSources[0], { claim_id: 'claim-1', source_id: 'src-1' });
});

test('status is partial when state.errors is non-empty', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-2' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }, { job_id: 'job-2' }],
    claims: [claim()],
    errors: ['item job-2: LLM timeout']
  };

  const result = await node(state);

  assert.equal(result.status, 'partial');
});

test('creates a run with no writes when there are no claims at all', async () => {
  let sourcesCalled = false;
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-3' }, error: null } : { error: null }),
    sources: () => { sourcesCalled = true; return { data: { id: 'src-1' }, error: null }; }
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [], claims: [], errors: [] };

  const result = await node(state);

  assert.equal(result.runId, 'run-3');
  assert.equal(result.status, 'ok');
  assert.equal(sourcesCalled, false);
  assert.deepEqual(result.persistedFacts, []);
  assert.deepEqual(result.persistedContradictions, []);
});

test('creates one source per distinct (agent, jobId) pair when claims come from different sources', async () => {
  let entityCounter = 0;
  let sourceCounter = 0;
  const inserted = { sources: [], entities: [], claims: [] };
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-5' }, error: null } : { error: null }),
    sources: (state) => {
      sourceCounter += 1;
      inserted.sources.push(state.payload);
      return { data: { id: `src-${sourceCounter}` }, error: null };
    },
    entities: (state) => {
      entityCounter += 1;
      inserted.entities.push(state.payload);
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => {
      inserted.claims.push(state.payload);
      return { data: { id: `claim-${inserted.claims.length}` }, error: null };
    },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }, { job_id: 'job-2' }],
    claims: [
      claim({ subject: 'A', source: { agent: 1, jobId: 'job-1', refType: 'search', reachEstimate: 0 } }),
      claim({ subject: 'B', source: { agent: 2, jobId: 'job-2', refType: 'video', reachEstimate: 0 } })
    ],
    errors: []
  };

  const result = await node(state);

  assert.equal(result.status, 'ok');
  assert.equal(inserted.sources.length, 2, 'two distinct (agent, jobId) pairs produce two source rows');
  assert.equal(inserted.claims.length, 2);
  assert.equal(inserted.claims[0].source_id, 'src-1');
  assert.equal(inserted.claims[1].source_id, 'src-2');
});

test('sets run status to error and rethrows when a write fails partway through', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-4' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: null, error: { message: 'constraint violation' } })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  await assert.rejects(() => node(state), /failed to create entity/);
  assert.equal(runUpdatePayload.status, 'error');
});

test('reusing an existing entity does not insert a new entities row, and updates its last_seen_at', async () => {
  const entityUpdates = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-6' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => {
      if (state.operation === 'update') {
        entityUpdates.push(state.payload);
        return { error: null };
      }
      throw new Error('should not insert a new entity when subjectEntityId is already resolved');
    },
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ subjectEntityId: 'ent-existing', subjectEmbedding: null, batchEntityKey: null })],
    errors: []
  };

  await node(state);

  assert.equal(entityUpdates.length, 1);
  assert.ok(entityUpdates[0].last_seen_at);
});

test('two claims sharing a batchEntityKey (both new) create only one entity, reused for both claims', async () => {
  let entityInsertCount = 0;
  const insertedClaims = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-7' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => {
      entityInsertCount += 1;
      return { data: { id: `ent-${entityInsertCount}` }, error: null };
    },
    claims: (state) => {
      insertedClaims.push(state.payload);
      return { data: { id: `claim-${insertedClaims.length}` }, error: null };
    },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [
      claim({ subject: 'Same Subject', batchEntityKey: 'same subject' }),
      claim({ subject: 'Same Subject', object_value: 'other value', batchEntityKey: 'same subject' })
    ],
    errors: []
  };

  await node(state);

  assert.equal(entityInsertCount, 1);
  assert.equal(insertedClaims.length, 2);
  assert.equal(insertedClaims[0].subject_entity_id, 'ent-1');
  assert.equal(insertedClaims[1].subject_entity_id, 'ent-1');
});

test('a claim marked isDuplicate updates the existing claim instead of inserting a new one, and links claim_sources to the existing claim id', async () => {
  let claimsInsertCalled = false;
  let claimsUpdatePayload = null;
  const claimSourceLinks = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-8' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    claims: (state) => {
      if (state.operation === 'insert') { claimsInsertCalled = true; return { error: null }; }
      claimsUpdatePayload = state.payload;
      return { error: null };
    },
    claim_sources: (state) => { claimSourceLinks.push(state.payload); return { error: null }; }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({
      isDuplicate: true,
      duplicateOfClaimId: 'claim-existing',
      bumpedConfidenceLevel: 'средняя',
      bumpedConfidenceExplanation: 'ok Подтверждено дополнительным источником (agent 1, job job-1).',
      subjectEntityId: 'ent-existing'
    })],
    errors: []
  };

  const result = await node(state);

  assert.equal(claimsInsertCalled, false);
  assert.equal(claimsUpdatePayload.confidence_level, 'средняя');
  assert.match(claimsUpdatePayload.confidence_explanation, /Подтверждено дополнительным источником/);
  assert.equal(claimSourceLinks.length, 1);
  assert.deepEqual(claimSourceLinks[0], { claim_id: 'claim-existing', source_id: 'src-1' });
  assert.equal(result.persistedFacts.length, 1);
  assert.equal(result.persistedFacts[0].claimId, 'claim-existing');
  assert.equal(result.persistedFacts[0].confidence_level, 'средняя');
});

test('new entities and claims are created with their embedding column populated', async () => {
  const insertedEntities = [];
  const insertedClaims = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-9' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => { insertedEntities.push(state.payload); return { data: { id: 'ent-1' }, error: null }; },
    claims: (state) => { insertedClaims.push(state.payload); return { data: { id: 'claim-1' }, error: null }; },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  await node(state);

  assert.deepEqual(insertedEntities[0].embedding, [0.1, 0.2]);
  assert.deepEqual(insertedClaims[0].embedding, [0.3, 0.4]);
});

test('sources row is created with the reach_estimate from claim.source.reachEstimate', async () => {
  const insertedSources = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-17' }, error: null } : { error: null }),
    sources: (state) => { insertedSources.push(state.payload); return { data: { id: 'src-1' }, error: null }; },
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ source: { agent: 1, jobId: 'job-1', refType: 'search', reachEstimate: 45000 } })],
    errors: []
  };

  await node(state);

  assert.equal(insertedSources[0].reach_estimate, 45000);
});

test('a claim with a null claimEmbedding (dedup error-fallback) is skipped for the claims insert, but its entity is still created, and it does not appear in persistedFacts', async () => {
  const insertedEntities = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-10' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => { insertedEntities.push(state.payload); return { data: { id: 'ent-1' }, error: null }; },
    claims: () => { throw new Error('should not insert a claims row for a claim with a null claimEmbedding'); }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ claimEmbedding: null, isDuplicate: false })],
    errors: ['dedup failed for claim subject "Subject": embedding error']
  };

  const result = await node(state);

  assert.equal(insertedEntities.length, 1, 'entity grouping/creation still happens even when the claim itself is skipped');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.persistedFacts, []);
});

test('a claim marked hasContradiction inserts a contradictions row after the claim, and appears in persistedContradictions', async () => {
  const insertedContradictions = [];
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-11' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => {
      if (state.operation === 'insert') return { data: { id: 'claim-new-1' }, error: null };
      throw new Error('unexpected claims update in this test');
    },
    contradictions: (state) => {
      insertedContradictions.push(state.payload);
      return { error: null };
    },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({
      hasContradiction: true,
      contradictsClaimId: 'claim-existing-1',
      contradictionRawLabel: 'contradict',
      contradictionConfidenceLevel: 'высокая',
      contradictionExplanation: 'разные суммы'
    })],
    errors: []
  };

  const result = await node(state);

  assert.equal(insertedContradictions.length, 1);
  assert.equal(insertedContradictions[0].claim_a_id, 'claim-new-1');
  assert.equal(insertedContradictions[0].claim_b_id, 'claim-existing-1');
  assert.equal(result.persistedContradictions.length, 1);
  assert.deepEqual(result.persistedContradictions[0], {
    claimAId: 'claim-new-1',
    claimBId: 'claim-existing-1',
    explanation: 'разные суммы'
  });
});

test('a claim without hasContradiction does not touch the contradictions table, and persistedContradictions stays empty', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-12' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-new-2' }, error: null } : { error: null }),
    contradictions: () => { throw new Error('should not write to contradictions when hasContradiction is not true'); },
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  const result = await node(state);

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.persistedContradictions, []);
});

test('writes cost_usd/cost_usd_analysis/cost_usd_retry/escalations_auto/escalations_pending_user on the final status update', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-13' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim()],
    errors: [],
    costUsdAnalysis: 0.03,
    costUsdRetry: 0.02,
    escalationsAuto: 2,
    escalationsPendingUser: 1
  };

  await node(state);

  assert.equal(runUpdatePayload.cost_usd, 0.05);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0.03);
  assert.equal(runUpdatePayload.cost_usd_retry, 0.02);
  assert.equal(runUpdatePayload.escalations_auto, 2);
  assert.equal(runUpdatePayload.escalations_pending_user, 1);
});

test('defaults cost/escalation fields to 0 when the state does not set them (backward compatible with pre-escalation runs)', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-14' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  await node(state);

  assert.equal(runUpdatePayload.cost_usd, 0);
  assert.equal(runUpdatePayload.cost_usd_analysis, 0);
  assert.equal(runUpdatePayload.cost_usd_retry, 0);
  assert.equal(runUpdatePayload.escalations_auto, 0);
  assert.equal(runUpdatePayload.escalations_pending_user, 0);
});

test('status is cost_cap_reached when state.costCapReached is true, overriding ok/partial', async () => {
  let runUpdatePayload = null;
  const db = makeFakeDb({
    runs: (state) => {
      if (state.operation === 'insert') return { data: { id: 'run-15' }, error: null };
      runUpdatePayload = state.payload;
      return { error: null };
    },
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [], costCapReached: true };

  const result = await node(state);

  assert.equal(result.status, 'cost_cap_reached');
  assert.equal(runUpdatePayload.status, 'cost_cap_reached');
});

test('status is still partial (not cost_cap_reached) when costCapReached is false but there are errors', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-16' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: ['some error'], costCapReached: false };

  const result = await node(state);

  assert.equal(result.status, 'partial');
});

test('a failure inserting a claim_sources row is logged, not thrown (does not crash the whole run)', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-18' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ data: { id: 'claim-1' }, error: null }),
    claim_sources: () => ({ error: { message: 'constraint violation' } })
  });

  const node = createPersistResultsNode({ db });
  const state = { items: [{ job_id: 'job-1' }], claims: [claim()], errors: [] };

  const result = await node(state);

  assert.equal(result.status, 'ok');
  assert.equal(result.persistedFacts.length, 1, 'claim_sources failure does not prevent the fact from being reported');
});
