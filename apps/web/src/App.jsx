import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  fetchChicagoAlerts,
  fetchChicagoMarketCatalog,
  fetchChicagoSnapshot,
  repriceChicagoMarkets
} from './lib/api.js';

const DEFAULT_CATALOG_DAYS_AHEAD = 7;
const DEFAULT_KMDW_SNAPSHOT_POLL_INTERVAL_MS = 180000;

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatPercent(value, digits = 1) {
  const number = numberOrNull(value);
  return number === null ? 'n/a' : `${(number * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value, digits = 1) {
  const number = numberOrNull(value);

  if (number === null) {
    return 'n/a';
  }

  return `${number > 0 ? '+' : ''}${(number * 100).toFixed(digits)}%`;
}

function formatPrice(value) {
  const number = numberOrNull(value);
  return number === null ? 'n/a' : `$${number.toFixed(3)}`;
}

function formatCompactNumber(value) {
  const number = numberOrNull(value);

  if (number === null) {
    return 'n/a';
  }

  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(number);
}

function formatTemperature(value) {
  const number = numberOrNull(value);
  return number === null ? 'n/a' : `${number.toFixed(1)} F`;
}

function formatDate(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
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

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
}

function formatRelativeAge(value, now = new Date()) {
  if (!value) {
    return 'n/a';
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  const seconds = Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 1000));

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatBucketLabel(bucket) {
  if (!bucket) {
    return 'Bucket';
  }

  if (typeof bucket.lowTemp === 'number' && typeof bucket.highTemp === 'number') {
    return bucket.lowTemp === bucket.highTemp
      ? `${bucket.lowTemp} F`
      : `${bucket.lowTemp}-${bucket.highTemp} F`;
  }

  if (typeof bucket.lowTemp === 'number') {
    return `${bucket.lowTemp} F+`;
  }

  if (typeof bucket.highTemp === 'number') {
    return `${bucket.highTemp} F or lower`;
  }

  return bucket.outcomeLabel ?? bucket.marketTitle ?? bucket.marketQuestion ?? 'Bucket';
}

function formatAction(recommendation) {
  if (!recommendation) {
    return 'NO SIGNAL';
  }

  return recommendation.action === 'recommend-buy-yes' ? 'BUY YES' : 'WATCH';
}

function formatStatus(value) {
  const text = String(value ?? 'unranked').trim();

  if (!text) {
    return 'UNRANKED';
  }

  return text
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatMarketDataMode(policy) {
  if (policy?.transport === 'polling' && policy?.streamingEnabled === false) {
    return 'POLLING';
  }

  return policy?.transport ? String(policy.transport).toUpperCase() : 'POLLING';
}

function getPollingIntervalMs(snapshot) {
  const value = Number.parseInt(
    String(snapshot?.marketDataPolicy?.polling?.kmdwSnapshotPollIntervalMs ?? ''),
    10
  );

  return Number.isFinite(value) && value > 0 ? value : DEFAULT_KMDW_SNAPSHOT_POLL_INTERVAL_MS;
}

function getToneClass(value) {
  const number = numberOrNull(value);

  if (number === null) {
    return 'metric-neutral';
  }

  if (number > 0.002) {
    return 'metric-good';
  }

  if (number < -0.002) {
    return 'metric-bad';
  }

  return 'metric-neutral';
}

function getMarketUrl(row) {
  if (row?.eventSlug) {
    return `https://polymarket.us/event/${row.eventSlug}`;
  }

  if (row?.marketSlug) {
    return `https://polymarket.us/market/${row.marketSlug}`;
  }

  return null;
}

function getActiveAlerts(alerts) {
  if (Array.isArray(alerts?.alerts)) {
    return alerts.alerts;
  }

  if (Array.isArray(alerts)) {
    return alerts;
  }

  return [];
}

function getAlertCount(alerts) {
  const activeAlerts = getActiveAlerts(alerts);
  return alerts?.summary?.activeCount ?? alerts?.activeCount ?? activeAlerts.length;
}

function getVerificationLabel(bucket) {
  if (bucket?.designatedSource?.verified === true) {
    return 'VERIFIED';
  }

  if (bucket?.ruleFlags?.hasKmdwSource === true && bucket?.ruleFlags?.ruleAmbiguity !== true) {
    return 'KMDW RULES';
  }

  return 'REVIEW';
}

