const BINARY_OUTCOME_LABELS = new Set([
  'yes',
  'no',
  'over',
  'under',
  'draw',
  'tie'
]);

const LEAGUE_HINTS = [
  { league: 'NBA', tokens: [' nba ', 'basketball', 'playoffs nba', 'eastern conference', 'western conference'] },
  { league: 'WNBA', tokens: [' wnba ', 'women basketball'] },
  { league: 'NFL', tokens: [' nfl ', 'football nfl', 'super bowl'] },
  { league: 'NCAAF', tokens: [' ncaaf ', 'college football', 'cfb '] },
  { league: 'MLB', tokens: [' mlb ', 'baseball', 'world series'] },
  { league: 'NHL', tokens: [' nhl ', 'hockey', 'stanley cup'] },
  { league: 'NCAAB', tokens: [' ncaab ', 'college basketball', 'march madness'] },
  { league: 'MLS', tokens: [' mls ', 'major league soccer'] },
  { league: 'EPL', tokens: [' premier league ', ' epl ', 'english premier league'] },
  { league: 'UCL', tokens: [' champions league ', ' ucl ', 'uefa champions'] }
];

function normalizeText(value) {
  return ` ${String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function normalizeTeamKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|cf|afc|nfc|club)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeTeamKey(value).replace(/\s+/g, '-');
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractMarketOutcomeLabels(market) {
  if (Array.isArray(market?.outcomes)) {
    return market.outcomes
      .map((outcome) => typeof outcome?.label === 'string' ? outcome.label : outcome)
      .filter((label) => typeof label === 'string' && label.trim().length > 0);
  }

  return parseJsonArray(market?.outcomes).filter((label) => typeof label === 'string' && label.trim().length > 0);
}

function isNamedTeamOutcomeLabel(label) {
  const normalized = normalizeTeamKey(label);

  return normalized.length > 1 && !BINARY_OUTCOME_LABELS.has(normalized);
}

function inferLeagueFromValues(...values) {
  const normalized = normalizeText(values.filter(Boolean).join(' '));

  for (const candidate of LEAGUE_HINTS) {
    if (candidate.tokens.some((token) => normalized.includes(token))) {
      return candidate.league;
    }
  }

  return null;
}

function getTagValues(rawTags) {
  if (!Array.isArray(rawTags)) {
    return [];
  }

  return rawTags
    .flatMap((tag) => {
      if (typeof tag === 'string') {
        return [tag];
      }

      if (tag && typeof tag === 'object') {
        return [tag.name, tag.slug, tag.label].filter(Boolean);
      }

      return [];
    })
    .filter(Boolean);
}

function getMarketLeague(rawMarket) {
  return inferLeagueFromValues(
    rawMarket?.sportsLeague,
    rawMarket?.league,
    rawMarket?.category,
    rawMarket?.group,
    rawMarket?.question,
    rawMarket?.slug,
    ...getTagValues(rawMarket?.tags)
  );
}

function addAlias(aliases, value) {
  const normalized = normalizeTeamKey(value);

  if (!normalized) {
    return;
  }

  aliases.add(normalized);
}

export function buildSportsTeamUniverseSnapshot(usMarkets, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const teamsById = new Map();
  const normalizedMarkets = [];

  for (const market of Array.isArray(usMarkets) ? usMarkets : []) {
    const league = getMarketLeague(market);
    const labels = extractMarketOutcomeLabels(market);

    if (!league || labels.length !== 2 || labels.some((label) => !isNamedTeamOutcomeLabel(label))) {
      continue;
    }

    const normalizedLabels = labels.map((label) => ({
      label,
      teamKey: normalizeTeamKey(label)
    }));

    if (normalizedLabels[0].teamKey === normalizedLabels[1].teamKey) {
      continue;
    }

    normalizedMarkets.push({
      slug: market?.slug ?? null,
      question: market?.question ?? '',
      league,
      outcomeLabels: labels
    });

    for (const outcome of normalizedLabels) {
      const teamId = `${league}:${slugify(outcome.teamKey)}`;
      const existing = teamsById.get(teamId);

      if (existing) {
        existing.marketCount += 1;
        existing.displayName = existing.displayName.length >= outcome.label.length ? existing.displayName : outcome.label;
        addAlias(existing.aliases, outcome.label);
        if (market?.slug) {
          existing.exampleMarketSlugs.add(market.slug);
        }
        continue;
      }

      const aliases = new Set();
      addAlias(aliases, outcome.label);

      teamsById.set(teamId, {
        id: teamId,
        league,
        displayName: outcome.label,
        aliases,
        marketCount: 1,
        exampleMarketSlugs: new Set(market?.slug ? [market.slug] : [])
      });
    }
  }

  const teams = [...teamsById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((team) => ({
      id: team.id,
      league: team.league,
      displayName: team.displayName,
      aliases: [...team.aliases].sort(),
      marketCount: team.marketCount,
      exampleMarketSlugs: [...team.exampleMarketSlugs].sort().slice(0, 10)
    }));

  return {
    version: 1,
    generatedAt,
    marketCount: normalizedMarkets.length,
    teamCount: teams.length,
    teams,
    markets: normalizedMarkets
  };
}

export function buildTeamUniverseIndex(snapshot) {
  const nameIndex = new Map();

  for (const team of Array.isArray(snapshot?.teams) ? snapshot.teams : []) {
    const aliases = Array.isArray(team.aliases) ? team.aliases : [];

    for (const alias of aliases) {
      const normalized = normalizeTeamKey(alias);

      if (!normalized) {
        continue;
      }

      const existing = nameIndex.get(normalized) ?? [];
      existing.push(team);
      nameIndex.set(normalized, existing);
    }
  }

  return {
    nameIndex
  };
}

function resolveTeamFromLabel(label, leagueHint, teamUniverseIndex) {
  const normalized = normalizeTeamKey(label);
  const candidates = teamUniverseIndex.nameIndex.get(normalized) ?? [];

  if (candidates.length === 0) {
    return null;
  }

  if (leagueHint) {
    const sameLeague = candidates.filter((candidate) => candidate.league === leagueHint);

    if (sameLeague.length === 1) {
      return sameLeague[0];
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function detectHomeAwayTeams(text, teams) {
  const normalized = normalizeText(text);
  const byId = new Map(teams.map((team) => [team.id, team]));

  for (const away of teams) {
    for (const home of teams) {
      if (away.id === home.id) {
        continue;
      }

      const awayName = normalizeText(away.displayName).trim();
      const homeName = normalizeText(home.displayName).trim();

      if (!awayName || !homeName) {
        continue;
      }

      if (normalized.includes(` ${awayName} at ${homeName} `)) {
        return {
          homeTeamId: home.id,
          awayTeamId: away.id,
          source: 'at'
        };
      }

      if (normalized.includes(` ${homeName} vs ${awayName} `) || normalized.includes(` ${homeName} v ${awayName} `)) {
        return {
          homeTeamId: home.id,
          awayTeamId: away.id,
          source: 'vs'
        };
      }
    }
  }

  return {
    homeTeamId: null,
    awayTeamId: null,
    source: null
  };
}

export function canonicalizeSportsEventMarkets(event, snapshot) {
  const teamUniverseIndex = buildTeamUniverseIndex(snapshot);
  const eventLeagueHint = inferLeagueFromValues(event?.slug, event?.title, event?.description);

  return (Array.isArray(event?.markets) ? event.markets : [])
    .map((market) => {
      const labels = Array.isArray(market?.outcomes)
        ? market.outcomes.map((outcome) => outcome?.label).filter(Boolean)
        : [];

      if (labels.length !== 2 || labels.some((label) => !isNamedTeamOutcomeLabel(label))) {
        return null;
      }

      const marketLeagueHint = inferLeagueFromValues(market?.slug, market?.question) ?? eventLeagueHint;
      const teams = labels.map((label) => resolveTeamFromLabel(label, marketLeagueHint, teamUniverseIndex));

      if (teams.some((team) => !team)) {
        return null;
      }

      if (teams[0].league !== teams[1].league || teams[0].id === teams[1].id) {
        return null;
      }

      const homeAway = detectHomeAwayTeams(
        `${event?.title ?? ''} ${market?.question ?? ''} ${event?.description ?? ''}`,
        teams
      );

      return {
        conditionId: market.conditionId,
        question: market.question,
        league: teams[0].league,
        labelMappings: labels.map((label, index) => ({
          label,
          teamId: teams[index].id,
          teamName: teams[index].displayName
        })),
        homeTeamId: homeAway.homeTeamId,
        awayTeamId: homeAway.awayTeamId,
        homeAwaySource: homeAway.source
      };
    })
    .filter(Boolean);
}

export function inferLeagueFromEventText(...values) {
  return inferLeagueFromValues(...values);
}

export function normalizeSportsTeamKey(value) {
  return normalizeTeamKey(value);
}