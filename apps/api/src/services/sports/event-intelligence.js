import { normalizeSportsTeamKey } from './canonicalization.js';

const LEAGUE_CONFIG = {
  NBA: {
    sportPath: 'basketball/nba'
  },
  MLB: {
    sportPath: 'baseball/mlb'
  }
};

const TEAM_DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;
const ROSTER_TTL_MS = 60 * 60 * 1000;
const NEWS_TTL_MS = 5 * 60 * 1000;
const SCOREBOARD_TTL_MS = 2 * 60 * 1000;
const MAX_NEWS_ARTICLES = 8;
const MAX_MATCHED_PLAYERS = 5;

const teamDirectoryCache = new Map();
const rosterCache = new Map();
const newsCache = new Map();
const scoreboardCache = new Map();

function pruneExpiredCache(cache, now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if ((entry?.expiresAt ?? 0) <= now) {
      cache.delete(key);
    }
  }
}

async function getCachedJson(cache, key, ttlMs, factory) {
  const now = Date.now();
  pruneExpiredCache(cache, now);

  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = Promise.resolve().then(factory).catch((error) => {
    const current = cache.get(key);

    if (current?.promise === promise) {
      cache.delete(key);
    }

    throw error;
  });

  cache.set(key, {
    expiresAt: now + ttlMs,
    promise
  });

  return promise;
}

function getLeagueConfig(league) {
  return LEAGUE_CONFIG[league] ?? null;
}

function toDateKey(value) {
  const parsed = new Date(String(value ?? ''));

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}`);
  }

  return response.json();
}

function getLeagueBaseUrl(league) {
  const config = getLeagueConfig(league);

  if (!config) {
    return null;
  }

  return `https://site.api.espn.com/apis/site/v2/sports/${config.sportPath}`;
}

async function fetchLeagueTeams(league) {
  const baseUrl = getLeagueBaseUrl(league);

  if (!baseUrl) {
    return [];
  }

  return getCachedJson(teamDirectoryCache, league, TEAM_DIRECTORY_TTL_MS, async () => {
    const payload = await fetchJson(`${baseUrl}/teams`);
    const teams = payload?.sports?.[0]?.leagues?.[0]?.teams ?? [];

    return teams
      .map((entry) => entry?.team)
      .filter(Boolean)
      .map((team) => ({
        id: String(team.id),
        abbreviation: team.abbreviation ?? null,
        displayName: team.displayName ?? null,
        shortDisplayName: team.shortDisplayName ?? null,
        location: team.location ?? null,
        slug: team.slug ?? null,
        normalizedKeys: [
          team.displayName,
          team.shortDisplayName,
          `${team.location ?? ''} ${team.name ?? ''}`,
          team.slug?.replace(/-/g, ' '),
          team.abbreviation
        ]
          .filter(Boolean)
          .map((value) => normalizeSportsTeamKey(value))
      }));
  });
}

function resolveEspnTeam(leagueTeams, teamName, teamId) {
  const teamSlug = String(teamId ?? '').split(':')[1] ?? '';
  const normalizedName = normalizeSportsTeamKey(teamName);
  const normalizedSlug = normalizeSportsTeamKey(teamSlug.replace(/-/g, ' '));

  return leagueTeams.find((team) => (
    team.normalizedKeys.includes(normalizedName)
    || (normalizedSlug && team.normalizedKeys.includes(normalizedSlug))
  )) ?? null;
}

async function fetchTeamRoster(league, espnTeamId) {
  const baseUrl = getLeagueBaseUrl(league);

  if (!baseUrl || !espnTeamId) {
    return [];
  }

  return getCachedJson(rosterCache, `${league}:${espnTeamId}`, ROSTER_TTL_MS, async () => {
    const payload = await fetchJson(`${baseUrl}/teams/${espnTeamId}/roster`);
    const athletes = Array.isArray(payload?.athletes) ? payload.athletes : [];
    const flattened = athletes.flatMap((entry) => Array.isArray(entry?.items) ? entry.items : [entry]).filter(Boolean);

    return flattened.map((athlete) => ({
      id: athlete.id ? String(athlete.id) : null,
      displayName: athlete.displayName ?? athlete.fullName ?? null,
      shortName: athlete.shortName ?? null,
      position: athlete.position?.abbreviation ?? athlete.position ?? null
    }));
  });
}

