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
const SOCIAL_TTL_MS = 90 * 1000;
const MAX_NEWS_ARTICLES = 8;
const MAX_MATCHED_PLAYERS = 5;
const MAX_SOCIAL_POSTS = 8;

const teamDirectoryCache = new Map();
const rosterCache = new Map();
const newsCache = new Map();
const scoreboardCache = new Map();
const socialCache = new Map();

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

function shiftDateKey(dateKey, offsetDays) {
  if (!dateKey || typeof offsetDays !== 'number') {
    return null;
  }

  const year = Number.parseInt(dateKey.slice(0, 4), 10);
  const month = Number.parseInt(dateKey.slice(4, 6), 10);
  const day = Number.parseInt(dateKey.slice(6, 8), 10);

  if (![year, month, day].every(Number.isFinite)) {
    return null;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  parsed.setUTCDate(parsed.getUTCDate() + offsetDays);
  return toDateKey(parsed.toISOString());
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
  const dateKey = typeof eventDate === 'string' && /^\d{8}$/.test(eventDate)
    ? eventDate
    : toDateKey(eventDate);

  if (!baseUrl || !dateKey) {
    return [];
  }

  return getCachedJson(scoreboardCache, `${league}:${dateKey}`, SCOREBOARD_TTL_MS, async () => {
    const payload = await fetchJson(`${baseUrl}/scoreboard?dates=${encodeURIComponent(dateKey)}`);
    return Array.isArray(payload?.events) ? payload.events : [];
  });
}

async function fetchLeagueScoreboards(league, eventDate) {
  const baseDateKey = toDateKey(eventDate);

  if (!baseDateKey) {
    return [];
  }

  const dateKeys = [-1, 0, 1]
    .map((offsetDays) => shiftDateKey(baseDateKey, offsetDays))
    .filter(Boolean);
  const eventGroups = await Promise.all(dateKeys.map((dateKey) => fetchLeagueScoreboard(league, dateKey)));

  return eventGroups.flat();
}

function resolveGameFeedTargetDate(event) {
  const start = new Date(String(event?.startDate ?? ''));
  const end = new Date(String(event?.endDate ?? ''));
  const startValid = Number.isFinite(start.getTime());
  const endValid = Number.isFinite(end.getTime());

  if (startValid && endValid) {
    const diffMs = Math.abs(end.getTime() - start.getTime());

    // Polymarket startDate can reflect listing time rather than tip-off/first pitch.
    if (diffMs > 36 * 60 * 60 * 1000) {
      return end.toISOString();
    }

    return start.toISOString();
  }

  if (endValid) {
    return end.toISOString();
  }

  if (startValid) {
    return start.toISOString();
  }

  return new Date().toISOString();
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
    })) : [],
    provider: article?.provider ?? 'espn'
  };
}

function normalizeSocialPost(post) {
  return {
    id: post?.id ? String(post.id) : null,
    headline: post?.headline ?? post?.text ?? null,
    description: post?.description ?? post?.text ?? null,
    published: post?.published ?? post?.createdAt ?? null,
    lastModified: post?.lastModified ?? post?.published ?? post?.createdAt ?? null,
    type: post?.type ?? 'Social',
    link: post?.link ?? null,
    categories: Array.isArray(post?.categories) ? post.categories : [],
    provider: post?.provider ?? 'social'
  };
}

function getArticleText(article) {
  return normalizeSportsTeamKey(`${article?.headline ?? ''} ${article?.description ?? ''}`);
}

function buildTeamMatchKeys(team) {
  const aliasCandidates = [
    team?.displayName,
    team?.shortDisplayName,
    team?.teamName,
    team?.label,
    team?.abbreviation
  ].filter(Boolean);
  const aliasSet = new Set(aliasCandidates.map((value) => normalizeSportsTeamKey(value)).filter(Boolean));

  for (const value of aliasCandidates) {
    const normalized = normalizeSportsTeamKey(value);
    const parts = normalized.split(' ').filter(Boolean);

    if (parts.length > 1) {
      aliasSet.add(parts.slice(1).join(' '));
      aliasSet.add(parts.at(-1));
    }
  }

  return [...aliasSet];
}

