import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationsNode } from '../../../src/graph/nodes/notifications.js';

function contradictedClaim(overrides = {}) {
  return {
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    hasContradiction: true,
    contradictedClaimHistoricalConfidence: 'высокая',
    contradictionExplanation: 'разные суммы',
    ...overrides
  };
}

function baseState(overrides = {}) {
  return {
    claims: [],
    pendingDecisionMessages: [],
    costCapReached: false,
    ...overrides
  };
}

test('sends nothing when there are no escalations, no cost cap, and no high-confidence contradictions', async () => {
  const sendNotification = async () => { throw new Error('should not be called'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState());

  assert.deepEqual(result, {});
});

test('sends a message listing pending decisions when there are escalations', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({
    pendingDecisionMessages: [{ job_id: 'job-1', question: 'Ожидаемая стоимость повтора $0.15 превышает порог $0.1', estimated_cost_usd: 0.15 }]
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Ожидаемая стоимость повтора/);
  assert.match(sent[0], /0.15/);
});

test('sends a message about the cost cap when costCapReached is true', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({ costCapReached: true }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /\$5/);
});

test('sends a message about a contradiction only when the historical candidate had высокая confidence', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({ claims: [contradictedClaim({ contradictedClaimHistoricalConfidence: 'высокая' })] }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Компания X/);
  assert.match(sent[0], /разные суммы/);
});

test('does NOT send a notification for a contradiction against a средняя/низкая-confidence historical candidate', async () => {
  const sendNotification = async () => { throw new Error('should not be called'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState({ claims: [contradictedClaim({ contradictedClaimHistoricalConfidence: 'средняя' })] }));

  assert.deepEqual(result, {});
});

test('ignores claims where hasContradiction is false, even with contradictedClaimHistoricalConfidence set from an unrelated claim', async () => {
  const sendNotification = async () => { throw new Error('should not be called'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState({ claims: [contradictedClaim({ hasContradiction: false })] }));

  assert.deepEqual(result, {});
});

test('combines all three problem types into one single message, not three separate sends', async () => {
  const sent = [];
  const sendNotification = async (text) => { sent.push(text); };
  const node = createNotificationsNode({ sendNotification });

  await node(baseState({
    pendingDecisionMessages: [{ job_id: 'job-1', question: 'дорого', estimated_cost_usd: 0.2 }],
    costCapReached: true,
    claims: [contradictedClaim()]
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /дорого/);
  assert.match(sent[0], /\$5/);
  assert.match(sent[0], /Компания X/);
});

test('a sendNotification failure is caught and logged, does not throw', async () => {
  const sendNotification = async () => { throw new Error('Telegram HTTP 400'); };
  const node = createNotificationsNode({ sendNotification });

  const result = await node(baseState({ costCapReached: true }));

  assert.deepEqual(result, {});
});
