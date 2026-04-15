function clamp(value, min = 0.01, max = 0.99) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeProbabilities(outcomes) {
  const total = outcomes.reduce((sum, outcome) => sum + outcome.rawEstimate, 0);

  if (!total) {
    return outcomes.map((outcome) => ({
      ...outcome,
      estimatedProbability: outcome.currentProbability,
      edge: 0
    }));
  }

  return outcomes.map((outcome) => {
    const estimatedProbability = outcome.rawEstimate / total;

    return {
      ...outcome,
      estimatedProbability,
      edge: estimatedProbability - outcome.currentProbability
    };
  });
}

function scoreOutcome(outcome, marketSnapshot) {
  const summary = outcome.historySummary ?? {};
  const currentProbability = outcome.currentProbability ?? 0;
  const momentum = summary.absoluteChange ?? 0;
  const volatility = summary.highPrice !== null && summary.lowPrice !== null
    ? summary.highPrice - summary.lowPrice
    : 0;
  const pointCount = summary.pointCount ?? 0;
  const sampleStrength = Math.min(pointCount, 7) / 7;
  const quality = average(
    [marketSnapshot?.liquidityShare, marketSnapshot?.volumeShare].filter((value) => typeof value === 'number')
  ) ?? 0;
  const historicalAnchor = average(
    [summary.firstPrice, summary.latestPrice, summary.highPrice, summary.lowPrice].filter(
      (value) => typeof value === 'number'
    )
  ) ?? currentProbability;

  const trendWeight = 0.25 + quality * 0.35 + sampleStrength * 0.1;
  const anchorWeight = 0.18 + sampleStrength * 0.12;
  const volatilityPenalty = Math.min(0.35, volatility * 0.35);

  let rawEstimate = currentProbability;
  rawEstimate += momentum * trendWeight;
  rawEstimate += (historicalAnchor - currentProbability) * anchorWeight;
  rawEstimate = rawEstimate * (1 - volatilityPenalty) + 0.5 * volatilityPenalty;

  const confidence = clamp(0.15 + quality * 0.45 + sampleStrength * 0.3 - volatility * 0.25, 0.05, 0.95);

  return {
    label: outcome.label,
    tokenId: outcome.tokenId,
    currentProbability,
    historySummary: summary,
    rawEstimate: clamp(rawEstimate),
    confidence,
    features: {
      momentum,
      volatility,
      quality,
      sampleStrength,
      historicalAnchor
    }
  };
}

function getMarketOpportunity(outcomes) {
  const ranked = outcomes
    .filter((outcome) => outcome.edge > 0)
    .map((outcome) => ({
      ...outcome,
      score: outcome.edge * outcome.confidence
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? null;
}

export function buildStatisticalModel(event, aggregation) {
  const marketSnapshots = aggregation?.liquiditySnapshot?.markets ?? [];
  const historicalMarkets = aggregation?.historicalPrices?.markets ?? [];

  const markets = historicalMarkets.map((market) => {
    const marketSnapshot = marketSnapshots.find((candidate) => candidate.conditionId === market.conditionId);
    const scoredOutcomes = market.outcomes.map((outcome) => scoreOutcome(outcome, marketSnapshot));
    const normalizedOutcomes = normalizeProbabilities(scoredOutcomes).sort(
      (left, right) => right.estimatedProbability - left.estimatedProbability
    );
    const marketConfidence = average(normalizedOutcomes.map((outcome) => outcome.confidence)) ?? 0;
    const bestOpportunity = getMarketOpportunity(normalizedOutcomes);

    return {
      conditionId: market.conditionId,
      question: market.question,
      confidence: marketConfidence,
      opportunity: bestOpportunity,
      outcomes: normalizedOutcomes
    };
  });

  const bestOpportunity = markets
    .filter((market) => market.opportunity)
    .map((market) => ({
      conditionId: market.conditionId,
      question: market.question,
      confidence: market.confidence,
      ...market.opportunity
    }))
    .sort((left, right) => right.score - left.score)[0] ?? null;

  return {
    generatedAt: new Date().toISOString(),
    methodology: {
      name: 'first-pass-statistical-model',
      inputs: ['current_probability', '7d_price_history', 'liquidity_share', 'volume_share'],
      description:
        'Adjusts current market probabilities with short-horizon momentum, a historical anchor, and a volatility penalty weighted by market quality.'
    },
    summary: {
      eventSlug: event.slug,
      liveMarketCount: markets.length,
      bestOpportunity,
      highestConfidenceMarket: markets.sort((left, right) => right.confidence - left.confidence)[0] ?? null
    },
    markets
  };
}