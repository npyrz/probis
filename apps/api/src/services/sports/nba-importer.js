import axios from 'axios';

import { buildTeamUniverseIndex, normalizeSportsTeamKey } from './canonicalization.js';
import { loadPolymarketUsTeamUniverse, mergeSportsHistoryGames } from './history-store.js';

const ESPN_NBA_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';

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

export async function importNbaHistory(options = {}) {
  const startDate = parseInputDate(options.startDate ?? '2023-10-24');
  const endDate = parseInputDate(options.endDate ?? new Date().toISOString().slice(0, 10));

  if (endDate < startDate) {
    throw new Error('endDate must be on or after startDate.');
  }

  const [snapshot] = await Promise.all([
    loadPolymarketUsTeamUniverse()
  ]);
  const teamLookup = buildResolvedTeamLookup(snapshot);
  const client = createEspnClient();
  const dates = eachDate(startDate, endDate);
  const importedGames = [];

  for (const date of dates) {
    const dailyGames = await fetchGamesForDate(client, toDateKey(date), teamLookup);
    importedGames.push(...dailyGames);
  }

  const merged = await mergeSportsHistoryGames(importedGames, {
    generatedAt: new Date().toISOString()
  });

  return {
    league: 'NBA',
    source: 'espn-scoreboard',
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
    fetchedGameCount: importedGames.length,
    insertedCount: merged.insertedCount,
    totalStoredGameCount: merged.totalCount
  };
}