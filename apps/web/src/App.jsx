import { useEffect, useState, useTransition } from 'react';

import {
  analyzeEvent,
  createTradeIntent,
  deleteTradeIntent as deleteTradeIntentRequest,
  executeTradeIntent as executeTradeIntentRequest,
  fetchActiveEvents,
  fetchOpportunityScanner,
  fetchStatus,
  fetchTradeIntents,
  invalidateEventAggregationCache,
  pollTrackedTradeIntents,
  resolveEvent,
  resolveEventAggregation,
  sellTradeIntent as sellTradeIntentRequest,
  updateTradeIntent as updateTradeIntentRequest
} from './lib/api.js';

const TRADE_DRAFT_STORAGE_KEY = 'probis.tradeDraft';
const TRACKED_PROBABILITY_HISTORY_LIMIT = 72;
const TRACKED_PROBABILITY_WINDOW_MS = 5 * 60 * 1000;

function formatCompactNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value);
}

function formatSignedPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  const prefix = value > 0 ? '+' : '';
  return `${prefix}${(value * 100).toFixed(1)}%`;
}

function formatDate(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parsed);
}

function formatDateTime(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
}

function formatClockTime(value) {
  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(parsed);
}

function formatChartDate(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric'
  }).format(parsed);
}

function formatChartTime(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
}

function getTimestampMs(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRelativeAge(value, now = new Date()) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  const diffSeconds = Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 1000));

  if (diffSeconds < 2) {
    return 'just now';
  }

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours}h ago`;
}

function formatTimeToResolution(value) {
  if (typeof value !== 'number') {
    return 'n/a';
  }

  const totalMinutes = Math.max(0, Math.round(value / 60000));

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = totalMinutes / 60;

  if (totalHours < 48) {
    return `${totalHours.toFixed(totalHours < 10 ? 1 : 0)}h`;
  }

  const totalDays = totalHours / 24;
  return `${totalDays.toFixed(totalDays < 10 ? 1 : 0)}d`;
}

function formatOpportunityClassification(value) {
  if (value === 'strong-buy') {
    return 'Strong Buy';
  }

  if (value === 'soft-buy') {
    return 'Soft Buy';
  }

  if (value === 'watchlist') {
    return 'Watchlist';
  }

  return 'Avoid';
}

function getOpportunityClassificationClassName(value) {
  return `scanner-class-chip scanner-class-chip-${String(value ?? 'watchlist')}`;
}

function formatCompetitionPhase(value) {
  if (value === 'playoffs') {
    return 'Playoffs';
  }

  if (value === 'regular') {
    return 'Regular';
  }

  return 'Unknown';
}

function formatCompetitionPhaseSource(value) {
  if (value === 'espn-season-type') {
    return 'ESPN Season Type';
  }

  if (value === 'text-heuristic') {
    return 'Text Heuristic';
  }

  return 'Unavailable';
}

function formatImpactDirection(value) {
  if (value === 'positive') {
    return 'Positive';
  }

  if (value === 'negative') {
    return 'Negative';
  }

  if (value === 'neutral') {
    return 'Neutral';
  }

  return 'Unavailable';
}

function formatIntentStatus(intent) {
  if (intent.status === 'draft') {
    return 'Draft';
  }

  if (intent.status === 'tracking') {
    return 'Actively Trading';
  }

  if (intent.status === 'paused') {
    return 'Paused';
  }

  if (intent.status === 'closed') {
    return 'Closed';
  }

  return 'Confirmed';
}

function isDraftTradeIntent(intent) {
  return intent?.status !== 'tracking' && intent?.status !== 'closed';
}

function formatMonitoringStateLabel(state) {
  const normalized = String(state ?? 'active').trim();

  if (normalized === 'sync-warning') {
    return 'Sync Warning';
  }

  if (normalized === 'exit-submitted-awaiting-fill') {
    return 'Closing Position';
  }

  if (normalized === 'active') {
    return 'Actively Trading';
  }

  if (normalized === 'stop-loss-triggered-exit-failed') {
    return 'Stop-Loss Exit Failed';
  }

  if (normalized === 'take-profit-triggered-exit-failed') {
    return 'Take-Profit Exit Failed';
  }

  if (normalized === 'exit-failed-needs-manual-sell') {
    return 'Exit Failed — Cash Out Manually';
  }

  return normalized
    .split('-')
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function getMonitoringStateChipClass(state) {
  const normalized = String(state ?? 'active').trim();

  if (normalized === 'sync-warning') {
    return 'market-chip market-chip-warning';
  }

  if (normalized === 'exit-submitted-awaiting-fill') {
    return 'market-chip market-chip-warning';
  }

  if (normalized.endsWith('-failed') || normalized === 'exit-failed-needs-manual-sell') {
    return 'market-chip market-chip-alert';
  }

  if (normalized === 'active') {
    return 'market-chip market-chip-live';
  }

  return 'market-chip';
}

function hasApiVerifiedFilledPosition(intent) {
  return intent?.verification?.source === 'polymarket-us'
    && intent?.verification?.apiVerifiedFilledPosition === true;
}

function hasMonitoringSyncWarning(intent) {
  const notes = String(intent?.monitoring?.notes ?? '').toLowerCase();
  const verificationReason = String(intent?.verification?.reason ?? '').toLowerCase();

  return notes.includes('venue sync warning')
    || verificationReason === 'order-lookup-temporary-failure'
    || verificationReason === 'no-live-shares-detected'
    || verificationReason === 'live-position-lookup-temporary-failure';
}

function formatOrderId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'n/a';
  }

  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function isTradeIntentNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('was not found');
}

function getExecutePrecheckMessage(intent) {
  if (!intent?.confirmedAt) {
    return 'Confirm and save this trade intent first.';
  }

  if (!intent?.marketSlug) {
    return 'Missing market mapping. Open Intent and save changes before starting live trading.';
  }

  return null;
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatCurrency(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value);
}

function formatSignedCurrency(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatCurrency(value)}`;
}

function formatMarketPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return `$${value.toFixed(3)}`;
}

function formatEventPreview(value, maxLength = 220) {
  const text = String(value ?? '').trim();

  if (!text) {
    return 'No event description is available for this market.';
  }

  return text.length > maxLength
    ? `${text.slice(0, maxLength).trimEnd()}...`
    : text;
}

function formatRecommendationHeadline(recommendation) {
  const outcomeLabel = String(recommendation?.outcomeLabel ?? '').trim();
  const marketQuestion = String(recommendation?.marketQuestion ?? '').trim();

  if (outcomeLabel && marketQuestion) {
    return `${outcomeLabel} in ${marketQuestion}`;
  }

  if (outcomeLabel) {
    return outcomeLabel;
  }

  if (marketQuestion) {
    return marketQuestion;
  }

  return 'No specific market recommendation available yet.';
}

function formatRecommendationActionLabel(action, outcomeLabel) {
  const normalizedAction = String(action ?? '').trim().toLowerCase();
  const normalizedOutcome = String(outcomeLabel ?? '').trim();

  if (normalizedAction === 'buy') {
    return normalizedOutcome ? `Back ${normalizedOutcome}` : 'Buy';
  }

  if (normalizedAction === 'avoid') {
    return normalizedOutcome ? `Avoid ${normalizedOutcome}` : 'Avoid';
  }

  if (normalizedAction === 'watch') {
    return normalizedOutcome ? `Watch ${normalizedOutcome}` : 'Watch';
  }

  return normalizedOutcome || 'Recommendation';
}

function resolveRecommendationExpectedValue(recommendation) {
  if (typeof recommendation?.expectedValuePerDollar === 'number') {
    return recommendation.expectedValuePerDollar;
  }

  if (typeof recommendation?.edge === 'number'
    && typeof recommendation?.currentProbability === 'number'
    && recommendation.currentProbability > 0) {
    return recommendation.edge / recommendation.currentProbability;
  }

  return null;
}

function parseOperatorNotes(analysisText) {
  const source = String(analysisText ?? '').trim();

  if (!source) {
    return {
      paragraphs: [],
      bullets: []
    };
  }

  const lines = source
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim());

  const bullets = [];
  const paragraphs = [];

  for (const line of lines) {
    if (/^(event state|strongest market\/opportunity|why the model differs from market price|key risk)\s*:/i.test(line)) {
      bullets.push(line);
      continue;
    }

    paragraphs.push(line);
  }

  return {
    paragraphs,
    bullets
  };
}

function getEventValidationError(event) {
  if (!event || typeof event !== 'object') {
    return 'Unable to load this event. Please check the link or slug and try again.';
  }

  const slug = String(event.slug ?? '').trim();

  if (!slug) {
    return 'This event is missing a valid slug and cannot be loaded.';
  }

  if (!event.title || String(event.title).trim().length === 0) {
    return 'This event is missing a title and may be invalid.';
  }

  if (event.endDate) {
    const parsedEndDate = new Date(event.endDate);

    if (!Number.isNaN(parsedEndDate.getTime()) && parsedEndDate.getTime() < Date.now()) {
      return 'This event has already passed. Load an upcoming event to continue.';
    }
  }

  return null;
}

