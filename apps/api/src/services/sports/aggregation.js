import { canonicalizeSportsEventMarkets } from './canonicalization.js';
import { loadPolymarketUsTeamUniverse, loadSportsHistoryStore } from './history-store.js';
import { buildTeamStrengthMarketContext } from './elo-model.js';

export async function buildSportsContext(event) {
  const [teamUniverse, historyStore] = await Promise.all([
    loadPolymarketUsTeamUniverse(),
    loadSportsHistoryStore()
  ]);
  const canonicalMarkets = canonicalizeSportsEventMarkets(event, teamUniverse);
  const markets = canonicalMarkets.map((market) => buildTeamStrengthMarketContext({
    event,
    market,
    historyStore
  }));

  return {
    generatedAt: new Date().toISOString(),
    teamUniverseVersion: teamUniverse.version ?? 1,
    teamUniverseGeneratedAt: teamUniverse.generatedAt ?? null,
    supportedTeamCount: Array.isArray(teamUniverse.teams) ? teamUniverse.teams.length : 0,
    historyStoreVersion: historyStore.version ?? 1,
    historyGameCount: Array.isArray(historyStore.games) ? historyStore.games.length : 0,
    recognizedMarketCount: canonicalMarkets.length,
    markets
  };
}