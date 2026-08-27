// Family-agnostic market fusion: turn live quotes into a market-implied distribution
// and blend it with a family's model probabilities.
//
// `outcomes` are objects keyed by conditionId carrying quote fields
// (midpoint / marketProbability / bestBid / bestAsk / spread).
import { average, clamp, round } from './number.js';

export function getOutcomeMarketPrice(outcome) {
  if (typeof outcome.midpoint === 'number') {
    return outcome.midpoint;
  }

  if (typeof outcome.marketProbability === 'number') {
    return outcome.marketProbability;
  }

  if (typeof outcome.bestBid === 'number' && typeof outcome.bestAsk === 'number') {
    return (outcome.bestBid + outcome.bestAsk) / 2;
  }

  return typeof outcome.bestAsk === 'number' ? outcome.bestAsk : outcome.bestBid ?? null;
}

export function buildMarketImpliedProbabilities(outcomes) {
  const rows = (Array.isArray(outcomes) ? outcomes : [])
    .map((outcome) => ({
      conditionId: outcome.conditionId,
      probability: getOutcomeMarketPrice(outcome)
    }))
    .filter((row) => row.conditionId && typeof row.probability === 'number' && row.probability > 0 && row.probability < 1);
  const total = rows.reduce((sum, row) => sum + row.probability, 0);

  if (total <= 0) {
    return {};
  }

  return Object.fromEntries(rows.map((row) => [row.conditionId, round(row.probability / total, 6)]));
}

export function getAverageSpread(outcomes) {
  return average((Array.isArray(outcomes) ? outcomes : [])
    .map((outcome) => outcome.spread)
    .filter((value) => typeof value === 'number'));
}

// Quote quality: how much of the board is quoted, and how tight those quotes are.
export function getQuoteQuality(outcomes) {
  const rows = Array.isArray(outcomes) ? outcomes : [];

  if (rows.length === 0) {
    return 0;
  }

  const quotedCount = rows.filter((outcome) => typeof getOutcomeMarketPrice(outcome) === 'number').length;
  const quoteCoverage = quotedCount / rows.length;
  const averageSpread = getAverageSpread(rows);
  const spreadQuality = typeof averageSpread === 'number' ? 1 - clamp(averageSpread / 0.12, 0, 1) : 0.55;

  return clamp(0.7 * quoteCoverage + 0.3 * spreadQuality, 0, 1);
}

// Blend weight for the market-implied distribution. `baseWeight` is the family's
// prior (weather varies it by day phase); staleness pushes weight toward the market.
export function getMarketBlendWeight({ outcomes, baseWeight, isStale = false, maxWeight = 0.45 }) {
  const rows = Array.isArray(outcomes) ? outcomes : [];

  if (rows.length === 0 || typeof baseWeight !== 'number') {
    return 0;
  }

  const quality = getQuoteQuality(rows);
  const adjustedBase = isStale === true ? baseWeight + 0.12 : baseWeight;

  return round(clamp(adjustedBase * quality, 0, maxWeight), 4) ?? 0;
}

export function fuseProbabilities(modelProbabilities, marketProbabilities, marketBlendWeight) {
  const fused = {};
  const keys = new Set([
    ...Object.keys(modelProbabilities ?? {}),
    ...Object.keys(marketProbabilities ?? {})
  ]);

  for (const key of keys) {
    const modelProbability = modelProbabilities?.[key] ?? 0;
    const marketProbability = marketProbabilities?.[key];
    const blendWeight = typeof marketProbability === 'number' ? marketBlendWeight : 0;
    fused[key] = round((1 - blendWeight) * modelProbability + blendWeight * (marketProbability ?? 0), 6) ?? 0;
  }

  return fused;
}