function matchTeamsInText(text, teams) {
  return teams
    .filter((team) => (team.matchKeys ?? []).some((matchKey) => matchKey && text.includes(matchKey)))
    .map((team) => team.displayName ?? team.teamName ?? team.label)
    .filter(Boolean);
}

function matchesPattern(text, patterns) {
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }

    return text.includes(normalizeSportsTeamKey(pattern));
  });
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

  const signalRules = [
    {
      signal: 'injury',
      include: [
        /\binjur(?:y|ies|ed)\b/i,
        /\bhurt\b/i,
        /\b(?:left|exited|leaves)\b.{0,40}\b(?:game|match)\b.{0,40}\b(?:injur(?:y|ies)|hurt)\b/i,
        /\b(?:shoulder|hamstring|ankle|knee|elbow|wrist|back|groin|concussion)\b.{0,30}\b(?:injur(?:y|ies)|strain|sprain|tear|soreness|tightness)\b/i,
        /\bplaced on (?:the )?(?:injured list|il)\b/i
      ]
    },
    {
      signal: 'availability',
      include: [
        /\bquestionable\b/i,
        /\bdoubtful\b/i,
        /\bgame[- ]time decision\b/i,
        /\bwill play\b/i,
        /\bwill not play\b/i,
        /\bout for\b/i,
        /\bruled out\b/i,
        /\bcleared to play\b/i,
        /\bexpected to play\b/i,
        /\bexpected back\b/i,
        /\breturns? to (?:the )?(?:lineup|rotation|mound|court|field)\b/i,
        /\bavailable tonight\b/i,
        /\bavailable for (?:tonight|game \d+|the opener|the series)\b/i
      ],
      exclude: [
        /\bavailable on\b/i,
        /\btickets? available\b/i,
        /\bstream(?:ing)? available\b/i,
        /\btracker\b/i,
        /\brankings?\b/i
      ]
    },
    {
      signal: 'lineup',
      include: [
        /\bstarting lineup\b/i,
        /\blineup change\b/i,
        /\blineup shuffle\b/i,
        /\bremoved from the lineup\b/i,
        /\bbenched\b/i,
        /\bconfirmed starter\b/i,
        /\bprobable starter\b/i,
        /\bstarting pitcher\b/i,
        /\brotation change\b/i,
        /\bjoining the starting unit\b/i
      ],
      exclude: [
        /\bpower rankings?\b/i,
        /\brotation rankings?\b/i,
        /\bstarting (?:five|lineups?) for all teams\b/i
      ]
    },
    {
      signal: 'transaction',
      include: [
        /\btraded?\b/i,
        /\bsigned?\b/i,
        /\bwaived?\b/i,
        /\bdesignated for assignment\b/i,
        /\bcall(?:ed)? up\b/i,
        /\boptioned\b/i,
        /\bpromoted\b/i,
        /\brecalled\b/i,
        /\bactivated from (?:the )?(?:il|injured list)\b/i
      ],
      exclude: [
        /\btrade grades?\b/i,
        /\btrade deadline rankings?\b/i
      ]
    },
    {
      signal: 'discipline',
      include: [
        /\bsuspend(?:ed|sion)?\b/i,
        /\bfined?\b/i,
        /\bdisciplin(?:e|ary)\b/i,
        /\bejected\b/i
      ]
    },
    {
      signal: 'illness',
      include: [
        /\billness\b/i,
        /\bflu\b/i,
        /\bsick\b/i,
        /\bunder the weather\b/i,
        /\bnon-covid illness\b/i
      ]
    }
  ];

  for (const rule of signalRules) {
    const hasInclude = matchesPattern(normalizedText, rule.include ?? []);
    const hasExclude = matchesPattern(normalizedText, rule.exclude ?? []);

    if (hasInclude && !hasExclude) {
      signals.push(rule.signal);
    }
  }

  if (signals.includes('discipline') && !signals.includes('availability')) {
    if (matchesPattern(normalizedText, [/\bmiss(?:es|ing)?\b/i, /\bout\b/i, /\bineligible\b/i])) {
      signals.push('availability');
    }
  }

  if (signals.includes('injury') && !signals.includes('availability')) {
    if (matchesPattern(normalizedText, [/\bday to day\b/i, /\bquestionable\b/i, /\bwill not play\b/i])) {
      signals.push('availability');
    }
  }

  if (signals.includes('lineup') && !signals.includes('availability')) {
    if (matchesPattern(normalizedText, [/\bscratched\b/i, /\bout of the lineup\b/i])) {
      signals.push('availability');
    }
  }

  return signals;
}

