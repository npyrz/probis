import { getEnv } from '../config/env.js';
import { getChicagoSourceAudit, persistChicagoSnapshot } from '../services/persistence/postgres.js';
import { buildChicagoSnapshot } from '../services/weather/chicago.js';
import { failCli, normalizeCliDate, parseCliArgs, printCliJson } from './chicago-cli.js';

try {
  const args = parseCliArgs();
  const date = normalizeCliDate(args.date, '--date');
  const force = args.force === true || args.force === 'true';
  const env = getEnv();
  const snapshot = await buildChicagoSnapshot(env, { date, force });
  const persistence = await persistChicagoSnapshot(env, snapshot);
  const sourceAudit = await getChicagoSourceAudit(env, { date: snapshot.targetDate });

  printCliJson({
    ok: true,
    generatedAt: snapshot.generatedAt,
    targetDate: snapshot.targetDate,
    station: snapshot.station,
    marketStatus: snapshot.markets.status,
    bucketCount: snapshot.markets.bucketCount,
    verifiedBucketCount: (Array.isArray(snapshot.markets.buckets) ? snapshot.markets.buckets : [])
      .filter((bucket) => bucket.designatedSource?.verified === true).length,
    settlementStatus: snapshot.settlement.status,
    observedHighSoFar: snapshot.observations.observedHighSoFar,
    expectedHigh: snapshot.prediction.expectedHigh,
    marketBlendWeight: snapshot.prediction.marketBlendWeight,
    bestRecommendation: snapshot.recommendations.best,
    sourceAudit: {
      storage: sourceAudit.storage,
      marketCount: sourceAudit.marketCount,
      changedCount: sourceAudit.changedCount,
      blockedCount: sourceAudit.blockedCount,
      verifiedCount: sourceAudit.verifiedCount
    },
    persistence
  });
} catch (error) {
  failCli(error);
}
