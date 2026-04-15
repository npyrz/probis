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
  resolveEvent,
  resolveEventAggregation,
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isInvalidating, setIsInvalidating] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSavingTradeIntent, setIsSavingTradeIntent] = useState(false);
  const [isMutatingHistory, setIsMutatingHistory] = useState(false);
  const [isPending, startTransition] = useTransition();
  const visibleMarkets = selectedEvent?.markets.filter(marketHasLivePrices) ?? [];
  const eventHeadline = selectedEvent ? getEventHeadline(selectedEvent, visibleMarkets) : null;
  const rankedMarkets = filterAndSortMarkets(visibleMarkets, aggregation, statisticalModel, sortBy, filterBy);
  const selectedMarket = visibleMarkets.find((market) => market.conditionId === selectedMarketId) ?? rankedMarkets[0]?.market ?? null;
  const selectedHistoricalMarket = selectedMarket ? findHistoricalMarket(aggregation, selectedMarket.conditionId) : null;
  const selectedModelMarket = selectedMarket ? getModelMarket(statisticalModel, selectedMarket.conditionId) : null;
  const recommendedMarket = getRecommendedMarket(selectedEvent, decisionEngine);
  const tradeSuggestion = buildTradeSuggestion(decisionEngine, tradeAmount, riskInputs);

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
      } else {
        setAnalysis('');
        setDecisionEngine(null);
      }

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

      if (tradeDraft?.id === intentId) {
        handleClearTradeDraft();
      } else {
        setNotice('Deleted saved trade intent.');
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete trade intent');
    } finally {
      setIsMutatingHistory(false);
    }
  }

  async function handleExecuteTradeIntent(intent) {
    setError('');
    setNotice('');
    setIsMutatingHistory(true);

    try {
      const nextIntent = await executeTradeIntentRequest(intent.id);
      setTradeHistory((previous) => replaceIntentInList(previous, nextIntent));

      if (tradeDraft?.id === nextIntent.id) {
        setTradeDraft(nextIntent);
        saveStoredTradeDraft(nextIntent);
      }

      setNotice('Execution request prepared and monitoring state activated.');
    } catch (executeError) {
      setError(executeError instanceof Error ? executeError.message : 'Unable to start trade monitoring');
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
              eventTitle: payload.eventTitle
            })
          : await createTradeIntent(payload);

        setTradeDraft(savedIntent);
        setTradeHistory((previous) => [savedIntent, ...previous.filter((intent) => intent.id !== savedIntent.id)].slice(0, 6));
        saveStoredTradeDraft(savedIntent);
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
    <main className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Steps 4 and 5 live</p>
          <h1>Resolve an event and inspect its live market board.</h1>
          <p className="lede">
            The app now resolves a Polymarket event, surfaces event-level context, and displays live quoted
            outcomes in a market board that stays readable for both binary and multi-outcome structures.
          </p>
        </div>

        <div className="status-grid">
          <article>
            <span>Polymarket Read API</span>
            <strong>{status?.polymarket?.publicReadOk ? 'Reachable' : 'Checking...'}</strong>
            <p>
              {status?.polymarket?.auth?.privateKeyValid
                ? 'Private key parses for CLOB auth checks.'
                : 'Gamma reads work even when CLOB auth is not ready.'}
            </p>
          </article>
          <article>
            <span>Ollama</span>
            <strong>{status?.ai?.reachable ? status.ai.resolvedModel ?? 'Reachable' : 'Unavailable'}</strong>
            <p>Requested model: {status?.ai?.requestedModel ?? 'n/a'}</p>
          </article>
          <article>
            <span>Event Input</span>
            <strong>{selectedEvent ? selectedEvent.slug : 'Waiting for lookup'}</strong>
            <p>Paste a full Polymarket event URL or just the slug.</p>
          </article>
        </div>
      </section>

      <section className="control-card">
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
              {isPending ? 'Loading...' : 'Resolve Event'}
            </button>
          </div>
        </form>

        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="content-grid">
        <article className="panel-card">
          <div className="panel-heading">
            <p className="eyebrow">Step 2</p>
            <h2>High-volume active events</h2>
          </div>
          <div className="event-list">
            {activeEvents.map((event) => (
              <button key={event.slug} className="event-list-item" onClick={() => handleUseEvent(event.slug)}>
                <strong>{event.title}</strong>
                <span>{event.markets.length} markets</span>
              </button>
            ))}
          </div>
        </article>

        <article className="panel-card panel-card-wide">
          <div className="panel-heading panel-heading-inline">
            <div>
              <p className="eyebrow">Steps 4 through 7</p>
              <h2>{selectedEvent ? selectedEvent.title : 'Resolve an event to inspect its markets'}</h2>
            </div>
            <div className="action-row">
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
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleInvalidateCache('all')}
                disabled={isRefreshing || isInvalidating}
              >
                Clear All Cache
              </button>
            </div>
          </div>

          {notice ? <p className="notice-banner">{notice}</p> : null}

          {selectedEvent ? (
            <>
              <section className="event-summary-card">
                <div className="event-summary-copy">
                  <p className="event-meta">
                    slug: {selectedEvent.slug}
                    {selectedEvent.resolvedFromFallback ? ` · matched from ${selectedEvent.requestedSlug}` : ''}
                  </p>
                  <p className="event-description">
                    {selectedEvent.description || 'No event description is available for this market.'}
                  </p>
                </div>

                <div className="event-summary-stats">
                  <article>
                    <span>Live Markets</span>
                    <strong>{visibleMarkets.length}</strong>
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

                {aggregation ? (
                  <div className="derived-metrics-grid">
                    <article>
                      <span>Most Active Market</span>
                      <strong>{aggregation.derivedMetrics.highestVolumeMarket?.question ?? 'n/a'}</strong>
                    </article>
                    <article>
                      <span>Most Competitive</span>
                      <strong>{aggregation.derivedMetrics.mostCompetitiveMarket?.question ?? 'n/a'}</strong>
                    </article>
                    <article>
                      <span>Top Outcome</span>
                      <strong>
                        {aggregation.derivedMetrics.topOutcome
                          ? `${aggregation.derivedMetrics.topOutcome.label} · ${formatPercent(aggregation.derivedMetrics.topOutcome.probability)}`
                          : 'n/a'}
                      </strong>
                    </article>
                    <article>
                      <span>Avg Liquidity / Live Market</span>
                      <strong>{formatCompactNumber(aggregation.derivedMetrics.averageLiquidityPerLiveMarket)}</strong>
                    </article>
                  </div>
                ) : null}

                {statisticalModel?.summary?.bestOpportunity ? (
                  <div className="model-highlight">
                    <span>Step 6.1 Statistical Edge</span>
                    <strong>{statisticalModel.summary.bestOpportunity.question}</strong>
                    <p>
                      {statisticalModel.summary.bestOpportunity.label} est. true probability{' '}
                      {formatPercent(statisticalModel.summary.bestOpportunity.estimatedProbability)} vs market{' '}
                      {formatPercent(statisticalModel.summary.bestOpportunity.currentProbability)}.
                    </p>
                    <p>
                      Edge {formatSignedPercent(statisticalModel.summary.bestOpportunity.edge)} · confidence{' '}
                      {formatPercent(statisticalModel.summary.bestOpportunity.confidence)}
                    </p>
                  </div>
                ) : null}

                {decisionEngine?.recommendation ? (
                  <div className="decision-highlight">
                    <span>Steps 6.3 and 7</span>
                    <strong>
                      {decisionEngine.action.toUpperCase()} {decisionEngine.recommendation.outcomeLabel} in{' '}
                      {decisionEngine.recommendation.marketQuestion}
                    </strong>
                    <p>
                      Combined confidence {formatPercent(decisionEngine.recommendation.combinedConfidence)} · edge{' '}
                      {formatSignedPercent(decisionEngine.recommendation.edge)} · EV{' '}
                      {formatSignedPercent(decisionEngine.recommendation.expectedValuePerDollar)} per $1
                    </p>
                    <p>{decisionEngine.recommendation.thesis}</p>
                  </div>
                ) : null}

                {eventHeadline ? (
                  <div className="event-highlight">
                    <span>Highest-conviction live market</span>
                    <strong>{eventHeadline.market.question}</strong>
                    <p>
                      {eventHeadline.leader.label} leads at {formatPercent(eventHeadline.leader.probability)}.
                    </p>
                  </div>
                ) : null}
              </section>

              <div className="market-grid">
                <div className="market-toolbar">
                  <label>
                    Sort by
                    <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                      <option value="modelEdge">Model edge</option>
                      <option value="confidence">Confidence</option>
                      <option value="liquidity">Liquidity</option>
                      <option value="momentum">Momentum</option>
                    </select>
                  </label>
                  <label>
                    Filter
                    <select value={filterBy} onChange={(event) => setFilterBy(event.target.value)}>
                      <option value="all">All live markets</option>
                      <option value="positive-edge">Positive edge only</option>
                      <option value="high-confidence">High confidence</option>
                      <option value="positive-momentum">Positive momentum</option>
                    </select>
                  </label>
                </div>
                {rankedMarkets.length === 0 ? (
                  <p className="empty-state market-empty-state">No markets match the current filter.</p>
                ) : null}
                {rankedMarkets.map(({ market, metrics }) => (
                  <section
                    key={market.conditionId ?? market.question}
                    className={`market-card ${selectedMarket?.conditionId === market.conditionId ? 'market-card-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedMarketId(market.conditionId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedMarketId(market.conditionId);
                      }
                    }}
                  >
                    <div className="market-card-header">
                      <h3>{market.question}</h3>
                      <div className="market-chip-row">
                        <span className="market-chip">{market.outcomes.length} outcomes</span>
                        <span className="market-chip">Vol {formatCompactNumber(market.volume)}</span>
                        <span className="market-chip">Liq {formatCompactNumber(market.liquidity)}</span>
                        <span className="market-chip">Edge {formatSignedPercent(metrics.modelEdge)}</span>
                        <span className="market-chip">Conf {formatPercent(metrics.confidence)}</span>
                      </div>
                    </div>
                    <div className="outcome-list">
                      {sortOutcomes(market.outcomes).map((outcome) => {
                        const historicalMarket = findHistoricalMarket(aggregation, market.conditionId);
                        const historicalOutcome = historicalMarket?.outcomes?.find(
                          (candidate) => candidate.label === outcome.label
                        );

                        return (
                          <div key={`${market.conditionId}-${outcome.label}`} className="outcome-row">
                            <div className="outcome-copy">
                              <span>{outcome.label}</span>
                              <small>
                                7d move {formatSignedPercent(historicalOutcome?.historySummary?.percentChange)}
                              </small>
                              <OutcomeSparkline history={historicalOutcome?.history ?? []} />
                            </div>
                            <div className="outcome-value">
                              <strong>{formatPercent(outcome.probability)}</strong>
                              <div className="outcome-bar-track" aria-hidden="true">
                                <div
                                  className="outcome-bar-fill"
                                  style={{ width: `${Math.max(0, Math.min(100, (outcome.probability ?? 0) * 100))}%` }}
                                />
                              </div>
                              {statisticalModel ? (
                                <small className="model-estimate">
                                  model{' '}
                                  {formatPercent(
                                    statisticalModel.markets
                                      ?.find((candidate) => candidate.conditionId === market.conditionId)
                                      ?.outcomes?.find((candidate) => candidate.label === outcome.label)
                                      ?.estimatedProbability
                                  )}
                                </small>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>

              {selectedMarket ? (
                <section className="market-detail-card">
                  <div className="panel-heading panel-heading-inline">
                    <div>
                      <p className="eyebrow">Market Drilldown</p>
                      <h2>{selectedMarket.question}</h2>
                    </div>
                    <div className="market-chip-row">
                      <span className="market-chip">Liq {formatCompactNumber(selectedMarket.liquidity)}</span>
                      <span className="market-chip">Vol {formatCompactNumber(selectedMarket.volume)}</span>
                      <span className="market-chip">Conf {formatPercent(selectedModelMarket?.confidence)}</span>
                    </div>
                  </div>

                  <div className="detail-grid">
                    {sortOutcomes(selectedMarket.outcomes).map((outcome) => {
                      const historicalOutcome = selectedHistoricalMarket?.outcomes?.find(
                        (candidate) => candidate.label === outcome.label
                      );
                      const modelOutcome = selectedModelMarket?.outcomes?.find(
                        (candidate) => candidate.label === outcome.label
                      );

                      return (
                        <article key={`${selectedMarket.conditionId}-${outcome.label}`} className="detail-outcome-card">
                          <div className="detail-outcome-header">
                            <strong>{outcome.label}</strong>
                            <span>{formatPercent(outcome.probability)}</span>
                          </div>
                          <OutcomeSparkline history={historicalOutcome?.history ?? []} className="sparkline sparkline-large" />
                          <div className="detail-metrics">
                            <span>Model probability</span>
                            <strong>{formatPercent(modelOutcome?.estimatedProbability)}</strong>
                            <span>Edge</span>
                            <strong>{formatSignedPercent(modelOutcome?.edge)}</strong>
                            <span>7d move</span>
                            <strong>{formatSignedPercent(historicalOutcome?.historySummary?.percentChange)}</strong>
                            <span>Point count</span>
                            <strong>{historicalOutcome?.historySummary?.pointCount ?? 'n/a'}</strong>
                          </div>
                        </article>
                      );
                    })}
                  </div>

                  {decisionEngine?.recommendation?.marketQuestion === selectedMarket.question ? (
                    <div className="detail-callout">
                      <span>Decision engine rationale</span>
                      <strong>{decisionEngine.recommendation.outcomeLabel}</strong>
                      <div className="decision-rationale-grid">
                        <article>
                          <span>Combined confidence</span>
                          <strong>{formatPercent(decisionEngine.recommendation.combinedConfidence)}</strong>
                        </article>
                        <article>
                          <span>Model confidence</span>
                          <strong>{formatPercent(decisionEngine.recommendation.modelConfidence)}</strong>
                        </article>
                        <article>
                          <span>LLM confidence</span>
                          <strong>{formatPercent(decisionEngine.recommendation.llmConfidence)}</strong>
                        </article>
                        <article>
                          <span>Agreement</span>
                          <strong>{decisionEngine.recommendation.agreementWithModel ? 'Aligned' : 'Divergent'}</strong>
                        </article>
                      </div>
                      <p>{decisionEngine.recommendation.thesis}</p>
                      <p>Risk: {decisionEngine.recommendation.keyRisk}</p>
                      {decisionEngine.recommendation.reasons.length > 0 ? (
                        <ul className="reason-list">
                          {decisionEngine.recommendation.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {recommendedMarket && decisionEngine?.recommendation ? (
                    <section className="trade-suggestion-card">
                      <div className="panel-heading panel-heading-inline">
                        <div>
                          <p className="eyebrow">Step 7 Trade Suggestion</p>
                          <h2>
                            {decisionEngine.action.toUpperCase()} {decisionEngine.recommendation.outcomeLabel} in{' '}
                            {decisionEngine.recommendation.marketQuestion}
                          </h2>
                        </div>
                        {recommendedMarket.conditionId !== selectedMarket?.conditionId ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setSelectedMarketId(recommendedMarket.conditionId)}
                          >
                            Jump to Recommended Market
                          </button>
                        ) : null}
                      </div>

                      <div className="trade-input-row">
                        <label>
                          Enter amount to invest
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={tradeAmount}
                            onChange={(event) => setTradeAmount(event.target.value)}
                          />
                        </label>
                        <label>
                          Stop-loss probability
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
                          Take-profit probability
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
                        <div className="market-chip-row">
                          <span className="market-chip">Entry {formatPercent(decisionEngine.recommendation.currentProbability)}</span>
                          <span className="market-chip">Model {formatPercent(decisionEngine.recommendation.modelProbability)}</span>
                          <span className="market-chip">EV {formatSignedPercent(decisionEngine.recommendation.expectedValuePerDollar)}</span>
                          <span className="market-chip">Stake {formatPercent(decisionEngine.recommendation.suggestedStakeFraction)}</span>
                          <span className="market-chip">Stop {formatPercent(decisionEngine.recommendation.stopLossProbability)}</span>
                          <span className="market-chip">Take {formatPercent(decisionEngine.recommendation.takeProfitProbability)}</span>
                        </div>
                      </div>

                      {tradeSuggestion ? (
                        <div className="trade-preview-grid">
                          <article>
                            <span>Expected profit</span>
                            <strong>{formatCurrency(tradeSuggestion.expectedProfit)}</strong>
                          </article>
                          <article>
                            <span>Profit if correct</span>
                            <strong>{formatCurrency(tradeSuggestion.profitIfCorrect)}</strong>
                          </article>
                          <article>
                            <span>Gross payout</span>
                            <strong>{formatCurrency(tradeSuggestion.grossPayout)}</strong>
                          </article>
                          <article>
                            <span>Estimated shares</span>
                            <strong>{typeof tradeSuggestion.shares === 'number' ? tradeSuggestion.shares.toFixed(2) : 'n/a'}</strong>
                          </article>
                          <article>
                            <span>Break-even probability</span>
                            <strong>{formatPercent(tradeSuggestion.breakEvenProbability)}</strong>
                          </article>
                          <article>
                            <span>Sizing hint</span>
                            <strong>{tradeSuggestion.bankrollHint}</strong>
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
                            <span>Loss at stop</span>
                            <strong>{formatCurrency(tradeSuggestion.stopLossLoss)}</strong>
                          </article>
                          <article>
                            <span>Gain at take-profit</span>
                            <strong>{formatCurrency(tradeSuggestion.takeProfitGain)}</strong>
                          </article>
                          <article>
                            <span>Risk / reward</span>
                            <strong>{tradeSuggestion.riskRewardRatio ? `${tradeSuggestion.riskRewardRatio.toFixed(2)}x` : 'n/a'}</strong>
                          </article>
                        </div>
                      ) : (
                        <p className="empty-state">Enter a positive dollar amount to preview the trade suggestion.</p>
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
                        {tradeDraft?.confirmedAt ? (
                          <p className="trade-status-copy">
                            {tradeDraft.status === 'tracking' ? 'Tracking' : 'Confirmed'} {formatDate(tradeDraft.confirmedAt)}
                          </p>
                        ) : (
                          <p className="trade-status-copy">Draft autosaves and survives refresh.</p>
                        )}
                      </div>
                    </section>
                  ) : null}

                  <section className="trade-history-card">
                    <div className="panel-heading panel-heading-inline">
                      <div>
                        <p className="eyebrow">Saved Drafts</p>
                        <h2>Recent trade intents</h2>
                      </div>
                      <span className="market-chip">{tradeHistory.length} saved</span>
                    </div>

                    {tradeHistory.length === 0 ? (
                      <p className="empty-state">No confirmed trade intents yet.</p>
                    ) : (
                      <div className="trade-history-list">
                        {tradeHistory.map((intent) => (
                          <article key={intent.id} className="trade-history-item">
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
                                {intent.status === 'tracking' ? 'Tracking' : 'Confirmed'} · {formatDateTime(intent.confirmedAt)}
                              </small>
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
                              >
                                {intent.status === 'tracking' ? 'Tracking' : 'Start Tracking'}
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
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                </section>
              ) : null}
            </>
          ) : (
            <p className="empty-state">No event loaded yet.</p>
          )}

          {analysis ? (
            <section className="analysis-card">
              <p className="eyebrow">AI Smoke Test</p>
              <pre>{analysis}</pre>
            </section>
          ) : null}
        </article>
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