function loadStoredTradeDraft() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const value = window.localStorage.getItem(TRADE_DRAFT_STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function isRestorableDraft(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const status = String(candidate.status ?? '').trim().toLowerCase();
  return status !== 'tracking' && status !== 'closed';
}

function saveStoredTradeDraft(draft) {
  if (typeof window === 'undefined') {
    return;
  }

  if (!isRestorableDraft(draft)) {
    window.localStorage.removeItem(TRADE_DRAFT_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(TRADE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

function clearStoredTradeDraft() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(TRADE_DRAFT_STORAGE_KEY);
}

function marketHasLivePrices(market) {
  return market.outcomes.some((outcome) => typeof outcome.probability === 'number');
}

function sortOutcomes(outcomes) {
  return [...outcomes].sort((left, right) => {
    const leftValue = typeof left.probability === 'number' ? left.probability : -1;
    const rightValue = typeof right.probability === 'number' ? right.probability : -1;

    return rightValue - leftValue;
  });
}

function getMarketLeader(market) {
  const rankedOutcomes = sortOutcomes(market.outcomes);
  return rankedOutcomes[0] ?? null;
}

function findHistoricalMarket(aggregation, conditionId) {
  return aggregation?.historicalPrices?.markets?.find((market) => market.conditionId === conditionId) ?? null;
}

function getModelMarket(statisticalModel, conditionId) {
  return statisticalModel?.markets?.find((market) => market.conditionId === conditionId) ?? null;
}

function getMarketMomentum(aggregation, conditionId) {
  const market = findHistoricalMarket(aggregation, conditionId);

  if (!market) {
    return null;
  }

  const changes = market.outcomes
    .map((outcome) => outcome.historySummary?.percentChange)
    .filter((value) => typeof value === 'number');

  if (changes.length === 0) {
    return null;
  }

  return Math.max(...changes.map((value) => Math.abs(value)));
}

function getMarketDisplayMetrics(market, aggregation, statisticalModel) {
  const modelMarket = getModelMarket(statisticalModel, market.conditionId);
  const topEdge = modelMarket?.outcomes
    ?.map((outcome) => outcome.edge)
    .filter((value) => typeof value === 'number')
    .sort((left, right) => right - left)[0] ?? null;

  return {
    modelEdge: topEdge,
    confidence: modelMarket?.confidence ?? null,
    liquidity: market.liquidity ?? null,
    momentum: getMarketMomentum(aggregation, market.conditionId)
  };
}

function getModelOutcome(modelMarket, outcomeLabel) {
  return modelMarket?.outcomes?.find((outcome) => outcome.label === outcomeLabel) ?? null;
}

function getSportsMarketOutcome(modelMarket, outcomeLabel) {
  return modelMarket?.sportsContext?.outcomes?.find((outcome) => outcome.label === outcomeLabel) ?? null;
}

function getSportsProbabilityBreakdown(market, modelMarket) {
  if (!market || !modelMarket?.sportsContext) {
    return [];
  }

  return (Array.isArray(market.outcomes) ? market.outcomes : [])
    .map((outcome) => {
      const sportsOutcome = getSportsMarketOutcome(modelMarket, outcome.label);
      const modelOutcome = getModelOutcome(modelMarket, outcome.label);

      if (!sportsOutcome || !modelOutcome) {
        return null;
      }

      return {
        label: outcome.label,
        marketProbability: typeof outcome.probability === 'number' ? outcome.probability : modelOutcome.currentProbability,
        rawSportsProbability: sportsOutcome.rawFairProbability ?? null,
        calibratedSportsProbability: sportsOutcome.fairProbability ?? null,
        finalModelProbability: modelOutcome.estimatedProbability ?? null,
        edge: modelOutcome.edge ?? null,
        confidence: modelOutcome.confidence ?? null
      };
    })
    .filter(Boolean)
    .sort((left, right) => (right.finalModelProbability ?? -1) - (left.finalModelProbability ?? -1));
}

function getSportsLeagues(statisticalModel) {
  return [...new Set(
    (Array.isArray(statisticalModel?.markets) ? statisticalModel.markets : [])
      .map((market) => market?.sportsContext?.league)
      .filter(Boolean)
  )];
}

function getRecommendationSource(modelMarket) {
  const league = String(modelMarket?.sportsContext?.league ?? '').trim().toUpperCase();

  if (league === 'NBA' || league === 'MLB') {
    return {
      label: league,
      detail: 'sports model',
      className: `market-chip market-chip-league market-chip-league-${league.toLowerCase()}`
    };
  }

  return {
    label: 'MARKET',
    detail: 'market only',
    className: 'market-chip market-chip-market-only'
  };
}

function formatSignedDecimal(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(digits)}`;
}

function formatStarterSummary(pitcher) {
  if (!pitcher?.name) {
    return 'n/a';
  }

  const record = String(pitcher.record ?? '').trim();
  return record ? `${pitcher.name} ${record}` : pitcher.name;
}

function getEventIntelligenceSummary(aggregation) {
  return aggregation?.eventIntelligence?.available ? aggregation.eventIntelligence : null;
}

function formatImpactScore(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return value.toFixed(0);
}

function getRecommendedStarterContext(modelMarket) {
  const features = modelMarket?.sportsContext?.features;
  const probablePitchers = features?.probablePitchers ?? null;

  if (!probablePitchers?.home && !probablePitchers?.away) {
    return null;
  }

  return {
    source: features?.probablePitcherSource ?? null,
    diff: features?.probablePitcherDiff ?? null,
    home: probablePitchers.home ?? null,
    away: probablePitchers.away ?? null,
    recentForm: features?.probablePitcherRecentForm ?? null
  };
}

function getRecommendedMarket(selectedEvent, decisionEngine) {
  if (!selectedEvent?.markets || !decisionEngine?.recommendation?.marketQuestion) {
    return null;
  }

  return selectedEvent.markets.find(
    (market) => market.question === decisionEngine.recommendation.marketQuestion
  ) ?? null;
}

function parseProbabilityInput(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isValidProbabilityRange(stopLossProbability, takeProfitProbability) {
  return Number.isFinite(stopLossProbability)
    && Number.isFinite(takeProfitProbability)
    && stopLossProbability > 0
    && takeProfitProbability < 1
    && stopLossProbability < takeProfitProbability;
}

function buildTradeSuggestion(decisionEngine, amount, riskInputs = {}) {
  const recommendation = decisionEngine?.recommendation;
  const numericAmount = Number.parseFloat(amount);

  if (!recommendation || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    return null;
  }

  const price = recommendation.currentProbability;
  const modelProbability = recommendation.modelProbability;
  const shares = typeof price === 'number' && price > 0 ? numericAmount / price : null;
  const grossPayout = typeof shares === 'number' ? shares : null;
  const profitIfCorrect = typeof grossPayout === 'number' ? grossPayout - numericAmount : null;
  const fallbackExpectedProfit = typeof recommendation.expectedValuePerDollar === 'number'
    ? numericAmount * recommendation.expectedValuePerDollar
    : null;
  const weightedRisk = typeof recommendation.combinedConfidence === 'number'
    ? numericAmount * recommendation.combinedConfidence
    : null;
  const bankrollHint = typeof recommendation.suggestedStakeFraction === 'number' && recommendation.suggestedStakeFraction > 0
    ? `${(recommendation.suggestedStakeFraction * 100).toFixed(1)}% of bankroll`
    : 'No stake size suggested';
  const stopLossProbability = parseProbabilityInput(riskInputs.stopLossProbability, recommendation.stopLossProbability ?? null);
  const takeProfitProbability = parseProbabilityInput(riskInputs.takeProfitProbability, recommendation.takeProfitProbability ?? null);
  const stopLossLoss = typeof shares === 'number' && typeof stopLossProbability === 'number' && typeof price === 'number'
    ? shares * Math.max(0, price - stopLossProbability)
    : null;
  const takeProfitGain = typeof shares === 'number' && typeof takeProfitProbability === 'number' && typeof price === 'number'
    ? shares * Math.max(0, takeProfitProbability - price)
    : null;
  const dynamicRiskRewardRatio = typeof takeProfitGain === 'number'
    && typeof stopLossLoss === 'number'
    && stopLossLoss > 0
    ? takeProfitGain / stopLossLoss
    : null;
  const dynamicExpectedProfit = typeof modelProbability === 'number'
    && typeof takeProfitGain === 'number'
    && typeof stopLossLoss === 'number'
    ? (modelProbability * takeProfitGain) - ((1 - modelProbability) * stopLossLoss)
    : null;
  const expectedProfit = dynamicExpectedProfit ?? fallbackExpectedProfit;
  const hasValidRange = typeof stopLossProbability === 'number'
    && typeof takeProfitProbability === 'number'
    && stopLossProbability > 0
    && takeProfitProbability < 1
    && stopLossProbability < takeProfitProbability;
  const followsEntryDirection = typeof price === 'number'
    ? stopLossProbability < price && takeProfitProbability > price
    : true;
  const isRiskValid = hasValidRange && followsEntryDirection;
  let riskValidationMessage = null;

  if (!hasValidRange) {
    riskValidationMessage = 'Stop-loss must be below take-profit and both must stay between 0% and 100%.';
  } else if (!followsEntryDirection) {
    riskValidationMessage = 'For a long entry, stop-loss should stay below the entry probability and take-profit above it.';
  }

  return {
    amount: numericAmount,
    shares,
    grossPayout,
    profitIfCorrect,
    expectedProfit,
    weightedRisk,
    bankrollHint,
    modelProbability,
    breakEvenProbability: recommendation.breakEvenProbability ?? null,
    stopLossProbability,
    takeProfitProbability,
    stopLossLoss,
    takeProfitGain,
    riskRewardRatio: dynamicRiskRewardRatio ?? recommendation.riskRewardRatio ?? null,
    isRiskValid,
    riskValidationMessage
  };
}

function buildTradeDraft(event, recommendedMarket, decisionEngine, tradeSuggestion, tradeAmount, existingDraft = null) {
  if (!event?.slug || !recommendedMarket?.conditionId || !decisionEngine?.recommendation || !tradeSuggestion) {
    return null;
  }

  return {
    id: existingDraft?.id ?? null,
    status: existingDraft?.status ?? null,
    input: event.slug,
    eventSlug: event.slug,
    eventTitle: event.title,
    marketSlug: recommendedMarket.slug ?? null,
    conditionId: recommendedMarket.conditionId,
    marketQuestion: decisionEngine.recommendation.marketQuestion,
    outcomeLabel: decisionEngine.recommendation.outcomeLabel,
    action: decisionEngine.action,
    tradeAmount,
    recommendation: decisionEngine.recommendation,
    tradeSuggestion,
    analysis: decisionEngine.rawAnalysis ?? null,
    generatedAt: decisionEngine.generatedAt,
    confirmedAt: existingDraft?.confirmedAt ?? null
  };
}

function estimateTrackedPnl(intent, currentProbability, entryProbability) {
  if (typeof currentProbability !== 'number' || typeof entryProbability !== 'number') {
    return {
      dollars: null,
      percent: null
    };
  }

  const shares = Number.parseFloat(intent?.position?.sharesFilled ?? intent?.executionRequest?.sharesEstimate ?? NaN);

  if (!Number.isFinite(shares) || shares <= 0) {
    return {
      dollars: null,
      percent: null
    };
  }

  const spent = Number.parseFloat(intent?.position?.notionalSpent ?? intent?.tradeAmount ?? NaN);
  const pnlDollars = shares * (currentProbability - entryProbability);
  const pnlPercent = Number.isFinite(spent) && spent > 0 ? pnlDollars / spent : null;

  return {
    dollars: pnlDollars,
    percent: pnlPercent
  };
}

function getSignedMetricTone(value, epsilon = 0.002) {
  if (typeof value !== 'number') {
    return 'ok';
  }

  if (value > epsilon) {
    return 'good';
  }

  if (value < -epsilon) {
    return 'bad';
  }

  return 'ok';
}

function getProbabilityMetricTone(currentProbability, stopLossProbability, takeProfitProbability) {
  if (typeof currentProbability !== 'number') {
    return 'ok';
  }

  if (typeof takeProfitProbability === 'number' && currentProbability >= takeProfitProbability) {
    return 'good';
  }

  if (typeof stopLossProbability === 'number' && currentProbability <= stopLossProbability) {
    return 'bad';
  }

  return 'ok';
}

function getTradeMetricClass(tone) {
  return `trade-metric-card trade-metric-card-${tone}`;
}

function getTrackedEntryProbability(intent) {
  const sharesFilled = Number.parseFloat(intent?.position?.sharesFilled ?? NaN);
  const notionalSpent = Number.parseFloat(intent?.position?.notionalSpent ?? NaN);

  if (Number.isFinite(sharesFilled) && sharesFilled > 0 && Number.isFinite(notionalSpent) && notionalSpent > 0) {
    return notionalSpent / sharesFilled;
  }

  return intent?.monitoring?.entryProbability ?? intent?.executionRequest?.entryProbability ?? null;
}

function replaceIntentInList(intents, nextIntent) {
  return intents.map((intent) => (intent.id === nextIntent.id ? nextIntent : intent));
}

function filterAndSortMarkets(markets, aggregation, statisticalModel, sortBy, filterBy) {
  const enriched = markets.map((market) => ({
    market,
    metrics: getMarketDisplayMetrics(market, aggregation, statisticalModel)
  }));

  const filtered = enriched.filter(({ metrics }) => {
    if (filterBy === 'positive-edge') {
      return typeof metrics.modelEdge === 'number' && metrics.modelEdge > 0;
    }

    if (filterBy === 'high-confidence') {
      return typeof metrics.confidence === 'number' && metrics.confidence >= 0.55;
    }

    if (filterBy === 'positive-momentum') {
      return typeof metrics.momentum === 'number' && metrics.momentum > 0;
    }

    return true;
  });

  const sorted = filtered.sort((left, right) => {
    const getValue = (candidate) => candidate.metrics[sortBy];
    const leftValue = typeof getValue(left) === 'number' ? getValue(left) : -Infinity;
    const rightValue = typeof getValue(right) === 'number' ? getValue(right) : -Infinity;

    return rightValue - leftValue;
  });

  return sorted;
}

function buildSparklinePath(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return '';
  }

  const prices = history.map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = maxPrice - minPrice || 1;

  return history
    .map((point, index) => {
      const x = history.length === 1 ? 50 : (index / (history.length - 1)) * 100;
      const y = 100 - ((point.price - minPrice) / range) * 100;

      return `${x},${y}`;
    })
    .join(' ');
}

function buildTrackedProbabilityPoint(intent, fallbackTimestamp = new Date().toISOString()) {
  const price = intent?.monitoring?.currentProbability;

  if (typeof price !== 'number' || Number.isNaN(price)) {
    return null;
  }

  return {
    price,
    timestamp: intent?.monitoring?.lastPolymarketQuoteAt ?? intent?.monitoring?.lastEvaluationAt ?? fallbackTimestamp,
    monitoringState: intent?.monitoring?.state ?? 'active'
  };
}

function mergeTrackedProbabilityHistory(previousHistoryByIntent, intents) {
  const nextHistoryByIntent = {};
  let hasChanged = false;

  for (const intent of intents) {
    if (intent?.status !== 'tracking') {
      continue;
    }

    const previousHistory = Array.isArray(previousHistoryByIntent[intent.id])
      ? previousHistoryByIntent[intent.id]
      : [];
    const nextPoint = buildTrackedProbabilityPoint(intent);

    if (!nextPoint) {
      nextHistoryByIntent[intent.id] = previousHistory;
      continue;
    }

    const lastPoint = previousHistory[previousHistory.length - 1] ?? null;
    const isDuplicatePoint = lastPoint
      && lastPoint.timestamp === nextPoint.timestamp
      && lastPoint.price === nextPoint.price
      && lastPoint.monitoringState === nextPoint.monitoringState;

    if (isDuplicatePoint) {
      nextHistoryByIntent[intent.id] = previousHistory;
      continue;
    }

    const nextHistory = [...previousHistory, nextPoint].slice(-TRACKED_PROBABILITY_HISTORY_LIMIT);
    nextHistoryByIntent[intent.id] = nextHistory;
    hasChanged = true;
  }

  const previousIds = Object.keys(previousHistoryByIntent);

  if (previousIds.length !== Object.keys(nextHistoryByIntent).length) {
    hasChanged = true;
  }

  return hasChanged ? nextHistoryByIntent : previousHistoryByIntent;
}

function getProbabilityChartBounds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return null;
  }

  const range = maxValue - minValue;

  if (range < 0.08) {
    const midpoint = (maxValue + minValue) / 2;
    minValue = midpoint - 0.04;
    maxValue = midpoint + 0.04;
  } else {
    const padding = range * 0.18;
    minValue -= padding;
    maxValue += padding;
  }

  minValue = Math.max(0, minValue);
  maxValue = Math.min(1, maxValue);

  if (maxValue - minValue < 0.04) {
    if (maxValue >= 1) {
      minValue = Math.max(0, maxValue - 0.04);
    } else {
      maxValue = Math.min(1, minValue + 0.04);
    }
  }

  return { minValue, maxValue };
}

function getProbabilityChartY(value, bounds) {
  if (typeof value !== 'number' || !bounds) {
    return 50;
  }

  const range = bounds.maxValue - bounds.minValue || 1;
  return 100 - ((value - bounds.minValue) / range) * 100;
}

function getProbabilityChartStep(range) {
  if (range <= 0.2) {
    return 0.05;
  }

  if (range <= 0.45) {
    return 0.1;
  }

  if (range <= 0.75) {
    return 0.15;
  }

  return 0.2;
}

function getRoundedProbabilityChartBounds(bounds) {
  if (!bounds) {
    return null;
  }

  const rawRange = Math.max(0.04, bounds.maxValue - bounds.minValue);
  const step = getProbabilityChartStep(rawRange);
  let minValue = Math.floor(bounds.minValue / step) * step;
  let maxValue = Math.ceil(bounds.maxValue / step) * step;

  minValue = Math.max(0, Number(minValue.toFixed(4)));
  maxValue = Math.min(1, Number(maxValue.toFixed(4)));

  if (maxValue - minValue < step * 2) {
    if (maxValue >= 1) {
      minValue = Math.max(0, Number((maxValue - step * 2).toFixed(4)));
    } else {
      maxValue = Math.min(1, Number((minValue + step * 2).toFixed(4)));
    }
  }

  return {
    minValue,
    maxValue,
    step
  };
}

function getProbabilityChartTicks(bounds) {
  if (!bounds || typeof bounds.step !== 'number' || bounds.step <= 0) {
    return [];
  }

  const ticks = [];

  for (let value = bounds.minValue; value <= bounds.maxValue + bounds.step / 2; value += bounds.step) {
    ticks.push(Number(value.toFixed(4)));
  }

  return ticks;
}

function buildSmoothLinePath(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    const [point] = points;
    return `M ${point.x} ${point.y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midX = (current.x + next.x) / 2;

    path += ` Q ${current.x} ${current.y} ${midX} ${((current.y + next.y) / 2)}`;
  }

  const lastPoint = points[points.length - 1];
  path += ` T ${lastPoint.x} ${lastPoint.y}`;

  return path;
}

function buildChartAreaPath(points, baselineY) {
  if (!Array.isArray(points) || points.length === 0) {
    return '';
  }

  const linePath = buildSmoothLinePath(points);
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  return `${linePath} L ${lastPoint.x} ${baselineY} L ${firstPoint.x} ${baselineY} Z`;
}

function TrackingProbabilityChart({
  history,
  currentProbability,
  entryProbability,
  stopLossProbability,
  takeProfitProbability,
  monitoringState,
  lastQuoteAt
}) {
  const baseHistory = Array.isArray(history)
    ? history
      .filter((point) => typeof point?.price === 'number')
      .map((point) => ({
        ...point,
        timestampMs: getTimestampMs(point.timestamp)
      }))
      .filter((point) => point.timestampMs !== null)
    : [];
  const fallbackTimestampMs = getTimestampMs(lastQuoteAt) ?? Date.now();
  const seededHistory = baseHistory.length > 0
    ? baseHistory
    : typeof currentProbability === 'number'
      ? [{ price: currentProbability, timestamp: lastQuoteAt ?? null, timestampMs: fallbackTimestampMs, monitoringState }]
      : [];
  const latestTimestampMs = seededHistory[seededHistory.length - 1]?.timestampMs ?? fallbackTimestampMs;
  const windowStartMs = latestTimestampMs - TRACKED_PROBABILITY_WINDOW_MS;
  const filteredWindowHistory = seededHistory.filter((point) => point.timestampMs >= windowStartMs);
  const leadingPoint = seededHistory
    .filter((point) => point.timestampMs < windowStartMs)
    .at(-1);
  const chartHistory = leadingPoint
    ? [leadingPoint, ...filteredWindowHistory]
    : filteredWindowHistory;
  const plotArea = {
    left: 4,
    right: 156,
    top: 8,
    bottom: 82
  };
  const viewBox = {
    width: 160,
    height: 100
  };

  if (chartHistory.length === 0) {
    return <div className="sparkline-empty tracking-chart-empty">No live probability history yet.</div>;
  }

  const bounds = {
    minValue: 0,
    maxValue: 1,
    step: 0.2
  };
  const ticks = getProbabilityChartTicks(bounds);
  const displayTicks = [...ticks].reverse();
  const plotWidth = plotArea.right - plotArea.left;
  const plotHeight = plotArea.bottom - plotArea.top;
  const xAxisInsetStyle = {
    paddingLeft: `${(plotArea.left / viewBox.width) * 100}%`,
    paddingRight: `${Math.max(0, ((viewBox.width - plotArea.right) / viewBox.width) * 100)}%`
  };

  const getPlotY = (value) => {
    if (typeof value !== 'number' || !bounds) {
      return plotArea.top + plotHeight / 2;
    }

    const range = bounds.maxValue - bounds.minValue || 1;
    return plotArea.bottom - (((value - bounds.minValue) / range) * plotHeight);
  };

  const chartPoints = chartHistory.map((point, index) => ({
    x: chartHistory.length === 1
      ? plotArea.right
      : Math.max(
          plotArea.left,
          Math.min(plotArea.right, plotArea.left + (((point.timestampMs - windowStartMs) / TRACKED_PROBABILITY_WINDOW_MS) * plotWidth))
        ),
    y: getPlotY(point.price),
    price: point.price,
    timestamp: point.timestamp,
    timestampMs: point.timestampMs,
    key: `${point.timestampMs}-${index}`
  }));
  const latestPoint = chartPoints[chartPoints.length - 1] ?? null;
  const isSelling = monitoringState === 'exit-submitted-awaiting-fill';
  const linePath = buildSmoothLinePath(chartPoints);
  const areaPath = buildChartAreaPath(chartPoints, plotArea.bottom);
  const timeTicks = Array.from({ length: 6 }, (_, index) => {
    const timestampMs = windowStartMs + ((TRACKED_PROBABILITY_WINDOW_MS / 5) * index);
    const x = plotArea.left + ((index / 5) * plotWidth);

    return {
      timestampMs,
      x,
      label: formatChartTime(timestampMs)
    };
  });
  const referenceLines = [
    {
      key: 'entry',
      label: 'Entry',
      value: entryProbability,
      className: 'tracking-chart-threshold-entry'
    },
    {
      key: 'stop',
      label: 'Stop Exit',
      value: stopLossProbability,
      className: 'tracking-chart-threshold-stop'
    },
    {
      key: 'take',
      label: 'Take Exit',
      value: takeProfitProbability,
      className: 'tracking-chart-threshold-take'
    }
  ].filter((line) => typeof line.value === 'number');

  return (
    <div className="tracking-chart-shell">
      <div className="tracking-chart-header">
        <div>
          <span className="eyebrow">Last 5 Minutes</span>
          <strong>{formatPercent(currentProbability)}</strong>
        </div>
        <span className="tracking-chart-meta">{chartPoints.length} pts · newest {formatRelativeAge(lastQuoteAt)}</span>
      </div>
      <div className="tracking-chart-frame">
        <svg
          className="tracking-chart"
          viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="tracking-chart-area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(31, 181, 255, 0.18)" />
              <stop offset="100%" stopColor="rgba(31, 181, 255, 0.01)" />
            </linearGradient>
          </defs>
          {timeTicks.map((tick) => (
            <line
              key={`time-grid-${tick.timestampMs}`}
              className="tracking-chart-time-line"
              x1={tick.x}
              y1={plotArea.top}
              x2={tick.x}
              y2={plotArea.bottom}
            />
          ))}
          {ticks.map((tick) => {
            const y = getPlotY(tick);

            return (
              <line
                key={`tick-${tick}`}
                className="tracking-chart-grid-line"
                x1={plotArea.left}
                y1={y}
                x2={plotArea.right}
                y2={y}
              />
            );
          })}
          {areaPath ? <path d={areaPath} className="tracking-chart-area" /> : null}
          {referenceLines.map((line) => {
            const y = getPlotY(line.value);

            return (
              <line
                key={line.key}
                className={`tracking-chart-threshold ${line.className}`}
                x1={plotArea.left}
                y1={y}
                x2={plotArea.right}
                y2={y}
              />
            );
          })}
          {linePath ? (
            <path
              d={linePath}
              className={isSelling ? 'tracking-chart-current-line tracking-chart-current-line-selling' : 'tracking-chart-current-line'}
            />
          ) : null}
          {latestPoint ? <circle className="tracking-chart-current-dot" cx={latestPoint.x} cy={latestPoint.y} r="1.8" /> : null}
        </svg>
        <div className="tracking-chart-axis tracking-chart-axis-y" aria-hidden="true">
          {displayTicks.map((tick) => (
            <span key={`axis-y-${tick}`} className="tracking-chart-axis-label-y">
              {formatPercent(tick)}
            </span>
          ))}
        </div>
        <div className="tracking-chart-axis tracking-chart-axis-x" aria-hidden="true" style={xAxisInsetStyle}>
          {timeTicks.map((tick) => (
            <span key={`axis-x-${tick.timestampMs}`} className="tracking-chart-axis-label-x">
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="tracking-chart-legend">
        {referenceLines.map((line) => (
          <span key={line.key} className="tracking-chart-legend-item">
            <span className={`tracking-chart-legend-swatch ${line.className}`} aria-hidden="true" />
            {line.label} {formatPercent(line.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function OutcomeSparkline({ history, className = 'sparkline' }) {
  const path = buildSparklinePath(history);

  if (!path) {
    return <div className="sparkline-empty">No history</div>;
  }

  return (
    <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} className="sparkline-line" />
    </svg>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [activeEvents, setActiveEvents] = useState([]);
  const [scannerSnapshot, setScannerSnapshot] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [aggregation, setAggregation] = useState(null);
  const [statisticalModel, setStatisticalModel] = useState(null);
  const [decisionEngine, setDecisionEngine] = useState(null);
  const [selectedMarketId, setSelectedMarketId] = useState(null);
  const [eventInput, setEventInput] = useState('');
  const [sortBy, setSortBy] = useState('modelEdge');
  const [filterBy, setFilterBy] = useState('all');
  const [tradeAmount, setTradeAmount] = useState('100');
  const [riskInputs, setRiskInputs] = useState({ stopLossProbability: '', takeProfitProbability: '' });
  const [tradeDraft, setTradeDraft] = useState(null);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [isTradeModalOpen, setIsTradeModalOpen] = useState(false);
  const [analysis, setAnalysis] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [liveClock, setLiveClock] = useState(() => new Date());
  const [lastMarketUpdate, setLastMarketUpdate] = useState(null);
  const [lastAiUpdate, setLastAiUpdate] = useState(null);
  const [lastTradeUpdate, setLastTradeUpdate] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isInvalidating, setIsInvalidating] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSavingTradeIntent, setIsSavingTradeIntent] = useState(false);
  const [isMutatingHistory, setIsMutatingHistory] = useState(false);
  const [isPollingTracking, setIsPollingTracking] = useState(false);
  const [tradeCenterFilter, setTradeCenterFilter] = useState('tracking');
  const [editingActiveTradeId, setEditingActiveTradeId] = useState(null);
  const [activeTradeRiskInputs, setActiveTradeRiskInputs] = useState({});
  const [trackedProbabilityHistory, setTrackedProbabilityHistory] = useState({});
  const [hasLoadedInitialData, setHasLoadedInitialData] = useState(false);
  const [isPending, startTransition] = useTransition();
  const tradableMarkets = selectedEvent?.markets ?? [];
  const visibleMarkets = tradableMarkets.filter(marketHasLivePrices);
  const rankedMarkets = filterAndSortMarkets(visibleMarkets, aggregation, statisticalModel, sortBy, filterBy);
  const selectedMarket = visibleMarkets.find((market) => market.conditionId === selectedMarketId) ?? rankedMarkets[0]?.market ?? null;
  const selectedHistoricalMarket = selectedMarket ? findHistoricalMarket(aggregation, selectedMarket.conditionId) : null;
  const selectedModelMarket = selectedMarket ? getModelMarket(statisticalModel, selectedMarket.conditionId) : null;
  const recommendedMarket = getRecommendedMarket(selectedEvent, decisionEngine);
  const tradeSuggestion = buildTradeSuggestion(decisionEngine, tradeAmount, riskInputs);
  const activeTradeIntents = tradeHistory.filter((intent) => intent.status === 'tracking');
  const latestPolymarketQuoteAt = activeTradeIntents
    .map((intent) => intent?.monitoring?.lastPolymarketQuoteAt)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
  const opportunityBoard = scannerSnapshot?.opportunities ?? [];
  const scannerLastUpdatedAge = formatRelativeAge(scannerSnapshot?.generatedAt, liveClock);
  const filteredTradeHistory = tradeHistory.filter((intent) => {
    if (tradeCenterFilter === 'tracking') {
      return intent.status === 'tracking';
    }

    if (tradeCenterFilter === 'draft') {
      return isDraftTradeIntent(intent);
    }

    if (tradeCenterFilter === 'closed') {
      return intent.status === 'closed';
    }

    return isDraftTradeIntent(intent);
  });
  const editingActiveTrade = editingActiveTradeId
    ? tradeHistory.find((intent) => intent.id === editingActiveTradeId) ?? null
    : null;
  const lastPolledAge = formatRelativeAge(lastTradeUpdate, liveClock);
  const selectedLeader = selectedMarket ? getMarketLeader(selectedMarket) : null;
  const marketControlsOutcomes = Array.isArray(selectedMarket?.outcomes)
    ? sortOutcomes(selectedMarket.outcomes).filter((outcome) => typeof outcome?.probability === 'number')
    : [];
  const currentRecommendation = decisionEngine?.recommendation ?? null;
  const recommendationHeadline = formatRecommendationHeadline(currentRecommendation);
  const recommendationActionLabel = formatRecommendationActionLabel(decisionEngine?.action, currentRecommendation?.outcomeLabel);
  const recommendationExpectedValue = resolveRecommendationExpectedValue(currentRecommendation);
  const parsedOperatorNotes = parseOperatorNotes(analysis);
  const selectedSportsProbabilityBreakdown = getSportsProbabilityBreakdown(selectedMarket, selectedModelMarket);
  const recommendedModelMarket = recommendedMarket ? getModelMarket(statisticalModel, recommendedMarket.conditionId) : null;
  const recommendedSportsOutcome = currentRecommendation
    ? getSportsMarketOutcome(recommendedModelMarket, currentRecommendation.outcomeLabel)
    : null;
  const recommendedModelOutcome = currentRecommendation
    ? getModelOutcome(recommendedModelMarket, currentRecommendation.outcomeLabel)
    : null;
  const eventSportsLeagues = getSportsLeagues(statisticalModel);
  const recommendationSource = getRecommendationSource(recommendedModelMarket);
  const recommendedStarterContext = getRecommendedStarterContext(recommendedModelMarket);
  const eventIntelligence = getEventIntelligenceSummary(aggregation);
  const statusPopup = error
    ? { kind: 'error', message: error, dismiss: () => setError('') }
    : notice
      ? { kind: 'notice', message: notice, dismiss: () => setNotice('') }
      : null;

  useEffect(() => {
    setTrackedProbabilityHistory((previousHistoryByIntent) => mergeTrackedProbabilityHistory(previousHistoryByIntent, tradeHistory));
  }, [tradeHistory]);

  useEffect(() => {
    if (!statusPopup) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      statusPopup.dismiss();
    }, 5000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [statusPopup?.kind, statusPopup?.message]);

  function clearSelectedEventContext() {
    setSelectedEvent(null);
    setAggregation(null);
    setStatisticalModel(null);
    setDecisionEngine(null);
    setAnalysis('');
    setSelectedMarketId(null);
    setEventInput('');
    setTradeDraft(null);
    setRiskInputs({ stopLossProbability: '', takeProfitProbability: '' });
    setIsTradeModalOpen(false);
  }

  function handleClearSelectedEvent() {
    setError('');
    setNotice('');
    clearSelectedEventContext();
  }

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setLiveClock(new Date());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  function syncTradeDraftFromHistory(intents) {
    if (!tradeDraft?.id) {
      return;
    }

    const matchingIntent = intents.find((intent) => intent.id === tradeDraft.id) ?? null;

    if (matchingIntent && isRestorableDraft(matchingIntent)) {
      setTradeDraft(matchingIntent);
      saveStoredTradeDraft(matchingIntent);
      return;
    }

    clearStoredTradeDraft();
    setTradeDraft(null);
  }

  async function refreshTradeHistory() {
    const intents = await fetchTradeIntents(6);
    setTradeHistory(intents);
    syncTradeDraftFromHistory(intents);
    return intents;
  }

  function applyAuthoritativeTradeHistory(intents) {
    const nextIntents = Array.isArray(intents) ? intents.slice(0, 6) : [];
    setTradeHistory(nextIntents);
    syncTradeDraftFromHistory(nextIntents);
    return nextIntents;
  }

  async function applyStoredTradeDraft(storedDraft, successMessage = null) {
    const [event, analytics] = await Promise.all([
      resolveEvent(storedDraft.input),
      resolveEventAggregation(storedDraft.input)
    ]);

    setEventInput(storedDraft.input);
    setSelectedEvent(event);
    setAggregation(analytics.aggregation ?? null);
    setStatisticalModel(analytics.statisticalModel ?? null);
    setDecisionEngine(storedDraft.action && storedDraft.recommendation
      ? {
          action: storedDraft.action,
          recommendation: storedDraft.recommendation,
          rawAnalysis: storedDraft.analysis,
          generatedAt: storedDraft.generatedAt
        }
      : null);
    setTradeAmount(storedDraft.tradeAmount ?? '100');
    setRiskInputs({
      stopLossProbability:
        typeof storedDraft.tradeSuggestion?.stopLossProbability === 'number'
          ? String(storedDraft.tradeSuggestion.stopLossProbability)
          : '',
      takeProfitProbability:
        typeof storedDraft.tradeSuggestion?.takeProfitProbability === 'number'
          ? String(storedDraft.tradeSuggestion.takeProfitProbability)
          : ''
    });
    setTradeDraft(storedDraft);

    const matchingMarket = event.markets.find((market) => market.conditionId === storedDraft.conditionId);
    const fallbackMarket = event.markets.filter(marketHasLivePrices)[0] ?? null;
    setSelectedMarketId(matchingMarket?.conditionId ?? fallbackMarket?.conditionId ?? null);
    if (typeof successMessage === 'string' && successMessage.length > 0) {
      setNotice(successMessage);
    }
  }

  useEffect(() => {
    if (!hasLoadedInitialData) {
      return;
    }

    if (activeTradeIntents.length > 0) {
      clearStoredTradeDraft();
      return;
    }

    const storedDraft = loadStoredTradeDraft();

    if (!storedDraft?.input || !isRestorableDraft(storedDraft)) {
      if (storedDraft) {
        clearStoredTradeDraft();
      }
      return;
    }

    let isCancelled = false;

    async function restoreDraft() {
      try {
        if (isCancelled) {
          return;
        }

        await applyStoredTradeDraft(storedDraft);
      } catch {
        clearStoredTradeDraft();
      }
    }

    void restoreDraft();

    return () => {
      isCancelled = true;
    };
  }, [hasLoadedInitialData, activeTradeIntents.length]);

  useEffect(() => {
    const nextDraft = buildTradeDraft(
      selectedEvent,
      recommendedMarket,
      decisionEngine,
      tradeSuggestion,
      tradeAmount,
      tradeDraft
    );

    if (!nextDraft) {
      return;
    }

    setTradeDraft(nextDraft);
    saveStoredTradeDraft(nextDraft);
  }, [selectedEvent, recommendedMarket, decisionEngine, tradeSuggestion, tradeAmount, tradeDraft?.confirmedAt]);

  useEffect(() => {
    if (!decisionEngine?.recommendation) {
      return;
    }

    const matchingSavedDraft = tradeDraft
      && tradeDraft.marketQuestion === decisionEngine.recommendation.marketQuestion
      && tradeDraft.outcomeLabel === decisionEngine.recommendation.outcomeLabel
      ? tradeDraft
      : null;

    setRiskInputs({
      stopLossProbability:
        typeof matchingSavedDraft?.tradeSuggestion?.stopLossProbability === 'number'
          ? String(matchingSavedDraft.tradeSuggestion.stopLossProbability)
          : typeof decisionEngine.recommendation.stopLossProbability === 'number'
          ? String(decisionEngine.recommendation.stopLossProbability)
          : '',
      takeProfitProbability:
        typeof matchingSavedDraft?.tradeSuggestion?.takeProfitProbability === 'number'
          ? String(matchingSavedDraft.tradeSuggestion.takeProfitProbability)
          : typeof decisionEngine.recommendation.takeProfitProbability === 'number'
          ? String(decisionEngine.recommendation.takeProfitProbability)
          : ''
    });
  }, [
    tradeDraft?.id,
    decisionEngine?.recommendation?.marketQuestion,
    decisionEngine?.recommendation?.outcomeLabel,
    decisionEngine?.recommendation?.stopLossProbability,
    decisionEngine?.recommendation?.takeProfitProbability
  ]);

  useEffect(() => {
    let isCancelled = false;

    async function loadInitialData() {
      try {
        const [nextStatus, nextEvents, nextTradeHistory, nextScannerSnapshot] = await Promise.all([
          fetchStatus(),
          fetchActiveEvents(5),
          fetchTradeIntents(6),
          fetchOpportunityScanner()
        ]);

        if (isCancelled) {
          return;
        }

        setStatus(nextStatus);
        setActiveEvents(nextEvents);
        setTradeHistory(nextTradeHistory);
        setScannerSnapshot(nextScannerSnapshot);
        setLastMarketUpdate(new Date().toISOString());
        setLastTradeUpdate(new Date().toISOString());
        setNotice('');
      } catch (loadError) {
        if (!isCancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load initial data');
        }
      } finally {
        if (!isCancelled) {
          setHasLoadedInitialData(true);
        }
      }
    }

    loadInitialData();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedInitialData) {
      return undefined;
    }

    let isCancelled = false;
    let isFetching = false;

    const intervalId = window.setInterval(() => {
      void (async () => {
        if (isFetching || isCancelled) {
          return;
        }

        isFetching = true;

        try {
          const nextStatus = await fetchStatus();

          if (!isCancelled) {
            setStatus(nextStatus);
          }
        } catch {
          // Ignore background status refresh failures and keep the last known header values.
        } finally {
          isFetching = false;
        }
      })();
    }, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [hasLoadedInitialData]);

  useEffect(() => {
    if (!hasLoadedInitialData) {
      return undefined;
    }

    let isCancelled = false;
    let isFetching = false;

    const intervalId = window.setInterval(() => {
      void (async () => {
        if (isFetching || isCancelled) {
          return;
        }

        isFetching = true;

        try {
          const nextScannerSnapshot = await fetchOpportunityScanner();

          if (!isCancelled) {
            setScannerSnapshot(nextScannerSnapshot);
          }
        } catch {
          // Keep the last known board snapshot during background refresh failures.
        } finally {
          isFetching = false;
        }
      })();
    }, 120000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [hasLoadedInitialData]);

  useEffect(() => {
    if (activeTradeIntents.length === 0) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          const [polledTradeIntents, nextStatus] = await Promise.all([
            pollTrackedTradeIntents(),
            fetchStatus()
          ]);
          applyAuthoritativeTradeHistory(polledTradeIntents);
          setStatus(nextStatus);
          setLastMarketUpdate(new Date().toISOString());
          setLastTradeUpdate(new Date().toISOString());
        } catch {
          // Ignore background polling failures and keep the last known state in the UI.
        }
      })();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeTradeIntents.map((intent) => intent.id).join('|')]);

  async function handleResolveEvent(submittedInput, options = {}) {
    setError('');
    setNotice('');
    setAnalysis('');
    setDecisionEngine(null);
    setTradeDraft(null);
    setRiskInputs({ stopLossProbability: '', takeProfitProbability: '' });
    setIsTradeModalOpen(false);

    try {
      const [event, analytics] = await Promise.all([
        resolveEvent(submittedInput),
        resolveEventAggregation(submittedInput)
      ]);

      const validationError = getEventValidationError(event);

      if (validationError) {
        setSelectedEvent(null);
        setAggregation(null);
        setStatisticalModel(null);
        setSelectedMarketId(null);
        setError(validationError);
        return;
      }

      setSelectedEvent(event);
      setAggregation(analytics.aggregation ?? null);
      setStatisticalModel(analytics.statisticalModel ?? null);
      const liveMarkets = event.markets.filter(marketHasLivePrices);
      const preferredMarket = liveMarkets.find((market) => market.conditionId === options.preferredConditionId) ?? null;
      setSelectedMarketId(preferredMarket?.conditionId ?? liveMarkets[0]?.conditionId ?? null);
      setEventInput(submittedInput);
      setLastMarketUpdate(new Date().toISOString());
    } catch (resolveError) {
      setSelectedEvent(null);
      setAggregation(null);
      setStatisticalModel(null);
      setSelectedMarketId(null);
      setError(resolveError instanceof Error ? resolveError.message : 'Unable to resolve event');
    }
  }

  function handleSubmit(formEvent) {
    formEvent.preventDefault();

    if (!eventInput.trim()) {
      setError('Paste a Polymarket event URL or slug.');
      return;
    }

    startTransition(() => {
      void handleAnalyze();
    });
  }

  function handleUseEvent(slug) {
    startTransition(() => {
      void handleResolveEvent(slug);
    });
  }

  function handleUseScannerOpportunity(opportunity) {
    startTransition(() => {
      void (async () => {
        await handleResolveEvent(opportunity.eventSlug, {
          preferredConditionId: opportunity.conditionId
        });
        setNotice(`Loaded ${opportunity.outcomeLabel} in ${opportunity.marketQuestion}.`);
      })();
    });
  }

  async function handleAnalyze(options = {}) {
    const submittedInput = eventInput.trim();

    if (!submittedInput) {
      setError('Paste a Polymarket event URL or slug.');
      return;
    }

    setError('');
    setNotice('');
    setIsAnalyzing(true);

    try {
      const result = await analyzeEvent(submittedInput, options);
      const nextEvent = result.event ?? selectedEvent;
      const validationError = getEventValidationError(nextEvent);

      if (validationError) {
        setSelectedEvent(null);
        setAggregation(null);
        setStatisticalModel(null);
        setSelectedMarketId(null);
        setError(validationError);
        return;
      }

      setSelectedEvent(nextEvent);
      setAggregation(result.aggregation ?? null);
      setStatisticalModel(result.statisticalModel ?? null);
      setAnalysis(result.analysis);
      setDecisionEngine(result.decisionEngine ?? null);
      const currentSelection = nextEvent?.markets?.find((market) => market.conditionId === selectedMarketId);
      const fallbackSelection = nextEvent?.markets?.filter(marketHasLivePrices)[0] ?? null;
      setSelectedMarketId(currentSelection?.conditionId ?? fallbackSelection?.conditionId ?? null);
      setEventInput(nextEvent?.slug ?? submittedInput);
      setLastMarketUpdate(new Date().toISOString());
      setLastAiUpdate(new Date().toISOString());
      const sportsNotice = result.sportsSync?.updated
        ? ` Synced ${result.sportsSync.league} ${result.sportsSync.season ?? ''} history.`.trim()
        : '';
      setNotice(
        `${options.refresh ? 'Refreshed analytics and reran the decision engine.' : 'AI analysis updated.'}${sportsNotice ? ` ${sportsNotice}` : ''}`
      );
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'Unable to run AI analysis');
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleRefreshData() {
    if (!eventInput.trim()) {
      setError('Load an event before refreshing analytics.');
      return;
    }

    setError('');
    setNotice('');
    setIsRefreshing(true);

    try {
      const [event, analytics] = await Promise.all([
        resolveEvent(eventInput.trim()),
        resolveEventAggregation(eventInput.trim(), { refresh: true })
      ]);

      const validationError = getEventValidationError(event);

      if (validationError) {
        setSelectedEvent(null);
        setAggregation(null);
        setStatisticalModel(null);
        setSelectedMarketId(null);
        setError(validationError);
        return;
      }

      setSelectedEvent(event);
      setAggregation(analytics.aggregation ?? null);
      setStatisticalModel(analytics.statisticalModel ?? null);

      const currentSelection = event.markets.find((market) => market.conditionId === selectedMarketId);
      const fallbackSelection = event.markets.filter(marketHasLivePrices)[0] ?? null;
      setSelectedMarketId(currentSelection?.conditionId ?? fallbackSelection?.conditionId ?? null);

      if (decisionEngine || analysis) {
        const result = await analyzeEvent(event.slug, { refresh: true });
        setAnalysis(result.analysis);
        setDecisionEngine(result.decisionEngine ?? null);
        setLastAiUpdate(new Date().toISOString());
      } else {
        setAnalysis('');
        setDecisionEngine(null);
      }

      setLastMarketUpdate(new Date().toISOString());
      setNotice('Market data refreshed from source.');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh analytics');
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleInvalidateCache(scope) {
    setError('');
    setNotice('');
    setIsInvalidating(true);

    try {
      await invalidateEventAggregationCache(scope === 'all' ? null : eventInput.trim() || null);
      setLastMarketUpdate(new Date().toISOString());
      setNotice(scope === 'all' ? 'Cleared the full analytics cache.' : 'Cleared the current event analytics cache.');
    } catch (invalidateError) {
      setError(invalidateError instanceof Error ? invalidateError.message : 'Unable to invalidate analytics cache');
    } finally {
      setIsInvalidating(false);
    }
  }

  async function handleRestoreTradeIntent(intent) {
    setError('');
    setNotice('');

    try {
      await applyStoredTradeDraft(intent, 'Loaded saved trade intent.');
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Unable to restore trade intent');
    }
  }

  async function handleDeleteTradeIntent(intentId) {
    setError('');
    setNotice('');
    setIsMutatingHistory(true);

    try {
      await deleteTradeIntentRequest(intentId);
      setTradeHistory((previous) => previous.filter((intent) => intent.id !== intentId));
      setLastTradeUpdate(new Date().toISOString());

      if (tradeDraft?.id === intentId) {
        handleClearTradeDraft();
      } else {
        setNotice('Deleted saved trade intent.');
      }
    } catch (deleteError) {
      if (isTradeIntentNotFoundError(deleteError)) {
        await refreshTradeHistory();

        if (tradeDraft?.id === intentId) {
          handleClearTradeDraft();
        }

        setNotice('That trade intent no longer exists. Refreshed history.');
      } else {
        setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete trade intent');
      }
    } finally {
      setIsMutatingHistory(false);
    }
  }

  async function handlePollActivePositions() {
    setError('');
    setNotice('');
    setIsPollingTracking(true);

    try {
      const polledTradeIntents = await pollTrackedTradeIntents();
      const nextHistory = applyAuthoritativeTradeHistory(polledTradeIntents);
      const nextStatus = await fetchStatus();
      setStatus(nextStatus);
      setLastMarketUpdate(new Date().toISOString());
      setLastTradeUpdate(new Date().toISOString());
      const stillTracking = nextHistory.filter((intent) => intent.status === 'tracking').length;
      setNotice(stillTracking > 0 ? 'Updated active positions from live market probabilities.' : 'Polling completed and no active tracked positions remain.');
    } catch (pollError) {
      setError(pollError instanceof Error ? pollError.message : 'Unable to poll active positions');
    } finally {
      setIsPollingTracking(false);
    }
  }

  async function handleSellTrackedIntent(intent) {
    setError('');
    setNotice('');
    setIsMutatingHistory(true);

    try {
      const nextIntent = await sellTradeIntentRequest(intent.id);
      setTradeHistory((previous) => replaceIntentInList(previous, nextIntent));
      const nextStatus = await fetchStatus();
      setStatus(nextStatus);
      setLastTradeUpdate(new Date().toISOString());
      setLastMarketUpdate(new Date().toISOString());

      if (tradeDraft?.id === nextIntent.id) {
        setTradeDraft(nextIntent);
        saveStoredTradeDraft(nextIntent);
      }

      setNotice(
        nextIntent.status === 'closed'
          ? 'Position sold and closed successfully.'
          : 'Cash out submitted to Polymarket US. Trade stays active until the venue confirms the full close.'
      );
    } catch (sellError) {
      if (isTradeIntentNotFoundError(sellError)) {
        await refreshTradeHistory();

        if (tradeDraft?.id === intent.id) {
          handleClearTradeDraft();
        }

        setNotice('That trade intent no longer exists. Refreshed history.');
      } else {
        setError(sellError instanceof Error ? sellError.message : 'Unable to sell position');
      }
    } finally {
      setIsMutatingHistory(false);
    }
  }

  function handleStartEditingActiveTrade(intent) {
    setError('');
    setNotice('');
    setEditingActiveTradeId(intent.id);
    setActiveTradeRiskInputs((previous) => ({
      ...previous,
      [intent.id]: {
        stopLossProbability:
          typeof intent.tradeSuggestion?.stopLossProbability === 'number'
            ? String(intent.tradeSuggestion.stopLossProbability)
            : '',
        takeProfitProbability:
          typeof intent.tradeSuggestion?.takeProfitProbability === 'number'
            ? String(intent.tradeSuggestion.takeProfitProbability)
            : ''
      }
    }));
  }

  function handleCancelEditingActiveTrade() {
    setEditingActiveTradeId(null);
  }

  function handleActiveTradeRiskInputChange(intentId, field, value) {
    setActiveTradeRiskInputs((previous) => ({
      ...previous,
      [intentId]: {
        ...previous[intentId],
        [field]: value
      }
    }));
  }

  async function handleSaveActiveTradeRisk(intent) {
    const draft = activeTradeRiskInputs[intent.id] ?? {};
    const stopLossProbability = Number.parseFloat(draft.stopLossProbability);
    const takeProfitProbability = Number.parseFloat(draft.takeProfitProbability);

    if (!isValidProbabilityRange(stopLossProbability, takeProfitProbability)) {
      setError('Stop-loss must be below take-profit, greater than 0, and take-profit must be below 1.');
      return;
    }

    setError('');
    setNotice('');
    setIsMutatingHistory(true);

    try {
      const nextIntent = await updateTradeIntentRequest(intent.id, {
        tradeSuggestion: {
          stopLossProbability,
          takeProfitProbability
        }
      });

      setTradeHistory((previous) => replaceIntentInList(previous, nextIntent));
      setLastTradeUpdate(new Date().toISOString());
      setEditingActiveTradeId(null);
      setNotice('Updated active trade stop-loss and take-profit targets.');
    } catch (updateError) {
      if (isTradeIntentNotFoundError(updateError)) {
        await refreshTradeHistory();
        setEditingActiveTradeId(null);
        setNotice('That trade intent no longer exists. Refreshed history.');
      } else {
        setError(updateError instanceof Error ? updateError.message : 'Unable to update active trade targets');
      }
    } finally {
      setIsMutatingHistory(false);
    }
  }

  async function handleExecuteTradeIntent(intent) {
    setError('');
    setNotice('');

    if (!intent.confirmedAt) {
      setError('Confirm and save this trade intent before starting live trading.');
      return;
    }

    if (!intent.marketSlug) {
      setError('This intent is missing a market slug. Open Intent, save changes, and try again.');
      return;
    }

    setIsMutatingHistory(true);

    try {
      const nextIntent = await executeTradeIntentRequest(intent.id);
      setTradeHistory((previous) => replaceIntentInList(previous, nextIntent));
      const nextStatus = await fetchStatus();
      setStatus(nextStatus);
      setLastTradeUpdate(new Date().toISOString());
      clearStoredTradeDraft();
      setTradeDraft(null);
      clearSelectedEventContext();
      setTradeCenterFilter('tracking');

      setNotice('Buy order submitted to Polymarket US. Intent is now actively trading.');
    } catch (executeError) {
      if (isTradeIntentNotFoundError(executeError)) {
        await refreshTradeHistory();

        if (tradeDraft?.id === intent.id) {
          handleClearTradeDraft();
        }

        setNotice('That trade intent no longer exists. Refreshed history.');
      } else {
        setError(executeError instanceof Error ? executeError.message : 'Unable to start trade monitoring');
      }
    } finally {
      setIsMutatingHistory(false);
    }
  }

  function handleOpenTradeModal() {
    if (!tradeSuggestion || !decisionEngine?.recommendation) {
      return;
    }

    setIsTradeModalOpen(true);
  }

  function handleCloseTradeModal() {
    setIsTradeModalOpen(false);
  }

  function handleConfirmTradeDraft() {
    if (!tradeDraft || !tradeSuggestion?.isRiskValid) {
      return;
    }

    void (async () => {
      setIsSavingTradeIntent(true);
      setError('');
      setNotice('');

      try {
        const confirmedAt = new Date().toISOString();
        const payload = {
          ...tradeDraft,
          confirmedAt,
          tradeSuggestion
        };
        const savedIntent = tradeDraft?.id
          ? await updateTradeIntentRequest(tradeDraft.id, {
              tradeAmount: payload.tradeAmount,
              tradeSuggestion: payload.tradeSuggestion,
              eventTitle: payload.eventTitle,
              marketSlug: payload.marketSlug
            })
          : await createTradeIntent(payload);

        setTradeDraft(savedIntent);
        setTradeHistory((previous) => [savedIntent, ...previous.filter((intent) => intent.id !== savedIntent.id)].slice(0, 6));
        saveStoredTradeDraft(savedIntent);
        setLastTradeUpdate(new Date().toISOString());
        setNotice(tradeDraft?.id ? 'Saved trade intent changes.' : 'Trade draft confirmed and stored in backend intent history.');
        setIsTradeModalOpen(false);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Unable to save trade intent');
      } finally {
        setIsSavingTradeIntent(false);
      }
    })();
  }

  function handleClearTradeDraft() {
    clearStoredTradeDraft();
    setTradeDraft(null);
    setTradeAmount('100');
    setIsTradeModalOpen(false);
    setNotice('Cleared the saved trade draft.');
  }

  return (
    <main className="app-shell terminal-shell">
      {statusPopup ? (
        <section
          className={`status-toast ${statusPopup.kind === 'error' ? 'status-toast-error' : 'status-toast-notice'}`}
          role={statusPopup.kind === 'error' ? 'alert' : 'status'}
          aria-live={statusPopup.kind === 'error' ? 'assertive' : 'polite'}
        >
          <p className="eyebrow">{statusPopup.kind === 'error' ? 'Error' : 'Notice'}</p>
          <p className="status-toast-message">{statusPopup.message}</p>
        </section>
      ) : null}

      <header className="terminal-topbar">
        <div className="terminal-brand-block">
          <div className="brand-row">
            <img src="/logo.png" alt="Probis logo" className="brand-logo" />
            <h1>PROBIS</h1>
          </div>
        </div>
        <div className="terminal-meta-grid">
          <article>
            <span>Account Total</span>
            <strong>{formatCurrency(status?.polymarket?.usTrading?.totalAccountBudget)}</strong>
          </article>
          <article>
            <span>Total Buying Power</span>
            <strong>{formatCurrency(status?.polymarket?.usTrading?.buyingPower)}</strong>
          </article>
          <article>
            <span>Tracking</span>
            <strong>{activeTradeIntents.length}</strong>
          </article>
          <article>
            <span>Last Polymarket Quote</span>
            <strong>{formatDateTime(latestPolymarketQuoteAt)}</strong>
          </article>
          <article>
            <span>API Account</span>
            <strong>{status?.accountIdentity?.authenticated ? 'AUTHENTICATED' : 'UNAUTHENTICATED'}</strong>
          </article>
          <article>
            <span>Clock</span>
            <strong>{formatClockTime(liveClock)}</strong>
          </article>
        </div>
      </header>

      <section className="dashboard-grid dashboard-grid-no-explorer">
        <aside className="dashboard-sidebar">
          <section className="control-card terminal-card compact-card">
            <div className="panel-heading">
              <p className="eyebrow">Market Controls</p>
              <h2>Event Input</h2>
            </div>
            <form className="event-form" onSubmit={handleSubmit}>
              <label htmlFor="event-input">Event link or slug</label>
              <div className="input-row input-row-single">
                <input
                  id="event-input"
                  name="event-input"
                  type="text"
                  placeholder="polymarket.com/event/..."
                  value={eventInput}
                  onChange={(inputEvent) => setEventInput(inputEvent.target.value)}
                />
              </div>
            </form>
            <div className="action-row terminal-action-row control-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleAnalyze()}
                disabled={!eventInput.trim() || isPending || isAnalyzing || isRefreshing}
              >
                {isAnalyzing ? 'Running...' : 'Run Engine'}
              </button>
              <button
                type="button"
                className="secondary-button secondary-button-muted"
                onClick={() => void handleRefreshData()}
                disabled={!eventInput.trim() || isRefreshing || isInvalidating}
              >
                {isRefreshing ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            {selectedEvent ? (
              <>
                <div className="market-controls-event-header">
                  <div className="market-chip-row market-controls-chip-row">
                    <span className="market-chip market-chip-muted">{selectedEvent.slug}</span>
                    {eventSportsLeagues.map((league) => (
                      <span key={league} className={`market-chip market-chip-league market-chip-league-${league.toLowerCase()}`}>
                        {league}
                      </span>
                    ))}
                    {eventSportsLeagues.length === 0 ? (
                      <span className="market-chip market-chip-market-only">MARKET ONLY</span>
                    ) : null}
                    <button
                      type="button"
                      className="market-chip-button"
                      onClick={handleClearSelectedEvent}
                      title="Clear the current event and reset the panel."
                    >
                      Clear
                    </button>
                    {selectedEvent.resolvedFromFallback ? (
                      <span className="market-chip market-chip-muted">matched from {selectedEvent.requestedSlug}</span>
                    ) : null}
                  </div>
                  <div className="market-controls-title-wrap">
                    <h3 className="market-controls-title">{selectedEvent.title}</h3>
                    <p className="market-controls-subtitle">{selectedMarket?.question ?? 'Live market snapshot'}</p>
                  </div>
                </div>

                <div className="event-summary-stats compact-status-grid market-controls-stats">
                  <article>
                    <span>Volume</span>
                    <strong>{formatCompactNumber(selectedEvent.volume)}</strong>
                  </article>
                  <article>
                    <span>Liquidity</span>
                    <strong>{formatCompactNumber(selectedEvent.liquidity)}</strong>
                  </article>
                  {marketControlsOutcomes.map((outcome) => (
                    <article key={outcome.label} className="market-outcome-stat">
                      <span>{outcome.label}</span>
                      <strong>{formatPercent(outcome.probability)}</strong>
                      <small>{formatMarketPrice(outcome.probability)}</small>
                    </article>
                  ))}
                </div>

                {selectedEvent.usFiltered && tradableMarkets.length === 0 ? (
                  <p className="empty-state">No markets are currently available via your connected Polymarket US API key.</p>
                ) : null}
                {selectedEvent.usFiltered && tradableMarkets.length > 0 && visibleMarkets.length === 0 ? (
                  <p className="empty-state">Markets exist, but none are live-priced yet. Trading opens once the market is live.</p>
                ) : null}
              </>
            ) : null}
          </section>
        </aside>

        <aside className="dashboard-rail dashboard-rail-wide">
          <section className="panel-card terminal-card compact-card ai-panel">
            <div className="panel-heading panel-heading-inline">
              <div>
                <p className="eyebrow">AI Recommendations</p>
                <h2>Decision Engine</h2>
              </div>
              <div className="trade-heading-chips">
                <span className={recommendationSource.className} title={recommendationSource.detail}>{recommendationSource.label}</span>
                <span className="market-chip">{currentRecommendation ? decisionEngine.action.toUpperCase() : 'IDLE'}</span>
              </div>
            </div>

            <div className="panel-scroll-body ai-panel-scroll">
            {currentRecommendation ? (
              <>
                <div className="decision-highlight ai-primary-card ai-subsection">
                  <span>Current recommendation</span>
                  <strong>{recommendationActionLabel}</strong>
                  <p className="recommendation-market-copy">{recommendationHeadline}</p>
                  <div className="decision-rationale-grid compact-preview-grid recommendation-summary-grid">
                    <article>
                      <span className="label-with-tooltip" data-tooltip="Overall confidence in this recommendation after combining the sports model, market behavior, and agreement checks." tabIndex={0}>Confidence</span>
                      <strong>{formatPercent(currentRecommendation.combinedConfidence)}</strong>
                    </article>
                    <article>
                      <span className="label-with-tooltip" data-tooltip="Estimated value versus the current market price. Higher positive expected value means the recommendation looks more favorable." tabIndex={0}>Expected Value</span>
                      <strong>{formatSignedPercent(recommendationExpectedValue)}</strong>
                    </article>
                    <article>
                      <span className="label-with-tooltip" data-tooltip="The gap between the model's probability and the current market probability for this outcome." tabIndex={0}>Edge</span>
                      <strong>{formatSignedPercent(currentRecommendation.edge)}</strong>
                    </article>
                  </div>
                  <div className="market-chip-row recommendation-source-row">
                    <span
                      className={recommendationSource.className}
                      title={recommendationSource.detail === 'sports model'
                        ? 'This recommendation is driven by the sports model layer for this matchup.'
                        : 'This recommendation is being driven by market pricing without sports-model support.'}
                    >
                      {recommendationSource.detail}
                    </span>
                  </div>
                </div>

                {recommendedMarket ? (
                  <section className="trade-suggestion-card compact-card">
                    <div className="panel-heading panel-heading-inline">
                      <div>
                        <p className="eyebrow">Trade Suggestion</p>
                        <h2>{decisionEngine.action.toUpperCase()} {currentRecommendation.outcomeLabel ?? 'Recommendation'}</h2>
                      </div>
                      {recommendedMarket.conditionId !== selectedMarket?.conditionId ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => setSelectedMarketId(recommendedMarket.conditionId)}
                        >
                          Jump
                        </button>
                      ) : null}
                    </div>

                    <div className="trade-input-row compact-input-grid">
                      <label>
                        <span className="label-with-tooltip" data-tooltip="Dollar amount you plan to commit to this position." tabIndex={0}>Stake</span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={tradeAmount}
                          onChange={(event) => setTradeAmount(event.target.value)}
                        />
                      </label>
                      <label>
                        <span className="label-with-tooltip" data-tooltip="Stop-loss trigger probability. If live probability drops to or below this value, the system attempts an exit." tabIndex={0}>Stop</span>
                        <input
                          type="number"
                          min="0.01"
                          max="0.99"
                          step="0.01"
                          value={riskInputs.stopLossProbability}
                          onChange={(event) => setRiskInputs((current) => ({
                            ...current,
                            stopLossProbability: event.target.value
                          }))}
                        />
                      </label>
                      <label>
                        <span className="label-with-tooltip" data-tooltip="Take-profit trigger probability. If live probability rises to or above this value, the system attempts an exit." tabIndex={0}>Take</span>
                        <input
                          type="number"
                          min="0.01"
                          max="0.99"
                          step="0.01"
                          value={riskInputs.takeProfitProbability}
                          onChange={(event) => setRiskInputs((current) => ({
                            ...current,
                            takeProfitProbability: event.target.value
                          }))}
                        />
                      </label>
                    </div>

                    {tradeSuggestion ? (
                      <div className="trade-preview-grid compact-preview-grid">
                        <article>
                          <span className="label-with-tooltip" data-tooltip="Model-based expected profit for this trade size." tabIndex={0}>Expected</span>
                          <strong>{formatCurrency(tradeSuggestion.expectedProfit)}</strong>
                        </article>
                        <article>
                          <span className="label-with-tooltip" data-tooltip="Estimated shares purchased at the current price." tabIndex={0}>Shares</span>
                          <strong>{typeof tradeSuggestion.shares === 'number' ? tradeSuggestion.shares.toFixed(2) : 'n/a'}</strong>
                        </article>
                        <article>
                          <span className="label-with-tooltip" data-tooltip="Estimated upside-to-downside ratio based on your take-profit and stop-loss settings." tabIndex={0}>Risk/Reward</span>
                          <strong>{tradeSuggestion.riskRewardRatio ? `${tradeSuggestion.riskRewardRatio.toFixed(2)}x` : 'n/a'}</strong>
                        </article>
                        <article>
                          <span className="label-with-tooltip" data-tooltip="Projected dollar loss if stop-loss is triggered." tabIndex={0}>Loss @ Stop</span>
                          <strong>{formatCurrency(tradeSuggestion.stopLossLoss)}</strong>
                        </article>
                        <article>
                          <span className="label-with-tooltip" data-tooltip="Projected dollar gain if take-profit is triggered." tabIndex={0}>Gain @ Take</span>
                          <strong>{formatCurrency(tradeSuggestion.takeProfitGain)}</strong>
                        </article>
                        <article>
                          <span className="label-with-tooltip" data-tooltip="Current lifecycle state of this trade draft or saved intent." tabIndex={0}>Status</span>
                          <strong>{tradeDraft?.confirmedAt ? formatIntentStatus(tradeDraft) : 'Draft'}</strong>
                        </article>
                        <article>
                          <span className="label-with-tooltip" data-tooltip="Current live market price for the recommended outcome." tabIndex={0}>Current Price</span>
                          <strong>
                            {formatPercent(currentRecommendation.currentProbability)} ({formatMarketPrice(currentRecommendation.currentProbability)})
                          </strong>
                        </article>
                      </div>
                    ) : (
                      <p className="empty-state">Enter a positive amount to preview the trade.</p>
                    )}

                    {tradeSuggestion && !tradeSuggestion.isRiskValid ? (
                      <p className="error-banner trade-error-banner">{tradeSuggestion.riskValidationMessage}</p>
                    ) : null}

                    <div className="trade-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={handleOpenTradeModal}
                        disabled={!tradeSuggestion || !tradeSuggestion.isRiskValid}
                      >
                        {tradeDraft?.id ? 'Review Changes' : 'Review Recommendation'}
                      </button>
                      <button type="button" className="ghost-button" onClick={handleClearTradeDraft}>
                        Clear Draft
                      </button>
                    </div>
                  </section>
                ) : null}

                <section className="panel-card terminal-card compact-card ai-reasoning-card">
                  <div className="panel-heading">
                    <p className="eyebrow">AI Recommendations</p>
                    <h2>Reasoning</h2>
                  </div>
                  <div className="decision-rationale-grid compact-preview-grid">
                    <article>
                      <span className="label-with-tooltip" data-tooltip="Overall confidence after combining the sports model, market data, and agreement checks." tabIndex={0}>Combined Confidence</span>
                      <strong>{formatPercent(currentRecommendation.combinedConfidence)}</strong>
                    </article>
                    <article>
                      <span className="label-with-tooltip" data-tooltip="Estimated edge versus the current market price. Higher positive expected value means the recommendation looks more favorable." tabIndex={0}>Expected Value</span>
                      <strong>{formatSignedPercent(recommendationExpectedValue)}</strong>
                    </article>
                    <article>
                      <span className="label-with-tooltip" data-tooltip="The model's probability estimate for the recommended outcome before your trade sizing is applied." tabIndex={0}>Model Probability</span>
                      <strong>{formatPercent(currentRecommendation.modelProbability)}</strong>
                    </article>
                    <article>
                      <span className="label-with-tooltip" data-tooltip="Whether the live market and the model are pointing in the same direction for this recommendation." tabIndex={0}>Agreement</span>
                      <strong>{currentRecommendation.agreementWithModel ? 'Aligned' : 'Divergent'}</strong>
                    </article>
                  </div>
                </section>

                {recommendedSportsOutcome && recommendedModelOutcome ? (
                  <section className="panel-card terminal-card compact-card ai-reasoning-card">
                    <div className="panel-heading">
                      <p className="eyebrow">Sports Pricing</p>
                      <h2>Why This Team</h2>
                    </div>
                    <div className="decision-rationale-grid compact-preview-grid">
                      <article>
                        <span className="label-with-tooltip" data-tooltip="The live Polymarket probability for this outcome right now." tabIndex={0}>Market Price</span>
                        <strong>{formatPercent(currentRecommendation.currentProbability)}</strong>
                      </article>
                      <article>
                        <span className="label-with-tooltip" data-tooltip="The sports-only estimate after calibration. This is the cleaner pre-market model view to compare against the live market." tabIndex={0}>Sports Model</span>
                        <strong>{formatPercent(recommendedSportsOutcome.fairProbability)}</strong>
                      </article>
                      <article>
                        <span className="label-with-tooltip" data-tooltip="The final probability after blending the sports model with live market behavior and market quality signals." tabIndex={0}>Final Blended Model</span>
                        <strong>{formatPercent(recommendedModelOutcome.estimatedProbability)}</strong>
                      </article>
                      <article>
                        <span className="label-with-tooltip" data-tooltip="How reliable the sports model believes this matchup estimate is. Higher confidence means the model sees a cleaner signal." tabIndex={0}>Sports Confidence</span>
                        <strong>{formatPercent(recommendedSportsOutcome.modelConfidence)}</strong>
                      </article>
                    </div>
                  </section>
                ) : null}

                {recommendedStarterContext ? (
                  <section className="panel-card terminal-card compact-card ai-reasoning-card">
                    <div className="panel-heading">
                      <p className="eyebrow">MLB Starter Context</p>
                      <h2>Probable Starters</h2>
                    </div>
                    <div className="decision-rationale-grid compact-preview-grid">
                      <article>
                        <span>Starter Source</span>
                        <strong>{recommendedStarterContext.source ?? 'n/a'}</strong>
                      </article>
                      <article>
                        <span>Starter Signal</span>
                        <strong>{formatSignedDecimal(recommendedStarterContext.diff)}</strong>
                      </article>
                      <article>
                        <span>Home Starter</span>
                        <strong>{formatStarterSummary(recommendedStarterContext.home)}</strong>
                      </article>
                      <article>
                        <span>Away Starter</span>
                        <strong>{formatStarterSummary(recommendedStarterContext.away)}</strong>
                      </article>
                    </div>
                    <div className="operator-notes-copy">
                      <p>
                        Home recent form: {recommendedStarterContext.recentForm?.home
                          ? `${recommendedStarterContext.recentForm.home.startCount} starts, ${formatSignedDecimal(recommendedStarterContext.recentForm.home.decayedScoreDiff)} score diff, ${formatPercent(recommendedStarterContext.recentForm.home.decayedWinRate)}`
                          : 'n/a'}
                      </p>
                      <p>
                        Away recent form: {recommendedStarterContext.recentForm?.away
                          ? `${recommendedStarterContext.recentForm.away.startCount} starts, ${formatSignedDecimal(recommendedStarterContext.recentForm.away.decayedScoreDiff)} score diff, ${formatPercent(recommendedStarterContext.recentForm.away.decayedWinRate)}`
                          : 'n/a'}
                      </p>
                    </div>
                  </section>
                ) : null}

                {eventIntelligence ? (
                  <section className="panel-card terminal-card compact-card ai-reasoning-card">
                    <div className="panel-heading">
                      <p className="eyebrow">Live Feed</p>
                      <h2>News And Game Context</h2>
                    </div>
                    <div className="decision-rationale-grid compact-preview-grid">
                      <article>
                        <span>League</span>
                        <strong>{eventIntelligence.league}</strong>
                      </article>
                      <article>
                        <span>Game Status</span>
                        <strong>{eventIntelligence.gameFeed?.status ?? 'n/a'}</strong>
                      </article>
                      <article>
                        <span>Game Detail</span>
                        <strong>{eventIntelligence.gameFeed?.detail ?? 'n/a'}</strong>
                      </article>
                      <article>
                        <span>Player Mentions</span>
                        <strong>{eventIntelligence.playerMentions?.length ?? 0}</strong>
                      </article>
                      <article>
                        <span>Social Posts</span>
                        <strong>{eventIntelligence.socialPosts?.length ?? 0}</strong>
                      </article>
                    </div>
                    {eventIntelligence.gameFeed ? (
                      <div className="operator-notes-copy">
                        <p>{eventIntelligence.gameFeed.name ?? 'Live game feed unavailable'}</p>
                        {(eventIntelligence.gameFeed.competitors ?? []).map((competitor) => (
                          <p key={`${competitor.teamId}-${competitor.homeAway}`}>
                            {competitor.teamName}: score {competitor.score ?? 'n/a'} | record {competitor.record ?? 'n/a'} | {competitor.homeAway ?? 'n/a'}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {(eventIntelligence.articles ?? []).length > 0 ? (
                      <div className="operator-notes-copy">
                        {eventIntelligence.articles.slice(0, 5).map((article) => (
                          <p key={article.id ?? article.headline}>
                            [{formatImpactScore(article.impactScore)}] {article.headline}: {article.description ?? 'No summary'}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {(eventIntelligence.socialPosts ?? []).length > 0 ? (
                      <div className="operator-notes-copy">
                        {eventIntelligence.socialPosts.slice(0, 4).map((post) => (
                          <p key={post.id ?? post.headline}>
                            [{String(post.provider ?? 'social').toUpperCase()} {formatImpactScore(post.impactScore)}] {post.headline}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {selectedSportsProbabilityBreakdown.length > 0 ? (
                  <section className="panel-card terminal-card compact-card ai-reasoning-card">
                    <div className="panel-heading">
                      <p className="eyebrow">Selected Market</p>
                      <h2>Sports Probability Breakdown</h2>
                    </div>
                    <div className="sports-breakdown-list">
                      {selectedSportsProbabilityBreakdown.map((outcome) => (
                        <section key={outcome.label} className="sports-breakdown-row">
                          <div className="sports-breakdown-row-header">
                            <h3>{outcome.label}</h3>
                          </div>
                          <div className="decision-rationale-grid compact-preview-grid sports-breakdown-grid">
                            <article>
                              <span className="label-with-tooltip" data-tooltip="The live market probability for this team right now." tabIndex={0}>Market</span>
                              <strong>{formatPercent(outcome.marketProbability)}</strong>
                            </article>
                            <article>
                              <span className="label-with-tooltip" data-tooltip="The raw sports-only estimate before calibration." tabIndex={0}>Raw Model</span>
                              <strong>{formatPercent(outcome.rawSportsProbability)}</strong>
                            </article>
                            <article>
                              <span className="label-with-tooltip" data-tooltip="The calibrated sports model after historical reliability adjustments." tabIndex={0}>Calibrated</span>
                              <strong>{formatPercent(outcome.calibratedSportsProbability)}</strong>
                            </article>
                            <article>
                              <span className="label-with-tooltip" data-tooltip="The final blended estimate after combining sports and market context." tabIndex={0}>Final</span>
                              <strong>{formatPercent(outcome.finalModelProbability)}</strong>
                            </article>
                            <article>
                              <span className="label-with-tooltip" data-tooltip="The difference between the final model and the current market price." tabIndex={0}>Edge</span>
                              <strong>{formatSignedPercent(outcome.edge)}</strong>
                            </article>
                          </div>
                        </section>
                      ))}
                    </div>
                  </section>
                ) : null}
              </>
            ) : (
              <p className="empty-state">Run the decision engine to populate AI recommendations.</p>
            )}

            {analysis ? (
              <section className="analysis-card terminal-analysis-card ai-notes-card">
                <p className="eyebrow">Realtime Updates</p>
                <h2>AI Operator Notes</h2>
                {parsedOperatorNotes.paragraphs.length > 0 ? (
                  <div className="operator-notes-copy">
                    {parsedOperatorNotes.paragraphs.map((line, index) => (
                      <p key={`${line}-${index}`}>{line}</p>
                    ))}
                  </div>
                ) : null}
                {parsedOperatorNotes.bullets.length > 0 ? (
                  <ul className="operator-notes-list">
                    {parsedOperatorNotes.bullets.map((line, index) => (
                      <li key={`${line}-${index}`}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            </div>
          </section>
        </aside>
      </section>

      <section className="dashboard-footer-grid">
        <section className="panel-card terminal-card trade-history-card footer-history-card opportunity-board-card">
          <div className="panel-heading panel-heading-inline">
            <div>
              <p className="eyebrow">Scanner</p>
              <h2>Opportunity Board</h2>
            </div>
            <div className="action-row">
              <span className="market-chip market-chip-muted">{opportunityBoard.length} ranked</span>
              <span className="market-chip market-chip-muted">
                {scannerSnapshot?.status === 'refreshing' || scannerSnapshot?.status === 'loading'
                  ? 'Refreshing'
                  : `Updated ${scannerLastUpdatedAge}`}
              </span>
            </div>
          </div>

          <div className="panel-scroll-body opportunity-board-scroll">
            {scannerSnapshot?.error ? (
              <p className="error-banner">{scannerSnapshot.error}</p>
            ) : null}

            {!scannerSnapshot ? (
              <p className="empty-state">Loading scanner snapshot.</p>
            ) : opportunityBoard.length === 0 ? (
              <p className="empty-state">No ranked scanner results are available right now.</p>
            ) : (
              <div className="opportunity-board-list">
                {opportunityBoard.map((opportunity) => (
                  <article
                    key={`${opportunity.eventSlug}-${opportunity.conditionId}-${opportunity.outcomeLabel}`}
                    className="trade-history-item opportunity-board-item"
                  >
                    {(() => {
                      const teamImpactSummary = Array.isArray(opportunity.teamImpactSummary)
                        ? opportunity.teamImpactSummary
                        : [];
                      const hasNonZeroImpactDelta = typeof opportunity.sportsImpactProbabilityDelta === 'number'
                        && Math.abs(opportunity.sportsImpactProbabilityDelta) >= 0.001;
                      const hasSportsAuditDetails = opportunity.signalSource === 'sports-model'
                        || hasNonZeroImpactDelta
                        || Boolean(opportunity.sportsPhase)
                        || Boolean(opportunity.sportsPhaseSource)
                        || teamImpactSummary.length > 0;

                      return (
                        <>
                    <div className="panel-heading panel-heading-inline">
                      <div>
                        <p className="eyebrow">#{opportunity.rank} {formatOpportunityClassification(opportunity.classification)}</p>
                        <h2>{opportunity.outcomeLabel} in {opportunity.marketQuestion}</h2>
                        <p className="event-meta">{opportunity.eventTitle}</p>
                      </div>
                      <div className="trade-heading-chips">
                        <span className={getOpportunityClassificationClassName(opportunity.classification)}>
                          {formatOpportunityClassification(opportunity.classification)}
                        </span>
                        {opportunity.sportsLeague ? (
                          <span className={`market-chip market-chip-league market-chip-league-${opportunity.sportsLeague.toLowerCase()}`}>
                            {opportunity.sportsLeague}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="decision-rationale-grid compact-preview-grid opportunity-board-metrics">
                      <article>
                        <span>EV / Dollar</span>
                        <strong>{formatSignedPercent(opportunity.expectedValuePerDollar)}</strong>
                      </article>
                      <article>
                        <span>Confidence</span>
                        <strong>{formatPercent(opportunity.confidence)}</strong>
                      </article>
                      <article>
                        <span>Market Price</span>
                        <strong>{formatPercent(opportunity.currentProbability)}</strong>
                      </article>
                      <article>
                        <span>Model Price</span>
                        <strong>{formatPercent(opportunity.modelProbability)}</strong>
                      </article>
                      <article>
                        <span>Liquidity</span>
                        <strong>{formatCompactNumber(opportunity.marketLiquidity ?? opportunity.eventLiquidity)}</strong>
                      </article>
                      <article>
                        <span>Spread</span>
                        <strong>{formatSignedPercent(opportunity.spread)}</strong>
                      </article>
                      <article>
                        <span>Resolves In</span>
                        <strong>{formatTimeToResolution(opportunity.timeToResolutionMs)}</strong>
                      </article>
                      <article>
                        <span>Signal</span>
                        <strong>{opportunity.signalSource === 'sports-model' ? 'Sports Model' : 'Microstructure'}</strong>
                      </article>
                    </div>

                    {hasSportsAuditDetails ? (
                      <section className="opportunity-board-audit">
                        <p className="eyebrow opportunity-board-audit-eyebrow">Sports Audit</p>
                        <div className="decision-rationale-grid compact-preview-grid opportunity-board-audit-grid">
                          <article>
                            <span>Competition Phase</span>
                            <strong>{formatCompetitionPhase(opportunity.sportsPhase)}</strong>
                          </article>
                          <article>
                            <span>Phase Source</span>
                            <strong>{formatCompetitionPhaseSource(opportunity.sportsPhaseSource)}</strong>
                          </article>
                          <article>
                            <span>Impact Direction</span>
                            <strong>{formatImpactDirection(opportunity.sportsImpactDirection)}</strong>
                          </article>
                          <article>
                            <span>Impact Delta</span>
                            <strong>{formatSignedPercent(opportunity.sportsImpactProbabilityDelta)}</strong>
                          </article>
                        </div>

                        {teamImpactSummary.length > 0 ? (
                          <div className="opportunity-board-impact-list" role="list" aria-label="Top team impacts">
                            {teamImpactSummary.map((teamImpact) => (
                              <article
                                key={`${opportunity.eventSlug}-${opportunity.conditionId}-${teamImpact.teamId ?? teamImpact.teamName}`}
                                className="opportunity-board-impact-item"
                                role="listitem"
                              >
                                <span>{teamImpact.teamName ?? teamImpact.teamId ?? 'Unknown Team'}</span>
                                <strong>{formatSignedPercent(teamImpact.probabilityDelta)}</strong>
                                <small>{formatImpactDirection(teamImpact.direction)} impact • conf {formatPercent(teamImpact.confidence)}</small>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <p className="empty-state opportunity-board-impact-empty">No directional team impact entries for this row yet.</p>
                        )}
                      </section>
                    ) : null}

                    <div className="trade-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => handleUseScannerOpportunity(opportunity)}
                      >
                        Load Event
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setEventInput(opportunity.eventSlug)}
                      >
                        Use Slug
                      </button>
                    </div>
                        </>
                      );
                    })()}
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel-card terminal-card trade-history-card footer-history-card">
          <div className="panel-heading panel-heading-inline">
            <div>
              <p className="eyebrow">Active Trades</p>
              <h2>Trade Center</h2>
            </div>
            <div className="action-row">
              <span className="market-chip market-chip-muted">Last polled {lastPolledAge}</span>
            </div>
          </div>

          <div className="trade-center-filter-row" role="tablist" aria-label="Trade Center Filters">
            <button
              type="button"
              role="tab"
              aria-selected={tradeCenterFilter === 'tracking'}
              className={tradeCenterFilter === 'tracking' ? 'filter-chip filter-chip-active' : 'filter-chip'}
              onClick={() => setTradeCenterFilter('tracking')}
            >
              Active
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tradeCenterFilter === 'draft'}
              className={tradeCenterFilter === 'draft' ? 'filter-chip filter-chip-active' : 'filter-chip'}
              onClick={() => setTradeCenterFilter('draft')}
            >
              Drafts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tradeCenterFilter === 'closed'}
              className={tradeCenterFilter === 'closed' ? 'filter-chip filter-chip-active' : 'filter-chip'}
              onClick={() => setTradeCenterFilter('closed')}
            >
              Closed
            </button>
          </div>

          <div className="panel-scroll-body trade-center-scroll">
            {tradeHistory.length === 0 ? (
              <p className="empty-state">No confirmed trade intents yet.</p>
            ) : filteredTradeHistory.length === 0 ? (
              <p className="empty-state">No trade intents match the selected filter.</p>
            ) : (
              <div className="trade-history-list terminal-list trade-center-list">
                {filteredTradeHistory.map((intent) => {
                const precheckMessage = getExecutePrecheckMessage(intent);
                const isTracking = intent.status === 'tracking';
                const currentProbability = isTracking
                  ? (intent.monitoring?.currentProbability ?? null)
                  : (intent.recommendation?.currentProbability ?? null);
                const entryProbability = getTrackedEntryProbability(intent);
                const monitoringState = intent.monitoring?.state ?? 'active';
                const monitoringStateDisplay = isTracking && hasMonitoringSyncWarning(intent)
                  ? 'sync-warning'
                  : monitoringState;
                const isVerifiedFilledPosition = hasApiVerifiedFilledPosition(intent);
                const drift = typeof currentProbability === 'number' && typeof entryProbability === 'number'
                  ? (currentProbability - entryProbability)
                  : null;
                const unrealizedPnl = estimateTrackedPnl(intent, currentProbability, entryProbability);
                const stopLossProbability = intent.monitoring?.stopLossProbability ?? null;
                const takeProfitProbability = intent.monitoring?.takeProfitProbability ?? null;
                const currentValue = typeof intent.position?.sharesFilled === 'number' && typeof currentProbability === 'number'
                  ? intent.position.sharesFilled * currentProbability
                  : null;
                const costBasis = intent.position?.notionalSpent ?? intent.tradeAmount;
                const pnlClassName = typeof unrealizedPnl.dollars === 'number'
                  ? unrealizedPnl.dollars >= 0
                    ? 'pnl-positive'
                    : 'pnl-negative'
                  : '';
                const probabilityTone = getProbabilityMetricTone(currentProbability, stopLossProbability, takeProfitProbability);
                const driftTone = getSignedMetricTone(drift);
                const pnlTone = getSignedMetricTone(unrealizedPnl.dollars ?? null, 0.01);
                const currentValueTone = getSignedMetricTone(
                  typeof currentValue === 'number' && typeof costBasis === 'number'
                    ? currentValue - costBasis
                    : null,
                  0.01
                );
                const monitoringNotes = String(intent.monitoring?.notes ?? '').trim();
                const liveProbabilityHistory = trackedProbabilityHistory[intent.id] ?? [];

                  return (
                    <article key={intent.id} className="trade-history-item trade-center-item">
                    <div className="panel-heading panel-heading-inline">
                      <div>
                        <p className="eyebrow">{intent.eventTitle ?? intent.eventSlug}</p>
                        <h2>{intent.outcomeLabel} in {intent.marketQuestion}</h2>
                      </div>
                      <div className="trade-heading-chips">
                        <span className={isTracking ? getMonitoringStateChipClass(monitoringStateDisplay) : 'market-chip'}>
                          {isTracking ? formatMonitoringStateLabel(monitoringStateDisplay) : formatIntentStatus(intent)}
                        </span>
                        {isVerifiedFilledPosition ? (
                          <span className="market-chip market-chip-verified">✓ API Verified</span>
                        ) : null}
                      </div>
                    </div>

                    <div className={isTracking ? 'tracked-trade-layout' : 'trade-preview-grid'}>
                      {isTracking ? (
                        <>
                          <div className="tracked-trade-summary">
                            <div className="tracked-trade-summary-list">
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass(probabilityTone)}`}>
                                <span>Current</span>
                                <strong>{formatPercent(currentProbability)}</strong>
                              </article>
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass('ok')}`}>
                                <span>Entry</span>
                                <strong>{formatPercent(entryProbability)}</strong>
                              </article>
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass(driftTone)}`}>
                                <span>Drift</span>
                                <strong>{formatSignedPercent(drift)}</strong>
                              </article>
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass(pnlTone)}`}>
                                <span>P/L</span>
                                <strong className={pnlClassName}>
                                  {formatSignedCurrency(unrealizedPnl.dollars)}
                                  {typeof unrealizedPnl.percent === 'number' ? ` (${formatSignedPercent(unrealizedPnl.percent)})` : ''}
                                </strong>
                              </article>
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass('bad')}`}>
                                <span>Stop</span>
                                <strong>{formatPercent(stopLossProbability)}</strong>
                              </article>
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass('good')}`}>
                                <span>Take</span>
                                <strong>{formatPercent(takeProfitProbability)}</strong>
                              </article>
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass('ok')}`}>
                                <span>Shares</span>
                                <strong>{typeof intent.position?.sharesFilled === 'number' ? intent.position.sharesFilled.toFixed(2) : 'n/a'}</strong>
                              </article>
                              <article className={`tracked-trade-summary-row ${getTradeMetricClass(currentValueTone)}`}>
                                <span>Value</span>
                                <strong>{typeof currentValue === 'number' ? formatCurrency(currentValue) : 'n/a'}</strong>
                              </article>
                            </div>
                            <div className="tracked-trade-meta-row">
                              <span className="market-chip market-chip-muted">Basis {formatCurrency(costBasis)}</span>
                              <span className="market-chip market-chip-muted">Quote {formatDateTime(intent.monitoring?.lastPolymarketQuoteAt)}</span>
                              <span className="market-chip market-chip-muted">Order {formatOrderId(intent.executionRequest?.venueOrderId)}</span>
                            </div>
                          </div>
                          <div className="tracked-trade-chart-panel">
                            <TrackingProbabilityChart
                              history={liveProbabilityHistory}
                              currentProbability={currentProbability}
                              entryProbability={entryProbability}
                              stopLossProbability={stopLossProbability}
                              takeProfitProbability={takeProfitProbability}
                              monitoringState={monitoringState}
                              lastQuoteAt={intent.monitoring?.lastPolymarketQuoteAt}
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <article>
                            <span>Stake</span>
                            <strong>{formatCurrency(intent.tradeAmount)}</strong>
                          </article>
                          <article>
                            <span>Confirmed</span>
                            <strong>{formatDateTime(intent.confirmedAt)}</strong>
                          </article>
                          <article>
                            <span>Stop-loss</span>
                            <strong>{formatPercent(intent.tradeSuggestion?.stopLossProbability)}</strong>
                          </article>
                          <article>
                            <span>Take-profit</span>
                            <strong>{formatPercent(intent.tradeSuggestion?.takeProfitProbability)}</strong>
                          </article>
                          <article>
                            <span>Entry order</span>
                            <strong>{formatOrderId(intent.executionRequest?.venueOrderId)}</strong>
                          </article>
                          <article>
                            <span>Exit order</span>
                            <strong>{formatOrderId(intent.exitRequest?.venueOrderId ?? intent.position?.exitOrderId)}</strong>
                          </article>
                        </>
                      )}
                    </div>

                    {!isTracking ? (
                      <p className="trade-status-copy">
                        {intent.executionRequest?.readyForExecution
                          ? `Request ready · ${intent.executionRequest.orderType} · ${intent.executionRequest.side}`
                          : precheckMessage ?? 'Intent is ready for review.'}
                      </p>
                    ) : null}

                    {isTracking && monitoringNotes ? (
                      <p className={monitoringStateDisplay.includes('failed') ? 'trade-monitoring-note trade-monitoring-note-alert' : 'trade-monitoring-note'}>
                        {monitoringNotes}
                      </p>
                    ) : null}

                    <div className="trade-history-actions">
                      {isTracking ? (
                        <>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => handleStartEditingActiveTrade(intent)}
                            disabled={isMutatingHistory}
                          >
                            Edit Active Trade
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void handleSellTrackedIntent(intent)}
                            disabled={isMutatingHistory}
                            title="Sell all shares via Polymarket US and close this trade when the venue fill completes."
                          >
                            Cash Out & Stop
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="ghost-button" onClick={() => void handleRestoreTradeIntent(intent)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="secondary-button secondary-button-muted"
                            onClick={() => void handleExecuteTradeIntent(intent)}
                            disabled={isMutatingHistory || intent.status === 'tracking'}
                            title={precheckMessage ?? 'Submit live buy order and transition to actively trading.'}
                          >
                            Start Trading
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => void handleDeleteTradeIntent(intent.id)}
                            disabled={isMutatingHistory}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </section>

      {isTradeModalOpen && tradeSuggestion && decisionEngine?.recommendation ? (
        <div className="modal-backdrop" role="presentation" onClick={handleCloseTradeModal}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trade-review-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-heading panel-heading-inline">
              <div>
                <p className="eyebrow">Trade Review</p>
                <h2 id="trade-review-title">
                  {decisionEngine.action.toUpperCase()} {decisionEngine.recommendation.outcomeLabel} in{' '}
                  {decisionEngine.recommendation.marketQuestion}
                </h2>
              </div>
              <button type="button" className="ghost-button" onClick={handleCloseTradeModal}>
                Close
              </button>
            </div>

            <p className="modal-copy">Review this draft, confirm risk controls, then submit execution when ready.</p>

            <div className="trade-preview-grid">
              <article>
                <span>Amount</span>
                <strong>{formatCurrency(tradeSuggestion.amount)}</strong>
              </article>
              <article>
                <span>Expected profit</span>
                <strong>{formatCurrency(tradeSuggestion.expectedProfit)}</strong>
              </article>
              <article>
                <span>Default stop-loss</span>
                <strong>{formatPercent(tradeSuggestion.stopLossProbability)}</strong>
              </article>
              <article>
                <span>Default take-profit</span>
                <strong>{formatPercent(tradeSuggestion.takeProfitProbability)}</strong>
              </article>
              <article>
                <span>Risk / reward</span>
                <strong>{tradeSuggestion.riskRewardRatio ? `${tradeSuggestion.riskRewardRatio.toFixed(2)}x` : 'n/a'}</strong>
              </article>
              <article>
                <span>Sizing hint</span>
                <strong>{tradeSuggestion.bankrollHint}</strong>
              </article>
            </div>

            {tradeSuggestion && !tradeSuggestion.isRiskValid ? (
              <p className="error-banner trade-error-banner">{tradeSuggestion.riskValidationMessage}</p>
            ) : null}

            <div className="detail-callout">
              <span>Rationale</span>
              <strong>{decisionEngine.recommendation.thesis}</strong>
              <p>Risk: {decisionEngine.recommendation.keyRisk}</p>
              {decisionEngine.recommendation.reasons?.length > 0 ? (
                <ul className="reason-list">
                  {decisionEngine.recommendation.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleConfirmTradeDraft}
                disabled={isSavingTradeIntent || !tradeSuggestion.isRiskValid}
              >
                {isSavingTradeIntent ? 'Saving...' : tradeDraft?.id ? 'Save Changes' : 'Confirm Draft'}
              </button>
              <button type="button" className="ghost-button" onClick={handleCloseTradeModal}>
                Keep Editing
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {editingActiveTrade ? (
        <div className="modal-backdrop" role="presentation" onClick={handleCancelEditingActiveTrade}>
          <section
            className="modal-card active-trade-edit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="active-trade-edit-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-heading panel-heading-inline">
              <div>
                <p className="eyebrow">Active Trade</p>
                <h2 id="active-trade-edit-title">Edit Stop-Loss And Take-Profit</h2>
              </div>
              <button type="button" className="ghost-button" onClick={handleCancelEditingActiveTrade}>
                Close
              </button>
            </div>

            <p className="modal-copy">
              Update the live risk thresholds for {editingActiveTrade.outcomeLabel} in {editingActiveTrade.marketQuestion}.
            </p>

            <div className="trade-preview-grid">
              <article>
                <span>Current probability</span>
                <strong>{formatPercent(editingActiveTrade.monitoring?.currentProbability)}</strong>
              </article>
              <article>
                <span>Entry probability</span>
                <strong>{formatPercent(getTrackedEntryProbability(editingActiveTrade))}</strong>
              </article>
            </div>

            <div className="trade-input-row compact-input-grid">
              <label>
                <span>Stop-loss</span>
                <input
                  type="number"
                  min="0.01"
                  max="0.99"
                  step="0.01"
                  value={activeTradeRiskInputs[editingActiveTrade.id]?.stopLossProbability ?? ''}
                  onChange={(event) => handleActiveTradeRiskInputChange(editingActiveTrade.id, 'stopLossProbability', event.target.value)}
                  disabled={isMutatingHistory}
                />
              </label>
              <label>
                <span>Take-profit</span>
                <input
                  type="number"
                  min="0.01"
                  max="0.99"
                  step="0.01"
                  value={activeTradeRiskInputs[editingActiveTrade.id]?.takeProfitProbability ?? ''}
                  onChange={(event) => handleActiveTradeRiskInputChange(editingActiveTrade.id, 'takeProfitProbability', event.target.value)}
                  disabled={isMutatingHistory}
                />
              </label>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleSaveActiveTradeRisk(editingActiveTrade)}
                disabled={isMutatingHistory}
              >
                {isMutatingHistory ? 'Saving...' : 'Save Targets'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={handleCancelEditingActiveTrade}
                disabled={isMutatingHistory}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}