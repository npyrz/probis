import { inferCompetitionPhaseFromEventText, inferLeagueFromEventText } from './canonicalization.js';
import { loadSportsHistoryStore } from './history-store.js';
import { importMlbHistory } from './mlb-importer.js';
import { importNbaHistory } from './nba-importer.js';

const MIN_NBA_SEASON_GAME_COUNT = 1000;
const MIN_MLB_SEASON_GAME_COUNT = 2000;
const MIN_NBA_PLAYOFF_GAME_COUNT = 20;
const MIN_MLB_PLAYOFF_GAME_COUNT = 8;

function toDate(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function getRelevantEventDate(event) {
  return toDate(event?.startDate) ?? toDate(event?.endDate) ?? new Date();
}

function inferEventLeague(event) {
  const marketQuestions = Array.isArray(event?.markets)
    ? event.markets.map((market) => market?.question).filter(Boolean)
    : [];

  return inferLeagueFromEventText(
    event?.slug,
    event?.title,
    event?.description,
    ...marketQuestions
  );
}

function inferNbaSeasonForDate(date) {
  if (!(date instanceof Date)) {
    return null;
  }

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const seasonStartYear = month >= 7 ? year : year - 1;
  const seasonEndYear = seasonStartYear + 1;

  return `${seasonStartYear}-${String(seasonEndYear).slice(-2)}`;
}

function inferMlbSeasonForDate(date) {
  if (!(date instanceof Date)) {
    return null;
  }

  return String(date.getUTCFullYear());
}

function getGamePhase(game) {
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

function getLeagueSeasonCoverage(historyStore, league, season, inferSeason) {
  const normalizedSeason = String(season ?? '').trim();

  if (!normalizedSeason) {
    return {
      totalGameCount: 0,
      regularSeasonGameCount: 0,
      playoffGameCount: 0
    };
  }

  let totalGameCount = 0;
  let regularSeasonGameCount = 0;
  let playoffGameCount = 0;

  for (const game of (Array.isArray(historyStore?.games) ? historyStore.games : [])) {
    if (game?.league !== league || game?.metadata?.seasonType === 1) {
      continue;
    }

    const gameDate = toDate(game.date);

    if (!gameDate || inferSeason(gameDate) !== normalizedSeason) {
      continue;
    }

    totalGameCount += 1;

    const phase = getGamePhase(game);

    if (phase === 'regular') {
      regularSeasonGameCount += 1;
    } else if (phase === 'playoffs') {
      playoffGameCount += 1;
    }
  }

  return {
    totalGameCount,
    regularSeasonGameCount,
    playoffGameCount
  };
}

function hasNbaSeasonCoverage(historyStore, season) {
  const coverage = getLeagueSeasonCoverage(historyStore, 'NBA', season, inferNbaSeasonForDate);

  return coverage.regularSeasonGameCount >= MIN_NBA_SEASON_GAME_COUNT;
}

function hasMlbSeasonCoverage(historyStore, season) {
  const coverage = getLeagueSeasonCoverage(historyStore, 'MLB', season, inferMlbSeasonForDate);

  return coverage.regularSeasonGameCount >= MIN_MLB_SEASON_GAME_COUNT;
}

export async function ensureSportsHistoryForEvent(event, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const league = inferEventLeague(event);

  if (league !== 'NBA' && league !== 'MLB') {
    return {
      attempted: false,
      updated: false,
      league,
      reason: 'unsupported-or-non-sports-event'
    };
  }

  const season = league === 'NBA'
    ? inferNbaSeasonForDate(getRelevantEventDate(event))
    : inferMlbSeasonForDate(getRelevantEventDate(event));
  const competitionPhase = inferCompetitionPhaseFromEventText(
    event?.slug,
    event?.title,
    event?.description,
    ...(Array.isArray(event?.markets) ? event.markets.map((market) => market?.question) : [])
  );

  if (!season) {
    return {
      attempted: false,
      updated: false,
      league,
      reason: 'could-not-infer-season'
    };
  }

  const historyStore = await loadSportsHistoryStore();
  const coverage = league === 'NBA'
    ? getLeagueSeasonCoverage(historyStore, 'NBA', season, inferNbaSeasonForDate)
    : getLeagueSeasonCoverage(historyStore, 'MLB', season, inferMlbSeasonForDate);
  const hasRegularCoverage = league === 'NBA'
    ? coverage.regularSeasonGameCount >= MIN_NBA_SEASON_GAME_COUNT
    : coverage.regularSeasonGameCount >= MIN_MLB_SEASON_GAME_COUNT;
  const hasPlayoffCoverage = league === 'NBA'
    ? coverage.playoffGameCount >= MIN_NBA_PLAYOFF_GAME_COUNT
    : coverage.playoffGameCount >= MIN_MLB_PLAYOFF_GAME_COUNT;
  const requiresPlayoffCoverage = competitionPhase === 'playoffs';

  const hasCoverage = league === 'NBA'
    ? hasNbaSeasonCoverage(historyStore, season)
    : hasMlbSeasonCoverage(historyStore, season);
  const phaseCoverageSatisfied = hasCoverage && (!requiresPlayoffCoverage || hasPlayoffCoverage);

  if (!forceRefresh && phaseCoverageSatisfied) {
    return {
      attempted: true,
      updated: false,
      league,
      season,
      competitionPhase,
      reason: 'coverage-already-present',
      coverage: {
        ...coverage,
        hasRegularCoverage,
        hasPlayoffCoverage,
        requiresPlayoffCoverage
      }
    };
  }

  const importResult = league === 'NBA'
    ? await importNbaHistory({
        season,
        batchSize: options.batchSize ?? 10
      })
    : await importMlbHistory({
        season,
        batchSize: options.batchSize ?? 10
      });

  return {
    attempted: true,
    updated: importResult.insertedCount > 0,
    league,
    season,
    competitionPhase,
    reason: importResult.insertedCount > 0
      ? 'imported-season-history'
      : (requiresPlayoffCoverage && !hasPlayoffCoverage
        ? 'playoff-coverage-still-pending'
        : 'season-already-up-to-date'),
    coverage: {
      ...coverage,
      hasRegularCoverage,
      hasPlayoffCoverage,
      requiresPlayoffCoverage
    },
    importResult
  };
}