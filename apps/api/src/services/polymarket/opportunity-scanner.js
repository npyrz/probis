import axios from 'axios';

import { buildStatisticalModel } from './statistical-model.js';

const scannerState = {
  snapshot: createEmptySnapshot(),
  inFlight: null,
  intervalId: null,
  initialized: false
};

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function createEmptySnapshot() {
  return {
    status: 'idle',
    generatedAt: null,
    startedAt: null,
    refreshReason: null,
    error: null,
    config: null,
    universe: {
      requestedLimit: 0,
      totalAvailableMarkets: 0,
      fetchedEventCount: 0,
      scannedEventCount: 0,
      qualifiedEventCount: 0,
      opportunityCount: 0,
      failureCount: 0,
      failures: []
    },
    opportunities: []
  };
}

function normalizeScannerConfig(env) {
  const rawUniverseLimit = Number(env.opportunityScannerUniverseLimit);
  const rawMaxOpportunities = Number(env.opportunityScannerMaxOpportunities);

  return {
    intervalMs: Math.max(60_000, Number(env.opportunityScannerIntervalMs) || 600_000),
    universeLimit: Number.isFinite(rawUniverseLimit) && rawUniverseLimit > 0 ? Math.max(10, rawUniverseLimit) : null,
    batchSize: Math.max(25, Number(env.opportunityScannerBatchSize) || 200),
    concurrency: Math.max(1, Number(env.opportunityScannerConcurrency) || 8),
    maxOpportunities: Number.isFinite(rawMaxOpportunities) && rawMaxOpportunities > 0 ? Math.max(5, rawMaxOpportunities) : null
  };
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

async function fetchScannerUniverse(env, config) {
  const gatewayClient = axios.create({
    baseURL: env.polymarketUsGatewayUrl ?? 'https://gateway.polymarket.us',
    timeout: 15000,
    headers: {
      Accept: 'application/json'
    }
  });
  const events = [];
  const seenSlugs = new Set();
  let offset = 0;

  async function fetchUsGatewayEventsPage(limit, pageOffset) {
    const pathCandidates = ['/events', '/v1/events'];
    let lastError = null;

    for (const path of pathCandidates) {
      try {
        const response = await gatewayClient.get(path, {
          params: {
            active: true,
            closed: false,
            limit,
            offset: pageOffset
          }
        });

        const batch = Array.isArray(response.data)
          ? response.data
          : (Array.isArray(response.data?.events) ? response.data.events : []);

        return batch;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error('Unable to fetch active events from polymarket.us gateway.');
  }

  while (true) {
    const batch = await fetchUsGatewayEventsPage(config.batchSize, offset);

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    for (const event of batch) {
      const slug = String(event?.slug ?? '').trim();

      if (!slug || seenSlugs.has(slug)) {
        continue;
      }

      seenSlugs.add(slug);
      events.push(event);
    }

    if (batch.length < config.batchSize) {
      break;
    }

    offset += batch.length;
  }

  return {
    totalAvailableMarkets: events.length,
    markets: config.universeLimit
      ? events.slice(0, config.universeLimit)
      : events
  };
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function normalizeMarketOutcomes(market) {
  const objectOutcomes = Array.isArray(market?.outcomes)
    ? market.outcomes.filter((outcome) => outcome && typeof outcome === 'object')
    : [];

  if (objectOutcomes.length > 0) {
    return objectOutcomes
      .map((outcome) => {
        const label = String(outcome.label ?? outcome.outcome ?? '').trim();

        if (!label) {
          return null;
        }

        return {
          label,
          tokenId: outcome.tokenId ?? null,
          probability: toNumberOrNull(outcome.probability)
        };
      })
      .filter(Boolean);
  }

  const labels = parseStringArray(market?.outcomes)
    .map((label) => String(label ?? '').trim())
    .filter(Boolean);
  const prices = parseStringArray(market?.outcomePrices).map((price) => toNumberOrNull(price));
  const sidePriceByLabel = new Map();

  if (Array.isArray(market?.marketSides)) {
    for (const side of market.marketSides) {
      const label = String(side?.description ?? '').trim().toLowerCase();
      const price = toNumberOrNull(side?.price);

      if (label && typeof price === 'number') {
        sidePriceByLabel.set(label, price);
      }
    }
  }

  const outcomes = labels.map((label, index) => {
    let probability = toNumberOrNull(prices[index]);

    if (typeof probability !== 'number') {
      probability = sidePriceByLabel.get(label.toLowerCase()) ?? null;
    }

    return {
      label,
      tokenId: null,
      probability
    };
  });

  if (outcomes.length === 2) {
    const firstProbability = outcomes[0].probability;
    const secondProbability = outcomes[1].probability;

    if (typeof firstProbability === 'number' && typeof secondProbability !== 'number') {
      outcomes[1].probability = clamp(1 - firstProbability, 0, 1);
    }

    if (typeof secondProbability === 'number' && typeof firstProbability !== 'number') {
      outcomes[0].probability = clamp(1 - secondProbability, 0, 1);
    }
  }

  return outcomes;
}

function normalizeEventMarkets(markets) {
  if (!Array.isArray(markets)) {
    return [];
  }

  return markets
    .map((market, index) => {
      const conditionId = String(market?.conditionId ?? market?.id ?? market?.slug ?? `market-${index + 1}`);
      const question = String(market?.question ?? market?.title ?? market?.slug ?? `Market ${index + 1}`).trim();

      return {
        ...market,
        conditionId,
        question,
        slug: market?.slug ?? null,
        endDate: market?.endDate ?? null,
        liquidity: toNumberOrNull(market?.liquidity),
        volume: toNumberOrNull(market?.volume),
        outcomes: normalizeMarketOutcomes(market)
      };
    })
    .filter((market) => Array.isArray(market.outcomes) && market.outcomes.length > 0);
}

function getImpliedSpreadFromMarket(eventMarket) {
  const probabilities = (Array.isArray(eventMarket?.outcomes) ? eventMarket.outcomes : [])
    .map((outcome) => toNumberOrNull(outcome?.probability))
    .filter((value) => typeof value === 'number');

  if (probabilities.length < 2) {
    return null;
  }

  const total = probabilities.reduce((sum, value) => sum + value, 0);
  return Math.abs(1 - total);
}

function buildLightweightAnalyticsFromEvent(event) {
  const normalizedMarkets = normalizeEventMarkets(event?.markets);
  const rawEventLiquidity = toNumberOrNull(event?.liquidity);
  const rawEventVolume = toNumberOrNull(event?.volume);
  const derivedLiquidity = normalizedMarkets.reduce((sum, market) => sum + (market.liquidity ?? 0), 0);
  const derivedVolume = normalizedMarkets.reduce((sum, market) => sum + (market.volume ?? 0), 0);
  const normalizedEvent = {
    id: event.id ?? null,
    slug: event.slug ?? null,
    title: event.title ?? event.slug ?? null,
    description: event.description ?? '',
    active: Boolean(event.active),
    closed: Boolean(event.closed),
    endDate: event.endDate ?? null,
    startDate: event.startDate ?? null,
    liquidity: typeof rawEventLiquidity === 'number' ? rawEventLiquidity : (derivedLiquidity > 0 ? derivedLiquidity : null),
    volume: typeof rawEventVolume === 'number' ? rawEventVolume : (derivedVolume > 0 ? derivedVolume : null),
    markets: normalizedMarkets
  };
  const pricedMarkets = normalizedEvent.markets
    .filter((market) => Array.isArray(market?.outcomes) && market.outcomes.some((outcome) => typeof toNumberOrNull(outcome?.probability) === 'number'));
  const aggregation = {
    generatedAt: new Date().toISOString(),
    liquiditySnapshot: {
      eventLiquidity: normalizedEvent.liquidity,
      eventVolume: normalizedEvent.volume,
      liveMarketCount: pricedMarkets.length,
      pricedOutcomeCount: pricedMarkets.reduce((count, market) => {
        return count + market.outcomes.filter((outcome) => typeof toNumberOrNull(outcome?.probability) === 'number').length;
      }, 0),
      markets: pricedMarkets.map((market) => ({
        conditionId: market.conditionId,
        question: market.question,
        liquidity: toNumberOrNull(market.liquidity),
        volume: toNumberOrNull(market.volume),
        liquidityShare: typeof normalizedEvent.liquidity === 'number' && normalizedEvent.liquidity > 0
          ? (toNumberOrNull(market.liquidity) ?? 0) / normalizedEvent.liquidity
          : null,
        volumeShare: typeof normalizedEvent.volume === 'number' && normalizedEvent.volume > 0
          ? (toNumberOrNull(market.volume) ?? 0) / normalizedEvent.volume
          : null
      }))
    },
    sportsContext: {
      generatedAt: new Date().toISOString(),
      recognizedMarketCount: 0,
      historyGameCount: 0,
      markets: []
    },
    historicalPrices: {
      markets: pricedMarkets.map((market) => ({
        conditionId: market.conditionId,
        question: market.question,
        outcomes: (Array.isArray(market.outcomes) ? market.outcomes : [])
          .map((outcome) => {
            const probability = toNumberOrNull(outcome?.probability);

            if (typeof probability !== 'number') {
              return null;
            }

            return {
              label: outcome.label,
              tokenId: outcome.tokenId ?? null,
              currentProbability: probability,
              historySummary: {
                pointCount: 1,
                firstPrice: probability,
                latestPrice: probability,
                lowPrice: probability,
                highPrice: probability,
                absoluteChange: 0,
                percentChange: 0
              },
              history: []
            };
          })
          .filter(Boolean)
      }))
    }
  };
  const statisticalModel = buildStatisticalModel(normalizedEvent, aggregation);

  return {
    event: normalizedEvent,
    aggregation,
    statisticalModel
  };
}

function selectScannerCandidate(statisticalMarket) {
  const outcomes = Array.isArray(statisticalMarket?.outcomes) ? statisticalMarket.outcomes : [];

  if (outcomes.length === 0) {
    return null;
  }

  return [...outcomes]
    .filter((outcome) => typeof outcome.currentProbability === 'number' && typeof outcome.estimatedProbability === 'number')
    .sort((left, right) => {
      const leftScore = (left.edge ?? 0) * (left.confidence ?? statisticalMarket.confidence ?? 0);
      const rightScore = (right.edge ?? 0) * (right.confidence ?? statisticalMarket.confidence ?? 0);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return (right.estimatedProbability ?? 0) - (left.estimatedProbability ?? 0);
    })[0] ?? null;
}

function getTimeToResolutionMs(value) {
  const timestamp = Date.parse(String(value ?? ''));

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(0, timestamp - Date.now());
}

function getTimeToResolutionScore(timeToResolutionMs) {
  if (typeof timeToResolutionMs !== 'number') {
    return 0.45;
  }

  const hours = timeToResolutionMs / (60 * 60 * 1000);

  if (hours <= 0.25) {
    return 0.2;
  }

  if (hours <= 6) {
    return 0.95;
  }

  if (hours <= 24) {
    return 0.8;
  }

  if (hours <= 72) {
    return 0.6;
  }

  if (hours <= 168) {
    return 0.4;
  }

  return 0.25;
}

function getLiquidityScore(liquidity) {
  if (typeof liquidity !== 'number' || liquidity <= 0) {
    return 0;
  }

  return clamp(Math.log10(liquidity + 1) / 4.5, 0, 1);
}

function getSpreadScore(spread) {
  if (typeof spread !== 'number') {
    return 0.5;
  }

  return 1 - clamp(spread / 0.1, 0, 1);
}

function getProbabilityReliabilityScore(currentProbability) {
  if (typeof currentProbability !== 'number') {
    return 0.45;
  }

  if (currentProbability < 0.01 || currentProbability > 0.99) {
    return 0.1;
  }

  if (currentProbability < 0.03 || currentProbability > 0.97) {
    return 0.25;
  }

  if (currentProbability < 0.05 || currentProbability > 0.95) {
    return 0.45;
  }

  return 1;
}

function getExpectedValuePerDollar(currentProbability, modelProbability) {
  if (typeof currentProbability !== 'number' || typeof modelProbability !== 'number' || currentProbability <= 0) {
    return null;
  }

  return modelProbability / currentProbability - 1;
}

function classifyOpportunity(opportunity) {
  const expectedValue = opportunity.expectedValuePerDollar ?? null;
  const edge = opportunity.edge ?? null;
  const confidence = opportunity.confidence ?? null;
  const spread = opportunity.spread ?? null;

  if (typeof expectedValue === 'number' && expectedValue >= 0.12 && typeof edge === 'number' && edge >= 0.035 && typeof confidence === 'number' && confidence >= 0.68 && (spread === null || spread <= 0.04)) {
    return 'strong-buy';
  }

  if (typeof expectedValue === 'number' && expectedValue >= 0.05 && typeof edge === 'number' && edge >= 0.015 && typeof confidence === 'number' && confidence >= 0.56) {
    return 'soft-buy';
  }

  if (typeof expectedValue === 'number' && expectedValue > 0 && typeof edge === 'number' && edge > 0.005) {
    return 'watchlist';
  }

  return 'avoid';
}

function scoreOpportunity(opportunity) {
  const expectedValueScore = clamp((opportunity.expectedValuePerDollar ?? 0) / 0.25, 0, 1);
  const edgeScore = clamp((opportunity.edge ?? 0) / 0.08, 0, 1);
  const confidenceScore = clamp(opportunity.confidence ?? 0, 0, 1);
  const liquidityScore = getLiquidityScore(opportunity.marketLiquidity ?? opportunity.eventLiquidity ?? null);
  const spreadScore = getSpreadScore(opportunity.spread);
  const resolutionScore = getTimeToResolutionScore(opportunity.timeToResolutionMs);
  const reliabilityScore = getProbabilityReliabilityScore(opportunity.currentProbability);

  return Number(
    (
      expectedValueScore * 0.2
      + edgeScore * 0.16
      + confidenceScore * 0.22
      + liquidityScore * 0.18
      + spreadScore * 0.12
      + resolutionScore * 0.1
      + reliabilityScore * 0.02
    ).toFixed(4)
  );
}

async function buildMarketOpportunity(env, analytics, statisticalMarket) {
  const opportunity = statisticalMarket?.opportunity ?? selectScannerCandidate(statisticalMarket);

  if (!opportunity) {
    return null;
  }

  const eventMarket = analytics.event.markets.find((candidate) => candidate.conditionId === statisticalMarket.conditionId) ?? null;

  if (!eventMarket) {
    return null;
  }

  const impliedSpread = getImpliedSpreadFromMarket(eventMarket);
  const currentProbability = opportunity.currentProbability ?? null;
  const modelProbability = opportunity.estimatedProbability ?? null;
  const timeToResolutionMs = getTimeToResolutionMs(eventMarket.endDate ?? analytics.event.endDate ?? null);
  const expectedValuePerDollar = getExpectedValuePerDollar(currentProbability, modelProbability);

  const result = {
    eventId: analytics.event.id,
    eventSlug: analytics.event.slug,
    eventTitle: analytics.event.title,
    eventEndDate: analytics.event.endDate,
    marketSlug: eventMarket.slug ?? null,
    conditionId: statisticalMarket.conditionId,
    marketQuestion: statisticalMarket.question,
    outcomeLabel: opportunity.label,
    currentProbability,
    modelProbability,
    edge: opportunity.edge ?? null,
    expectedValuePerDollar,
    confidence: opportunity.confidence ?? statisticalMarket.confidence ?? null,
    marketConfidence: statisticalMarket.confidence ?? null,
    eventLiquidity: analytics.aggregation?.liquiditySnapshot?.eventLiquidity ?? analytics.event.liquidity ?? null,
    eventVolume: analytics.aggregation?.liquiditySnapshot?.eventVolume ?? analytics.event.volume ?? null,
    marketLiquidity: eventMarket.liquidity ?? null,
    marketVolume: eventMarket.volume ?? null,
    liquidityShare: analytics.aggregation?.liquiditySnapshot?.markets?.find(
      (candidate) => candidate.conditionId === statisticalMarket.conditionId
    )?.liquidityShare ?? null,
    spread: impliedSpread,
    bestBid: null,
    bestAsk: null,
    midpoint: null,
    spreadSource: typeof impliedSpread === 'number' ? 'implied-market-probabilities' : 'unavailable',
    timeToResolutionMs,
    sportsLeague: opportunity.features?.sportsLeague ?? statisticalMarket.sportsContext?.league ?? null,
    signalSource: opportunity.features?.sportsModel ? 'sports-model' : 'market-microstructure',
    sportsModel: opportunity.features?.sportsModel ?? null,
    generatedAt: analytics.statisticalModel?.generatedAt ?? analytics.aggregation?.generatedAt ?? new Date().toISOString()
  };

  result.classification = classifyOpportunity(result);
  result.rankScore = scoreOpportunity(result);

  return result;
}

async function scanEvent(env, event) {
  const analytics = buildLightweightAnalyticsFromEvent(event);
  const statisticalMarkets = Array.isArray(analytics.statisticalModel?.markets) ? analytics.statisticalModel.markets : [];

  if (!analytics.event.active || analytics.event.closed || analytics.event.markets.length === 0 || statisticalMarkets.length === 0) {
    return {
      eventSlug: event.slug,
      opportunities: []
    };
  }

  const opportunities = await mapWithConcurrency(statisticalMarkets, 2, async (market) => buildMarketOpportunity(env, analytics, market));

  return {
    eventSlug: event.slug,
    eventTitle: analytics.event.title,
    opportunities: opportunities.filter(Boolean)
  };
}

function getClassificationPriority(classification) {
  switch (classification) {
    case 'strong-buy':
      return 0;
    case 'soft-buy':
      return 1;
    case 'watchlist':
      return 2;
    default:
      return 3;
  }
}

async function buildScannerSnapshot(env, reason) {
  const config = normalizeScannerConfig(env);
  const startedAt = new Date().toISOString();
  const universe = await fetchScannerUniverse(env, config);
  const scanResults = await mapWithConcurrency(universe.markets, config.concurrency, async (event) => {
    try {
      return await scanEvent(env, event);
    } catch (error) {
      return {
        eventSlug: event.slug,
        error: error instanceof Error ? error.message : 'Unable to scan event'
      };
    }
  });

  const failures = scanResults
    .filter((result) => result?.error)
    .map((result) => ({ eventSlug: result.eventSlug, error: result.error }))
    .slice(0, 10);
  const qualifiedResults = scanResults.filter((result) => Array.isArray(result?.opportunities) && result.opportunities.length > 0);
  const opportunities = qualifiedResults
    .flatMap((result) => result.opportunities)
    .sort((left, right) => {
      const leftPriority = getClassificationPriority(left.classification);
      const rightPriority = getClassificationPriority(right.classification);

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      if (right.rankScore !== left.rankScore) {
        return right.rankScore - left.rankScore;
      }

      if ((right.expectedValuePerDollar ?? 0) !== (left.expectedValuePerDollar ?? 0)) {
        return (right.expectedValuePerDollar ?? 0) - (left.expectedValuePerDollar ?? 0);
      }

      return (right.edge ?? 0) - (left.edge ?? 0);
    })
    .slice(0, config.maxOpportunities ?? undefined)
    .map((opportunity, index) => ({
      ...opportunity,
      rank: index + 1
    }));

  return {
    status: 'ready',
    generatedAt: new Date().toISOString(),
    startedAt,
    refreshReason: reason,
    error: null,
    config,
    universe: {
      requestedLimit: config.universeLimit ?? 0,
      totalAvailableMarkets: universe.totalAvailableMarkets,
      fetchedEventCount: universe.markets.length,
      scannedEventCount: scanResults.filter(Boolean).length,
      qualifiedEventCount: qualifiedResults.length,
      opportunityCount: opportunities.length,
      failureCount: failures.length,
      failures
    },
    opportunities
  };
}

async function runScannerRefresh(env, reason) {
  const currentSnapshot = scannerState.snapshot;
  scannerState.snapshot = {
    ...currentSnapshot,
    status: currentSnapshot.generatedAt ? 'refreshing' : 'loading',
    startedAt: new Date().toISOString(),
    refreshReason: reason,
    config: normalizeScannerConfig(env),
    error: null
  };

  try {
    const nextSnapshot = await buildScannerSnapshot(env, reason);
    scannerState.snapshot = nextSnapshot;
    return nextSnapshot;
  } catch (error) {
    scannerState.snapshot = {
      ...scannerState.snapshot,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to refresh opportunity scanner',
      generatedAt: scannerState.snapshot.generatedAt ?? new Date().toISOString()
    };
    return scannerState.snapshot;
  } finally {
    scannerState.inFlight = null;
  }
}

export function startOpportunityScanner(env) {
  if (scannerState.initialized) {
    return;
  }

  scannerState.initialized = true;
  const config = normalizeScannerConfig(env);
  scannerState.snapshot = {
    ...scannerState.snapshot,
    config
  };

  void refreshOpportunityScanner(env, { reason: 'startup' });

  scannerState.intervalId = setInterval(() => {
    void refreshOpportunityScanner(env, { reason: 'interval' });
  }, config.intervalMs);
}

export async function refreshOpportunityScanner(env, { reason = 'manual', wait = false } = {}) {
  if (!scannerState.inFlight) {
    scannerState.inFlight = runScannerRefresh(env, reason);
  }

  if (wait) {
    return scannerState.inFlight;
  }

  return scannerState.snapshot;
}

export async function getOpportunityScannerSnapshot(env, { refresh = false, wait = false } = {}) {
  if (!scannerState.initialized) {
    startOpportunityScanner(env);
  }

  if (refresh || !scannerState.snapshot.generatedAt) {
    await refreshOpportunityScanner(env, {
      reason: refresh ? 'manual' : 'cold-start',
      wait
    });
  }

  return scannerState.snapshot;
}