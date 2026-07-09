import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEscalationNode } from '../../../src/graph/nodes/escalation.js';
import { makeFakeDb } from '../../helpers/fakeSupabase.js';

function item(overrides = {}) {
  return {
    job_id: 'job-1',
    agent: 2,
    content_type: 'video',
    content_ref: 'https://example.com/video.mp4',
    result: { transcript: 'слабый разбор' },
    confidence: { level: 'низкая', explanation: 'автосубтитры' },
    ...overrides
  };
}

test('an item with non-low confidence passes through unchanged, no retry attempted', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: null }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ confidence: { level: 'высокая', explanation: 'ok' } })] });

  assert.deepEqual(result.items[0].confidence, { level: 'высокая', explanation: 'ok' });
  assert.equal(result.escalationsAuto, 0);
  assert.equal(result.escalationsPendingUser, 0);
});

test('a low-confidence item from Agent 1 (no content_ref) escalates without attempting retry', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ agent: 1, content_ref: null })] });

  assert.equal(result.escalationsPendingUser, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].job_id, 'job-1');
  assert.match(inserted[0].question, /content_ref/);
});

test('estimated retry cost above $0.10 escalates without attempting retry', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'video' })] }); // video estimate = $0.15 > $0.10

  assert.equal(result.escalationsPendingUser, 1);
  assert.equal(inserted[0].estimated_cost_usd, 0.15);
});

test('an unrecognized content_type escalates without attempting retry (no default cheap fallback)', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'unknown' })] });

  assert.equal(result.escalationsPendingUser, 1);
  assert.match(inserted[0].question, /Неизвестный content_type/);
});

test('estimated retry cost at or below $0.10 attempts a real retry', async () => {
  const db = makeFakeDb({});
  const retryParse = async ({ contentRef, contentType }) => {
    assert.equal(contentRef, 'https://example.com/audio.mp3');
    assert.equal(contentType, 'audio');
    return { result: { transcript: 'улучшено' }, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 0.04 } };
  };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'audio', content_ref: 'https://example.com/audio.mp3' })] }); // audio estimate = $0.05

  assert.equal(result.items[0].result.transcript, 'улучшено');
  assert.equal(result.items[0].confidence.level, 'высокая');
  assert.equal(result.escalationsAuto, 1);
  assert.equal(result.costUsdRetry, 0.04);
});

test('a failed retry escalates with the original item data intact', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  const retryParse = async () => { throw new Error('Agent 2 unreachable'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'audio' })] });

  assert.deepEqual(result.items[0].result, { transcript: 'слабый разбор' });
  assert.equal(result.escalationsPendingUser, 1);
  assert.match(inserted[0].question, /Agent 2 unreachable/);
});

test('once cumulative retry spend reaches $5, further items skip retry and escalate directly', async () => {
  const inserted = [];
  const db = makeFakeDb({ pending_user_decisions: (state) => { inserted.push(state.payload); return { error: null }; } });
  let retryCallCount = 0;
  const retryParse = async () => {
    retryCallCount += 1;
    return { result: {}, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 5 } };
  };
  const node = createEscalationNode({ db, retryParse });

  const items = [
    item({ job_id: 'job-a', content_type: 'audio' }),
    item({ job_id: 'job-b', content_type: 'audio' })
  ];
  const result = await node({ items });

  assert.equal(retryCallCount, 1); // only the first item retries; that alone reaches the $5 cap
  assert.equal(result.costCapReached, true);
  assert.equal(result.escalationsAuto, 1);
  assert.equal(result.escalationsPendingUser, 1);
  assert.match(inserted[0].question, /лимит/);
});

test('sums costUsdRetry across multiple successful retries', async () => {
  const db = makeFakeDb({});
  const retryParse = async () => ({ result: {}, confidence: { level: 'высокая', explanation: 'deep' }, meta: { cost_usd: 0.02 } });
  const node = createEscalationNode({ db, retryParse });

  const items = [
    item({ job_id: 'job-a', content_type: 'audio' }),
    item({ job_id: 'job-b', content_type: 'document' })
  ];
  const result = await node({ items });

  assert.equal(result.costUsdRetry, 0.04);
  assert.equal(result.escalationsAuto, 2);
});

test('a failure inserting a pending_user_decisions row is logged, not thrown', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: { message: 'constraint violation' } }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ agent: 1, content_ref: null })] });

  assert.equal(result.escalationsPendingUser, 1);
});

test('returns pendingDecisionMessages mirroring exactly what was inserted into pending_user_decisions', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: null }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ agent: 1, content_ref: null })] });

  assert.equal(result.pendingDecisionMessages.length, 1);
  assert.equal(result.pendingDecisionMessages[0].job_id, 'job-1');
  assert.match(result.pendingDecisionMessages[0].question, /content_ref/);
});

test('pendingDecisionMessages is an empty array when there are no escalations', async () => {
  const db = makeFakeDb({});
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ confidence: { level: 'высокая', explanation: 'ok' } })] });

  assert.deepEqual(result.pendingDecisionMessages, []);
});

test('pendingDecisionMessages includes the estimated_cost_usd for a cost-threshold escalation', async () => {
  const db = makeFakeDb({ pending_user_decisions: () => ({ error: null }) });
  const retryParse = async () => { throw new Error('should not be called'); };
  const node = createEscalationNode({ db, retryParse });

  const result = await node({ items: [item({ content_type: 'video' })] }); // video estimate = $0.15 > $0.10

  assert.equal(result.pendingDecisionMessages[0].estimated_cost_usd, 0.15);
});
