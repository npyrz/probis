import { buildEventAggregation } from './aggregation.js';
import { extractEventSlug, fetchEventByInput } from './gamma.js';
import { buildStatisticalModel } from './statistical-model.js';

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
  const aggregation = await buildEventAggregation(env, event);
  const statisticalModel = buildStatisticalModel(event, aggregation);

  return {
    ...event,
    aggregation,
    statisticalModel
  };
}

export async function resolveEventAnalytics(env, input, options = {}) {
  const cacheKey = getCacheKey(input);
  const forceRefresh = options.forceRefresh === true;
  const cached = forceRefresh ? null : getCachedAnalytics(cacheKey);

  if (cached) {
    return cached;
  }

  const event = await fetchEventByInput(env, input);
  const aggregation = await buildEventAggregation(env, event);
  const statisticalModel = buildStatisticalModel(event, aggregation);

  const result = {
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      resolvedFromFallback: event.resolvedFromFallback ?? false,
      requestedSlug: event.requestedSlug ?? null
    },
    aggregation,
    statisticalModel
  };

  setCachedAnalytics(cacheKey, result, env.analyticsCacheTtlMs);

  return result;
}