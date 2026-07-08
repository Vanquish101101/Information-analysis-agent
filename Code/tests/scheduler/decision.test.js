import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAction } from '../../src/scheduler/decision.js';

test('throws when now is not a valid Date', () => {
  assert.throws(
    () => decideAction({ now: '2026-07-08T08:00:00Z' }),
    /now must be a valid Date/
  );
  assert.throws(
    () => decideAction({ now: new Date('not-a-date') }),
    /now must be a valid Date/
  );
});

test('before the observation window returns OUTSIDE_WINDOW', () => {
  const action = decideAction({
    now: new Date('2026-07-08T07:59:00Z'),
    watchStartedAt: null,
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'OUTSIDE_WINDOW');
});

test('triggeredToday returns OUTSIDE_WINDOW even mid-window', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:00:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T08:50:00Z',
    triggeredToday: true
  });
  assert.equal(action, 'OUTSIDE_WINDOW');
});

test('ceiling hour returns FORCED_CEILING even with very recent activity', () => {
  const action = decideAction({
    now: new Date('2026-07-08T11:00:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T10:59:30Z',
    triggeredToday: false
  });
  assert.equal(action, 'FORCED_CEILING');
});

test('within window but watch not started yet returns WAITING', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:00:00Z'),
    watchStartedAt: null,
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'WAITING');
});

test('idle exactly 15 minutes since lastSeenAt returns BATCH_READY', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:15:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T09:00:00Z',
    triggeredToday: false
  });
  assert.equal(action, 'BATCH_READY');
});

test('idle 14:59 since lastSeenAt returns WAITING', () => {
  const action = decideAction({
    now: new Date('2026-07-08T09:14:59Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: '2026-07-08T09:00:00Z',
    triggeredToday: false
  });
  assert.equal(action, 'WAITING');
});

test('idle exactly 15 minutes since watchStartedAt (no lastSeenAt yet) returns BATCH_READY', () => {
  const action = decideAction({
    now: new Date('2026-07-08T08:15:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'BATCH_READY');
});

test('idle 14 minutes since watchStartedAt (no lastSeenAt yet) returns WAITING', () => {
  const action = decideAction({
    now: new Date('2026-07-08T08:14:00Z'),
    watchStartedAt: '2026-07-08T08:00:00Z',
    lastSeenAt: null,
    triggeredToday: false
  });
  assert.equal(action, 'WAITING');
});
