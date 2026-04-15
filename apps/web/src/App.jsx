import { useEffect, useState, useTransition } from 'react';

import { analyzeEvent, fetchActiveEvents, fetchStatus, resolveEvent, resolveEventAggregation } from './lib/api.js';

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

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return `${(value * 100).toFixed(1)}%`;
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

function OutcomeSparkline({ history }) {
  const path = buildSparklinePath(history);

  if (!path) {
    return <div className="sparkline-empty">No history</div>;
  }

  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
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
  const [eventInput, setEventInput] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();
  const visibleMarkets = selectedEvent?.markets.filter(marketHasLivePrices) ?? [];
  const eventHeadline = selectedEvent ? getEventHeadline(selectedEvent, visibleMarkets) : null;

  useEffect(() => {
    let isCancelled = false;

    async function loadInitialData() {
      try {
        const [nextStatus, nextEvents] = await Promise.all([fetchStatus(), fetchActiveEvents(5)]);

        if (isCancelled) {
          return;
        }

        setStatus(nextStatus);
        setActiveEvents(nextEvents);
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
    setAnalysis('');

    try {
      const [event, analytics] = await Promise.all([
        resolveEvent(submittedInput),
        resolveEventAggregation(submittedInput)
      ]);
      setSelectedEvent(event);
      setAggregation(analytics.aggregation ?? null);
      setStatisticalModel(analytics.statisticalModel ?? null);
      setEventInput(submittedInput);
    } catch (resolveError) {
      setSelectedEvent(null);
      setAggregation(null);
      setStatisticalModel(null);
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

  function handleAnalyze() {
    if (!selectedEvent?.slug) {
      return;
    }

    setError('');

    startTransition(async () => {
      try {
        const result = await analyzeEvent(selectedEvent.slug);
        setAnalysis(result.analysis);
      } catch (analysisError) {
        setError(analysisError instanceof Error ? analysisError.message : 'Unable to run AI analysis');
      }
    });
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
              <p className="eyebrow">Steps 4 and 5</p>
              <h2>{selectedEvent ? selectedEvent.title : 'Resolve an event to inspect its markets'}</h2>
            </div>
            <button type="button" className="secondary-button" onClick={handleAnalyze} disabled={!selectedEvent || isPending}>
              Test AI on Event
            </button>
          </div>

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
                {visibleMarkets.map((market) => (
                  <section key={market.conditionId ?? market.question} className="market-card">
                    <div className="market-card-header">
                      <h3>{market.question}</h3>
                      <div className="market-chip-row">
                        <span className="market-chip">{market.outcomes.length} outcomes</span>
                        <span className="market-chip">Vol {formatCompactNumber(market.volume)}</span>
                        <span className="market-chip">Liq {formatCompactNumber(market.liquidity)}</span>
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
    </main>
  );
}