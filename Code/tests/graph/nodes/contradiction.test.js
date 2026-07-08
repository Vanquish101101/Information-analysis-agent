import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContradictionNode } from '../../../src/graph/nodes/contradiction.js';

function claim(overrides = {}) {
  return {
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    confidence_level: 'высокая',
    confidence_explanation: 'ok',
    source: { agent: 1, jobId: 'job-1', refType: 'search' },
    isDuplicate: false,
    subjectEntityId: 'ent-1',
    contradictionCandidate: null,
    ...overrides
  };
}

function candidate(overrides = {}) {
  return {
    id: 'claim-existing',
    predicate: 'подняла раунд',
    object_value: '3 млн',
    confidence_level: 'средняя',
    confidence_explanation: 'ok',
    ...overrides
  };
}

test('claim with no contradictionCandidate passes through unchanged, no judge call', async () => {
  const judgeContradiction = async () => { throw new Error('should not be called'); };
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: null })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, undefined);
});

test('low/medium-confidence candidate: exactly one judge call', async () => {
  let callCount = 0;
  const judgeContradiction = async () => { callCount += 1; return { label: 'contradict', confidenceLevel: 'средняя', explanation: 'конфликт' }; };
  const node = createContradictionNode({ judgeContradiction });

  await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  assert.equal(callCount, 1);
});

test('high-confidence candidate: exactly three judge calls (self-consistency)', async () => {
  let callCount = 0;
  const judgeContradiction = async () => { callCount += 1; return { label: 'contradict', confidenceLevel: 'высокая', explanation: 'конфликт' }; };
  const node = createContradictionNode({ judgeContradiction });

  await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(callCount, 3);
});

test('agree verdict: does not mark the claim as a contradiction', async () => {
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'совместимо' });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, false);
});

test('contradict verdict: marks the claim with contradiction fields', async () => {
  const judgeContradiction = async () => ({ label: 'contradict', confidenceLevel: 'высокая', explanation: 'разные суммы' });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя', id: 'claim-42' }) })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.hasContradiction, true);
  assert.equal(resolved.contradictsClaimId, 'claim-42');
  assert.equal(resolved.contradictionRawLabel, 'contradict');
  assert.equal(resolved.contradictionConfidenceLevel, 'высокая');
  assert.equal(resolved.contradictionExplanation, 'разные суммы');
});

test('unclear verdict is treated as a contradiction (raw label preserved as "unclear")', async () => {
  const judgeContradiction = async () => ({ label: 'unclear', confidenceLevel: 'низкая', explanation: 'не уверен' });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'средняя' }) })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.hasContradiction, true);
  assert.equal(resolved.contradictionRawLabel, 'unclear');
});

test('self-consistency majority vote: 2 contradict + 1 agree results in contradict', async () => {
  let call = 0;
  const responses = [
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'a' },
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'b' },
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'c' }
  ];
  const judgeContradiction = async () => responses[call++];
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, true);
  assert.equal(result.claims.value[0].contradictionRawLabel, 'contradict');
});

test('self-consistency: confidence/explanation come from a verdict matching the winning label, not just the first sample', async () => {
  let call = 0;
  const responses = [
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'суммы дополняют друг друга' },
    { label: 'contradict', confidenceLevel: 'средняя', explanation: 'разные суммы, конфликт' },
    { label: 'contradict', confidenceLevel: 'средняя', explanation: 'явное противоречие' }
  ];
  const judgeContradiction = async () => responses[call++];
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  const resolved = result.claims.value[0];
  assert.equal(resolved.contradictionRawLabel, 'contradict');
  assert.equal(resolved.contradictionConfidenceLevel, 'средняя');
  assert.match(resolved.contradictionExplanation, /конфликт|противоречие/);
});

test('self-consistency three-way tie (agree/contradict/unclear) resolves to unclear, treated as a contradiction', async () => {
  let call = 0;
  const responses = [
    { label: 'agree', confidenceLevel: 'высокая', explanation: 'a' },
    { label: 'contradict', confidenceLevel: 'высокая', explanation: 'b' },
    { label: 'unclear', confidenceLevel: 'высокая', explanation: 'c' }
  ];
  const judgeContradiction = async () => responses[call++];
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ contradictionCandidate: candidate({ confidence_level: 'высокая' }) })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, true);
  assert.equal(result.claims.value[0].contradictionRawLabel, 'unclear');
});

test('a judge failure for one claim does not crash the node: falls back to no-contradiction and records an error', async () => {
  const judgeContradiction = async () => { throw new Error('LLM timeout'); };
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim({ subject: 'job-y-subject', contradictionCandidate: candidate() })], errors: [] });

  assert.equal(result.claims.value[0].hasContradiction, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /job-y-subject/);
});

test('claims channel is wrapped in Overwrite, not a plain array', async () => {
  const judgeContradiction = async () => ({ label: 'agree', confidenceLevel: 'высокая', explanation: 'ok' });
  const node = createContradictionNode({ judgeContradiction });

  const result = await node({ claims: [claim()], errors: [] });

  assert.equal(result.claims.constructor.name, 'Overwrite');
});
