function average(values) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function getExpectedValuePerDollar(currentProbability, modelProbability) {
  if (typeof currentProbability !== 'number' || typeof modelProbability !== 'number' || currentProbability <= 0) {
    return null;
  }

  return modelProbability / currentProbability - 1;
}

function getSuggestedStakeFraction(action, edge, combinedConfidence) {
  if (action !== 'buy' || typeof edge !== 'number' || typeof combinedConfidence !== 'number') {
    return 0;
  }

  return clamp(edge * combinedConfidence * 4, 0.01, 0.2);
}

function getDefaultRiskTargets(currentProbability, edge) {
  if (typeof currentProbability !== 'number' || currentProbability <= 0 || currentProbability >= 1) {
    return {
      stopLossProbability: null,
      takeProfitProbability: null,
      riskRewardRatio: null
    };
  }

  const edgeMagnitude = Math.max(0.02, Math.abs(edge || 0));
  const stopLossDistance = Math.max(0.03, edgeMagnitude * 0.6);
  const takeProfitDistance = Math.max(0.04, edgeMagnitude * 1.25);
  const stopLossProbability = clamp(currentProbability - stopLossDistance, 0.02, 0.97);
  const takeProfitProbability = clamp(currentProbability + takeProfitDistance, 0.03, 0.98);
  const downside = currentProbability - stopLossProbability;
  const upside = takeProfitProbability - currentProbability;

  return {
    stopLossProbability,
    takeProfitProbability,
    riskRewardRatio: downside > 0 ? upside / downside : null
  };
}

function getAiRiskTargets(aiRecommendation, currentProbability, edge) {
  const defaultTargets = getDefaultRiskTargets(currentProbability, edge);
  const stopLossProbability = typeof aiRecommendation?.stopLossProbability === 'number'
    ? clamp(aiRecommendation.stopLossProbability, 0.02, 0.97)
    : defaultTargets.stopLossProbability;
  const takeProfitProbability = typeof aiRecommendation?.takeProfitProbability === 'number'
    ? clamp(aiRecommendation.takeProfitProbability, 0.03, 0.98)
    : defaultTargets.takeProfitProbability;

  if (
    typeof currentProbability !== 'number'
    || typeof stopLossProbability !== 'number'
    || typeof takeProfitProbability !== 'number'
    || stopLossProbability >= currentProbability
    || takeProfitProbability <= currentProbability
    || stopLossProbability >= takeProfitProbability
  ) {
    return defaultTargets;
  }

  const downside = currentProbability - stopLossProbability;
  const upside = takeProfitProbability - currentProbability;

  return {
    stopLossProbability,
    takeProfitProbability,
    riskRewardRatio: downside > 0 ? upside / downside : null
  };
}

function findModelOutcome(statisticalModel, marketQuestion, outcomeLabel) {
  const market = statisticalModel.markets.find((candidate) => candidate.question === marketQuestion);
  const outcome = market?.outcomes.find((candidate) => candidate.label === outcomeLabel) ?? null;

  return {
    market,
    outcome
  };
}

function normalizeMatchValue(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeMatchValue(value) {
  return normalizeMatchValue(value)
    .split(/\s+/)
    .filter(Boolean);
}

function hasStrongTokenMatch(left, right) {
  const leftTokens = tokenizeMatchValue(left);
  const rightTokens = tokenizeMatchValue(right);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false;
  }

  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  const needed = Math.max(1, Math.ceil(Math.min(leftTokens.length, rightTokens.length) * 0.5));

  return overlap >= needed;
}

function getRawEventFallbackSelection(event, aiRecommendation) {
  const normalizedThesis = normalizeMatchValue(
    `${aiRecommendation?.marketQuestion ?? ''} ${aiRecommendation?.outcomeLabel ?? ''} ${aiRecommendation?.thesis ?? ''}`
  );
  const candidateMarkets = Array.isArray(event?.markets)
    ? event.markets.filter((market) => Array.isArray(market.outcomes) && market.outcomes.length > 0)
    : [];

  if (candidateMarkets.length === 0) {
    return {
      market: null,
      outcome: null
    };
  }

  for (const market of candidateMarkets) {
    const exactOutcome = market.outcomes.find((candidate) => {
      const normalizedLabel = normalizeMatchValue(candidate.label);
      return normalizedLabel.length > 0
        && (normalizedThesis.includes(normalizedLabel) || hasStrongTokenMatch(candidate.label, normalizedThesis));
    });

    if (exactOutcome) {
      return {
        market,
        outcome: {
          ...exactOutcome,
          currentProbability: exactOutcome.probability ?? exactOutcome.currentProbability ?? null,
          estimatedProbability: exactOutcome.probability ?? exactOutcome.currentProbability ?? null,
          edge: 0,
          confidence: null
        }
      };
    }
  }

  const fallbackMarket = candidateMarkets[0] ?? null;
  const fallbackOutcome = [...(fallbackMarket?.outcomes ?? [])]
    .sort((left, right) => {
      const leftValue = typeof left.probability === 'number' ? left.probability : -1;
      const rightValue = typeof right.probability === 'number' ? right.probability : -1;
      return rightValue - leftValue;
    })[0] ?? null;

  return {
    market: fallbackMarket,
    outcome: fallbackOutcome
      ? {
          ...fallbackOutcome,
          currentProbability: fallbackOutcome.probability ?? fallbackOutcome.currentProbability ?? null,
          estimatedProbability: fallbackOutcome.probability ?? fallbackOutcome.currentProbability ?? null,
          edge: 0,
          confidence: null
        }
      : null
  };
}

