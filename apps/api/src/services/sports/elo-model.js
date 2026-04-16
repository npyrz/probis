function average(values) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    pointDiffWeight: 12
  };

  const perLeague = {
    MLB: { homeAdvantageElo: 25, pointDiffWeight: 8 },
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

function getGamesForLeague(store, league, asOfDate) {
  const asOfTimestamp = asOfDate?.getTime() ?? Date.now();

  return (Array.isArray(store?.games) ? store.games : [])
    .filter((game) => game?.league === league && isFinalGame(game))
    .map((game) => ({
      ...game,
      parsedDate: toDate(game.date)
    }))
    .filter((game) => game.parsedDate && game.parsedDate.getTime() < asOfTimestamp)
    .sort((left, right) => left.parsedDate - right.parsedDate);
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

export function buildTeamStrengthMarketContext({ event, market, historyStore }) {
  const config = getLeagueConfig(market.league);
  const asOfDate = toDate(event?.startDate) ?? toDate(event?.endDate) ?? new Date();
  const games = getGamesForLeague(historyStore, market.league, asOfDate);
  const teamStates = new Map();

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
  const adjustedDiff = (homeSummary.elo - awaySummary.elo)
    + (market.homeTeamId && market.awayTeamId ? config.homeAdvantageElo : 0)
    + recentFormDiff * config.recentFormWeight
    + recentScoreDiff * config.pointDiffWeight
    + restDiff * config.restDayWeight;
  const homeProbability = expectedScore(adjustedDiff, 0);
  const marketSampleSize = Math.min(homeSummary.sampleSize, awaySummary.sampleSize);
  const marketConfidence = clamp(0.35 + Math.min(marketSampleSize, 30) / 60, 0.35, 0.85);

  return {
    conditionId: market.conditionId,
    question: market.question,
    league: market.league,
    model: {
      name: 'team-strength-elo-v1',
      description: 'League-specific Elo with optional home advantage, recent form, rest adjustment, and rolling score-differential features.'
    },
    marketConfidence,
    matchup: {
      homeTeamId,
      awayTeamId,
      homeAwaySource: market.homeAwaySource,
      asOfDate: asOfDate.toISOString()
    },
    features: {
      homeAdvantageEloApplied: market.homeTeamId && market.awayTeamId ? config.homeAdvantageElo : 0,
      recentFormDiff,
      recentScoreDiff,
      restDiff,
      adjustedDiff,
      leagueGameSampleSize: games.length
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
        homeProbability
      }),
      modelConfidence: marketConfidence,
      features: mapping.teamId === homeTeamId ? homeSummary : awaySummary
    }))
  };
}

export function runTeamStrengthBacktest(historyStore, { league, startDate, endDate, minTrainingGames = 10 } = {}) {
  if (!league) {
    throw new Error('league is required for sports backtesting.');
  }

  const config = getLeagueConfig(league);
  const start = startDate ? toDate(startDate) : null;
  const end = endDate ? toDate(endDate) : null;
  const games = (Array.isArray(historyStore?.games) ? historyStore.games : [])
    .filter((game) => game?.league === league && isFinalGame(game))
    .map((game) => ({
      ...game,
      parsedDate: toDate(game.date)
    }))
    .filter((game) => game.parsedDate)
    .filter((game) => (!start || game.parsedDate >= start) && (!end || game.parsedDate <= end))
    .sort((left, right) => left.parsedDate - right.parsedDate);
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
    const adjustedDiff = (homeSummary.elo - awaySummary.elo)
      + config.homeAdvantageElo
      + recentFormDiff * config.recentFormWeight
      + recentScoreDiff * config.pointDiffWeight
      + restDiff * config.restDayWeight;
    const homeProbability = expectedScore(adjustedDiff, 0);
    const actualHomeWin = Number(game.homeScore) > Number(game.awayScore) ? 1 : 0;

    if (trainingSample >= minTrainingGames) {
      predictions.push({
        date: game.date,
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
          adjustedDiff,
          trainingSample
        }
      });
    }

    applyGame(teamStates, game, config);
  }

  return {
    league,
    minTrainingGames,
    evaluationGameCount: predictions.length,
    averageBrier: average(predictions.map((prediction) => prediction.brier)),
    averageLogLoss: average(predictions.map((prediction) => prediction.logLoss)),
    accuracy: average(predictions.map((prediction) => (prediction.correct ? 1 : 0))),
    predictions: predictions.slice(-250)
  };
}