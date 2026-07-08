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
    source: { agent: 1, jobId: 'job-1', refType: 'search' },
    ...overrides
  };
}

test('creates a run, one source per unique job, one entity+claim per claim, status ok', async () => {
  let entityCounter = 0;
  const inserted = { sources: [], entities: [], claims: [] };
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
      return { error: null };
    }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }],
    claims: [claim({ subject: 'A' }), claim({ subject: 'B' })],
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
});

test('status is partial when state.errors is non-empty', async () => {
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-2' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: () => ({ error: null })
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
      return { error: null };
    }
  });

  const node = createPersistResultsNode({ db });
  const state = {
    items: [{ job_id: 'job-1' }, { job_id: 'job-2' }],
    claims: [
      claim({ subject: 'A', source: { agent: 1, jobId: 'job-1', refType: 'search' } }),
      claim({ subject: 'B', source: { agent: 2, jobId: 'job-2', refType: 'video' } })
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
