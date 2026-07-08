// tests/graph/nodes/dedup.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDedupNode } from '../../../src/graph/nodes/dedup.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function claim(overrides = {}) {
  return {
    subject: 'Продукт X',
    predicate: 'имеет цену',
    object_value: '999 руб',
    confidence_level: 'высокая',
    confidence_explanation: 'ok',
    source: { agent: 1, jobId: 'job-1', refType: 'search' },
    ...overrides
  };
}

test('no entity candidate: creates a new entity path with embeddings and a batchEntityKey', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async (text) => (text.includes('Продукт X') ? [0.1, 0.2] : [0.3, 0.4]);
  const judgeDuplicate = async () => { throw new Error('should not be called when there is no candidate'); };
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value.length, 1);
  const resolved = result.claims.value[0];
  assert.equal(resolved.isDuplicate, false);
  assert.equal(resolved.subjectEntityId, null);
  assert.equal(resolved.batchEntityKey, 'продукт x');
  assert.ok(Array.isArray(resolved.subjectEmbedding));
  assert.ok(Array.isArray(resolved.claimEmbedding));
});

test('entity candidate confirmed by judge: reuses existing entity, no new-entity fields set', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => [0.1, 0.2];
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true, reasoning: 'same' } : { isDuplicate: false });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.subjectEntityId, 'ent-1');
  assert.equal(resolved.subjectEmbedding, null);
  assert.equal(resolved.isDuplicate, false);
});

test('entity candidate rejected by judge: falls back to new-entity path', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Something else', similarity: 0.86 }], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => [0.1, 0.2];
  const judgeDuplicate = async () => ({ isDuplicate: false, reasoning: 'different' });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.subjectEntityId, null);
  assert.ok(Array.isArray(resolved.subjectEmbedding));
});

test('claim candidate confirmed by judge on a resolved entity: marks as duplicate with bumped confidence', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-1', predicate: 'имеет цену', object_value: '999 руб',
        confidence_level: 'низкая', confidence_explanation: 'из одного источника', similarity: 0.9
      }],
      error: null
    })
  });
  const embedText = async () => [0.1, 0.2];
  const judgeDuplicate = async () => ({ isDuplicate: true, reasoning: 'same fact' });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim({ source: { agent: 2, jobId: 'job-9', refType: 'video' } })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.isDuplicate, true);
  assert.equal(resolved.duplicateOfClaimId, 'claim-1');
  assert.equal(resolved.bumpedConfidenceLevel, 'средняя');
  assert.match(resolved.bumpedConfidenceExplanation, /из одного источника/);
  assert.match(resolved.bumpedConfidenceExplanation, /agent 2, job job-9/);
});

test('claim candidate exists but judge rejects duplicate: contradictionCandidate carries the rejected candidate through', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-1', predicate: 'имеет цену', object_value: '899 руб',
        confidence_level: 'высокая', confidence_explanation: 'другой источник', similarity: 0.87
      }],
      error: null
    })
  });
  const embedText = async () => [0.1, 0.2];
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true } : { isDuplicate: false });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.isDuplicate, false);
  assert.ok(resolved.contradictionCandidate);
  assert.equal(resolved.contradictionCandidate.id, 'claim-1');
  assert.equal(resolved.contradictionCandidate.confidence_level, 'высокая');
});

test('no claim candidate at all: contradictionCandidate is null', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => [0.1, 0.2];
  const judgeDuplicate = async () => ({ isDuplicate: true });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].contradictionCandidate, null);
});

test('new (unresolved) entity: contradictionCandidate is null (no existing claims possible)', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => [0.1];
  const judgeDuplicate = async () => ({ isDuplicate: false });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].contradictionCandidate, null);
});

test('confidence bump caps at высокая and never decreases', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Product X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{ id: 'claim-1', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e', similarity: 0.9 }],
      error: null
    })
  });
  const embedText = async () => [0.1];
  const judgeDuplicate = async () => ({ isDuplicate: true });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.value[0].bumpedConfidenceLevel, 'высокая');
});

test('a new (unresolved) entity skips the claim-duplicate check entirely (no existing claims possible)', async () => {
  let matchClaimsCalled = false;
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => { matchClaimsCalled = true; return { data: [], error: null }; }
  });
  const embedText = async () => [0.1];
  const judgeDuplicate = async () => ({ isDuplicate: false });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  await node({ claims: [claim()], errors: [] });

  assert.equal(matchClaimsCalled, false);
});

test('a failure resolving one claim does not crash the node: falls back to new-entity path and records an error', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async (text) => { throw new Error('Gemini timeout'); };
  const judgeDuplicate = async () => ({ isDuplicate: false });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim({ subject: 'job-x-subject' })], errors: [] });

  assert.equal(result.claims.value.length, 1);
  assert.equal(result.claims.value[0].isDuplicate, false);
  assert.equal(result.claims.value[0].subjectEntityId, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /job-x-subject/);
});

test('claims channel is wrapped in Overwrite, not a plain array (must replace, not concat)', async () => {
  const db = makeFakeDb({
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null })
  });
  const embedText = async () => [0.1];
  const judgeDuplicate = async () => ({ isDuplicate: false });
  const node = createDedupNode({ db, embedText, judgeDuplicate });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.constructor.name, 'Overwrite');
});
