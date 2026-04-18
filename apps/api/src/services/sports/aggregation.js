import { canonicalizeSportsEventMarkets, inferCompetitionPhaseFromEventText } from './canonicalization.js';
import { loadPolymarketUsTeamUniverse, loadSportsHistoryStore } from './history-store.js';
import { buildHistoricalCalibrationContext, buildTeamStrengthMarketContext } from './elo-model.js';

function resolveCompetitionPhase(event, eventIntelligence) {
  const seasonType = Number(eventIntelligence?.gameFeed?.seasonType ?? NaN);

  if (seasonType === 2) {
    return { phase: 'regular', source: 'espn-season-type' };
  }

  if (seasonType >= 3) {
    return { phase: 'playoffs', source: 'espn-season-type' };
  }

  return {
    phase: inferCompetitionPhaseFromEventText(
      event?.title,
      event?.description,
      ...(Array.isArray(event?.markets) ? event.markets.map((market) => market?.question) : [])
    ),
    source: 'text-heuristic'
  };
}

function buildTeamImpactMap(eventIntelligence) {
  const summaries = Array.isArray(eventIntelligence?.teamImpactSummary)
    ? eventIntelligence.teamImpactSummary
    : [];

  return new Map(summaries
    .filter((summary) => summary?.teamId)
    .map((summary) => [summary.teamId, summary]));
}

export async function buildSportsContext(event, options = {}) {
  const eventIntelligence = options.eventIntelligence ?? null;
  const [teamUniverse, historyStore] = await Promise.all([
    loadPolymarketUsTeamUniverse(),
    loadSportsHistoryStore()
  ]);
  const canonicalMarkets = canonicalizeSportsEventMarkets(event, teamUniverse);
  const competitionPhaseResolution = resolveCompetitionPhase(event, eventIntelligence);
  const competitionPhase = competitionPhaseResolution.phase;
  const teamImpactByTeamId = buildTeamImpactMap(eventIntelligence);
  const calibrationProfiles = new Map(
    [...new Set(canonicalMarkets.map((market) => market.league))].map((league) => ([
      league,
      buildHistoricalCalibrationContext(historyStore, {
        league,
        endDate: event?.startDate ?? event?.endDate,
        phase: competitionPhase
      })
    ]))
  );
  const markets = await Promise.all(canonicalMarkets.map((market) => buildTeamStrengthMarketContext({
    event,
    market,
    historyStore,
    phase: competitionPhase,
    calibrationProfile: calibrationProfiles.get(market.league) ?? null,
    teamImpactByTeamId
  })));

  return {
    generatedAt: new Date().toISOString(),
    teamUniverseVersion: teamUniverse.version ?? 1,
    teamUniverseGeneratedAt: teamUniverse.generatedAt ?? null,
    supportedTeamCount: Array.isArray(teamUniverse.teams) ? teamUniverse.teams.length : 0,
    historyStoreVersion: historyStore.version ?? 1,
    historyGameCount: Array.isArray(historyStore.games) ? historyStore.games.length : 0,
    competitionPhase,
    competitionPhaseSource: competitionPhaseResolution.source,
    teamImpactSummary: [...teamImpactByTeamId.values()],
    recognizedMarketCount: canonicalMarkets.length,
    markets
  };
}