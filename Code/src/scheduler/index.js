// src/scheduler/index.js
import { decideAction } from './decision.js';
import { pollQueues } from './pollQueues.js';

const STATE_KEYS = {
  watchStartedAt: 'watchStartedAt',
  lastSeenAt: 'lastSeenAt',
  triggeredOnDate: 'triggeredOnDate'
};

export function createScheduler({
  db,
  stateStore,
  onBatchReady,
  telegramId,
  now = () => new Date(),
  idleMinutes,
  ceilingHour,
  windowStartHour
} = {}) {
  if (!db) throw new Error('createScheduler: db is required');
  if (!stateStore) throw new Error('createScheduler: stateStore is required');
  if (typeof onBatchReady !== 'function') {
    throw new Error('createScheduler: onBatchReady must be a function');
  }

  let intervalHandle = null;

  async function checkOnce() {
    const currentTime = now();
    const currentDateStr = currentTime.toISOString().slice(0, 10);

    try {
      const triggeredOnDate = await stateStore.get(STATE_KEYS.triggeredOnDate);
      const state = {
        watchStartedAt: await stateStore.get(STATE_KEYS.watchStartedAt),
        lastSeenAt: await stateStore.get(STATE_KEYS.lastSeenAt),
        triggeredToday: triggeredOnDate === currentDateStr
      };

      const gateAction = decideAction({ now: currentTime, ...state, idleMinutes, ceilingHour, windowStartHour });
      if (gateAction === 'OUTSIDE_WINDOW') {
        return 'OUTSIDE_WINDOW';
      }

      if (!state.watchStartedAt) {
        state.watchStartedAt = currentTime.toISOString();
        await stateStore.set(STATE_KEYS.watchStartedAt, state.watchStartedAt);
      }

      let action = gateAction;
      if (gateAction !== 'FORCED_CEILING') {
        const { newestSeenAt } = await pollQueues(db, { telegramId, sinceTimestamp: state.lastSeenAt });
        if (newestSeenAt) {
          state.lastSeenAt = newestSeenAt;
          await stateStore.set(STATE_KEYS.lastSeenAt, newestSeenAt);
        }
        action = decideAction({ now: currentTime, ...state, idleMinutes, ceilingHour, windowStartHour });
      }

      if (action === 'BATCH_READY' || action === 'FORCED_CEILING') {
        let batchItems = [];
        try {
          const result = await pollQueues(db, { telegramId, sinceTimestamp: null });
          batchItems = result.items;
        } catch (err) {
          console.error('scheduler: full-range pollQueues failed at trigger:', err.message);
        }

        try {
          await onBatchReady(batchItems, { reason: action === 'BATCH_READY' ? 'idle' : 'ceiling' });
        } catch (err) {
          console.error('scheduler: onBatchReady failed:', err.message);
        }

        await stateStore.set(STATE_KEYS.triggeredOnDate, currentDateStr);
        await stateStore.set(STATE_KEYS.watchStartedAt, null);
        await stateStore.set(STATE_KEYS.lastSeenAt, null);
      }

      return action;
    } catch (err) {
      console.error('scheduler: checkOnce failed, treating tick as WAITING:', err.message);
      return 'WAITING';
    }
  }

  function start(intervalMs) {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
      checkOnce().catch((err) => console.error('scheduler: unexpected error in checkOnce:', err.message));
    }, intervalMs);
  }

  function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return { checkOnce, start, stop };
}
