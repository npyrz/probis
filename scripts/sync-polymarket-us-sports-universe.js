import { getEnv } from '../apps/api/src/config/env.js';
import { listUsActiveMarkets } from '../apps/api/src/services/polymarket/us-orders.js';
import { buildSportsTeamUniverseSnapshot } from '../apps/api/src/services/sports/canonicalization.js';
import { getSportsDataPaths, savePolymarketUsTeamUniverse } from '../apps/api/src/services/sports/history-store.js';

async function main() {
  const env = getEnv();

  if (!env.hasUsTradingCredentials) {
    throw new Error('Missing Polymarket US trading credentials. The sports universe sync reads signed /v1/markets.');
  }

  const markets = await listUsActiveMarkets(env, { limit: 200, maxPages: 20 });
  const snapshot = buildSportsTeamUniverseSnapshot(markets);
  await savePolymarketUsTeamUniverse(snapshot);

  const paths = getSportsDataPaths();

  console.log(JSON.stringify({
    ok: true,
    savedTo: paths.teamUniverseFile,
    marketCount: snapshot.marketCount,
    teamCount: snapshot.teamCount,
    generatedAt: snapshot.generatedAt
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});