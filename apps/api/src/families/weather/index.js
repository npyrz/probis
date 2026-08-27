// Weather market family — the first family, and the reference implementation of the
// market-family-v1 contract. It wraps the existing KMDW weather stack rather than
// duplicating it; the model, settlement, and backtest logic all still live in
// services/weather/ and services/persistence/.
import { registerFamily } from '../registry.js';
import {
  buildChicagoMarketCatalog,
  buildChicagoRecommendations,
  buildChicagoSnapshot,
  getChicagoSettlement
} from '../../services/weather/chicago.js';
import { fetchKmdwHistoricalBoardArchive } from '../../services/weather/historical-boards.js';
import { isWeatherEvent } from '../../services/weather/event-intelligence.js';
import { buildWeatherMlFeatures } from '../../services/ml/weather-model.js';
import { getChicagoBacktest } from '../../services/persistence/postgres.js';
import { fetchWeatherProviderSnapshotInputs, resolveWeatherProvider } from '../../services/weather/providers.js';

export const WEATHER_FAMILY = registerFamily({
  id: 'weather',
  name: 'Weather',
  description: 'Daily high-temperature markets settled from an official NWS climate product. Chicago Midway (KMDW) today.',
  dataSources: [
    'NWS station observations',
    'NWS hourly/grid forecasts',
    'CLIMDW settlement product',
    'NBM guidance (optional)',
    'NOAA CDO daily archive',
    'Open-Meteo forecast vintages'
  ],

  // Does this catalog market belong to the weather family?
  claimsMarket(market) {
    return isWeatherEvent(market?.event ?? market, market?.markets ?? []);
  },

  // find + parse the family's markets
  discoverMarkets(env, options = {}) {
    return buildChicagoMarketCatalog(env, options);
  },

  // Weather markets are not returned by the venue's /events listing — they are only
  // reachable through gateway search. This lets the venue-wide catalog include them.
  async catalogMarkets(env, options = {}) {
    const catalog = await buildChicagoMarketCatalog(env, options);

    return (Array.isArray(catalog?.buckets) ? catalog.buckets : [])
      .filter((bucket) => bucket.closed !== true)
      .map((bucket) => ({
        id: bucket.conditionId ?? bucket.marketSlug ?? null,
        conditionId: bucket.conditionId ?? null,
        marketSlug: bucket.marketSlug ?? null,
        eventSlug: bucket.eventSlug ?? null,
        title: bucket.eventTitle || bucket.marketQuestion || '',
        eventTitle: bucket.eventTitle ?? '',
        category: 'weather',
        familyId: 'weather',
        outcomeKey: bucket.outcomeLabel ?? null,
        outcomes: [{
          label: bucket.outcomeLabel ?? 'Yes',
          price: bucket.bestAsk ?? bucket.marketProbability ?? null,
          probability: bucket.marketProbability ?? null,
          tokenId: bucket.yesTokenId ?? null
        }],
        outcomeCount: 1,
        liquidity: bucket.liquidity ?? null,
        volume: bucket.volume ?? null,
        closeTime: bucket.endDate ?? null,
        startTime: null,
        active: bucket.active !== false,
        closed: bucket.closed === true,
        resolutionSource: bucket.designatedSource?.provider ?? null,
        rulesText: bucket.rulesText ?? null,
        rulesTextHash: bucket.rulesTextHash ?? null
      }));
  },

  // authoritative data sources for a market
  attachFeeds(env, options = {}) {
    return fetchWeatherProviderSnapshotInputs(resolveWeatherProvider(env, options), env, options);
  },

  // past data backfill
  fetchHistory(env, options = {}) {
    return fetchKmdwHistoricalBoardArchive(env, options);
  },

  // fair probability per outcome
  async priceOutcomes(env, options = {}) {
    const snapshot = await buildChicagoSnapshot(env, options);

    return {
      targetDate: snapshot?.prediction?.targetDate ?? null,
      outcomes: snapshot?.prediction?.bucketProbabilities ?? {},
      confidence: snapshot?.prediction?.confidence ?? null,
      recommendations: buildChicagoRecommendations(snapshot),
      snapshot
    };
  },

  // calibration feature vector
  features(input = {}) {
    return buildWeatherMlFeatures(input);
  },

  // designated settlement source + verification
  settlementSource(env, options = {}) {
    return getChicagoSettlement(env, options);
  },

  // prove edge on past data
  backtest(env, range = {}) {
    return getChicagoBacktest(env, range);
  }
});

export default WEATHER_FAMILY;