async function fetchTeamNews(league, espnTeamId) {
  const baseUrl = getLeagueBaseUrl(league);

  if (!baseUrl || !espnTeamId) {
    return [];
  }

  return getCachedJson(newsCache, `${league}:team:${espnTeamId}`, NEWS_TTL_MS, async () => {
    const payload = await fetchJson(`${baseUrl}/news?team=${encodeURIComponent(espnTeamId)}`);
    return Array.isArray(payload?.articles) ? payload.articles : [];
  });
}

async function fetchLeagueNews(league) {
  const baseUrl = getLeagueBaseUrl(league);

  if (!baseUrl) {
    return [];
  }

  return getCachedJson(newsCache, `${league}:league`, NEWS_TTL_MS, async () => {
    const payload = await fetchJson(`${baseUrl}/news`);
    return Array.isArray(payload?.articles) ? payload.articles : [];
  });
}

async function fetchLeagueScoreboard(league, eventDate) {
  const baseUrl = getLeagueBaseUrl(league);
  const dateKey = toDateKey(eventDate);

  if (!baseUrl || !dateKey) {
    return [];
  }

  return getCachedJson(scoreboardCache, `${league}:${dateKey}`, SCOREBOARD_TTL_MS, async () => {
    const payload = await fetchJson(`${baseUrl}/scoreboard?dates=${encodeURIComponent(dateKey)}`);
    return Array.isArray(payload?.events) ? payload.events : [];
  });
}

function normalizeArticle(article) {
  return {
    id: article?.id ? String(article.id) : null,
    headline: article?.headline ?? null,
    description: article?.description ?? null,
    published: article?.published ?? null,
    lastModified: article?.lastModified ?? null,
    type: article?.type ?? null,
    link: article?.links?.web?.href ?? article?.link?.href ?? null,
    categories: Array.isArray(article?.categories) ? article.categories.map((category) => ({
      type: category?.type ?? null,
      description: category?.description ?? null,
      id: category?.id ? String(category.id) : null
    })) : []
  };
}

function getArticleText(article) {
  return normalizeSportsTeamKey(`${article?.headline ?? ''} ${article?.description ?? ''}`);
}

function matchPlayersInArticle(article, roster) {
  const normalizedText = getArticleText(article);

  return roster
    .filter((player) => {
      const names = [player.displayName, player.shortName].filter(Boolean).map((value) => normalizeSportsTeamKey(value));
      return names.some((name) => name && normalizedText.includes(name));
    })
    .slice(0, MAX_MATCHED_PLAYERS)
    .map((player) => ({
      id: player.id,
      name: player.displayName,
      position: player.position ?? null
    }));
}

function detectImpactSignals(article) {
  const normalizedText = getArticleText(article);
  const signals = [];

  const keywordMap = [
    ['injury', ['injury', 'injured', 'hurt']],
    ['availability', ['out', 'questionable', 'doubtful', 'available', 'returns', 'returning']],
    ['lineup', ['starting', 'starter', 'lineup', 'rotation']],
    ['transaction', ['trade', 'waived', 'signed', 'call up', 'optioned', 'promoted']],
    ['discipline', ['suspended', 'fine', 'discipline']],
    ['illness', ['illness', 'sick', 'flu']]
  ];

  for (const [signal, tokens] of keywordMap) {
    if (tokens.some((token) => normalizedText.includes(normalizeSportsTeamKey(token)))) {
      signals.push(signal);
    }
  }

  return signals;
}

function rankArticles(articles, teamNames, roster) {
  const unique = new Map();

  for (const article of articles) {
    const normalized = normalizeArticle(article);

    if (!normalized.id || unique.has(normalized.id)) {
      continue;
    }

    const text = getArticleText(normalized);
    const matchedTeams = teamNames.filter((teamName) => text.includes(normalizeSportsTeamKey(teamName)));
    const matchedPlayers = matchPlayersInArticle(normalized, roster);
    const impactSignals = detectImpactSignals(normalized);
    const relevanceScore = matchedTeams.length * 2 + matchedPlayers.length * 2 + impactSignals.length;

    unique.set(normalized.id, {
      ...normalized,
      matchedTeams,
      matchedPlayers,
      impactSignals,
      relevanceScore
    });
  }

  return [...unique.values()]
    .sort((left, right) => {
      if (right.relevanceScore !== left.relevanceScore) {
        return right.relevanceScore - left.relevanceScore;
      }

      return Date.parse(right.published ?? 0) - Date.parse(left.published ?? 0);
    })
    .slice(0, MAX_NEWS_ARTICLES);
}

