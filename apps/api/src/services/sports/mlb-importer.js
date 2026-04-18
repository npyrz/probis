import axios from 'axios';

import { buildTeamUniverseIndex, normalizeSportsTeamKey } from './canonicalization.js';
import { loadPolymarketUsTeamUniverse, mergeSportsHistoryGames } from './history-store.js';

const ESPN_MLB_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
const DEFAULT_BATCH_SIZE = 7;
const LIVE_SCOREBOARD_CACHE_TTL_MS = 5 * 60 * 1000;
const liveScoreboardEventsByDate = new Map();

const MLB_SEASON_RANGES = {
  '2020': { startDate: '2020-07-23', endDate: '2020-10-28' },
  '2021': { startDate: '2021-04-01', endDate: '2021-11-02' },
  '2022': { startDate: '2022-04-07', endDate: '2022-11-05' },
  '2023': { startDate: '2023-03-30', endDate: '2023-11-01' },
  '2024': { startDate: '2024-03-20', endDate: '2024-10-30' },
  '2025': { startDate: '2025-03-18', endDate: '2025-11-01' },
  '2026': { startDate: '2026-03-26', endDate: '2026-11-01' }
};

const MLB_TEAM_ALIASES = {
  'arizona diamondbacks': ['diamondbacks', 'd backs', 'dbacks'],
  'atlanta braves': ['braves'],
  'baltimore orioles': ['orioles', 'os'],
  'boston red sox': ['red sox'],
  'chicago cubs': ['cubs'],
  'chicago white sox': ['white sox'],
  'cincinnati reds': ['reds'],
  'cleveland guardians': ['guardians'],
  'colorado rockies': ['rockies'],
  'detroit tigers': ['tigers'],
  'houston astros': ['astros'],
  'kansas city royals': ['royals'],
  'los angeles angels': ['angels'],
  'los angeles dodgers': ['dodgers'],
  'miami marlins': ['marlins'],
  'milwaukee brewers': ['brewers'],
  'minnesota twins': ['twins'],
  'new york mets': ['mets'],
  'new york yankees': ['yankees'],
  'oakland athletics': ['athletics', 'as', 'a s'],
  'philadelphia phillies': ['phillies'],
  'pittsburgh pirates': ['pirates'],
  'san diego padres': ['padres'],
  'san francisco giants': ['giants'],
  'seattle mariners': ['mariners'],
  'st louis cardinals': ['cardinals'],
  'tampa bay rays': ['rays'],
  'texas rangers': ['rangers'],
  'toronto blue jays': ['blue jays', 'jays'],
  'washington nationals': ['nationals', 'nats']
};