function buildRankedBetRows(snapshot) {
  const buckets = Array.isArray(snapshot?.markets?.buckets) ? snapshot.markets.buckets : [];
  const recommendations = Array.isArray(snapshot?.recommendations?.recommendations)
    ? snapshot.recommendations.recommendations
    : [];
  const bucketById = new Map(buckets.map((bucket) => [bucket.conditionId, bucket]));
  const recommendationById = new Map(recommendations.map((recommendation) => [recommendation.conditionId, recommendation]));
  const conditionIds = new Set([
    ...buckets.map((bucket) => bucket.conditionId),
    ...recommendations.map((recommendation) => recommendation.conditionId)
  ]);

  return [...conditionIds]
    .filter(Boolean)
    .map((conditionId) => {
      const bucket = bucketById.get(conditionId) ?? {};
      const recommendation = recommendationById.get(conditionId) ?? null;
      const fairProbability = numberOrNull(recommendation?.fairProbability)
        ?? numberOrNull(snapshot?.prediction?.bucketProbabilities?.[conditionId]);
      const marketPrice = numberOrNull(recommendation?.marketPrice)
        ?? numberOrNull(bucket.bestAsk)
        ?? numberOrNull(bucket.marketProbability);
      const edge = numberOrNull(recommendation?.edge)
        ?? (fairProbability !== null && marketPrice !== null ? fairProbability - marketPrice : null);
      const riskAdjustedEdge = numberOrNull(recommendation?.riskAdjustedEdge) ?? edge;
      const score = numberOrNull(recommendation?.score);

      return {
        conditionId,
        marketSlug: recommendation?.marketSlug ?? bucket.marketSlug ?? null,
        eventSlug: bucket.eventSlug ?? null,
        eventTitle: bucket.eventTitle ?? null,
        marketQuestion: bucket.marketQuestion ?? bucket.marketTitle ?? recommendation?.outcomeLabel ?? '',
        label: formatBucketLabel(recommendation ?? bucket),
        action: formatAction(recommendation),
        status: recommendation?.status ?? 'unranked',
        fairProbability,
        marketPrice,
        edge,
        riskAdjustedEdge,
        score,
        maxEntryPrice: numberOrNull(recommendation?.maxEntryPrice),
        bestBid: numberOrNull(bucket.bestBid),
        bestAsk: numberOrNull(bucket.bestAsk),
        marketProbability: numberOrNull(bucket.marketProbability),
        spread: numberOrNull(bucket.spread),
        liquidity: numberOrNull(bucket.askDepth) ?? numberOrNull(bucket.liquidity),
        volume: numberOrNull(bucket.volume),
        verificationLabel: getVerificationLabel(bucket),
        gates: Array.isArray(recommendation?.gates) ? recommendation.gates : [],
        bucket,
        recommendation
      };
    })
    .sort((left, right) => {
      const leftPassed = left.status === 'passed' ? 1 : 0;
      const rightPassed = right.status === 'passed' ? 1 : 0;

      if (leftPassed !== rightPassed) {
        return rightPassed - leftPassed;
      }

      const leftRankValue = left.score ?? left.riskAdjustedEdge ?? left.edge ?? -Infinity;
      const rightRankValue = right.score ?? right.riskAdjustedEdge ?? right.edge ?? -Infinity;

      return rightRankValue - leftRankValue;
    });
}

function buildCatalogRows(catalog) {
  const dateGroups = Array.isArray(catalog?.dateGroups) ? catalog.dateGroups : [];

  return dateGroups.flatMap((group) => {
    const markets = Array.isArray(group.markets) ? group.markets : [];

    return markets.map((market) => ({
      ...market,
      targetDate: market.targetDate ?? group.targetDate ?? null
    }));
  });
}

function getTemperatureDistributionRows(snapshot) {
  return Object.entries(snapshot?.prediction?.temperatureDistribution ?? {})
    .map(([temperature, probability]) => ({
      temperature: Number.parseInt(temperature, 10),
      probability
    }))
    .filter((row) => Number.isFinite(row.temperature) && typeof row.probability === 'number')
    .sort((left, right) => right.probability - left.probability)
    .slice(0, 8);
}

