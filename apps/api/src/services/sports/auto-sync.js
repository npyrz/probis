import { inferLeagueFromEventText } from './canonicalization.js';
import { loadSportsHistoryStore } from './history-store.js';
import { importMlbHistory } from './mlb-importer.js';
import { importNbaHistory } from './nba-importer.js';

const MIN_NBA_SEASON_GAME_COUNT = 1000;
const MIN_MLB_SEASON_GAME_COUNT = 2000;

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

function hasNbaSeasonCoverage(historyStore, season) {
  const normalizedSeason = String(season ?? '').trim();

  if (!normalizedSeason) {
    return false;
  }

  const count = (Array.isArray(historyStore?.games) ? historyStore.games : [])
    .filter((game) => game?.league === 'NBA' && game?.metadata?.seasonType !== 1)
    .filter((game) => String(game?.seasonLabel ?? '').trim().length > 0)
    .filter((game) => {
      const gameDate = toDate(game.date);
      return gameDate && inferNbaSeasonForDate(gameDate) === normalizedSeason;
    })
    .length;

  return count >= MIN_NBA_SEASON_GAME_COUNT;
}

function hasMlbSeasonCoverage(historyStore, season) {
  const normalizedSeason = String(season ?? '').trim();

  if (!normalizedSeason) {
    return false;
  }

  const count = (Array.isArray(historyStore?.games) ? historyStore.games : [])
    .filter((game) => game?.league === 'MLB' && game?.metadata?.seasonType !== 1)
    .filter((game) => String(game?.seasonLabel ?? '').trim().length > 0)
    .filter((game) => {
      const gameDate = toDate(game.date);
      return gameDate && inferMlbSeasonForDate(gameDate) === normalizedSeason;
    })
    .length;

  return count >= MIN_MLB_SEASON_GAME_COUNT;
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

  if (!season) {
    return {
      attempted: false,
      updated: false,
      league,
      reason: 'could-not-infer-season'
    };
  }

  const historyStore = await loadSportsHistoryStore();

  const hasCoverage = league === 'NBA'
    ? hasNbaSeasonCoverage(historyStore, season)
    : hasMlbSeasonCoverage(historyStore, season);

  if (!forceRefresh && hasCoverage) {
    return {
      attempted: true,
      updated: false,
      league,
      season,
      reason: 'coverage-already-present'
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
    reason: importResult.insertedCount > 0 ? 'imported-season-history' : 'season-already-up-to-date',
    importResult
  };
}