function buildGameFeed(events, teams) {
  const teamIds = new Set(teams.map((team) => team.espnTeamId).filter(Boolean));
  const matching = events.find((event) => {
    const competitors = event?.competitions?.[0]?.competitors ?? [];
    const competitorIds = new Set(competitors.map((competitor) => String(competitor?.team?.id ?? '')));
    return [...teamIds].every((teamId) => competitorIds.has(String(teamId)));
  }) ?? null;

  if (!matching) {
    return null;
  }

  const competition = matching?.competitions?.[0] ?? null;
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];

  return {
    id: matching?.id ? String(matching.id) : null,
    name: matching?.name ?? null,
    shortName: matching?.shortName ?? null,
    status: competition?.status?.type?.description ?? competition?.status?.type?.name ?? null,
    detail: competition?.status?.type?.detail ?? null,
    startDate: matching?.date ?? null,
    competitors: competitors.map((competitor) => ({
      teamId: competitor?.team?.id ? String(competitor.team.id) : null,
      teamName: competitor?.team?.displayName ?? null,
      homeAway: competitor?.homeAway ?? null,
      score: competitor?.score ?? null,
      record: competitor?.records?.[0]?.summary ?? null
    }))
  };
}

export async function buildEventIntelligence(event, sportsContext) {
  const sportsMarkets = Array.isArray(sportsContext?.markets) ? sportsContext.markets : [];
  const supportedLeague = sportsMarkets.find((market) => market?.league === 'NBA' || market?.league === 'MLB')?.league ?? null;

  if (!supportedLeague) {
    return {
      generatedAt: new Date().toISOString(),
      available: false,
      league: null,
      reason: 'No supported sports news source for this event.',
      sources: {
        espnNews: false,
        espnGameFeed: false,
        socialMedia: false
      }
    };
  }

  const teamMap = new Map();

  for (const market of sportsMarkets.filter((candidate) => candidate.league === supportedLeague)) {
    for (const mapping of Array.isArray(market?.labelMappings) ? market.labelMappings : []) {
      if (!teamMap.has(mapping.teamId)) {
        teamMap.set(mapping.teamId, {
          teamId: mapping.teamId,
          teamName: mapping.teamName ?? mapping.label,
          label: mapping.label
        });
      }
    }
  }

  const leagueTeams = await fetchLeagueTeams(supportedLeague);
  const teams = [...teamMap.values()]
    .map((team) => {
      const espnTeam = resolveEspnTeam(leagueTeams, team.teamName, team.teamId);
      return {
        ...team,
        espnTeamId: espnTeam?.id ?? null,
        abbreviation: espnTeam?.abbreviation ?? null,
        displayName: espnTeam?.displayName ?? team.teamName
      };
    })
    .filter((team) => team.espnTeamId);

  const [leagueNews, scoreboardEvents, rosterGroups, teamNewsGroups] = await Promise.all([
    fetchLeagueNews(supportedLeague),
    fetchLeagueScoreboard(supportedLeague, event?.startDate ?? event?.endDate ?? new Date().toISOString()),
    Promise.all(teams.map((team) => fetchTeamRoster(supportedLeague, team.espnTeamId))),
    Promise.all(teams.map((team) => fetchTeamNews(supportedLeague, team.espnTeamId)))
  ]);

  const roster = rosterGroups.flat();
  const teamNames = teams.map((team) => team.displayName);
  const articles = rankArticles([...leagueNews, ...teamNewsGroups.flat()], teamNames, roster);
  const playerMentions = [...new Map(
    articles
      .flatMap((article) => article.matchedPlayers)
      .map((player) => [player.id ?? player.name, player])
  ).values()].slice(0, 12);

  return {
    generatedAt: new Date().toISOString(),
    available: true,
    league: supportedLeague,
    teams,
    gameFeed: buildGameFeed(scoreboardEvents, teams),
    articles,
    playerMentions,
    sources: {
      espnNews: true,
      espnGameFeed: true,
      socialMedia: false
    },
    notes: [
      'ESPN team and league news are included.',
      'Player relevance is inferred from team rosters plus article text/categories.',
      'No single reliable API exists for all live social media sources; social feeds are not configured.'
    ]
  };
}