function hasLowSignalHeadline(article) {
  const normalizedText = getArticleText(article);

  return matchesPattern(normalizedText, [
    /\bpower rankings?\b/i,
    /\brankings?\b/i,
    /\btracker\b/i,
    /\bpreview\b/i,
    /\brecap\b/i,
    /\bhighlights?\b/i,
    /\bbest bets?\b/i,
    /\bhow to watch\b/i,
    /\bodds\b/i
  ]);
}

function getArticleImpactScore(article, matchedTeams, matchedPlayers, impactSignals) {
  const type = String(article?.type ?? '').toLowerCase();
  const normalizedText = getArticleText(article);
  let score = 0;

  const signalWeights = {
    injury: 12,
    availability: 10,
    suspension: 10,
    discipline: 9,
    lineup: 7,
    illness: 7,
    transaction: 6
  };

  for (const signal of impactSignals) {
    score += signalWeights[signal] ?? 3;
  }

  score += matchedTeams.length * 2;
  score += matchedPlayers.length * 3;

  if (type.includes('recap') || type.includes('media') || type.includes('highlight')) {
    score -= 6;
  }

  if (hasLowSignalHeadline(article) && impactSignals.length === 0) {
    score -= 4;
  }

  if (normalizedText.includes('walk-off') || normalizedText.includes('beat ') || normalizedText.includes('rally')) {
    score -= 2;
  }

  const publishedAt = Date.parse(article?.published ?? 0);
  const ageHours = Number.isFinite(publishedAt) ? Math.max(0, (Date.now() - publishedAt) / 3600000) : null;

  if (typeof ageHours === 'number') {
    if (ageHours <= 6) {
      score += 3;
    } else if (ageHours <= 24) {
      score += 1;
    } else if (ageHours > 72) {
      score -= 1;
    }
  }

  return score;
}

function shouldKeepArticle(article, matchedTeams, matchedPlayers, impactSignals) {
  if (article.sourceScope === 'team') {
    return matchedTeams.length > 0 || matchedPlayers.length > 0 || impactSignals.length > 0;
  }

  if (matchedTeams.length > 0 || matchedPlayers.length > 0) {
    return true;
  }

  return false;
}

function rankArticles(articles, teams, roster) {
  const unique = new Map();

  for (const article of articles) {
    const normalized = normalizeArticle(article);

    if (!normalized.id || unique.has(normalized.id)) {
      continue;
    }

    const text = getArticleText(normalized);
    const matchedTeams = matchTeamsInText(text, teams);
    const matchedPlayers = matchPlayersInArticle(normalized, roster);
    const impactSignals = detectImpactSignals(normalized);

    if (!shouldKeepArticle(article, matchedTeams, matchedPlayers, impactSignals)) {
      continue;
    }

    const impactScore = getArticleImpactScore(normalized, matchedTeams, matchedPlayers, impactSignals);

    unique.set(normalized.id, {
      ...normalized,
      matchedTeams,
      matchedPlayers,
      impactSignals,
      impactScore,
      relevanceScore: impactScore
    });
  }

  return [...unique.values()]
    .sort((left, right) => {
      if (right.impactScore !== left.impactScore) {
        return right.impactScore - left.impactScore;
      }

      return Date.parse(right.published ?? 0) - Date.parse(left.published ?? 0);
    })
    .slice(0, MAX_NEWS_ARTICLES);
}

