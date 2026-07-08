export const DEFAULT_IDLE_MINUTES = 15;
export const DEFAULT_CEILING_HOUR = 11;
export const DEFAULT_WINDOW_START_HOUR = 8;

// Часы сравниваются в UTC (getUTCHours), не в локальном времени машины — иначе
// поведение планировщика зависело бы от таймзоны хоста, на котором он запущен.
export function decideAction({
  now,
  watchStartedAt = null,
  lastSeenAt = null,
  triggeredToday = false,
  idleMinutes = DEFAULT_IDLE_MINUTES,
  ceilingHour = DEFAULT_CEILING_HOUR,
  windowStartHour = DEFAULT_WINDOW_START_HOUR
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('decideAction: now must be a valid Date');
  }

  if (triggeredToday || now.getUTCHours() < windowStartHour) {
    return 'OUTSIDE_WINDOW';
  }
  if (now.getUTCHours() >= ceilingHour) {
    return 'FORCED_CEILING';
  }
  if (!watchStartedAt) {
    return 'WAITING';
  }

  const referenceTime = new Date(lastSeenAt ?? watchStartedAt).getTime();
  const idleMs = now.getTime() - referenceTime;
  if (idleMs >= idleMinutes * 60 * 1000) {
    return 'BATCH_READY';
  }
  return 'WAITING';
}
