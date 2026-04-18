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

function getSportsOutcome(outcome, sportsMarket) {
  if (!sportsMarket || !Array.isArray(sportsMarket.outcomes)) {
    return null;
  }

  return sportsMarket.outcomes.find((candidate) => candidate.label === outcome.label) ?? null;
}

function normalizeMarketCategory(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isPoliticsCategory(value) {
  const normalized = normalizeMarketCategory(value);
  return normalized === 'politics';
}

function scoreOutcome(outcome, marketSnapshot, sportsMarket) {
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
  const sportsOutcome = getSportsOutcome(outcome, sportsMarket);
  const sportsFairProbability = sportsOutcome?.fairProbability ?? null;
  const sportsConfidence = sportsOutcome?.modelConfidence ?? sportsMarket?.marketConfidence ?? null;
  const marketCategory = normalizeMarketCategory(marketSnapshot?.category ?? null);
  const politicsModel = isPoliticsCategory(marketCategory) ? 'politics-residual-microstructure-v1' : null;
  const modelFamily = sportsMarket
    ? 'sports-model'
    : (politicsModel ? 'politics-model' : 'market-microstructure');
  const teamImpact = sportsOutcome?.features?.teamImpact ?? null;
  const sportsImpactProbabilityDelta = typeof teamImpact?.probabilityDelta === 'number'
    ? teamImpact.probabilityDelta
    : 0;
  const adjustedSportsFairProbability = typeof sportsFairProbability === 'number'
    ? clamp(sportsFairProbability + sportsImpactProbabilityDelta, 0.01, 0.99)
    : null;

  const trendWeight = politicsModel
    ? (0.34 + quality * 0.28 + sampleStrength * 0.12)
    : (0.25 + quality * 0.35 + sampleStrength * 0.1);
  const anchorWeight = politicsModel
    ? (0.12 + sampleStrength * 0.08)
    : (0.18 + sampleStrength * 0.12);
  const volatilityPenalty = politicsModel
    ? Math.min(0.28, volatility * 0.26)
    : Math.min(0.35, volatility * 0.35);

  let rawEstimate = currentProbability;
  rawEstimate += momentum * trendWeight;
  rawEstimate += (historicalAnchor - currentProbability) * anchorWeight;
  rawEstimate = rawEstimate * (1 - volatilityPenalty) + 0.5 * volatilityPenalty;

  if (typeof adjustedSportsFairProbability === 'number') {
    const sportsBlendWeight = clamp((sportsConfidence ?? 0.45) * 0.65, 0.2, 0.75);
    rawEstimate = rawEstimate * (1 - sportsBlendWeight) + adjustedSportsFairProbability * sportsBlendWeight;
  }

  const baseConfidence = clamp(
    0.15
      + quality * (politicsModel ? 0.5 : 0.45)
      + sampleStrength * 0.3
      - volatility * (politicsModel ? 0.2 : 0.25)
      + (politicsModel ? 0.04 : 0),
    0.05,
    0.95
  );
  const confidence = clamp(
    average([baseConfidence, sportsConfidence].filter((value) => typeof value === 'number')) ?? baseConfidence,
    0.05,
    0.97
  );

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
      historicalAnchor,
      marketCategory,
      modelFamily,
      politicsModel,
      sportsFairProbability,
      adjustedSportsFairProbability,
      sportsConfidence,
      sportsImpactProbabilityDelta,
      sportsImpactDirection: teamImpact?.direction ?? null,
      sportsModel: sportsMarket?.model?.name ?? null,
      sportsLeague: sportsMarket?.league ?? null
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
  const sportsMarkets = aggregation?.sportsContext?.markets ?? [];

  const markets = historicalMarkets.map((market) => {
    const marketSnapshot = marketSnapshots.find((candidate) => candidate.conditionId === market.conditionId);
    const sportsMarket = sportsMarkets.find((candidate) => candidate.conditionId === market.conditionId) ?? market.sportsContext ?? null;
    const scoredOutcomes = market.outcomes.map((outcome) => scoreOutcome(outcome, marketSnapshot, sportsMarket));
    const normalizedOutcomes = normalizeProbabilities(scoredOutcomes).sort(
      (left, right) => right.estimatedProbability - left.estimatedProbability
    );
    const marketConfidence = average(normalizedOutcomes.map((outcome) => outcome.confidence)) ?? 0;
    const bestOpportunity = getMarketOpportunity(normalizedOutcomes);

    return {
      conditionId: market.conditionId,
      question: market.question,
      sportsContext: sportsMarket,
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
      name: 'hybrid-market-and-sports-statistical-model',
      inputs: [
        'current_probability',
        '7d_price_history',
        'liquidity_share',
        'volume_share',
        'market_category',
        'team_elo',
        'home_edge',
        'recent_form',
        'rest_days',
        'rolling_score_differential',
        'mlb_probable_starter_era',
        'mlb_probable_starter_record'
      ],
      description:
        'Adjusts current market probabilities with short-horizon market behavior. For recognized team-vs-team sports markets, blends in calibrated fair probabilities from local team history (plus MLB probable-starter context). For politics markets, applies a dedicated residual microstructure profile tuned for event-driven repricing.'
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