function createEspnClient() {
  return axios.create({
    baseURL: ESPN_MLB_SCOREBOARD_URL,
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

  const range = MLB_SEASON_RANGES[normalizedSeason];

  if (!range) {
    throw new Error(`Unsupported MLB season "${normalizedSeason}".`);
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

function pruneExpiredLiveScoreboardCache(now = Date.now()) {
  for (const [dateKey, entry] of liveScoreboardEventsByDate.entries()) {
    if ((entry?.expiresAt ?? 0) <= now) {
      liveScoreboardEventsByDate.delete(dateKey);
    }
  }
}

async function fetchCachedLiveScoreboardEvents(client, dateKey) {
  const now = Date.now();
  pruneExpiredLiveScoreboardCache(now);

  const cached = liveScoreboardEventsByDate.get(dateKey);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = client.get('', {
    params: {
      dates: dateKey,
      limit: 200
    }
  }).then((response) => (Array.isArray(response.data?.events) ? response.data.events : []))
    .catch((error) => {
      const current = liveScoreboardEventsByDate.get(dateKey);

      if (current?.promise === promise) {
        liveScoreboardEventsByDate.delete(dateKey);
      }

      throw error;
    });

  liveScoreboardEventsByDate.set(dateKey, {
    expiresAt: now + LIVE_SCOREBOARD_CACHE_TTL_MS,
    promise
  });

  return promise;
}

function buildFallbackMlbIndex() {
  const index = new Map();

  for (const [canonicalName, aliases] of Object.entries(MLB_TEAM_ALIASES)) {
    const teamId = `MLB:${canonicalName.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    const values = [canonicalName, ...aliases];

    for (const value of values) {
      index.set(normalizeSportsTeamKey(value), {
        id: teamId,
        league: 'MLB',
        displayName: canonicalName.replace(/\b\w/g, (char) => char.toUpperCase())
      });
    }
  }

  return index;
}

function buildResolvedTeamLookup(snapshot) {
  const universeIndex = buildTeamUniverseIndex(snapshot);
  const lookup = buildFallbackMlbIndex();

  for (const [alias, candidates] of universeIndex.nameIndex.entries()) {
    const match = candidates.find((candidate) => candidate.league === 'MLB');

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

function parseFloatStat(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function getProbablePitcherEntry(competitor) {
  const probables = Array.isArray(competitor?.probables) ? competitor.probables : [];

  return probables.find((entry) => String(entry?.abbreviation ?? '').toUpperCase() === 'SP')
    ?? probables.find((entry) => String(entry?.name ?? '').toLowerCase().includes('startingpitcher'))
    ?? probables[0]
    ?? null;
}

function getProbablePitcherStat(probablePitcher, key) {
  const statistics = Array.isArray(probablePitcher?.statistics) ? probablePitcher.statistics : [];
  const match = statistics.find((statistic) => {
    const statisticName = String(statistic?.name ?? '').toLowerCase();
    const abbreviation = String(statistic?.abbreviation ?? '').toLowerCase();
    return statisticName === key || abbreviation === key;
  });

  return parseFloatStat(match?.displayValue);
}

function parsePitcherRecord(probablePitcher) {
  const record = String(probablePitcher?.record ?? '');
  const recordMatch = record.match(/(\d+)\s*-\s*(\d+)/);
  const eraMatch = record.match(/,\s*([0-9.]+)\)?$/);

  return {
    wins: recordMatch ? Number.parseInt(recordMatch[1], 10) : null,
    losses: recordMatch ? Number.parseInt(recordMatch[2], 10) : null,
    era: eraMatch ? Number.parseFloat(eraMatch[1]) : null
  };
}

function normalizeProbablePitcher(probablePitcher) {
  if (!probablePitcher) {
    return null;
  }

  const parsedRecord = parsePitcherRecord(probablePitcher);

  return {
    playerId: probablePitcher?.athlete?.id ? String(probablePitcher.athlete.id) : null,
    name: probablePitcher?.athlete?.displayName ?? probablePitcher?.athlete?.fullName ?? null,
    shortName: probablePitcher?.athlete?.shortName ?? null,
    position: probablePitcher?.athlete?.position ?? probablePitcher?.abbreviation ?? null,
    era: getProbablePitcherStat(probablePitcher, 'era') ?? parsedRecord.era,
    wins: getProbablePitcherStat(probablePitcher, 'wins') ?? parsedRecord.wins,
    losses: getProbablePitcherStat(probablePitcher, 'losses') ?? parsedRecord.losses,
    record: probablePitcher?.record ?? null
  };
}

function summarizeTeamRecord(competitor) {
  const record = (Array.isArray(competitor?.records) ? competitor.records : []).find(
    (entry) => String(entry?.type ?? '').toLowerCase() === 'total'
  ) ?? competitor?.records?.[0] ?? null;

  return record?.summary ?? null;
}

function getMlbSeasonPhase(event) {
  const seasonType = Number(event?.competitions?.[0]?.season?.type ?? event?.season?.type ?? NaN);

  if (seasonType === 2) {
    return 'regular';
  }

  if (seasonType >= 3) {
    return 'playoffs';
  }

  return 'other';
}

function normalizeEspnMatchup(event, teamLookup) {
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

  return {
    name: event?.name ?? null,
    shortName: event?.shortName ?? null,
    status: getStatus(event),
    seasonPhase: getMlbSeasonPhase(event),
    seasonLabel: event?.season?.year ? String(event.season.year) : null,
    homeTeam,
    awayTeam,
    homeRecord: summarizeTeamRecord(home),
    awayRecord: summarizeTeamRecord(away),
    probablePitchers: {
      home: normalizeProbablePitcher(getProbablePitcherEntry(home)),
      away: normalizeProbablePitcher(getProbablePitcherEntry(away))
    }
  };
}

function normalizeEspnGame(event, teamLookup) {
  if (!isFinalEvent(event)) {
    return null;
  }

  const matchup = normalizeEspnMatchup(event, teamLookup);

  if (!matchup) {
    return null;
  }

  const competitors = getCompetitors(event);
  const home = competitors.find((competitor) => competitor.homeAway === 'home');
  const away = competitors.find((competitor) => competitor.homeAway === 'away');

  const homeScore = parseScore(home.score);
  const awayScore = parseScore(away.score);

  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
    return null;
  }

  return {
    league: 'MLB',
    seasonPhase: matchup.seasonPhase,
    source: 'espn-scoreboard',
    sourceId: String(event?.id ?? `${event?.date}:${matchup.awayTeam.id}:${matchup.homeTeam.id}`),
    date: event?.date ?? null,
    seasonLabel: matchup.seasonLabel,
    status: 'final',
    homeTeamId: matchup.homeTeam.id,
    awayTeamId: matchup.awayTeam.id,
    homeTeamName: matchup.homeTeam.displayName,
    awayTeamName: matchup.awayTeam.displayName,
    homeScore,
    awayScore,
    neutralSite: Boolean(event?.competitions?.[0]?.neutralSite),
    metadata: {
      name: matchup.name,
      shortName: matchup.shortName,
      seasonType: event?.season?.type ?? null,
      homeRecord: matchup.homeRecord,
      awayRecord: matchup.awayRecord,
      probablePitchers: matchup.probablePitchers
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

export async function importMlbHistory(options = {}) {
  const seasonRange = resolveSeasonRange(options.season);
  const startDate = parseInputDate(options.startDate ?? seasonRange?.startDate ?? '2024-03-20');
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
    league: 'MLB',
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

export async function resolveMlbProbablePitcherMatchup({ eventDate, homeTeamId, awayTeamId }) {
  if (!eventDate || !homeTeamId || !awayTeamId) {
    return null;
  }

  const [snapshot] = await Promise.all([
    loadPolymarketUsTeamUniverse()
  ]);
  const teamLookup = buildResolvedTeamLookup(snapshot);
  const client = createEspnClient();
  const dateKey = toDateKey(parseInputDate(eventDate));
  const events = await fetchCachedLiveScoreboardEvents(client, dateKey);

  for (const event of events) {
    const matchup = normalizeEspnMatchup(event, teamLookup);

    if (!matchup) {
      continue;
    }

    if (matchup.homeTeam.id === homeTeamId && matchup.awayTeam.id === awayTeamId) {
      return {
        name: matchup.name,
        shortName: matchup.shortName,
        status: matchup.status,
        seasonPhase: matchup.seasonPhase,
        seasonLabel: matchup.seasonLabel,
        homeRecord: matchup.homeRecord,
        awayRecord: matchup.awayRecord,
        probablePitchers: matchup.probablePitchers
      };
    }

    if (matchup.homeTeam.id === awayTeamId && matchup.awayTeam.id === homeTeamId) {
      return {
        name: matchup.name,
        shortName: matchup.shortName,
        status: matchup.status,
        seasonPhase: matchup.seasonPhase,
        seasonLabel: matchup.seasonLabel,
        homeRecord: matchup.awayRecord,
        awayRecord: matchup.homeRecord,
        probablePitchers: {
          home: matchup.probablePitchers?.away ?? null,
          away: matchup.probablePitchers?.home ?? null
        },
        swappedMatchup: true
      };
    }
  }

  return null;
}