function buildSearchQueries(teams, roster) {
  const teamTerms = teams
    .flatMap((team) => [team.displayName, team.abbreviation])
    .filter(Boolean);
  const playerTerms = roster
    .slice(0, 20)
    .map((player) => player.displayName)
    .filter(Boolean);

  return [...new Set([...teamTerms, ...playerTerms])].slice(0, 16);
}

async function fetchRedditPosts(env, queries, league) {
  if (!env?.socialRedditEnabled || queries.length === 0) {
    return [];
  }

  const subredditPart = Array.isArray(env.socialRedditSubreddits) && env.socialRedditSubreddits.length > 0
    ? env.socialRedditSubreddits.join('+')
    : 'sports';
  const query = encodeURIComponent(queries.slice(0, 6).join(' OR '));

  return getCachedJson(socialCache, `reddit:${league}:${query}`, SOCIAL_TTL_MS, async () => {
    const response = await fetch(`https://www.reddit.com/r/${subredditPart}/search.json?q=${query}&sort=new&restrict_sr=0&limit=${MAX_SOCIAL_POSTS}`, {
      headers: {
        'User-Agent': env.socialRedditUserAgent
      }
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const posts = Array.isArray(payload?.data?.children) ? payload.data.children : [];

    return posts.map((entry) => {
      const data = entry?.data ?? {};

      return normalizeSocialPost({
        id: data.id,
        text: data.title,
        description: data.selftext?.slice(0, 240) ?? '',
        published: data.created_utc ? new Date(data.created_utc * 1000).toISOString() : null,
        type: 'Reddit',
        link: data.permalink ? `https://www.reddit.com${data.permalink}` : null,
        provider: 'reddit'
      });
    });
  });
}

async function fetchXPosts(env, queries, league) {
  if (!env?.socialXBearerToken || queries.length === 0) {
    return [];
  }

  const search = encodeURIComponent(queries.slice(0, 6).map((query) => `"${query}"`).join(' OR '));

  return getCachedJson(socialCache, `x:${league}:${search}`, SOCIAL_TTL_MS, async () => {
    const response = await fetch(`${env.socialXRecentSearchUrl}?max_results=${MAX_SOCIAL_POSTS}&tweet.fields=created_at&query=${search}`, {
      headers: {
        Authorization: `Bearer ${env.socialXBearerToken}`
      }
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const posts = Array.isArray(payload?.data) ? payload.data : [];

    return posts.map((post) => normalizeSocialPost({
      id: post.id,
      text: post.text,
      published: post.created_at ?? null,
      type: 'X',
      link: post.id ? `https://x.com/i/web/status/${post.id}` : null,
      provider: 'x'
    }));
  });
}

function rankSocialPosts(posts, teams, roster) {
  const unique = new Map();

  for (const post of posts.map((entry) => normalizeSocialPost(entry))) {
    if (!post.id || unique.has(post.id)) {
      continue;
    }

    const text = getArticleText(post);
    const matchedTeams = matchTeamsInText(text, teams);
    const matchedPlayers = matchPlayersInArticle(post, roster);
    const impactSignals = detectImpactSignals(post);

    if (matchedTeams.length === 0 && matchedPlayers.length === 0) {
      continue;
    }

    const impactScore = getArticleImpactScore(post, matchedTeams, matchedPlayers, impactSignals) + 1;

    unique.set(post.id, {
      ...post,
      matchedTeams,
      matchedPlayers,
      impactSignals,
      impactScore
    });
  }

  return [...unique.values()]
    .sort((left, right) => {
      if (right.impactScore !== left.impactScore) {
        return right.impactScore - left.impactScore;
      }

      return Date.parse(right.published ?? 0) - Date.parse(left.published ?? 0);
    })
    .slice(0, MAX_SOCIAL_POSTS);
}

function buildGameFeed(events, teams, targetDate) {
  const teamIds = new Set(teams.map((team) => team.espnTeamId).filter(Boolean));

  if (teamIds.size === 0) {
    return null;
  }

  const targetTimestamp = Date.parse(String(targetDate ?? ''));
  const matching = events
    .filter((event) => {
      const competitors = event?.competitions?.[0]?.competitors ?? [];
      const competitorIds = new Set(competitors.map((competitor) => String(competitor?.team?.id ?? '')));
      return [...teamIds].every((teamId) => competitorIds.has(String(teamId)));
    })
    .sort((left, right) => {
      if (!Number.isFinite(targetTimestamp)) {
        return Date.parse(right?.date ?? 0) - Date.parse(left?.date ?? 0);
      }

      const leftDiff = Math.abs(Date.parse(left?.date ?? 0) - targetTimestamp);
      const rightDiff = Math.abs(Date.parse(right?.date ?? 0) - targetTimestamp);

      return leftDiff - rightDiff;
    })[0]
    ?? null;

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

export async function buildEventIntelligence(env, event, sportsContext) {
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
        displayName: espnTeam?.displayName ?? team.teamName,
        shortDisplayName: espnTeam?.shortDisplayName ?? null
      };
    })
    .map((team) => ({
      ...team,
      matchKeys: buildTeamMatchKeys(team)
    }))
    .filter((team) => team.espnTeamId);

  const [leagueNews, scoreboardEvents, rosterGroups, teamNewsGroups] = await Promise.all([
    fetchLeagueNews(supportedLeague),
    fetchLeagueScoreboards(supportedLeague, resolveGameFeedTargetDate(event)),
    Promise.all(teams.map((team) => fetchTeamRoster(supportedLeague, team.espnTeamId))),
    Promise.all(teams.map((team) => fetchTeamNews(supportedLeague, team.espnTeamId)))
  ]);

  const roster = rosterGroups.flat();
  const scopedLeagueNews = leagueNews.map((article) => ({ ...article, sourceScope: 'league' }));
  const scopedTeamNews = teamNewsGroups.flat().map((article) => ({ ...article, sourceScope: 'team' }));
  const articles = rankArticles([...scopedTeamNews, ...scopedLeagueNews], teams, roster);
  const queries = buildSearchQueries(teams, roster);
  const [redditPosts, xPosts] = await Promise.all([
    fetchRedditPosts(env, queries, supportedLeague),
    fetchXPosts(env, queries, supportedLeague)
  ]);
  const socialPosts = rankSocialPosts([...redditPosts, ...xPosts], teams, roster);
  const playerMentions = [...new Map(
    [...articles, ...socialPosts]
      .flatMap((article) => article.matchedPlayers)
      .map((player) => [player.id ?? player.name, player])
  ).values()].slice(0, 12);

  return {
    generatedAt: new Date().toISOString(),
    available: true,
    league: supportedLeague,
    teams,
    gameFeed: buildGameFeed(scoreboardEvents, teams, resolveGameFeedTargetDate(event)),
    articles,
    socialPosts,
    playerMentions,
    sources: {
      espnNews: true,
      espnGameFeed: true,
      socialMedia: socialPosts.length > 0
    },
    notes: [
      'ESPN team and league news are included.',
      'Player relevance is inferred from team rosters plus article text/categories.',
      env?.socialXBearerToken || env?.socialRedditEnabled
        ? 'Optional social providers are enabled when configured and merged into event intelligence.'
        : 'No single reliable API exists for all live social media sources; optional social providers are currently disabled.'
    ]
  };
}