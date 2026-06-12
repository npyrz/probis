import { buildEventAggregation } from './aggregation.js';
import { extractEventSlug, fetchEventByInput } from './gamma.js';
import { buildStatisticalModel } from './statistical-model.js';
import { loadWeatherMlModel } from '../ml/weather-model.js';
import { getMlCalibrationStats, persistEventAnalytics } from '../persistence/postgres.js';

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

async function buildMlCalibrationOptions(env, aggregation) {
  const stationIds = [...new Set(
    (Array.isArray(aggregation?.weatherSnapshots) ? aggregation.weatherSnapshots : [])
      .map((snapshot) => snapshot?.stationId)
      .filter(Boolean)
  )];
  const entries = await Promise.all(stationIds.map(async (stationId) => [
    stationId,
    await getMlCalibrationStats(env, { stationId })
  ]));
  const [mlCalibration, weatherMlModel] = await Promise.all([
    getMlCalibrationStats(env),
    loadWeatherMlModel(env)
  ]);

  return {
    mlCalibrationByStationId: new Map(entries),
    mlCalibration,
    weatherMlModel
  };
}

export async function resolveEventWithAggregation(env, input) {
  const event = await fetchEventByInput(env, input);
  const aggregation = await buildEventAggregation(env, event);
  const calibrationOptions = await buildMlCalibrationOptions(env, aggregation);
  const statisticalModel = buildStatisticalModel(event, aggregation, calibrationOptions);
  const result = {
    ...event,
    aggregation,
    statisticalModel
  };

  void persistEventAnalytics(env, { event, aggregation, statisticalModel });

  return result;
}

export async function resolveEventAnalytics(env, input, options = {}) {
  const cacheKey = getCacheKey(input);
  const forceRefresh = options.forceRefresh === true;
  const event = await fetchEventByInput(env, input);
  const cached = forceRefresh ? null : getCachedAnalytics(cacheKey);

  if (cached) {
    return cached;
  }

  const aggregation = await buildEventAggregation(env, event);
  const calibrationOptions = await buildMlCalibrationOptions(env, aggregation);
  const statisticalModel = buildStatisticalModel(event, aggregation, calibrationOptions);

  const result = {
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: event.description ?? '',
      category: event.category ?? null,
      rules: event.rules ?? null,
      resolutionSource: event.resolutionSource ?? null,
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
    aggregation,
    statisticalModel
  };

  void persistEventAnalytics(env, result);

  setCachedAnalytics(cacheKey, result, env.analyticsCacheTtlMs);

  return result;
}
