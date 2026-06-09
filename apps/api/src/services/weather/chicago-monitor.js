import { buildChicagoSnapshot, getChicagoClimateDayWindow, getChicagoDayPhase } from './chicago.js';
import { persistChicagoSnapshot } from '../persistence/postgres.js';
import { evaluateChicagoWeatherAlerts } from './chicago-alerts.js';

let trackerState = {
  timerId: null,
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  currentIntervalMs: null,
  cadence: 'idle',
  dayPhase: null,
  lastStatus: 'idle',
  lastError: null,
  lastAlertStatus: null,
  lastAlertError: null,
  runCount: 0
};

function getPositiveInterval(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function getCadenceForPhase(env, dayPhase) {
  const baseIntervalMs = getPositiveInterval(env?.chicagoWeatherRefreshIntervalMs, 5 * 60 * 1000);
  const hotIntervalMs = getPositiveInterval(env?.chicagoWeatherHotRefreshIntervalMs, 60 * 1000);
  const upcomingIntervalMs = getPositiveInterval(env?.chicagoWeatherUpcomingRefreshIntervalMs, 15 * 60 * 1000);
  const settledIntervalMs = getPositiveInterval(env?.chicagoWeatherSettledRefreshIntervalMs, 15 * 60 * 1000);

  switch (dayPhase) {
    case 'midday':
    case 'late-afternoon':
      return {
        cadence: 'hot-window',
        intervalMs: hotIntervalMs
      };
    case 'future':
      return {
        cadence: 'upcoming',
        intervalMs: upcomingIntervalMs
      };
    case 'complete':
      return {
        cadence: 'settlement-watch',
        intervalMs: settledIntervalMs
      };
    case 'morning':
    case 'evening':
      return {
        cadence: 'base',
        intervalMs: baseIntervalMs
      };
    default:
      return {
        cadence: 'base',
        intervalMs: baseIntervalMs
      };
  }
}

function updateCadenceFromPhase(env, dayPhase) {
  const cadence = getCadenceForPhase(env, dayPhase);

  trackerState = {
    ...trackerState,
    cadence: cadence.cadence,
    currentIntervalMs: cadence.intervalMs,
    dayPhase
  };

  return cadence;
}

function scheduleNextRun(env, delayMs) {
  const intervalMs = getPositiveInterval(delayMs, getPositiveInterval(env?.chicagoWeatherRefreshIntervalMs, 5 * 60 * 1000));
  const nextRunAt = new Date(Date.now() + intervalMs).toISOString();

  if (trackerState.timerId) {
    clearTimeout(trackerState.timerId);
  }

  trackerState = {
    ...trackerState,
    nextRunAt,
    currentIntervalMs: intervalMs
  };
  trackerState.timerId = setTimeout(() => {
    void runChicagoWeatherRefresh(env);
  }, intervalMs);
  trackerState.timerId.unref?.();
}

async function runChicagoWeatherRefresh(env) {
  if (trackerState.running) {
    return;
  }

  trackerState = {
    ...trackerState,
    running: true,
    lastRunAt: new Date().toISOString(),
    nextRunAt: null,
    lastStatus: 'running',
    lastError: null
  };

  try {
    const snapshot = await buildChicagoSnapshot(env);
    const persistence = await persistChicagoSnapshot(env, snapshot);
    let alertStatus = null;
    let alertError = null;

    try {
      const alerts = await evaluateChicagoWeatherAlerts(env, {
        snapshot,
        persistSnapshot: false
      });
      alertStatus = `${alerts.stored?.summary?.activeCount ?? alerts.activeCount ?? 0} active`;
    } catch (error) {
      alertError = error instanceof Error ? error.message : 'KMDW alert evaluation failed';
    }

    const cadence = updateCadenceFromPhase(env, snapshot?.prediction?.dayPhase ?? null);

    trackerState = {
      ...trackerState,
      running: false,
      lastStatus: persistence.enabled ? 'persisted' : 'skipped',
      lastError: persistence.enabled ? null : persistence.reason ?? null,
      lastAlertStatus: alertStatus,
      lastAlertError: alertError,
      runCount: trackerState.runCount + 1
    };
    scheduleNextRun(env, cadence.intervalMs);
  } catch (error) {
    const cadence = updateCadenceFromPhase(env, trackerState.dayPhase);

    trackerState = {
      ...trackerState,
      running: false,
      lastStatus: 'error',
      lastError: error instanceof Error ? error.message : 'Chicago weather refresh failed',
      runCount: trackerState.runCount + 1
    };
    scheduleNextRun(env, Math.min(cadence.intervalMs, 2 * 60 * 1000));
  }
}

export function startChicagoWeatherTracker(env) {
  const baseIntervalMs = Number(env?.chicagoWeatherRefreshIntervalMs ?? 0);

  if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) {
    trackerState = {
      ...trackerState,
      lastStatus: 'disabled'
    };
    return trackerState;
  }

  if (trackerState.timerId) {
    return trackerState;
  }

  const initialPhase = getChicagoDayPhase(getChicagoClimateDayWindow());
  updateCadenceFromPhase(env, initialPhase);
  scheduleNextRun(env, 5000);

  return trackerState;
}

export function getChicagoWeatherTrackerStatus() {
  return {
    running: trackerState.running,
    lastRunAt: trackerState.lastRunAt,
    nextRunAt: trackerState.nextRunAt,
    currentIntervalMs: trackerState.currentIntervalMs,
    cadence: trackerState.cadence,
    dayPhase: trackerState.dayPhase,
    lastStatus: trackerState.lastStatus,
    lastError: trackerState.lastError,
    lastAlertStatus: trackerState.lastAlertStatus,
    lastAlertError: trackerState.lastAlertError,
    runCount: trackerState.runCount
  };
}
