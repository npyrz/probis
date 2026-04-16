import axios from 'axios';

import { buildTeamUniverseIndex, normalizeSportsTeamKey } from './canonicalization.js';
import { loadPolymarketUsTeamUniverse, mergeSportsHistoryGames } from './history-store.js';

const ESPN_NBA_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const DEFAULT_BATCH_SIZE = 7;

const NBA_SEASON_RANGES = {
  '2020-21': {
    startDate: '2020-12-22',
    endDate: '2021-07-20'
  },
  '2021-22': {
    startDate: '2021-10-19',
    endDate: '2022-06-16'
  },
  '2022-23': {
    startDate: '2022-10-18',
    endDate: '2023-06-12'
  },
  '2023-24': {
    startDate: '2023-10-24',
    endDate: '2024-06-17'
  },
  '2024-25': {
    startDate: '2024-10-22',
    endDate: '2025-06-22'
  },
  '2025-26': {
    startDate: '2025-10-21',
    endDate: '2026-06-21'
  }
};

const NBA_TEAM_ALIASES = {
  'atlanta hawks': ['hawks'],
  'boston celtics': ['celtics'],
  'brooklyn nets': ['nets'],
  'charlotte hornets': ['hornets'],
  'chicago bulls': ['bulls'],
  'cleveland cavaliers': ['cavaliers', 'cavs'],
  'dallas mavericks': ['mavericks', 'mavs'],
  'denver nuggets': ['nuggets'],
  'detroit pistons': ['pistons'],
  'golden state warriors': ['warriors'],
  'houston rockets': ['rockets'],
  'indiana pacers': ['pacers'],
  'los angeles clippers': ['clippers', 'la clippers'],
  'los angeles lakers': ['lakers', 'la lakers'],
  'memphis grizzlies': ['grizzlies'],
  'miami heat': ['heat'],
  'milwaukee bucks': ['bucks'],
  'minnesota timberwolves': ['timberwolves', 'wolves'],
  'new orleans pelicans': ['pelicans'],
  'new york knicks': ['knicks'],
  'oklahoma city thunder': ['thunder', 'okc thunder'],
  'orlando magic': ['magic'],
  'philadelphia 76ers': ['76ers', 'sixers', 'philadelphia sixers'],
  'phoenix suns': ['suns'],
  'portland trail blazers': ['trail blazers', 'blazers'],
  'sacramento kings': ['kings'],
  'san antonio spurs': ['spurs'],
  'toronto raptors': ['raptors'],
  'utah jazz': ['jazz'],
  'washington wizards': ['wizards']
};

function createEspnClient() {
  return axios.create({
    baseURL: ESPN_NBA_SCOREBOARD_URL,
    timeout: 30000,
    headers: {
      Accept: 'application/json'
    }
  });
}

function toDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}${month}${day}`;
}

function parseInputDate(value) {
  const parsed = new Date(String(value ?? ''));

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }

  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function resolveSeasonRange(season) {
  const normalizedSeason = String(season ?? '').trim();

  if (!normalizedSeason) {
    return null;
  }

  const range = NBA_SEASON_RANGES[normalizedSeason];

  if (!range) {
    throw new Error(`Unsupported NBA season "${normalizedSeason}".`);
  }

  return range;
}

function eachDate(startDate, endDate) {
  const dates = [];
  const cursor = new Date(startDate);

  while (cursor <= endDate) {
    dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function buildFallbackNbaIndex() {
  const index = new Map();

  for (const [canonicalName, aliases] of Object.entries(NBA_TEAM_ALIASES)) {
    const teamId = `NBA:${canonicalName.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    const values = [canonicalName, ...aliases];

    for (const value of values) {
      index.set(normalizeSportsTeamKey(value), {
        id: teamId,
        league: 'NBA',
        displayName: canonicalName.replace(/\b\w/g, (char) => char.toUpperCase())
      });
    }
  }

  return index;
}

function buildResolvedTeamLookup(snapshot) {
  const universeIndex = buildTeamUniverseIndex(snapshot);
  const lookup = buildFallbackNbaIndex();

  for (const [alias, candidates] of universeIndex.nameIndex.entries()) {
    const match = candidates.find((candidate) => candidate.league === 'NBA');

    if (match) {
      lookup.set(alias, match);
    }
  }

  return lookup;
}

function resolveTeam(lookup, ...names) {
  for (const name of names) {
    const normalized = normalizeSportsTeamKey(name);

    if (!normalized) {
      continue;
    }

    const match = lookup.get(normalized);

    if (match) {
      return match;
    }
  }

  return null;
}

