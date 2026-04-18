import { loadSportsHistoryStore } from './history-store.js';
import { runTeamStrengthBacktest } from './elo-model.js';

const DASHBOARD_LEAGUES = ['NBA', 'MLB'];

function toMetric(value) {
  return typeof value === 'number' ? Number(value.toFixed(6)) : null;
}

function deltaMetric(left, right) {
  if (typeof left !== 'number' || typeof right !== 'number') {
    return null;
  }

  return toMetric(left - right);
}

function summarizePhaseForDashboard(phaseResult) {
  if (!phaseResult) {
    return null;
  }

  const raw = phaseResult.raw ?? null;
  const calibrated = phaseResult.calibrated ?? null;
  const walkForward = phaseResult.walkForward ?? null;

  return {
    evaluationGameCount: phaseResult.evaluationGameCount ?? 0,
    raw: {
      accuracy: toMetric(raw?.accuracy),
      averageBrier: toMetric(raw?.averageBrier),
      averageLogLoss: toMetric(raw?.averageLogLoss)
    },
    calibrated: {
      accuracy: toMetric(calibrated?.accuracy),
      averageBrier: toMetric(calibrated?.averageBrier),
      averageLogLoss: toMetric(calibrated?.averageLogLoss)
    },
    walkForward: {
      accuracy: toMetric(walkForward?.accuracy),
      averageBrier: toMetric(walkForward?.averageBrier),
      averageLogLoss: toMetric(walkForward?.averageLogLoss)
    },
    deltas: {
      brierImprovementRawToCalibrated: deltaMetric(raw?.averageBrier, calibrated?.averageBrier),
      brierImprovementCalibratedToWalkForward: deltaMetric(calibrated?.averageBrier, walkForward?.averageBrier),
      logLossImprovementRawToCalibrated: deltaMetric(raw?.averageLogLoss, calibrated?.averageLogLoss),
      logLossImprovementCalibratedToWalkForward: deltaMetric(calibrated?.averageLogLoss, walkForward?.averageLogLoss),
      accuracyChangeRawToWalkForward: deltaMetric(walkForward?.accuracy, raw?.accuracy)
    }
  };
}

function buildLeagueDashboard(historyStore, league, options = {}) {
  const result = runTeamStrengthBacktest(historyStore, {
    league,
    startDate: options.startDate,
    endDate: options.endDate,
    phase: 'all',
    minTrainingGames: options.minTrainingGames,
    calibrationBucketSize: options.calibrationBucketSize,
    walkForwardMinCalibrationSampleSize: options.walkForwardMinCalibrationSampleSize
  });

  return {
    league,
    overall: summarizePhaseForDashboard(result),
    regular: summarizePhaseForDashboard(result.phaseBreakdown?.regular ?? null),
    playoffs: summarizePhaseForDashboard(result.phaseBreakdown?.playoffs ?? null)
  };
}

export async function runSportsPerformanceDashboard(options = {}) {
  const historyStore = await loadSportsHistoryStore();

  return {
    generatedAt: new Date().toISOString(),
    leagues: DASHBOARD_LEAGUES.map((league) => buildLeagueDashboard(historyStore, league, options))
  };
}

export async function runSportsBacktest(options = {}) {
  const league = String(options.league ?? 'NBA').toUpperCase();

  if (league === 'ALL' || league === 'DASHBOARD') {
    return runSportsPerformanceDashboard(options);
  }

  const historyStore = await loadSportsHistoryStore();
  return runTeamStrengthBacktest(historyStore, {
    ...options,
    league
  });
}