function getFallbackSelection(statisticalModel) {
  const marketsByConfidence = [...statisticalModel.markets]
    .filter((market) => Array.isArray(market.outcomes) && market.outcomes.length > 0)
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0));
  const fallbackMarket = marketsByConfidence[0] ?? null;
  const fallbackOutcome = fallbackMarket?.outcomes
    ?.filter((candidate) => typeof candidate.currentProbability === 'number' || typeof candidate.estimatedProbability === 'number')
    .sort((left, right) => {
      const leftValue = typeof left.estimatedProbability === 'number'
        ? left.estimatedProbability
        : (left.currentProbability ?? -1);
      const rightValue = typeof right.estimatedProbability === 'number'
        ? right.estimatedProbability
        : (right.currentProbability ?? -1);

      return rightValue - leftValue;
    })[0] ?? null;

  return {
    market: fallbackMarket,
    outcome: fallbackOutcome
  };
}

function resolveRecommendedSelection(event, statisticalModel, aiRecommendation) {
  const rankedCandidates = statisticalModel.markets
    .filter((market) => market.opportunity)
    .sort((left, right) => right.opportunity.score - left.opportunity.score);
  const bestOpportunity = statisticalModel.summary.bestOpportunity;

  if (aiRecommendation?.marketQuestion && aiRecommendation?.outcomeLabel) {
    const exactMatch = findModelOutcome(
      statisticalModel,
      aiRecommendation.marketQuestion,
      aiRecommendation.outcomeLabel
    );

    if (exactMatch.market && exactMatch.outcome) {
      return exactMatch;
    }
  }

  const fallbackMarket = rankedCandidates.find((market) => market.question === bestOpportunity?.question) ?? null;
  const fallbackOutcome = fallbackMarket?.outcomes.find((outcome) => outcome.label === bestOpportunity?.label)
    ?? bestOpportunity
    ?? null;

  if (fallbackMarket && fallbackOutcome) {
    return {
      market: fallbackMarket,
      outcome: fallbackOutcome
    };
  }

  const modelFallback = getFallbackSelection(statisticalModel);

  if (modelFallback.market && modelFallback.outcome) {
    return modelFallback;
  }

  return getRawEventFallbackSelection(event, aiRecommendation);
}

export function combineDecisionRecommendation(event, aggregation, statisticalModel, aiRecommendation, rawAnalysis, options = {}) {
  const bestOpportunity = statisticalModel.summary.bestOpportunity;
  const validatedSelection = resolveRecommendedSelection(event, statisticalModel, aiRecommendation);
  const chosenMarket = validatedSelection.market;
  const chosenOutcome = validatedSelection.outcome;
  const recommendedMarketQuestion = chosenMarket?.question ?? bestOpportunity?.question ?? null;
  const recommendedOutcomeLabel = chosenOutcome?.label ?? bestOpportunity?.label ?? null;
  const llmConfidence = typeof aiRecommendation?.confidence === 'number' ? aiRecommendation.confidence : null;
  const modelConfidence = chosenOutcome?.confidence ?? chosenMarket?.confidence ?? null;
  const combinedConfidence = clamp(average([llmConfidence, modelConfidence].filter((value) => typeof value === 'number')) ?? 0.5);
  const edge = chosenOutcome?.edge ?? 0;
  const agreement = aiRecommendation?.agreeWithModel ?? Boolean(bestOpportunity && chosenOutcome?.label === bestOpportunity.label);

  let action = 'watch';
  if (edge > 0.01 && combinedConfidence >= 0.55 && agreement) {
    action = 'buy';
  } else if (edge < -0.01 || (llmConfidence !== null && llmConfidence < 0.4 && !agreement)) {
    action = 'avoid';
  }

  const expectedValuePerDollar = getExpectedValuePerDollar(
    chosenOutcome?.currentProbability ?? null,
    chosenOutcome?.estimatedProbability ?? null
  );
  const suggestedStakeFraction = getSuggestedStakeFraction(action, edge, combinedConfidence);
  const riskTargets = getAiRiskTargets(aiRecommendation, chosenOutcome?.currentProbability ?? null, edge);

  return {
    generatedAt: new Date().toISOString(),
    action,
    recommendation: {
      marketQuestion: recommendedMarketQuestion,
      outcomeLabel: recommendedOutcomeLabel,
      currentProbability: chosenOutcome?.currentProbability ?? null,
      modelProbability: chosenOutcome?.estimatedProbability ?? null,
      edge,
      expectedValuePerDollar,
      combinedConfidence,
      modelConfidence,
      llmConfidence,
      agreementWithModel: agreement,
      breakEvenProbability: chosenOutcome?.currentProbability ?? null,
      payoutMultiple: typeof chosenOutcome?.currentProbability === 'number' && chosenOutcome.currentProbability > 0
        ? 1 / chosenOutcome.currentProbability
        : null,
      suggestedStakeFraction,
      stopLossProbability: riskTargets.stopLossProbability,
      takeProfitProbability: riskTargets.takeProfitProbability,
      riskRewardRatio: riskTargets.riskRewardRatio,
      plannedTradeAmount: typeof options.tradeAmount === 'number' ? options.tradeAmount : null,
      thesis: aiRecommendation?.thesis ?? null,
      keyRisk: aiRecommendation?.keyRisk ?? null,
      reasons: Array.isArray(aiRecommendation?.reasons) ? aiRecommendation.reasons : []
    },
    modelSummary: {
      bestOpportunity: statisticalModel.summary.bestOpportunity,
      highestConfidenceMarket: statisticalModel.summary.highestConfidenceMarket
    },
    liquidityContext: {
      eventLiquidity: aggregation.liquiditySnapshot.eventLiquidity,
      eventVolume: aggregation.liquiditySnapshot.eventVolume
    },
    rawAnalysis
  };
}