function Metric({ label, value, tone = 'metric-neutral' }) {
  return (
    <article className="metric-cell">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </article>
  );
}

function GateList({ gates }) {
  if (!Array.isArray(gates) || gates.length === 0) {
    return <span className="chip chip-muted">No gates</span>;
  }

  return (
    <div className="gate-list">
      {gates.map((gate) => (
        <span
          key={gate.name}
          className={gate.passed ? 'chip chip-good' : 'chip chip-bad'}
          title={gate.name}
        >
          {gate.passed ? 'Pass' : 'Block'} {gate.name}
        </span>
      ))}
    </div>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRepricing, setIsRepricing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [clock, setClock] = useState(() => new Date());

  const rankedRows = useMemo(() => buildRankedBetRows(snapshot), [snapshot]);
  const catalogRows = useMemo(() => buildCatalogRows(catalog), [catalog]);
  const temperatureRows = useMemo(() => getTemperatureDistributionRows(snapshot), [snapshot]);
  const activeAlerts = getActiveAlerts(alerts);
  const bestRow = rankedRows[0] ?? null;
  const pollIntervalMs = getPollingIntervalMs(snapshot);
  const marketDataMode = formatMarketDataMode(snapshot?.marketDataPolicy);
  const rankByConditionId = new Map(rankedRows.map((row, index) => [row.conditionId, index + 1]));

  const loadChicagoBoard = useCallback(async ({ force = false, silent = false } = {}) => {
    if (force) {
      setIsRepricing(true);
    } else if (!silent) {
      setIsLoading(true);
    }

    try {
      const nextSnapshot = force ? await repriceChicagoMarkets() : await fetchChicagoSnapshot();
      setSnapshot(nextSnapshot);

      const [catalogResult, alertsResult] = await Promise.allSettled([
        fetchChicagoMarketCatalog({ daysAhead: DEFAULT_CATALOG_DAYS_AHEAD }),
        fetchChicagoAlerts(nextSnapshot?.targetDate, { limit: 8 })
      ]);

      if (catalogResult.status === 'fulfilled') {
        setCatalog(catalogResult.value);
      }

      if (alertsResult.status === 'fulfilled') {
        setAlerts(alertsResult.value);
      }

      setLastRefreshAt(new Date());
      setError('');
    } catch (loadError) {
      if (!silent) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load Chicago weather bets');
      }
    } finally {
      setIsLoading(false);
      setIsRepricing(false);
    }
  }, []);

  useEffect(() => {
    void loadChicagoBoard();
  }, [loadChicagoBoard]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClock(new Date());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadChicagoBoard({ silent: true });
    }, pollIntervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadChicagoBoard, pollIntervalMs]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-cluster">
          <img src="/logo.png" alt="Probis logo" className="brand-logo" />
          <div>
            <p className="eyebrow">Chicago Weather Markets</p>
            <h1>KMDW High Temp Bets</h1>
          </div>
        </div>

        <div className="topbar-actions">
          <span className="timestamp">Updated {formatRelativeAge(lastRefreshAt, clock)}</span>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void loadChicagoBoard()}
            disabled={isLoading || isRepricing}
          >
            {isLoading ? 'Loading' : 'Refresh'}
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void loadChicagoBoard({ force: true })}
            disabled={isLoading || isRepricing}
          >
            {isRepricing ? 'Repricing' : 'Reprice'}
          </button>
        </div>
      </header>

      {error ? <p className="system-banner">{error}</p> : null}

      <section className="summary-grid" aria-label="Chicago weather status">
        <Metric label="Target Date" value={snapshot?.targetDate ?? 'n/a'} />
        <Metric label="Observed High" value={formatTemperature(snapshot?.observations?.observedHighSoFar)} />
        <Metric label="Current KMDW" value={formatTemperature(snapshot?.observations?.currentObservedTemp)} />
        <Metric label="Model Mean" value={formatTemperature(snapshot?.prediction?.expectedHigh)} />
        <Metric label="Best Edge" value={formatSignedPercent(bestRow?.riskAdjustedEdge)} tone={getToneClass(bestRow?.riskAdjustedEdge)} />
        <Metric label="Markets" value={rankedRows.length || 'n/a'} />
        <Metric label="Market Data" value={marketDataMode} />
        <Metric label="Alerts" value={getAlertCount(alerts)} tone={getAlertCount(alerts) > 0 ? 'metric-bad' : 'metric-good'} />
      </section>

      {isLoading && !snapshot ? (
        <section className="empty-panel">
          <p className="eyebrow">Loading</p>
          <h2>Chicago board is loading.</h2>
        </section>
      ) : null}

      {snapshot ? (
        <>
          <section className="board-grid">
            <section className="panel ranking-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Ranking</p>
                  <h2>Current Chicago Weather Bets</h2>
                </div>
                <span className="chip chip-muted">{rankedRows.length} bets</span>
              </div>

              <div className="table-scroll">
                <table className="rank-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Bet</th>
                      <th>Action</th>
                      <th>Fair</th>
                      <th>Entry</th>
                      <th>Edge</th>
                      <th>Score</th>
                      <th>Spread</th>
                      <th>Liquidity</th>
                      <th>Rules</th>
                      <th>Gates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankedRows.map((row, index) => {
                      const marketUrl = getMarketUrl(row);

                      return (
                        <tr key={row.conditionId}>
                          <td>
                            <span className="rank-number">{index + 1}</span>
                          </td>
                          <td className="bet-cell">
                            <strong>{row.label}</strong>
                            <span>{row.marketQuestion || row.eventTitle || row.conditionId}</span>
                            <div className="quote-row">
                              <span>Bid {formatPrice(row.bestBid)}</span>
                              <span>Ask {formatPrice(row.bestAsk)}</span>
                              <span>Max {formatPrice(row.maxEntryPrice)}</span>
                              {marketUrl ? (
                                <a href={marketUrl} target="_blank" rel="noreferrer">
                                  Open
                                </a>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <span className={row.action === 'BUY YES' ? 'chip chip-good' : 'chip chip-muted'}>
                              {row.action}
                            </span>
                            <small>{formatStatus(row.status)}</small>
                          </td>
                          <td>{formatPercent(row.fairProbability)}</td>
                          <td>{formatPrice(row.marketPrice)}</td>
                          <td>
                            <strong className={getToneClass(row.riskAdjustedEdge)}>
                              {formatSignedPercent(row.riskAdjustedEdge)}
                            </strong>
                            <small>raw {formatSignedPercent(row.edge)}</small>
                          </td>
                          <td>{formatPercent(row.score)}</td>
                          <td>{formatSignedPercent(row.spread, 1)}</td>
                          <td>
                            <span>{formatCompactNumber(row.liquidity)}</span>
                            <small>vol {formatCompactNumber(row.volume)}</small>
                          </td>
                          <td>
                            <span className={row.verificationLabel === 'REVIEW' ? 'chip chip-warn' : 'chip chip-good'}>
                              {row.verificationLabel}
                            </span>
                          </td>
                          <td>
                            <GateList gates={row.gates} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {rankedRows.length === 0 ? (
                <p className="empty-copy">No active Chicago weather bets were returned.</p>
              ) : null}
            </section>

            <aside className="side-stack">
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Weather</p>
                    <h2>Model Inputs</h2>
                  </div>
                  <span className={snapshot?.prediction?.sourceFreshness?.isStale ? 'chip chip-warn' : 'chip chip-good'}>
                    {snapshot?.prediction?.sourceFreshness?.isStale ? 'STALE' : 'FRESH'}
                  </span>
                </div>

                <div className="detail-list">
                  <div>
                    <span>Latest Observation</span>
                    <strong>{formatDateTime(snapshot?.observations?.latestObservationAt)}</strong>
                  </div>
                  <div>
                    <span>Settlement</span>
                    <strong>{snapshot?.settlement?.status ?? 'n/a'}</strong>
                  </div>
                  <div>
                    <span>NWS Forecast</span>
                    <strong>{formatTemperature(snapshot?.forecasts?.features?.forecast_max_nws_hourly)}</strong>
                  </div>
                  <div>
                    <span>NBM p50</span>
                    <strong>{formatTemperature(snapshot?.nbm?.features?.nbm_p50)}</strong>
                  </div>
                  <div>
                    <span>Confidence</span>
                    <strong>{formatPercent(snapshot?.prediction?.confidence)}</strong>
                  </div>
                  <div>
                    <span>Blend</span>
                    <strong>{formatPercent(snapshot?.prediction?.marketBlendWeight)}</strong>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Distribution</p>
                    <h2>Top Temperatures</h2>
                  </div>
                </div>

                <div className="distribution-list">
                  {temperatureRows.map((row) => (
                    <div className="distribution-row" key={row.temperature}>
                      <span>{row.temperature} F</span>
                      <div className="distribution-track">
                        <div style={{ width: `${Math.max(2, Math.min(100, row.probability * 100))}%` }} />
                      </div>
                      <strong>{formatPercent(row.probability)}</strong>
                    </div>
                  ))}
                </div>

                {temperatureRows.length === 0 ? (
                  <p className="empty-copy">No temperature distribution is available.</p>
                ) : null}
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Alerts</p>
                    <h2>Chicago Watch</h2>
                  </div>
                  <span className={activeAlerts.length > 0 ? 'chip chip-warn' : 'chip chip-good'}>
                    {activeAlerts.length > 0 ? `${activeAlerts.length} active` : 'Clear'}
                  </span>
                </div>

                <div className="alert-list">
                  {activeAlerts.slice(0, 5).map((alert) => (
                    <article className="alert-row" key={alert.id ?? alert.alertKey ?? alert.title}>
                      <span className={String(alert.severity ?? '').toLowerCase() === 'critical' ? 'chip chip-bad' : 'chip chip-warn'}>
                        {String(alert.severity ?? 'info').toUpperCase()}
                      </span>
                      <div>
                        <strong>{alert.title ?? 'Weather alert'}</strong>
                        <p>{alert.message ?? 'No alert detail available.'}</p>
                        <small>{formatDateTime(alert.triggeredAt)}</small>
                      </div>
                    </article>
                  ))}
                </div>

                {activeAlerts.length === 0 ? (
                  <p className="empty-copy">No active Chicago weather alerts.</p>
                ) : null}
              </section>
            </aside>
          </section>

          <section className="panel catalog-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">All Chicago Weather Bets</p>
                <h2>Current And Upcoming Market Board</h2>
              </div>
              <span className="chip chip-muted">{catalogRows.length} fetched</span>
            </div>

            <div className="table-scroll">
              <table className="catalog-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Bucket</th>
                    <th>Rank</th>
                    <th>Bid</th>
                    <th>Ask</th>
                    <th>Mid</th>
                    <th>Spread</th>
                    <th>Rules</th>
                    <th>Volume</th>
                    <th>Market</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogRows.map((row) => {
                    const rank = rankByConditionId.get(row.conditionId);
                    const marketUrl = getMarketUrl(row);

                    return (
                      <tr key={`${row.targetDate ?? 'undated'}-${row.conditionId ?? row.marketSlug}`}>
                        <td>{row.targetDate ? formatDate(row.targetDate) : 'n/a'}</td>
                        <td className="bet-cell">
                          <strong>{formatBucketLabel(row)}</strong>
                          <span>{row.marketQuestion ?? row.marketTitle ?? row.conditionId}</span>
                        </td>
                        <td>{rank ? `#${rank}` : 'n/a'}</td>
                        <td>{formatPrice(row.bestBid)}</td>
                        <td>{formatPrice(row.bestAsk)}</td>
                        <td>{formatPrice(row.marketProbability ?? row.midpoint)}</td>
                        <td>{formatSignedPercent(row.spread, 1)}</td>
                        <td>
                          <span className={getVerificationLabel(row) === 'REVIEW' ? 'chip chip-warn' : 'chip chip-good'}>
                            {getVerificationLabel(row)}
                          </span>
                        </td>
                        <td>{formatCompactNumber(row.volume)}</td>
                        <td>
                          {marketUrl ? (
                            <a href={marketUrl} target="_blank" rel="noreferrer">
                              Open
                            </a>
                          ) : (
                            'n/a'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {catalogRows.length === 0 ? (
              <p className="empty-copy">No Chicago weather market catalog rows were returned.</p>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
