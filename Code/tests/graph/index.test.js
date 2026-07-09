// tests/graph/index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisGraph } from '../../src/graph/index.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

function makeDb() {
  let entityCounter = 0;
  let claimCounter = 0;
  return makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-1' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: (state) => {
      entityCounter += 1;
      return { data: { id: `ent-${entityCounter}` }, error: null };
    },
    claims: (state) => {
      if (state.operation !== 'insert') return { error: null };
      claimCounter += 1;
      return { data: { id: `claim-${claimCounter}` }, error: null };
    },
    claim_sources: () => ({ error: null }),
    contradictions: () => ({ error: null }),
    pending_user_decisions: () => ({ error: null }),
    digests: () => ({ error: null }),
    match_entities: () => ({ data: [], error: null }),
    match_claims: () => ({ data: [], error: null }),
    claim_source_stats: () => ({ data: [], error: null })
  });
}

const fakeEmbedText = async () => ({ embedding: [0.1, 0.2], costUsd: 0 });
const fakeJudgeDuplicate = async () => ({ isDuplicate: false, costUsd: 0 });
const fakeJudgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok', costUsd: 0 });
const fakeRetryParse = async () => { throw new Error('should not be called unless an item has low confidence'); };
const fakeSynthesizeDigest = async (facts) => ({
  statements: facts.map((f) => ({ claimId: f.claimId, statement: `${f.subject} ${f.predicate}` })),
  costUsd: 0
});

test('throws when db is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ extractClaims: async () => ({ claims: [], costUsd: 0 }) }),
    /db is required/
  );
});

test('throws when extractClaims is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb() }),
    /extractClaims must be a function/
  );
});

test('runs the full graph for a non-empty batch: extracts, reduces, persists, synthesizes', async () => {
  const extractClaims = async (item) => ({
    claims: [{ subject: `subject-${item.job_id}`, predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } },
     { job_id: 'job-2', agent: 2, content_type: 'video', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 2);
  assert.deepEqual(result.errors, []);
});

test('isolates a per-item extraction failure: run still completes with status partial', async () => {
  const extractClaims = async (item) => {
    if (item.job_id === 'job-bad') throw new Error('LLM timeout');
    return { claims: [{ subject: 'ok', predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }], costUsd: 0.001 };
  };
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-good', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } },
     { job_id: 'job-bad', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.claimsWritten, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /job-bad/);
});

test('runs for an empty batch (FORCED_CEILING with nothing accumulated): still records a run', async () => {
  const extractClaims = async () => ({ claims: [], costUsd: 0 });
  const runAnalysis = createAnalysisGraph({ db: makeDb(), extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis([], { reason: 'ceiling' });

  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 0);
});

test('throws when embedText is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest }),
    /embedText must be a function/
  );
});

test('throws when judgeDuplicate is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest }),
    /judgeDuplicate must be a function/
  );
});

test('throws when judgeContradiction is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest }),
    /judgeContradiction must be a function/
  );
});

test('throws when retryParse is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, synthesizeDigest: fakeSynthesizeDigest }),
    /retryParse must be a function/
  );
});

test('throws when synthesizeDigest is missing', () => {
  assert.throws(
    () => createAnalysisGraph({ db: makeDb(), extractClaims: async () => ({ claims: [], costUsd: 0 }), embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse: fakeRetryParse }),
    /synthesizeDigest must be a function/
  );
});

test('end-to-end: a contradicting claim gets flagged, persisted, and included in the saved digest', async () => {
  const insertedContradictions = [];
  let insertedDigest = null;
  const db = makeFakeDb({
    runs: (state) => (state.operation === 'insert' ? { data: { id: 'run-2' }, error: null } : { error: null }),
    sources: () => ({ data: { id: 'src-1' }, error: null }),
    entities: () => ({ data: { id: 'ent-1' }, error: null }),
    claims: (state) => (state.operation === 'insert' ? { data: { id: 'claim-new-1' }, error: null } : { error: null }),
    claim_sources: () => ({ error: null }),
    contradictions: (state) => { insertedContradictions.push(state.payload); return { error: null }; },
    pending_user_decisions: () => ({ error: null }),
    digests: (state) => { insertedDigest = state.payload; return { error: null }; },
    match_entities: () => ({ data: [{ id: 'ent-1', name: 'Компания X', similarity: 0.9 }], error: null }),
    match_claims: () => ({
      data: [{
        id: 'claim-existing-1', predicate: 'подняла раунд', object_value: '3 млн',
        confidence_level: 'средняя', confidence_explanation: 'ok', similarity: 0.9
      }],
      error: null
    }),
    claim_source_stats: () => ({ data: [{ claim_id: 'claim-new-1', sources_count: 1, reach_estimate: 0 }], error: null })
  });

  const extractClaims = async () => ({
    claims: [{ subject: 'Компания X', predicate: 'подняла раунд', object_value: '5 млн', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const judgeDuplicate = async ({ kind }) => (kind === 'entity' ? { isDuplicate: true, costUsd: 0 } : { isDuplicate: false, costUsd: 0 });
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы', costUsd: 0 });

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate, judgeContradiction, retryParse: fakeRetryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 1, content_type: 'search', confidence: { level: 'высокая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'ok');
  assert.equal(insertedContradictions.length, 1);
  assert.equal(insertedContradictions[0].claim_a_id, 'claim-new-1');
  assert.equal(insertedContradictions[0].claim_b_id, 'claim-existing-1');
  assert.ok(insertedDigest, 'a digest row was saved');
  assert.equal(insertedDigest.contradictions.length, 1);
  assert.equal(insertedDigest.contradictions[0].claim_a_id, 'claim-new-1');
});

test('end-to-end: a low-confidence item with content_ref is retried before extraction', async () => {
  const db = makeDb();
  const extractClaims = async (item) => ({
    claims: [{ subject: item.result.transcript, predicate: 'p', object_value: 'v', confidence_level: 'высокая', confidence_explanation: 'e' }],
    costUsd: 0.001
  });
  const retryParse = async ({ contentRef, contentType }) => {
    assert.equal(contentRef, 'https://example.com/audio.mp3');
    assert.equal(contentType, 'audio');
    return { result: { transcript: 'улучшенный текст' }, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 0.03 } };
  };

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText: fakeEmbedText, judgeDuplicate: fakeJudgeDuplicate, judgeContradiction: fakeJudgeContradiction, retryParse, synthesizeDigest: fakeSynthesizeDigest });

  const result = await runAnalysis(
    [{ job_id: 'job-1', agent: 2, content_type: 'audio', content_ref: 'https://example.com/audio.mp3', result: { transcript: 'слабо' }, confidence: { level: 'низкая', explanation: 'ok' } }],
    { reason: 'idle' }
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.claimsWritten, 1);
});
