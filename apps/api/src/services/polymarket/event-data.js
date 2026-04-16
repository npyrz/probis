import { buildEventAggregation } from './aggregation.js';
import { extractEventSlug, fetchEventByInput } from './gamma.js';
import { buildStatisticalModel } from './statistical-model.js';
import { ensureSportsHistoryForEvent } from '../sports/auto-sync.js';

const analyticsCache = new Map();

function getCacheKey(input) {
  return extractEventSlug(input).toLowerCase();
}

function getCachedAnalytics(cacheKey) {
  const entry = analyticsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    analyticsCache.delete(cacheKey);
    return null;
  }

  return entry.value;
}

function setCachedAnalytics(cacheKey, value, ttlMs) {
  analyticsCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

export function invalidateEventAnalyticsCache(input) {
  if (!input) {
    analyticsCache.clear();
    return;
  }

  analyticsCache.delete(getCacheKey(input));
}

export async function resolveEventWithAggregation(env, input) {
  const event = await fetchEventByInput(env, input);
  const sportsSync = await ensureSportsHistoryForEvent(event);
  const aggregation = await buildEventAggregation(env, event);
  const statisticalModel = buildStatisticalModel(event, aggregation);

  return {
    ...event,
    sportsSync,
    aggregation,
    statisticalModel
  };
}

export async function resolveEventAnalytics(env, input, options = {}) {
  const cacheKey = getCacheKey(input);
  const forceRefresh = options.forceRefresh === true;
  const event = await fetchEventByInput(env, input);
  const sportsSync = await ensureSportsHistoryForEvent(event, { forceRefresh });
  const cached = forceRefresh ? null : getCachedAnalytics(cacheKey);

  if (cached) {
    const recognizedMarketCount = cached.aggregation?.sportsContext?.recognizedMarketCount ?? 0;
    const historyGameCount = cached.aggregation?.sportsContext?.historyGameCount ?? 0;
    const sportsCacheStillValid = recognizedMarketCount === 0 || historyGameCount > 0 || !sportsSync.updated;

    if (sportsCacheStillValid) {
      return {
        ...cached,
        sportsSync
      };
    }
  }

  const aggregation = await buildEventAggregation(env, event);
  const statisticalModel = buildStatisticalModel(event, aggregation);

  const result = {
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: event.description ?? '',
      active: Boolean(event.active),
      closed: Boolean(event.closed),
      endDate: event.endDate ?? null,
      startDate: event.startDate ?? null,
      liquidity: event.liquidity ?? null,
      volume: event.volume ?? null,
      markets: Array.isArray(event.markets) ? event.markets : [],
      usFiltered: event.usFiltered ?? false,
      usAvailableMarketCount: event.usAvailableMarketCount ?? (Array.isArray(event.markets) ? event.markets.length : 0),
      usFilterFallbackRetainedOriginalMarkets: event.usFilterFallbackRetainedOriginalMarkets ?? false,
      resolvedFromFallback: event.resolvedFromFallback ?? false,
      requestedSlug: event.requestedSlug ?? null,
      resolvedFromUsMarketSlug: event.resolvedFromUsMarketSlug ?? false,
      sourceMarketSlug: event.sourceMarketSlug ?? null
    },
    sportsSync,
    aggregation,
    statisticalModel
  };

  setCachedAnalytics(cacheKey, result, env.analyticsCacheTtlMs);

  return result;
}