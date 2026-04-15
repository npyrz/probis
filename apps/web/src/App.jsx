import { useEffect, useState, useTransition } from 'react';

import {
  analyzeEvent,
  createTradeIntent,
  deleteTradeIntent as deleteTradeIntentRequest,
  executeTradeIntent as executeTradeIntentRequest,
  fetchActiveEvents,
  fetchStatus,
  fetchTradeIntents,
  invalidateEventAggregationCache,
  pollTrackedTradeIntents,
  resolveEvent,
  resolveEventAggregation,
  sellTradeIntent as sellTradeIntentRequest,
  stopTradeIntent as stopTradeIntentRequest,
  updateTradeIntent as updateTradeIntentRequest
} from './lib/api.js';

const TRADE_DRAFT_STORAGE_KEY = 'probis.tradeDraft';

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

function formatMonitoringStateLabel(state) {
  const normalized = String(state ?? 'active').trim();

  if (normalized === 'active') {
    return 'Actively Trading';
  }

  if (normalized === 'stop-loss-triggered-exit-failed') {
    return 'Stop-Loss Exit Failed';
  }

  if (normalized === 'take-profit-triggered-exit-failed') {
    return 'Take-Profit Exit Failed';
  }

  return normalized
    .split('-')
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function getMonitoringStateChipClass(state) {
  const normalized = String(state ?? 'active').trim();

  if (normalized.endsWith('-failed')) {
    return 'market-chip market-chip-alert';
  }

  if (normalized === 'active') {
    return 'market-chip market-chip-live';
  }

  return 'market-chip';
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

function saveStoredTradeDraft(draft) {
  if (typeof window === 'undefined') {
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

function getEventHeadline(event, visibleMarkets) {
  const leaders = visibleMarkets
    .map((market) => ({
      market,
      leader: getMarketLeader(market)
    }))
    .filter((candidate) => typeof candidate.leader?.probability === 'number')
    .sort((left, right) => right.leader.probability - left.leader.probability);

  return leaders[0] ?? null;
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
  const expectedProfit = typeof recommendation.expectedValuePerDollar === 'number'
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
    riskRewardRatio: recommendation.riskRewardRatio ?? null,
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
  const [isPending, startTransition] = useTransition();
  const tradableMarkets = selectedEvent?.markets ?? [];
  const visibleMarkets = tradableMarkets.filter(marketHasLivePrices);
  const eventHeadline = selectedEvent ? getEventHeadline(selectedEvent, visibleMarkets) : null;
  const rankedMarkets = filterAndSortMarkets(visibleMarkets, aggregation, statisticalModel, sortBy, filterBy);
  const selectedMarket = visibleMarkets.find((market) => market.conditionId === selectedMarketId) ?? rankedMarkets[0]?.market ?? null;
  const selectedHistoricalMarket = selectedMarket ? findHistoricalMarket(aggregation, selectedMarket.conditionId) : null;
  const selectedModelMarket = selectedMarket ? getModelMarket(statisticalModel, selectedMarket.conditionId) : null;
  const recommendedMarket = getRecommendedMarket(selectedEvent, decisionEngine);
  const tradeSuggestion = buildTradeSuggestion(decisionEngine, tradeAmount, riskInputs);
  const activeTradeIntents = tradeHistory.filter((intent) => intent.status === 'tracking');
  const selectedLeader = selectedMarket ? getMarketLeader(selectedMarket) : null;
  const currentRecommendation = decisionEngine?.recommendation ?? null;

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

    if (matchingIntent) {
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

  async function applyStoredTradeDraft(storedDraft, successMessage) {
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
    setNotice(successMessage);
  }

  useEffect(() => {
    const storedDraft = loadStoredTradeDraft();

    if (!storedDraft?.input) {
      return;
    }

    let isCancelled = false;

    async function restoreDraft() {
      try {
        if (isCancelled) {
          return;
        }

        await applyStoredTradeDraft(storedDraft, 'Restored saved trade draft.');
      } catch {
        clearStoredTradeDraft();
      }
    }

    void restoreDraft();

    return () => {
      isCancelled = true;
    };
  }, []);

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
        const [nextStatus, nextEvents, nextTradeHistory] = await Promise.all([
          fetchStatus(),
          fetchActiveEvents(5),
          fetchTradeIntents(6)
        ]);

        if (isCancelled) {
          return;
        }

        setStatus(nextStatus);
        setActiveEvents(nextEvents);
        setTradeHistory(nextTradeHistory);
        setLastMarketUpdate(new Date().toISOString());
        setLastTradeUpdate(new Date().toISOString());
        setNotice('');
      } catch (loadError) {
        if (!isCancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load initial data');
        }
      }
    }

    loadInitialData();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeTradeIntents.length === 0) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          await pollTrackedTradeIntents();
          await refreshTradeHistory();
          setLastMarketUpdate(new Date().toISOString());
          setLastTradeUpdate(new Date().toISOString());
        } catch {
          // Ignore background polling failures and keep the last known state in the UI.
        }
      })();
    }, 10000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeTradeIntents.map((intent) => intent.id).join('|')]);

  async function handleResolveEvent(submittedInput) {
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
      setSelectedEvent(event);
      setAggregation(analytics.aggregation ?? null);
      setStatisticalModel(analytics.statisticalModel ?? null);
      const liveMarkets = event.markets.filter(marketHasLivePrices);
      setSelectedMarketId(liveMarkets[0]?.conditionId ?? null);
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
      void handleResolveEvent(eventInput.trim());
    });
  }

  function handleUseEvent(slug) {
    startTransition(() => {
      void handleResolveEvent(slug);
    });
  }

  async function handleAnalyze(options = {}) {
    if (!selectedEvent?.slug) {
      return;
    }

    setError('');
    setNotice('');
    setIsAnalyzing(true);

    try {
      const result = await analyzeEvent(selectedEvent.slug, options);
      setAnalysis(result.analysis);
      setDecisionEngine(result.decisionEngine ?? null);
      setLastAiUpdate(new Date().toISOString());
      setNotice(options.refresh ? 'Refreshed analytics and reran the decision engine.' : 'AI analysis updated.');
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
      await pollTrackedTradeIntents();
      const intents = await refreshTradeHistory();
      const nextStatus = await fetchStatus();
      setStatus(nextStatus);
      setLastMarketUpdate(new Date().toISOString());
      setLastTradeUpdate(new Date().toISOString());
      const stillTracking = intents.filter((intent) => intent.status === 'tracking').length;
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

      if (tradeDraft?.id === nextIntent.id) {
        setTradeDraft(nextIntent);
        saveStoredTradeDraft(nextIntent);
      }

      setNotice('Sell order submitted to Polymarket US and position moved out of active tracking.');
    } catch (sellError) {
      if (isTradeIntentNotFoundError(sellError)) {
        await refreshTradeHistory();

        if (tradeDraft?.id === intent.id) {
          handleClearTradeDraft();
        }

        setNotice('That trade intent no longer exists. Refreshed history.');
      } else {
        setError(sellError instanceof Error ? sellError.message : 'Unable to sell tracked intent');
      }
    } finally {
      setIsMutatingHistory(false);
    }
  }

  async function handleStopTrackedIntent(intent) {
    setError('');
    setNotice('');
    setIsMutatingHistory(true);

    try {
      const nextIntent = await stopTradeIntentRequest(intent.id);
      setTradeHistory((previous) => replaceIntentInList(previous, nextIntent));
      setLastTradeUpdate(new Date().toISOString());

      if (tradeDraft?.id === nextIntent.id) {
        setTradeDraft(nextIntent);
        saveStoredTradeDraft(nextIntent);
      }

      setNotice('Trade stopped and moved out of active tracking.');
    } catch (stopError) {
      if (isTradeIntentNotFoundError(stopError)) {
        await refreshTradeHistory();

        if (tradeDraft?.id === intent.id) {
          handleClearTradeDraft();
        }

        setNotice('That trade intent no longer exists. Refreshed history.');
      } else {
        setError(stopError instanceof Error ? stopError.message : 'Unable to stop trade monitoring');
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

      if (tradeDraft?.id === nextIntent.id) {
        setTradeDraft(nextIntent);
        saveStoredTradeDraft(nextIntent);
      }

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
      <header className="terminal-topbar">
        <div className="terminal-brand-block">
          <p className="terminal-kicker">Step 12 Dashboard</p>
          <h1>PROBIS OPS</h1>
          <p className="terminal-subtitle">Local-first prediction market console with live trade planning, monitoring, and operator controls.</p>
        </div>
        <div className="terminal-meta-grid">
          <article>
            <span>Total Buying Power</span>
            <strong>{formatCurrency(status?.polymarket?.usTrading?.buyingPower)}</strong>
          </article>
          <article>
            <span>Clock</span>
            <strong>{formatClockTime(liveClock)}</strong>
          </article>
          <article>
            <span>Tracking</span>
            <strong>{activeTradeIntents.length}</strong>
          </article>
          <article>
            <span>Last Market</span>
            <strong>{formatDateTime(lastMarketUpdate)}</strong>
          </article>
          <article>
            <span>Last AI</span>
            <strong>{formatDateTime(lastAiUpdate)}</strong>
          </article>
        </div>
      </header>

      <section className="terminal-ticker">
        <div className="ticker-item">
          <span>POLY</span>
          <strong>{status?.polymarket?.publicReadOk ? 'ONLINE' : 'CHECKING'}</strong>
        </div>
        <div className="ticker-item">
          <span>OLLAMA</span>
          <strong>{status?.ai?.reachable ? status.ai.resolvedModel ?? 'READY' : 'OFFLINE'}</strong>
        </div>
        <div className="ticker-item">
          <span>EVENT</span>
          <strong>{selectedEvent?.slug ?? 'NONE'}</strong>
        </div>
        <div className="ticker-item">
          <span>REC</span>
          <strong>{currentRecommendation ? `${decisionEngine.action.toUpperCase()} ${currentRecommendation.outcomeLabel}` : 'WAITING'}</strong>
        </div>
        <div className="ticker-item">
          <span>REALTIME</span>
          <strong>{activeTradeIntents.length > 0 ? 'LIVE POLLING' : 'IDLE'}</strong>
        </div>
      </section>

      {error ? <p className="error-banner terminal-banner">{error}</p> : null}
      {notice ? <p className="notice-banner terminal-banner">{notice}</p> : null}

      <section className="dashboard-grid dashboard-grid-no-explorer">
        <aside className="dashboard-sidebar">
          <section className="control-card terminal-card compact-card">
            <div className="panel-heading">
              <p className="eyebrow">Operator Console</p>
              <h2>Resolve Event</h2>
            </div>
            <form className="event-form" onSubmit={handleSubmit}>
              <label htmlFor="event-input">Event URL or slug</label>
              <div className="input-row">
                <input
                  id="event-input"
                  name="event-input"
                  type="text"
                  placeholder="https://polymarket.com/event/..."
                  value={eventInput}
                  onChange={(inputEvent) => setEventInput(inputEvent.target.value)}
                />
                <button type="submit" disabled={isPending}>
                  {isPending ? 'Loading...' : 'Resolve'}
                </button>
              </div>
            </form>
            <div className="action-row terminal-action-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleAnalyze()}
                disabled={!selectedEvent || isPending || isAnalyzing || isRefreshing}
              >
                {isAnalyzing ? 'Analyzing...' : 'Run Decision Engine'}
              </button>
              <button
                type="button"
                className="secondary-button secondary-button-muted"
                onClick={() => void handleRefreshData()}
                disabled={!selectedEvent || isRefreshing || isInvalidating}
              >
                {isRefreshing ? 'Refreshing...' : 'Refresh Data'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleInvalidateCache('event')}
                disabled={!selectedEvent || isRefreshing || isInvalidating}
              >
                {isInvalidating ? 'Clearing...' : 'Clear Event Cache'}
              </button>
            </div>
          </section>

          {selectedEvent ? (
            <article className="panel-card terminal-card compact-card">
              <div className="panel-heading">
                <p className="eyebrow">Selected Event</p>
                <h2>{selectedEvent.title}</h2>
              </div>
              <p className="event-meta">
                slug: {selectedEvent.slug}
                {selectedEvent.resolvedFromFallback ? ` · matched from ${selectedEvent.requestedSlug}` : ''}
              </p>
              <p className="terminal-copy">{selectedEvent.description || 'No event description is available for this market.'}</p>
              <div className="event-summary-stats compact-status-grid">
                <article>
                  <span>Live Markets</span>
                  <strong>{visibleMarkets.length}</strong>
                </article>
                <article>
                  <span>Tradable Markets</span>
                  <strong>{tradableMarkets.length}</strong>
                </article>
                <article>
                  <span>Volume</span>
                  <strong>{formatCompactNumber(selectedEvent.volume)}</strong>
                </article>
                <article>
                  <span>Liquidity</span>
                  <strong>{formatCompactNumber(selectedEvent.liquidity)}</strong>
                </article>
                <article>
                  <span>End Date</span>
                  <strong>{formatDate(selectedEvent.endDate)}</strong>
                </article>
              </div>
              {selectedEvent.usFiltered && tradableMarkets.length === 0 ? (
                <p className="empty-state">No tradable markets are currently available for this event via your connected Polymarket US API key.</p>
              ) : null}
              {selectedEvent.usFiltered && tradableMarkets.length > 0 && visibleMarkets.length === 0 ? (
                <p className="empty-state">Markets exist for this event, but none are live-priced yet. Trading becomes available once the market is live.</p>
              ) : null}
              {eventHeadline ? (
                <div className="event-highlight compact-highlight">
                  <span>Highest-conviction</span>
                  <strong>{eventHeadline.market.question}</strong>
                  <p>
                    {eventHeadline.leader.label} leads at {formatPercent(eventHeadline.leader.probability)}.
                  </p>
                </div>
              ) : null}
            </article>
          ) : null}
        </aside>

        <aside className="dashboard-rail dashboard-rail-wide">
          <section className="panel-card terminal-card compact-card ai-panel">
            <div className="panel-heading panel-heading-inline">
              <div>
                <p className="eyebrow">AI Recommendations</p>
                <h2>Decision Engine</h2>
              </div>
              <span className="market-chip">{currentRecommendation ? decisionEngine.action.toUpperCase() : 'IDLE'}</span>
            </div>

            {currentRecommendation ? (
              <>
                <div className="decision-highlight ai-primary-card">
                  <span>Current recommendation</span>
                  <strong>{currentRecommendation.outcomeLabel} in {currentRecommendation.marketQuestion}</strong>
                  <p>
                    Confidence {formatPercent(currentRecommendation.combinedConfidence)} · EV {formatSignedPercent(currentRecommendation.expectedValuePerDollar)} · Edge {formatSignedPercent(currentRecommendation.edge)}
                  </p>
                  <p>{currentRecommendation.thesis}</p>
                </div>

                {recommendedMarket ? (
                  <section className="trade-suggestion-card compact-card">
                    <div className="panel-heading panel-heading-inline">
                      <div>
                        <p className="eyebrow">Trade Suggestion</p>
                        <h2>{decisionEngine.action.toUpperCase()} {currentRecommendation.outcomeLabel}</h2>
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

                <section className="panel-card terminal-card compact-card">
                  <div className="panel-heading">
                    <p className="eyebrow">AI Recommendations</p>
                    <h2>Reasoning</h2>
                  </div>
                  <div className="decision-rationale-grid compact-preview-grid">
                    <article>
                      <span>Combined</span>
                      <strong>{formatPercent(currentRecommendation.combinedConfidence)}</strong>
                    </article>
                    <article>
                      <span>Model</span>
                      <strong>{formatPercent(currentRecommendation.modelConfidence)}</strong>
                    </article>
                    <article>
                      <span>LLM</span>
                      <strong>{formatPercent(currentRecommendation.llmConfidence)}</strong>
                    </article>
                    <article>
                      <span>Agreement</span>
                      <strong>{currentRecommendation.agreementWithModel ? 'Aligned' : 'Divergent'}</strong>
                    </article>
                  </div>
                  <p className="terminal-copy">{currentRecommendation.keyRisk}</p>
                  {currentRecommendation.reasons?.length ? (
                    <ul className="reason-list compact-reason-list">
                      {currentRecommendation.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              </>
            ) : (
              <p className="empty-state">Run the decision engine to populate AI recommendations.</p>
            )}

            {analysis ? (
              <section className="analysis-card terminal-analysis-card">
                <p className="eyebrow">Realtime Updates</p>
                <h2>AI Operator Notes</h2>
                <pre>{analysis}</pre>
              </section>
            ) : null}
          </section>
        </aside>
      </section>

      <section className="dashboard-footer-grid">
        <section className="panel-card terminal-card active-positions-card">
        <div className="panel-heading panel-heading-inline">
          <div>
            <p className="eyebrow">Active Trades</p>
            <h2>Active tracked positions</h2>
          </div>
          <div className="action-row">
            <span className="market-chip">{activeTradeIntents.length} tracking</span>
            <button
              type="button"
              className="secondary-button secondary-button-muted"
              onClick={() => void handlePollActivePositions()}
              disabled={activeTradeIntents.length === 0 || isPollingTracking}
            >
              {isPollingTracking ? 'Polling...' : 'Poll Now'}
            </button>
          </div>
        </div>

        {activeTradeIntents.length === 0 ? (
          <p className="empty-state">No active tracked positions yet.</p>
        ) : (
          <div className="active-positions-grid compact-active-grid">
            {activeTradeIntents.map((intent) => {
              const currentProbability = intent.monitoring?.currentProbability ?? intent.recommendation?.currentProbability ?? null;
              const entryProbability = intent.monitoring?.entryProbability ?? intent.executionRequest?.entryProbability ?? null;
              const monitoringState = intent.monitoring?.state ?? 'active';
              const drift = typeof currentProbability === 'number' && typeof entryProbability === 'number'
                ? currentProbability - entryProbability
                : null;
              const unrealizedPnl = estimateTrackedPnl(intent, currentProbability, entryProbability);
              const pnlClassName = typeof unrealizedPnl.dollars === 'number'
                ? unrealizedPnl.dollars >= 0
                  ? 'pnl-positive'
                  : 'pnl-negative'
                : '';

              return (
                <article key={intent.id} className="active-position-item">
                  <div className="panel-heading panel-heading-inline">
                    <div>
                      <p className="eyebrow">{intent.eventTitle ?? intent.eventSlug}</p>
                      <h2>{intent.outcomeLabel} in {intent.marketQuestion}</h2>
                    </div>
                    <span className={getMonitoringStateChipClass(monitoringState)}>{formatMonitoringStateLabel(monitoringState)}</span>
                  </div>

                  <div className="trade-preview-grid">
                    <article>
                      <span>Current probability</span>
                      <strong>{formatPercent(currentProbability)}</strong>
                    </article>
                    <article>
                      <span>Entry probability</span>
                      <strong>{formatPercent(entryProbability)}</strong>
                    </article>
                    <article>
                      <span>Drift from entry</span>
                      <strong>{formatSignedPercent(drift)}</strong>
                    </article>
                    <article>
                      <span>Unrealized P/L</span>
                      <strong className={pnlClassName}>
                        {formatSignedCurrency(unrealizedPnl.dollars)}
                        {typeof unrealizedPnl.percent === 'number' ? ` (${formatSignedPercent(unrealizedPnl.percent)})` : ''}
                      </strong>
                    </article>
                    <article>
                      <span>Stop-loss</span>
                      <strong>{formatPercent(intent.monitoring?.stopLossProbability)}</strong>
                    </article>
                    <article>
                      <span>Take-profit</span>
                      <strong>{formatPercent(intent.monitoring?.takeProfitProbability)}</strong>
                    </article>
                    <article>
                      <span>Last evaluation</span>
                      <strong>{formatDateTime(intent.monitoring?.lastEvaluationAt)}</strong>
                    </article>
                    <article>
                      <span>Entry order</span>
                      <strong>{formatOrderId(intent.executionRequest?.venueOrderId)}</strong>
                    </article>
                    <article>
                      <span>Shares filled</span>
                      <strong>{typeof intent.position?.sharesFilled === 'number' ? intent.position.sharesFilled.toFixed(2) : 'n/a'}</strong>
                    </article>
                  </div>

                  <p className="trade-status-copy">{intent.monitoring?.notes ?? 'Monitoring live price movement.'}</p>

                  <div className="trade-history-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleSellTrackedIntent(intent)}
                      disabled={isMutatingHistory}
                    >
                      Sell Now
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void handleStopTrackedIntent(intent)}
                      disabled={isMutatingHistory}
                    >
                      Stop Trade
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void handleRestoreTradeIntent(intent)}
                      disabled={isMutatingHistory}
                    >
                      Open Intent
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        </section>

        <section className="panel-card terminal-card trade-history-card footer-history-card">
          <div className="panel-heading panel-heading-inline">
            <div>
              <p className="eyebrow">Active Trades</p>
              <h2>Recent trade intents</h2>
            </div>
            <span className="market-chip">{tradeHistory.length} saved</span>
          </div>

          {tradeHistory.length === 0 ? (
            <p className="empty-state">No confirmed trade intents yet.</p>
          ) : (
            <div className="trade-history-list terminal-list">
              {tradeHistory.map((intent) => (
                <article key={intent.id} className="trade-history-item">
                  {(() => {
                    const precheckMessage = getExecutePrecheckMessage(intent);

                    return (
                      <>
                  <button
                    type="button"
                    className="trade-history-main"
                    onClick={() => void handleRestoreTradeIntent(intent)}
                  >
                    <strong>{intent.eventTitle ?? intent.eventSlug}</strong>
                    <span>{intent.outcomeLabel} in {intent.marketQuestion}</span>
                    <span>
                      {formatCurrency(intent.tradeAmount)} · stop {formatPercent(intent.tradeSuggestion?.stopLossProbability)} · take {formatPercent(intent.tradeSuggestion?.takeProfitProbability)}
                    </span>
                    <small>
                      {formatIntentStatus(intent)} · {formatDateTime(intent.confirmedAt)}
                    </small>
                    {intent.executionRequest?.venueOrderId ? (
                      <small>
                        Entry order {formatOrderId(intent.executionRequest.venueOrderId)} · submitted {formatDateTime(intent.executionRequest.executedAt)}
                      </small>
                    ) : null}
                    {intent.exitRequest?.venueOrderId ? (
                      <small>
                        Exit order {formatOrderId(intent.exitRequest.venueOrderId)} · submitted {formatDateTime(intent.exitRequest.executedAt)}
                      </small>
                    ) : null}
                    {intent.executionRequest?.readyForExecution ? (
                      <small>
                        Request ready · {intent.executionRequest.orderType} · {intent.executionRequest.side}
                      </small>
                    ) : null}
                    {intent.monitoring?.state ? (
                      <small>
                        Monitor {intent.monitoring.state} · stop {formatPercent(intent.monitoring.stopLossProbability)} · take {formatPercent(intent.monitoring.takeProfitProbability)}
                      </small>
                    ) : null}
                    {precheckMessage ? (
                      <small>{precheckMessage}</small>
                    ) : null}
                  </button>
                  <div className="trade-history-actions">
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
                      {intent.status === 'tracking' ? 'Actively Trading' : 'Start Trading'}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void handleDeleteTradeIntent(intent.id)}
                      disabled={isMutatingHistory}
                    >
                      Delete
                    </button>
                  </div>
                      </>
                    );
                  })()}
                </article>
              ))}
            </div>
          )}
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

            <p className="modal-copy">Review the Step 7 draft before Step 8 risk controls and Step 9 execution wiring.</p>

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
              {decisionEngine.recommendation.reasons.length > 0 ? (
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
    </main>
  );
}