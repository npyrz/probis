import { canonicalizeSportsEventMarkets, inferCompetitionPhaseFromEventText } from './canonicalization.js';
import { loadPolymarketUsTeamUniverse, loadSportsHistoryStore } from './history-store.js';
import { buildHistoricalCalibrationContext, buildTeamStrengthMarketContext } from './elo-model.js';

export async function buildSportsContext(event) {
  const [teamUniverse, historyStore] = await Promise.all([
    loadPolymarketUsTeamUniverse(),
    loadSportsHistoryStore()
  ]);
  const canonicalMarkets = canonicalizeSportsEventMarkets(event, teamUniverse);
  const competitionPhase = inferCompetitionPhaseFromEventText(
    event?.title,
    event?.description,
    ...(Array.isArray(event?.markets) ? event.markets.map((market) => market?.question) : [])
  );
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
  const markets = canonicalMarkets.map((market) => buildTeamStrengthMarketContext({
    event,
    market,
    historyStore,
    phase: competitionPhase,
    calibrationProfile: calibrationProfiles.get(market.league) ?? null
  }));

  return {
    generatedAt: new Date().toISOString(),
    teamUniverseVersion: teamUniverse.version ?? 1,
    teamUniverseGeneratedAt: teamUniverse.generatedAt ?? null,
    supportedTeamCount: Array.isArray(teamUniverse.teams) ? teamUniverse.teams.length : 0,
    historyStoreVersion: historyStore.version ?? 1,
    historyGameCount: Array.isArray(historyStore.games) ? historyStore.games.length : 0,
    competitionPhase,
    recognizedMarketCount: canonicalMarkets.length,
    markets
  };
}