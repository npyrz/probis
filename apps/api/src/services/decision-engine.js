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

function findModelOutcome(statisticalModel, marketQuestion, outcomeLabel) {
  const market = statisticalModel.markets.find((candidate) => candidate.question === marketQuestion);
  const outcome = market?.outcomes.find((candidate) => candidate.label === outcomeLabel) ?? null;

  return {
    market,
    outcome
  };
}

function resolveRecommendedSelection(statisticalModel, aiRecommendation) {
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

  return {
    market: fallbackMarket,
    outcome: fallbackOutcome
  };
}

export function combineDecisionRecommendation(event, aggregation, statisticalModel, aiRecommendation, rawAnalysis) {
  const bestOpportunity = statisticalModel.summary.bestOpportunity;
  const validatedSelection = resolveRecommendedSelection(statisticalModel, aiRecommendation);
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