function getCompetitors(event) {
  return Array.isArray(event?.competitions?.[0]?.competitors)
    ? event.competitions[0].competitors
    : [];
}

function getStatus(event) {
  return String(event?.competitions?.[0]?.status?.type?.name ?? event?.status?.type?.name ?? '').toUpperCase();
}

function isFinalEvent(event) {
  return getStatus(event) === 'STATUS_FINAL' || getStatus(event) === 'FINAL';
}

function parseScore(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getNbaSeasonPhase(event) {
  const seasonType = Number(event?.season?.type ?? event?.competitions?.[0]?.season?.type ?? NaN);

  if (seasonType === 2) {
    return 'regular';
  }

  if (seasonType >= 3) {
    return 'playoffs';
  }

  return 'other';
}

function normalizeEspnGame(event, teamLookup) {
  if (!isFinalEvent(event)) {
    return null;
  }

  const competitors = getCompetitors(event);
  const home = competitors.find((competitor) => competitor.homeAway === 'home');
  const away = competitors.find((competitor) => competitor.homeAway === 'away');

  if (!home || !away) {
    return null;
  }

  const homeTeam = resolveTeam(
    teamLookup,
    home.team?.displayName,
    home.team?.shortDisplayName,
    home.team?.name
  );
  const awayTeam = resolveTeam(
    teamLookup,
    away.team?.displayName,
    away.team?.shortDisplayName,
    away.team?.name
  );

  if (!homeTeam || !awayTeam) {
    return null;
  }

  const homeScore = parseScore(home.score);
  const awayScore = parseScore(away.score);

  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
    return null;
  }

  return {
    league: 'NBA',
    seasonPhase: getNbaSeasonPhase(event),
    source: 'espn-scoreboard',
    sourceId: String(event?.id ?? `${event?.date}:${awayTeam.id}:${homeTeam.id}`),
    date: event?.date ?? null,
    seasonLabel: event?.season?.year ? String(event.season.year) : null,
    status: 'final',
    homeTeamId: homeTeam.id,
    awayTeamId: awayTeam.id,
    homeTeamName: homeTeam.displayName,
    awayTeamName: awayTeam.displayName,
    homeScore,
    awayScore,
    neutralSite: Boolean(event?.competitions?.[0]?.neutralSite),
    metadata: {
      name: event?.name ?? null,
      shortName: event?.shortName ?? null,
      seasonType: event?.season?.type ?? null
    }
  };
}

async function fetchGamesForDate(client, dateKey, teamLookup) {
  const response = await client.get('', {
    params: {
      dates: dateKey,
      limit: 200
    }
  });
  const events = Array.isArray(response.data?.events) ? response.data.events : [];

  return events
    .map((event) => normalizeEspnGame(event, teamLookup))
    .filter(Boolean);
}

async function fetchGamesForDates(client, dates, teamLookup, batchSize) {
  const importedGames = [];

  for (let index = 0; index < dates.length; index += batchSize) {
    const batch = dates.slice(index, index + batchSize);
    const dailyBatches = await Promise.all(
      batch.map((date) => fetchGamesForDate(client, toDateKey(date), teamLookup))
    );

    for (const games of dailyBatches) {
      importedGames.push(...games);
    }
  }

  return importedGames;
}

export async function importNbaHistory(options = {}) {
  const seasonRange = resolveSeasonRange(options.season);
  const startDate = parseInputDate(options.startDate ?? seasonRange?.startDate ?? '2023-10-24');
  const endDate = parseInputDate(options.endDate ?? seasonRange?.endDate ?? new Date().toISOString().slice(0, 10));
  const batchSize = Math.max(1, Number.parseInt(options.batchSize ?? String(DEFAULT_BATCH_SIZE), 10) || DEFAULT_BATCH_SIZE);

  if (endDate < startDate) {
    throw new Error('endDate must be on or after startDate.');
  }

  const [snapshot] = await Promise.all([
    loadPolymarketUsTeamUniverse()
  ]);
  const teamLookup = buildResolvedTeamLookup(snapshot);
  const client = createEspnClient();
  const dates = eachDate(startDate, endDate);
  const importedGames = await fetchGamesForDates(client, dates, teamLookup, batchSize);

  const merged = await mergeSportsHistoryGames(importedGames, {
    generatedAt: new Date().toISOString()
  });

  return {
    league: 'NBA',
    source: 'espn-scoreboard',
    season: options.season ?? null,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
    batchSize,
    fetchedGameCount: importedGames.length,
    insertedCount: merged.insertedCount,
    totalStoredGameCount: merged.totalCount
  };
}