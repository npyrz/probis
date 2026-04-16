import { resolveMlbProbablePitcherMatchup } from './mlb-importer.js';

function average(values) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0);
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function logit(value) {
  const clipped = clamp(value, 0.001, 0.999);
  return Math.log(clipped / (1 - clipped));
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function toDate(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function diffDays(left, right) {
  if (!(left instanceof Date) || !(right instanceof Date)) {
    return null;
  }

  return Math.round((left.getTime() - right.getTime()) / 86400000);
}

function getLeagueConfig(league) {
  const defaults = {
    baseElo: 1500,
    kFactor: 24,
    homeAdvantageElo: 45,
    recentFormWeight: 20,
    restDayWeight: 8,
    pointDiffWeight: 12,
    pitcherAdjustmentCap: 40,
    pitcherEraWeight: 10,
    pitcherRecordWeight: 12,
    pitcherFullWeightSample: 20,
    pitcherEraFallbackSampleWeight: 0.2
  };

  const perLeague = {
    MLB: {
      homeAdvantageElo: 25,
      pointDiffWeight: 8,
      pitcherAdjustmentCap: 28,
      pitcherEraWeight: 6,
      pitcherRecordWeight: 8,
      pitcherFullWeightSample: 18,
      pitcherEraFallbackSampleWeight: 0.15
    },
    NHL: { homeAdvantageElo: 30, pointDiffWeight: 10 },
    NBA: { homeAdvantageElo: 40, pointDiffWeight: 14 },
    WNBA: { homeAdvantageElo: 35, pointDiffWeight: 12 },
    NFL: { homeAdvantageElo: 55, pointDiffWeight: 18 },
    NCAAF: { homeAdvantageElo: 60, pointDiffWeight: 18 },
    NCAAB: { homeAdvantageElo: 45, pointDiffWeight: 14 }
  };

  return {
    ...defaults,
    ...(perLeague[league] ?? {})
  };
}

function expectedScore(eloA, eloB) {
  return 1 / (1 + 10 ** ((eloB - eloA) / 400));
}

function logLoss(probability, outcome) {
  const clipped = clamp(probability, 0.001, 0.999);
  return -(outcome * Math.log(clipped) + (1 - outcome) * Math.log(1 - clipped));
}

function buildCalibrationBuckets(predictions, bucketSize = 0.1) {
  const buckets = new Map();

  for (const prediction of predictions) {
    const probability = clamp(prediction.homeProbability, 0, 0.999999);
    const bucketIndex = Math.min(Math.floor(probability / bucketSize), Math.floor(1 / bucketSize) - 1);
    const bucketStart = Number((bucketIndex * bucketSize).toFixed(2));
    const bucketEnd = Number((bucketStart + bucketSize).toFixed(2));
    const key = `${bucketStart.toFixed(2)}-${bucketEnd.toFixed(2)}`;
    const bucket = buckets.get(key) ?? {
      bucket: key,
      bucketStart,
      bucketEnd,
      count: 0,
      predictedProbabilitySum: 0,
      actualWinSum: 0,
      brierSum: 0,
      logLossSum: 0
    };

    bucket.count += 1;
    bucket.predictedProbabilitySum += prediction.homeProbability;
    bucket.actualWinSum += prediction.actualHomeWin;
    bucket.brierSum += prediction.brier;
    bucket.logLossSum += prediction.logLoss;
    buckets.set(key, bucket);
  }

  const sorted = [...buckets.values()]
    .sort((left, right) => left.bucketStart - right.bucketStart)
    .map((bucket) => ({
      bucket: bucket.bucket,
      bucketStart: bucket.bucketStart,
      bucketEnd: bucket.bucketEnd,
      count: bucket.count,
      averagePredictedProbability: bucket.count ? bucket.predictedProbabilitySum / bucket.count : null,
      empiricalWinRate: bucket.count ? bucket.actualWinSum / bucket.count : null,
      calibrationGap: bucket.count ? (bucket.actualWinSum / bucket.count) - (bucket.predictedProbabilitySum / bucket.count) : null,
      averageBrier: bucket.count ? bucket.brierSum / bucket.count : null,
      averageLogLoss: bucket.count ? bucket.logLossSum / bucket.count : null
    }));

  let runningFloor = 0;

  return sorted.map((bucket) => {
    const empirical = typeof bucket.empiricalWinRate === 'number'
      ? clamp(bucket.empiricalWinRate, runningFloor, 1)
      : null;

    if (typeof empirical === 'number') {
      runningFloor = empirical;
    }

    return {
      ...bucket,
      isotonicWinRate: empirical
    };
  });
}

function getSeasonPhase(game) {
  const explicitPhase = String(game?.seasonPhase ?? '').trim().toLowerCase();

  if (explicitPhase === 'regular' || explicitPhase === 'playoffs') {
    return explicitPhase;
  }

  const seasonType = Number(game?.metadata?.seasonType ?? NaN);

  if (seasonType === 2) {
    return 'regular';
  }

  if (seasonType >= 3) {
    return 'playoffs';
  }

  return 'other';
}

function getFilteredGames(store, { league, startDate, endDate, phase = 'all', includeFuture = false } = {}) {
  const start = startDate ? toDate(startDate) : null;
  const end = endDate ? toDate(endDate) : null;
  const endTimestamp = includeFuture ? Number.POSITIVE_INFINITY : (end?.getTime() ?? Date.now());

  return (Array.isArray(store?.games) ? store.games : [])
    .filter((game) => game?.league === league && isFinalGame(game))
    .map((game) => ({
      ...game,
      parsedDate: toDate(game.date),
      normalizedPhase: getSeasonPhase(game)
    }))
    .filter((game) => game.parsedDate)
    .filter((game) => game.parsedDate.getTime() <= endTimestamp)
    .filter((game) => (!start || game.parsedDate >= start) && (!end || game.parsedDate <= end))
    .filter((game) => phase === 'all' || game.normalizedPhase === phase)
    .sort((left, right) => left.parsedDate - right.parsedDate);
}

function buildCalibrationProfile(predictions, { bucketSize = 0.1, minBucketCount = 25, logisticScale = 0.72 } = {}) {
  const buckets = buildCalibrationBuckets(predictions, bucketSize).map((bucket) => ({
    ...bucket,
    calibratedTarget: bucket.count >= minBucketCount && typeof bucket.isotonicWinRate === 'number'
      ? bucket.isotonicWinRate
      : bucket.averagePredictedProbability
  }));

  return {
    method: 'logistic-compression-plus-isotonic-buckets',
    logisticScale,
    bucketSize,
    minBucketCount,
    sampleSize: predictions.length,
    buckets
  };
}

function getCalibrationBucket(profile, probability) {
  if (!profile || !Array.isArray(profile.buckets)) {
    return null;
  }

  return profile.buckets.find((bucket) => probability >= bucket.bucketStart && probability < bucket.bucketEnd)
    ?? profile.buckets.at(-1)
    ?? null;
}

function applyCalibrationProfile(probability, profile) {
  if (!profile) {
    return clamp(probability);
  }

  const compressed = sigmoid(logit(probability) * profile.logisticScale);
  const bucket = getCalibrationBucket(profile, probability);

  if (!bucket || bucket.count < profile.minBucketCount || typeof bucket.calibratedTarget !== 'number') {
    return clamp(compressed);
  }

  const empiricalWeight = clamp(bucket.count / (profile.minBucketCount * 2), 0.15, 0.7);
  return clamp(compressed * (1 - empiricalWeight) + bucket.calibratedTarget * empiricalWeight);
}

function summarizePredictions(predictions, calibrationBucketSize, phase = 'all') {
  const rawBuckets = buildCalibrationBuckets(predictions, calibrationBucketSize);
  const profile = buildCalibrationProfile(predictions, {
    bucketSize: calibrationBucketSize
  });
  const calibratedPredictions = predictions.map((prediction) => {
    const calibratedHomeProbability = applyCalibrationProfile(prediction.homeProbability, profile);

    return {
      ...prediction,
      calibratedHomeProbability,
      calibratedAwayProbability: 1 - calibratedHomeProbability,
      calibratedBrier: (calibratedHomeProbability - prediction.actualHomeWin) ** 2,
      calibratedLogLoss: logLoss(calibratedHomeProbability, prediction.actualHomeWin),
      calibratedCorrect: (calibratedHomeProbability >= 0.5 ? 1 : 0) === prediction.actualHomeWin
    };
  });

  return {
    phase,
    evaluationGameCount: predictions.length,
    raw: {
      averageBrier: average(predictions.map((prediction) => prediction.brier)),
      averageLogLoss: average(predictions.map((prediction) => prediction.logLoss)),
      accuracy: average(predictions.map((prediction) => (prediction.correct ? 1 : 0))),
      meanPrediction: average(predictions.map((prediction) => prediction.homeProbability)),
      meanActualHomeWinRate: average(predictions.map((prediction) => prediction.actualHomeWin)),
      calibration: {
        meanCalibrationGap: predictions.length
          ? average(predictions.map((prediction) => prediction.actualHomeWin - prediction.homeProbability))
          : null,
        expectedWins: sum(predictions.map((prediction) => prediction.homeProbability)),
        actualWins: sum(predictions.map((prediction) => prediction.actualHomeWin)),
        buckets: rawBuckets
      }
    },
    calibrated: {
      method: profile.method,
      averageBrier: average(calibratedPredictions.map((prediction) => prediction.calibratedBrier)),
      averageLogLoss: average(calibratedPredictions.map((prediction) => prediction.calibratedLogLoss)),
      accuracy: average(calibratedPredictions.map((prediction) => (prediction.calibratedCorrect ? 1 : 0))),
      meanPrediction: average(calibratedPredictions.map((prediction) => prediction.calibratedHomeProbability)),
      meanActualHomeWinRate: average(calibratedPredictions.map((prediction) => prediction.actualHomeWin)),
      calibration: {
        meanCalibrationGap: calibratedPredictions.length
          ? average(calibratedPredictions.map((prediction) => prediction.actualHomeWin - prediction.calibratedHomeProbability))
          : null,
        expectedWins: sum(calibratedPredictions.map((prediction) => prediction.calibratedHomeProbability)),
        actualWins: sum(calibratedPredictions.map((prediction) => prediction.actualHomeWin)),
        profile,
        buckets: buildCalibrationBuckets(
          calibratedPredictions.map((prediction) => ({
            ...prediction,
            homeProbability: prediction.calibratedHomeProbability,
            brier: prediction.calibratedBrier,
            logLoss: prediction.calibratedLogLoss
          })),
          calibrationBucketSize
        )
      }
    },
    predictions: calibratedPredictions
  };
}

function summarizeWalkForwardPredictions(
  predictions,
  calibrationBucketSize,
  phase = 'all',
  { minCalibrationSampleSize = 250 } = {}
) {
  const priorPredictions = [];
  const walkForwardPredictions = predictions.map((prediction) => {
    const profile = priorPredictions.length >= minCalibrationSampleSize
      ? buildCalibrationProfile(priorPredictions, { bucketSize: calibrationBucketSize })
      : null;
    const walkForwardHomeProbability = applyCalibrationProfile(prediction.homeProbability, profile);
    const nextPrediction = {
      ...prediction,
      walkForwardHomeProbability,
      walkForwardAwayProbability: 1 - walkForwardHomeProbability,
      walkForwardBrier: (walkForwardHomeProbability - prediction.actualHomeWin) ** 2,
      walkForwardLogLoss: logLoss(walkForwardHomeProbability, prediction.actualHomeWin),
      walkForwardCorrect: (walkForwardHomeProbability >= 0.5 ? 1 : 0) === prediction.actualHomeWin
    };

    priorPredictions.push(prediction);
    return nextPrediction;
  });

  return {
    phase,
    method: 'walk-forward-logistic-compression-plus-isotonic-buckets',
    minCalibrationSampleSize,
    evaluationGameCount: walkForwardPredictions.length,
    averageBrier: average(walkForwardPredictions.map((prediction) => prediction.walkForwardBrier)),
    averageLogLoss: average(walkForwardPredictions.map((prediction) => prediction.walkForwardLogLoss)),
    accuracy: average(walkForwardPredictions.map((prediction) => (prediction.walkForwardCorrect ? 1 : 0))),
    meanPrediction: average(walkForwardPredictions.map((prediction) => prediction.walkForwardHomeProbability)),
    meanActualHomeWinRate: average(walkForwardPredictions.map((prediction) => prediction.actualHomeWin)),
    calibration: {
      meanCalibrationGap: walkForwardPredictions.length
        ? average(walkForwardPredictions.map((prediction) => prediction.actualHomeWin - prediction.walkForwardHomeProbability))
        : null,
      expectedWins: sum(walkForwardPredictions.map((prediction) => prediction.walkForwardHomeProbability)),
      actualWins: sum(walkForwardPredictions.map((prediction) => prediction.actualHomeWin)),
      buckets: buildCalibrationBuckets(
        walkForwardPredictions.map((prediction) => ({
          ...prediction,
          homeProbability: prediction.walkForwardHomeProbability,
          brier: prediction.walkForwardBrier,
          logLoss: prediction.walkForwardLogLoss
        })),
        calibrationBucketSize
      )
    },
    predictions: walkForwardPredictions
  };
}

function getMarginMultiplier(scoreDiff, eloDiff) {
  const magnitude = Math.max(1, Math.abs(scoreDiff));
  return Math.log(magnitude + 1) * (2.2 / ((Math.abs(eloDiff) * 0.001) + 2.2));
}

function isFinalGame(game) {
  if (!game || typeof game !== 'object') {
    return false;
  }

  const homeScore = Number(game.homeScore);
  const awayScore = Number(game.awayScore);

  return Number.isFinite(homeScore) && Number.isFinite(awayScore);
}

function getGamesForLeague(store, league, asOfDate, phase = 'all') {
  return getFilteredGames(store, {
    league,
    endDate: asOfDate,
    phase
  }).filter((game) => game.parsedDate.getTime() < (asOfDate?.getTime() ?? Date.now()));
}

function initializeTeamState(baseElo) {
  return {
    elo: baseElo,
    games: [],
    wins: 0,
    losses: 0,
    scoreDiffs: [],
    lastGameDate: null,
    pointsFor: [],
    pointsAgainst: []
  };
}

function getTeamState(teamStates, teamId, baseElo) {
  if (!teamStates.has(teamId)) {
    teamStates.set(teamId, initializeTeamState(baseElo));
  }

  return teamStates.get(teamId);
}

function pushBounded(list, value, size = 5) {
  list.push(value);

  if (list.length > size) {
    list.shift();
  }
}

function applyGame(teamStates, game, config) {
  const homeState = getTeamState(teamStates, game.homeTeamId, config.baseElo);
  const awayState = getTeamState(teamStates, game.awayTeamId, config.baseElo);
  const homeScore = Number(game.homeScore);
  const awayScore = Number(game.awayScore);
  const scoreDiff = homeScore - awayScore;
  const homeAdjustedElo = homeState.elo + config.homeAdvantageElo;
  const homeExpectation = expectedScore(homeAdjustedElo, awayState.elo);
  const awayExpectation = 1 - homeExpectation;
  const homeActual = scoreDiff > 0 ? 1 : 0;
  const awayActual = 1 - homeActual;
  const marginMultiplier = getMarginMultiplier(scoreDiff, homeAdjustedElo - awayState.elo);
  const delta = config.kFactor * marginMultiplier;

  homeState.elo += delta * (homeActual - homeExpectation);
  awayState.elo += delta * (awayActual - awayExpectation);

  pushBounded(homeState.games, { won: homeActual === 1, scoreDiff, date: game.parsedDate });
  pushBounded(awayState.games, { won: awayActual === 1, scoreDiff: -scoreDiff, date: game.parsedDate });
  pushBounded(homeState.scoreDiffs, scoreDiff);
  pushBounded(awayState.scoreDiffs, -scoreDiff);
  pushBounded(homeState.pointsFor, homeScore);
  pushBounded(homeState.pointsAgainst, awayScore);
  pushBounded(awayState.pointsFor, awayScore);
  pushBounded(awayState.pointsAgainst, homeScore);
  homeState.lastGameDate = game.parsedDate;
  awayState.lastGameDate = game.parsedDate;
  homeState.wins += homeActual;
  homeState.losses += awayActual;
  awayState.wins += awayActual;
  awayState.losses += homeActual;
}

function getRecentWinRate(teamState) {
  if (!teamState || teamState.games.length === 0) {
    return null;
  }

  return average(teamState.games.map((game) => (game.won ? 1 : 0)));
}

function getRecentScoreDiff(teamState) {
  if (!teamState || teamState.scoreDiffs.length === 0) {
    return null;
  }

  return average(teamState.scoreDiffs);
}

function getRestDays(teamState, asOfDate) {
  if (!teamState?.lastGameDate) {
    return null;
  }

  return diffDays(asOfDate, teamState.lastGameDate);
}

function getTeamSummary(teamState, asOfDate) {
  return {
    elo: Number(teamState.elo.toFixed(2)),
    wins: teamState.wins,
    losses: teamState.losses,
    recentWinRate: getRecentWinRate(teamState),
    recentScoreDiff: getRecentScoreDiff(teamState),
    restDays: getRestDays(teamState, asOfDate),
    recentPointsFor: average(teamState.pointsFor),
    recentPointsAgainst: average(teamState.pointsAgainst),
    sampleSize: teamState.wins + teamState.losses
  };
}

function getTeamProbability({ teamId, homeTeamId, awayTeamId, homeProbability }) {
  if (teamId === homeTeamId) {
    return homeProbability;
  }

  if (teamId === awayTeamId) {
    return 1 - homeProbability;
  }

  return 0.5;
}

function getPitcherWinRate(pitcher) {
  const wins = Number(pitcher?.wins);
  const losses = Number(pitcher?.losses);

  if (!Number.isFinite(wins) || !Number.isFinite(losses) || wins + losses <= 0) {
    return null;
  }

  return wins / (wins + losses);
}

function getPitcherDecisionSample(pitcher) {
  const wins = Number(pitcher?.wins);
  const losses = Number(pitcher?.losses);

  if (!Number.isFinite(wins) || !Number.isFinite(losses)) {
    return 0;
  }

  return Math.max(0, wins + losses);
}

function getMlbPitcherScore(pitcher, config) {
  if (!pitcher) {
    return 0;
  }

  const era = Number.isFinite(Number(pitcher.era)) ? Number(pitcher.era) : null;
  const winRate = getPitcherWinRate(pitcher);
  const decisionSample = getPitcherDecisionSample(pitcher);
  const sampleWeight = decisionSample > 0
    ? clamp(decisionSample / config.pitcherFullWeightSample, 0.1, 1)
    : config.pitcherEraFallbackSampleWeight;
  const eraComponent = typeof era === 'number'
    ? (4.2 - clamp(era, 2.2, 6.2)) * config.pitcherEraWeight * sampleWeight
    : 0;
  const recordComponent = typeof winRate === 'number'
    ? (winRate - 0.5) * config.pitcherRecordWeight * 2 * sampleWeight
    : 0;

  return eraComponent + recordComponent;
}

function getPitcherAdjustment(league, probablePitchers, config) {
  if (league !== 'MLB') {
    return {
      adjustment: 0,
      homeScore: 0,
      awayScore: 0,
      homePitcher: null,
      awayPitcher: null,
      source: null
    };
  }

  const homePitcher = probablePitchers?.home ?? null;
  const awayPitcher = probablePitchers?.away ?? null;
  const homeScore = getMlbPitcherScore(homePitcher, config);
  const awayScore = getMlbPitcherScore(awayPitcher, config);

  return {
    adjustment: clamp(homeScore - awayScore, -config.pitcherAdjustmentCap, config.pitcherAdjustmentCap),
    homeScore,
    awayScore,
    homePitcher,
    awayPitcher,
    source: homePitcher || awayPitcher ? 'espn-probable-starters' : null
  };
}

export function buildHistoricalCalibrationContext(
  historyStore,
  { league, endDate, phase = 'all', minTrainingGames = 10, calibrationBucketSize = 0.1 } = {}
) {
  const summary = runTeamStrengthBacktest(historyStore, {
    league,
    endDate,
    phase,
    minTrainingGames,
    calibrationBucketSize
  });

  return summary?.calibrated?.calibration?.profile ?? null;
}

export function applyPostModelCalibration(probability, calibrationProfile) {
  return applyCalibrationProfile(probability, calibrationProfile);
}

export async function buildTeamStrengthMarketContext({ event, market, historyStore, phase = 'all', calibrationProfile = null }) {
  const config = getLeagueConfig(market.league);
  const asOfDate = toDate(event?.startDate) ?? toDate(event?.endDate) ?? new Date();
  const games = getGamesForLeague(historyStore, market.league, asOfDate, phase);
  const teamStates = new Map();
  const homeAdvantageApplied = market.homeAwaySource && market.homeAwaySource !== 'vs'
    ? config.homeAdvantageElo
    : 0;

  for (const game of games) {
    applyGame(teamStates, game, config);
  }

  const fallbackHomeTeamId = market.homeTeamId ?? market.labelMappings[0]?.teamId ?? null;
  const fallbackAwayTeamId = market.awayTeamId ?? market.labelMappings[1]?.teamId ?? null;
  const homeTeamId = fallbackHomeTeamId;
  const awayTeamId = fallbackAwayTeamId;
  const homeTeamState = getTeamState(teamStates, homeTeamId, config.baseElo);
  const awayTeamState = getTeamState(teamStates, awayTeamId, config.baseElo);
  const homeSummary = getTeamSummary(homeTeamState, asOfDate);
  const awaySummary = getTeamSummary(awayTeamState, asOfDate);
  const recentFormDiff = (homeSummary.recentWinRate ?? 0.5) - (awaySummary.recentWinRate ?? 0.5);
  const recentScoreDiff = (homeSummary.recentScoreDiff ?? 0) - (awaySummary.recentScoreDiff ?? 0);
  const restDiff = Math.max(-4, Math.min(4, (homeSummary.restDays ?? 0) - (awaySummary.restDays ?? 0)));
  const probablePitcherMatchup = market.league === 'MLB' && homeTeamId && awayTeamId
    ? await resolveMlbProbablePitcherMatchup({
        eventDate: event?.startDate ?? event?.endDate ?? asOfDate.toISOString(),
        homeTeamId,
        awayTeamId
      })
    : null;
  const pitcherAdjustment = getPitcherAdjustment(market.league, probablePitcherMatchup?.probablePitchers, config);
  const adjustedDiff = (homeSummary.elo - awaySummary.elo)
    + homeAdvantageApplied
    + recentFormDiff * config.recentFormWeight
    + recentScoreDiff * config.pointDiffWeight
    + restDiff * config.restDayWeight
    + pitcherAdjustment.adjustment;
  const rawHomeProbability = expectedScore(adjustedDiff, 0);
  const calibratedHomeProbability = applyCalibrationProfile(rawHomeProbability, calibrationProfile);
  const marketSampleSize = Math.min(homeSummary.sampleSize, awaySummary.sampleSize);
  const marketConfidence = clamp(0.35 + Math.min(marketSampleSize, 30) / 60, 0.35, 0.85);

  return {
    conditionId: market.conditionId,
    question: market.question,
    league: market.league,
    model: {
      name: market.league === 'MLB' ? 'team-strength-elo-plus-starters-v2' : 'team-strength-elo-v2',
      description: market.league === 'MLB'
        ? 'League-specific Elo with optional home advantage, recent form, rest adjustment, rolling score-differential features, and MLB probable-starter adjustments when available.'
        : 'League-specific Elo with optional home advantage, recent form, rest adjustment, and rolling score-differential features.'
    },
    marketConfidence,
    matchup: {
      homeTeamId,
      awayTeamId,
      homeAwaySource: market.homeAwaySource,
      asOfDate: asOfDate.toISOString()
    },
    features: {
      homeAdvantageEloApplied: homeAdvantageApplied,
      recentFormDiff,
      recentScoreDiff,
      restDiff,
      probablePitcherSource: pitcherAdjustment.source,
      probablePitcherDiff: pitcherAdjustment.adjustment,
      probablePitcherHomeScore: pitcherAdjustment.homeScore,
      probablePitcherAwayScore: pitcherAdjustment.awayScore,
      probablePitchers: probablePitcherMatchup?.probablePitchers ?? null,
      adjustedDiff,
      leagueGameSampleSize: games.length,
      competitionPhase: phase,
      rawHomeProbability,
      calibratedHomeProbability,
      calibrationMethod: calibrationProfile?.method ?? null
    },
    teams: {
      [homeTeamId]: homeSummary,
      [awayTeamId]: awaySummary
    },
    outcomes: market.labelMappings.map((mapping) => ({
      label: mapping.label,
      teamId: mapping.teamId,
      fairProbability: getTeamProbability({
        teamId: mapping.teamId,
        homeTeamId,
        awayTeamId,
        homeProbability: calibratedHomeProbability
      }),
      rawFairProbability: getTeamProbability({
        teamId: mapping.teamId,
        homeTeamId,
        awayTeamId,
        homeProbability: rawHomeProbability
      }),
      modelConfidence: marketConfidence,
      features: mapping.teamId === homeTeamId ? homeSummary : awaySummary
    }))
  };
}

export function runTeamStrengthBacktest(
  historyStore,
  {
    league,
    startDate,
    endDate,
    minTrainingGames = 10,
    calibrationBucketSize = 0.1,
    phase = 'all',
    walkForwardMinCalibrationSampleSize = 250
  } = {}
) {
  if (!league) {
    throw new Error('league is required for sports backtesting.');
  }

  const config = getLeagueConfig(league);
  const games = getFilteredGames(historyStore, {
    league,
    startDate,
    endDate,
    phase
  });
  const teamStates = new Map();
  const predictions = [];

  for (const game of games) {
    const homeState = getTeamState(teamStates, game.homeTeamId, config.baseElo);
    const awayState = getTeamState(teamStates, game.awayTeamId, config.baseElo);
    const trainingSample = Math.min(homeState.wins + homeState.losses, awayState.wins + awayState.losses);
    const homeSummary = getTeamSummary(homeState, game.parsedDate);
    const awaySummary = getTeamSummary(awayState, game.parsedDate);
    const recentFormDiff = (homeSummary.recentWinRate ?? 0.5) - (awaySummary.recentWinRate ?? 0.5);
    const recentScoreDiff = (homeSummary.recentScoreDiff ?? 0) - (awaySummary.recentScoreDiff ?? 0);
    const restDiff = Math.max(-4, Math.min(4, (homeSummary.restDays ?? 0) - (awaySummary.restDays ?? 0)));
    const pitcherAdjustment = getPitcherAdjustment(league, game?.metadata?.probablePitchers, config);
    const adjustedDiff = (homeSummary.elo - awaySummary.elo)
      + config.homeAdvantageElo
      + recentFormDiff * config.recentFormWeight
      + recentScoreDiff * config.pointDiffWeight
      + restDiff * config.restDayWeight
      + pitcherAdjustment.adjustment;
    const homeProbability = expectedScore(adjustedDiff, 0);
    const actualHomeWin = Number(game.homeScore) > Number(game.awayScore) ? 1 : 0;

    if (trainingSample >= minTrainingGames) {
      predictions.push({
        date: game.date,
        seasonPhase: game.normalizedPhase,
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        homeProbability,
        awayProbability: 1 - homeProbability,
        actualHomeWin,
        brier: (homeProbability - actualHomeWin) ** 2,
        logLoss: logLoss(homeProbability, actualHomeWin),
        correct: (homeProbability >= 0.5 ? 1 : 0) === actualHomeWin,
        features: {
          homeElo: homeSummary.elo,
          awayElo: awaySummary.elo,
          recentFormDiff,
          recentScoreDiff,
          restDiff,
          probablePitcherDiff: pitcherAdjustment.adjustment,
          adjustedDiff,
          trainingSample
        }
      });
    }

    applyGame(teamStates, game, config);
  }

  const overallSummary = summarizePredictions(predictions, calibrationBucketSize, phase);
  const walkForwardSummary = summarizeWalkForwardPredictions(predictions, calibrationBucketSize, phase, {
    minCalibrationSampleSize: walkForwardMinCalibrationSampleSize
  });
  const regularPredictions = predictions.filter((prediction) => prediction.seasonPhase === 'regular');
  const playoffPredictions = predictions.filter((prediction) => prediction.seasonPhase === 'playoffs');

  return {
    league,
    phase,
    minTrainingGames,
    calibrationBucketSize,
    walkForwardMinCalibrationSampleSize,
    totalLeagueGameCount: games.length,
    evaluationGameCount: overallSummary.evaluationGameCount,
    raw: overallSummary.raw,
    calibrated: overallSummary.calibrated,
    walkForward: walkForwardSummary,
    phaseBreakdown: phase === 'all'
      ? {
          regular: {
            ...summarizePredictions(regularPredictions, calibrationBucketSize, 'regular'),
            walkForward: summarizeWalkForwardPredictions(regularPredictions, calibrationBucketSize, 'regular', {
              minCalibrationSampleSize: walkForwardMinCalibrationSampleSize
            })
          },
          playoffs: {
            ...summarizePredictions(playoffPredictions, calibrationBucketSize, 'playoffs'),
            walkForward: summarizeWalkForwardPredictions(playoffPredictions, calibrationBucketSize, 'playoffs', {
              minCalibrationSampleSize: walkForwardMinCalibrationSampleSize
            })
          }
        }
      : null,
    predictions: overallSummary.predictions.slice(-250)
  };
}