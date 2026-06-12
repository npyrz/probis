import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  bucketProbability,
  buildChicagoMarketCatalogFromBuckets,
  buildChicagoRecommendations,
  buildChicagoTradeIntentPayload,
  buildDesignatedSource,
  buildKmdwMarketDataPolicy,
  buildKmdwPositionLifecycle,
  buildMarketImpliedBucketProbabilities,
  buildThresholdDiagnostics,
  dedupeChicagoMarketBuckets,
  detectRuleFlags,
  fuseBucketProbabilities,
  getChicagoClimateDayWindow,
  getChicagoDefaultTargetDate,
  normalizeBucketMarket,
  parseClimdwProduct,
  parseTemperatureBucket
} from '../src/services/weather/chicago.js';
import { getPolymarketMarketDataPolicy } from '../src/services/polymarket/client.js';
import {
  getChicagoDailyArchive,
  getChicagoAlerts,
  getChicagoForecastVintages,
  getChicagoHistoricalMarketBoards,
  getChicagoModelTrainingRows,
  persistChicagoAlerts,
  persistChicagoHistoricalMarketBoards,
  persistChicagoForecastVintageArchive,
  persistChicagoDailyArchive,
  persistChicagoSnapshot,
  summarizeChicagoBacktestRows,
  summarizeChicagoSignalDriftSnapshots,
  summarizeChicagoSourceAuditRows
} from '../src/services/persistence/postgres.js';
import {
  scoreTrainedWeatherModel,
  trainTabularWeatherModel
} from '../src/services/ml/weather-training.js';
import { buildChicagoAlertSummary } from '../src/services/weather/chicago-alerts.js';
import {
  chunkDateRange as chunkForecastVintageDateRange,
  normalizeOpenMeteoPreviousRunsRows,
  parseLeadDays
} from '../src/services/weather/forecast-vintage.js';
import {
  buildHistoricalBoardArchiveFromBuckets,
  normalizePricePoints,
  normalizeTradeRows
} from '../src/services/weather/historical-boards.js';
import {
  chunkDateRange,
  normalizeCdoDailyRows
} from '../src/services/weather/noaa-archive.js';
import {
  WEATHER_PROVIDER_INTERFACE_VERSION,
  createWeatherProvider,
  fetchWeatherProviderSnapshotInputs,
  getWeatherProvider,
  listWeatherProviders
} from '../src/services/weather/providers.js';
import {
  buildKmdwIntentMarketDataPolicy,
  buildTradeIntentPayload,
  getTradeIntentExecutionBlocker,
  getTradeIntentLiveRoutingBlocker,
  getTradeIntentLiveTradingPolicy,
  hardenTradeIntentLiveRouting
} from '../src/services/trade-intents.js';

test('parseClimdwProduct extracts CHICAGO-MIDWAY yesterday maximum', () => {
  const product = `
000
CDUS43 KLOT 130632
CLIMDW

CLIMATE REPORT
NATIONAL WEATHER SERVICE CHICAGO IL

...THE CHICAGO-MIDWAY CLIMATE SUMMARY FOR MAY 12 2026...

TEMPERATURE (F)
 YESTERDAY
  MAXIMUM         64   315 PM
  MINIMUM         49   559 AM

PRECIPITATION (IN)
  YESTERDAY        0.00
`;

  const parsed = parseClimdwProduct(product, '2026-05-12');

  assert.equal(parsed.status, 'settled');
  assert.equal(parsed.cliDate, '2026-05-12');
  assert.equal(parsed.maxTempF, 64);
  assert.equal(parsed.dateMatches, true);
  assert.equal(parsed.parsed, true);
});

test('parseClimdwProduct accepts CHICAGO MIDWAY header without hyphen', () => {
  const product = `
000
CDUS43 KLOT 130632
CLIMDW

CLIMATE REPORT
NATIONAL WEATHER SERVICE CHICAGO IL

...THE CHICAGO MIDWAY CLIMATE SUMMARY FOR MAY 12 2026...

TEMPERATURE (F)
 YESTERDAY
  MAXIMUM         64   315 PM
`;

  const parsed = parseClimdwProduct(product, '2026-05-12');

  assert.equal(parsed.status, 'settled');
  assert.equal(parsed.cliDate, '2026-05-12');
  assert.equal(parsed.maxTempF, 64);
});

test('parseClimdwProduct handles NWS glossary HTML around CLIMATE', () => {
  const product = `
CLIMDW

<a href="/glossary.php?word=CLIMATE">CLIMATE</a> REPORT
NATIONAL WEATHER SERVICE CHICAGO IL

...THE CHICAGO-MIDWAY <a href="/glossary.php?word=CLIMATE">CLIMATE</a> SUMMARY FOR MAY 18 2026...

TEMPERATURE (F)
  MAXIMUM         80   2:01 PM  93    1934  72      8       62
`;

  const parsed = parseClimdwProduct(product, '2026-05-19');

  assert.equal(parsed.status, 'date-mismatch');
  assert.equal(parsed.cliDate, '2026-05-18');
  assert.equal(parsed.maxTempF, 80);
});

test('getChicagoClimateDayWindow uses 1 AM CDT during daylight saving time', () => {
  const window = getChicagoClimateDayWindow('2026-07-15');

  assert.equal(window.start, '2026-07-15T06:00:00.000Z');
  assert.equal(window.endExclusive, '2026-07-16T06:00:00.000Z');
  assert.equal(window.isDstAtStart, true);
  assert.match(window.startLocal, /1:00 AM CDT/);
});

test('getChicagoClimateDayWindow uses midnight CST during standard time', () => {
  const window = getChicagoClimateDayWindow('2026-01-15');

  assert.equal(window.start, '2026-01-15T06:00:00.000Z');
  assert.equal(window.endExclusive, '2026-01-16T06:00:00.000Z');
  assert.equal(window.isDstAtStart, false);
  assert.match(window.startLocal, /12:00 AM CST/);
});

test('getChicagoDefaultTargetDate rolls to tomorrow after Chicago evening window', () => {
  assert.equal(getChicagoDefaultTargetDate(new Date('2026-06-09T22:30:00.000Z')), '2026-06-09');
  assert.equal(getChicagoDefaultTargetDate(new Date('2026-06-09T23:30:00.000Z')), '2026-06-10');
});

test('weather provider abstraction collects inputs through a pluggable interface', async () => {
  const provider = createWeatherProvider({
    id: 'test-weather-provider',
    name: 'Test Weather Provider',
    scope: 'unit-test-weather',
    station: {
      stationId: 'TEST',
      stationName: 'Test Station',
      timezone: 'America/Chicago'
    },
    capabilities: {
      settlementSource: 'fixture'
    },
    dataSources: ['fixture'],
    getTargetDate(date) {
      return date ?? '2026-05-20';
    },
    getClimateDayWindow(targetDate) {
      return {
        targetDate,
        start: `${targetDate}T06:00:00.000Z`,
        end: `${targetDate}T23:59:59.999Z`,
        endExclusive: '2026-05-21T06:00:00.000Z',
        timezone: 'America/Chicago'
      };
    },
    fetchSettlement(_env, { targetDate }) {
      return Promise.resolve({ status: 'pending', requestedDate: targetDate });
    },
    fetchObservations(_env, { targetDate }) {
      return Promise.resolve({ status: 'ready', targetDate, observedHighSoFar: 72 });
    },
    fetchForecasts() {
      return Promise.resolve({ status: 'ready', hourly: { forecastMaxF: 74 }, grid: { forecastMaxF: 75 }, features: {} });
    },
    fetchModelForecast() {
      return Promise.resolve({ status: 'disabled', features: { forecast_max_nbm: null } });
    },
    fetchMarkets() {
      return Promise.resolve({ status: 'empty', buckets: [] });
    }
  });
  const inputs = await fetchWeatherProviderSnapshotInputs(provider, {}, { date: '2026-05-20' });

  assert.equal(provider.interfaceVersion, WEATHER_PROVIDER_INTERFACE_VERSION);
  assert.equal(inputs.provider.id, 'test-weather-provider');
  assert.equal(inputs.provider.station.stationId, 'TEST');
  assert.equal(inputs.targetDate, '2026-05-20');
  assert.equal(inputs.settlement.status, 'pending');
  assert.equal(inputs.observations.observedHighSoFar, 72);
  assert.equal(inputs.forecasts.status, 'ready');
  assert.equal(inputs.modelForecast.status, 'disabled');
  assert.equal(inputs.markets.status, 'empty');
});

test('KMDW weather provider is registered as the active pluggable provider', () => {
  const provider = getWeatherProvider('kmdw-nws-climdw');
  const catalog = listWeatherProviders();

  assert.ok(provider);
  assert.equal(provider.interfaceVersion, WEATHER_PROVIDER_INTERFACE_VERSION);
  assert.equal(provider.station.stationId, 'KMDW');
  assert.equal(provider.capabilities.settlementSource, 'nws-climdw');
  assert.equal(provider.capabilities.observationSource, 'nws-station-observations');
  assert.equal(provider.capabilities.forecastSource, 'nws-api');
  assert.equal(catalog.some((entry) => entry.id === 'kmdw-nws-climdw'), true);
});

test('parseTemperatureBucket handles common Polymarket labels', () => {
  assert.deepEqual(parseTemperatureBucket('59 or lower'), {
    lowTemp: null,
    highTemp: 59,
    inclusiveLow: false,
    inclusiveHigh: true
  });
  assert.deepEqual(parseTemperatureBucket('60-61'), {
    lowTemp: 60,
    highTemp: 61,
    inclusiveLow: true,
    inclusiveHigh: true
  });
  assert.deepEqual(parseTemperatureBucket('62 to 63°F'), {
    lowTemp: 62,
    highTemp: 63,
    inclusiveLow: true,
    inclusiveHigh: true
  });
  assert.deepEqual(parseTemperatureBucket('70+'), {
    lowTemp: 70,
    highTemp: null,
    inclusiveLow: true,
    inclusiveHigh: false
  });
});

test('bucketProbability sums integer temperature probabilities inclusively', () => {
  const distribution = {
    59: 0.22,
    60: 0.31,
    61: 0.18,
    62: 0.12
  };

  assert.equal(bucketProbability(distribution, 60, 61), 0.49);
  assert.equal(bucketProbability(distribution, null, 59), 0.22);
  assert.equal(bucketProbability(distribution, 62, null), 0.12);
});

test('market-implied probabilities normalize listed KMDW bucket prices', () => {
  const implied = buildMarketImpliedBucketProbabilities([{
    conditionId: 'low',
    midpoint: 0.2
  }, {
    conditionId: 'middle',
    bestBid: 0.28,
    bestAsk: 0.32
  }, {
    conditionId: 'high',
    marketProbability: 0.5
  }]);

  assert.equal(implied.low, 0.2);
  assert.equal(implied.middle, 0.3);
  assert.equal(implied.high, 0.5);
});

test('fuseBucketProbabilities blends weather and market distributions by weight', () => {
  const fused = fuseBucketProbabilities({
    low: 0.7,
    high: 0.3
  }, {
    low: 0.4,
    high: 0.6
  }, 0.25);

  assert.equal(fused.low, 0.625);
  assert.equal(fused.high, 0.375);
});

test('buildThresholdDiagnostics flags knife-edge KMDW bucket boundaries', () => {
  const diagnostics = buildThresholdDiagnostics({
    temperatureDistribution: {
      79: 0.5,
      80: 0.5
    },
    bucketProbabilities: {
      lower: 0.5,
      upper: 0.5
    },
    expectedHigh: 79.5,
    marketBuckets: [{
      conditionId: 'lower',
      outcomeLabel: '78-79',
      lowTemp: 78,
      highTemp: 79
    }, {
      conditionId: 'upper',
      outcomeLabel: '80-81',
      lowTemp: 80,
      highTemp: 81
    }]
  });

  assert.equal(diagnostics.status, 'knife-edge');
  assert.equal(diagnostics.topBucketMargin, 0);
  assert.equal(diagnostics.nearestBoundary.boundary, 79.5);
  assert.equal(diagnostics.nearestBoundary.distanceF, 0);
  assert.equal(diagnostics.nearestBoundary.probabilityMassWithin1F, 1);
});

test('buildThresholdDiagnostics marks separated KMDW bucket as stable', () => {
  const diagnostics = buildThresholdDiagnostics({
    temperatureDistribution: {
      78: 0.05,
      79: 0.9,
      80: 0.03,
      81: 0.02
    },
    bucketProbabilities: {
      lower: 0.95,
      upper: 0.05
    },
    expectedHigh: 78.8,
    marketBuckets: [{
      conditionId: 'lower',
      outcomeLabel: '78-80',
      lowTemp: 78,
      highTemp: 80
    }, {
      conditionId: 'upper',
      outcomeLabel: '81-83',
      lowTemp: 81,
      highTemp: 83
    }]
  });

  assert.equal(diagnostics.status, 'stable');
  assert.equal(diagnostics.topBucket.conditionId, 'lower');
  assert.equal(diagnostics.topBucketMargin, 0.9);
  assert.equal(diagnostics.bucketConcentration, 0.95);
});

test('detectRuleFlags requires explicit KMDW or CLIMDW source evidence', () => {
  assert.deepEqual(detectRuleFlags('Resolves using CLIMDW from weather.gov for Chicago-Midway.').ruleAmbiguity, false);
  assert.deepEqual(detectRuleFlags('Resolves using Weather Underground station KMDW history.').ruleAmbiguity, false);
  assert.deepEqual(detectRuleFlags('Resolves to the high temperature in Chicago.').ruleAmbiguity, true);
  assert.deepEqual(detectRuleFlags("Resolves using the northern airport observations.").ruleAmbiguity, true);
});

test('buildDesignatedSource verifies only explicit Midway source rules', () => {
  const verified = buildDesignatedSource(detectRuleFlags('Resolves using CLIMDW from weather.gov for Chicago-Midway.'));
  const ambiguous = buildDesignatedSource(detectRuleFlags('Resolves to the official high temperature in Chicago.'));

  assert.equal(verified.verified, true);
  assert.equal(verified.stationId, 'KMDW');
  assert.equal(verified.cliProduct, 'CLIMDW');
  assert.equal(verified.verificationStatus, 'verified-kmdw-midway');
  assert.equal(ambiguous.verified, false);
  assert.equal(ambiguous.tradeGate, 'live-trading-blocked');
});

test('normalizeBucketMarket uses Polymarket US gateway bid and ask quotes', () => {
  const bucket = normalizeBucketMarket({
    id: '31156',
    slug: 'tc-temp-mdwhigh-2026-05-20-gte57lt58f',
    conditionId: '31156',
    question: 'Highest temperature in Chicago on May 20?',
    title: '57 to 58',
    description: 'Will the highest temperature recorded at Chicago Midway Airport (KMDW) in Chicago for 2026-05-20 as reported by the National Weather Service be between 57F and 58F?',
    bestBid: 0.29,
    bestAsk: 0.3,
    spread: 0.01,
    midpoint: 0.295,
    quoteSource: 'polymarket-us-gateway-quotes',
    outcomes: [{
      label: 'Yes',
      probability: 0.29
    }, {
      label: 'No',
      probability: 0.3
    }]
  }, '2026-05-20');

  assert.equal(bucket.bestBid, 0.29);
  assert.equal(bucket.bestAsk, 0.3);
  assert.equal(bucket.spread, 0.01);
  assert.equal(bucket.marketProbability, 0.295);
  assert.equal(bucket.ruleFlags.ruleAmbiguity, false);
  assert.match(bucket.rulesTextHash, /^[a-f0-9]{64}$/);
  assert.equal(bucket.designatedSource.verified, true);
  assert.equal(bucket.designatedSource.stationId, 'KMDW');
  assert.equal(bucket.designatedSource.sourceTextHash, bucket.rulesTextHash);
});

test('buildChicagoMarketCatalogFromBuckets groups current and upcoming KMDW markets by date', () => {
  const baseBucket = {
    conditionId: 'bucket-a',
    marketSlug: 'bucket-a',
    lowTemp: 57,
    highTemp: 58,
    bestBid: 0.2,
    bestAsk: 0.25,
    designatedSource: {
      verified: true
    }
  };
  const catalog = buildChicagoMarketCatalogFromBuckets([{
    ...baseBucket,
    targetDate: '2026-05-20'
  }, {
    ...baseBucket,
    conditionId: 'bucket-b',
    marketSlug: 'bucket-b',
    targetDate: '2026-05-21',
    lowTemp: 59,
    highTemp: 60
  }, {
    ...baseBucket,
    conditionId: 'bucket-late',
    marketSlug: 'bucket-late',
    targetDate: '2026-05-23'
  }], {
    dateFrom: '2026-05-20',
    daysAhead: 1
  });

  assert.equal(catalog.dateFrom, '2026-05-20');
  assert.equal(catalog.dateTo, '2026-05-21');
  assert.equal(catalog.bucketCount, 2);
  assert.equal(catalog.dateGroupCount, 2);
  assert.deepEqual(catalog.dateGroups.map((group) => group.targetDate), ['2026-05-20', '2026-05-21']);
  assert.equal(catalog.verification.allVerified, true);
});

test('buildChicagoMarketCatalogFromBuckets can include all open KMDW markets outside the date range', () => {
  const baseBucket = {
    conditionId: 'bucket-a',
    marketSlug: 'bucket-a',
    lowTemp: 57,
    highTemp: 58,
    bestBid: 0.2,
    bestAsk: 0.25,
    active: true,
    closed: false,
    archived: false,
    designatedSource: {
      verified: true
    }
  };
  const catalog = buildChicagoMarketCatalogFromBuckets([{
    ...baseBucket,
    conditionId: 'open-prior',
    marketSlug: 'open-prior',
    targetDate: '2026-05-19'
  }, {
    ...baseBucket,
    conditionId: 'open-current',
    marketSlug: 'open-current',
    targetDate: '2026-05-20'
  }, {
    ...baseBucket,
    conditionId: 'closed-prior',
    marketSlug: 'closed-prior',
    targetDate: '2026-05-18',
    closed: true
  }], {
    dateFrom: '2026-05-20',
    daysAhead: 0,
    openOnly: true,
    includeOpenOutsideDateRange: true
  });

  assert.equal(catalog.bucketCount, 2);
  assert.equal(catalog.openBucketCount, 2);
  assert.deepEqual(catalog.dateGroups.map((group) => group.targetDate), ['2026-05-19', '2026-05-20']);
});

test('dedupeChicagoMarketBuckets collapses duplicate search hits by condition id', () => {
  const deduped = dedupeChicagoMarketBuckets([{
    conditionId: '30391',
    marketSlug: 'child-only',
    bestBid: null,
    bestAsk: null,
    eventSlug: null
  }, {
    conditionId: '30391',
    marketSlug: 'parent-market',
    bestBid: 0.01,
    bestAsk: 0.02,
    eventSlug: 'temp-mdwhigh-2026-05-19'
  }]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].marketSlug, 'child-only');
  assert.equal(deduped[0].bestBid, 0.01);
  assert.equal(deduped[0].bestAsk, 0.02);
  assert.equal(deduped[0].eventSlug, 'temp-mdwhigh-2026-05-19');
});

test('buildChicagoRecommendations rejects stale data even with positive edge', () => {
  const recommendations = buildChicagoRecommendations({
    prediction: {
      confidence: 0.8,
      dayPhase: 'midday',
      bucketProbabilities: {
        bucketA: 0.5
      },
      sourceFreshness: {
        isStale: true
      }
    },
    markets: {
      buckets: [{
        conditionId: 'bucketA',
        marketSlug: 'market-a',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        bestAsk: 0.38,
        spread: 0.03,
        askDepth: 100,
        ruleFlags: {
          ruleAmbiguity: false
        }
      }]
    }
  });

  assert.equal(recommendations.best.status, 'rejected');
  assert.equal(recommendations.best.action, 'watch');
  assert.match(recommendations.best.reason, /fresh weather/);
});

test('buildChicagoRecommendations rejects ambiguous Chicago source rules', () => {
  const recommendations = buildChicagoRecommendations({
    prediction: {
      confidence: 0.8,
      dayPhase: 'midday',
      bucketProbabilities: {
        bucketA: 0.5
      },
      sourceFreshness: {
        isStale: false
      }
    },
    markets: {
      buckets: [{
        conditionId: 'bucketA',
        marketSlug: 'market-a',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        bestAsk: 0.38,
        spread: 0.03,
        askDepth: 100,
        ruleFlags: detectRuleFlags('Resolves to the official high temperature in Chicago.')
      }]
    }
  });

  assert.equal(recommendations.best.status, 'rejected');
  assert.equal(recommendations.best.action, 'watch');
  assert.match(recommendations.best.reason, /KMDW\/CLIMDW/);
});

test('buildChicagoRecommendations sizes passed entries with fractional Kelly', () => {
  const recommendations = buildChicagoRecommendations({
    prediction: {
      confidence: 0.8,
      dayPhase: 'midday',
      bucketProbabilities: {
        bucketA: 0.5
      },
      sourceFreshness: {
        isStale: false
      }
    },
    markets: {
      buckets: [{
        conditionId: 'bucketA',
        marketSlug: 'market-a',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        bestAsk: 0.38,
        spread: 0.03,
        askDepth: 100,
        ruleFlags: detectRuleFlags('Resolves using KMDW from the National Weather Service.')
      }]
    }
  });

  assert.equal(recommendations.best.status, 'passed');
  assert.equal(recommendations.best.suggestedSize, 2);
  assert.equal(recommendations.best.kellyFraction, 0.02);
  assert.equal(recommendations.best.estimatedCost, 0.0105);
  assert.equal(recommendations.best.riskAdjustedEdge, 0.1095);
  assert.equal(recommendations.best.executionPlan.executable, true);
  assert.equal(recommendations.best.executionPlan.limitPrice, 0.38);
  assert.equal(recommendations.best.executionPlan.liveTradingAllowed, true);
  assert.equal(recommendations.best.executionPlan.mode, 'live-routing');
  assert.equal(recommendations.best.executionPlan.blockers.length, 0);
  assert.equal(recommendations.best.executionPlan.desiredContracts, 5.2632);
  assert.equal(recommendations.best.executionPlan.depthCoverage, 19);
});

test('buildChicagoRecommendations treats wide spread as a warning, not a blocker', () => {
  const recommendations = buildChicagoRecommendations({
    prediction: {
      confidence: 0.8,
      dayPhase: 'midday',
      bucketProbabilities: {
        bucketA: 0.7
      },
      sourceFreshness: {
        isStale: false
      }
    },
    markets: {
      buckets: [{
        conditionId: 'bucketA',
        marketSlug: 'market-a',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        bestAsk: 0.3,
        spread: 0.08,
        askDepth: 100,
        ruleFlags: detectRuleFlags('Resolves using KMDW from the National Weather Service.')
      }]
    }
  });

  assert.equal(recommendations.best.status, 'passed');
  assert.equal(recommendations.best.action, 'recommend-buy-yes');
  assert.equal(recommendations.best.executionPlan.executable, true);
  assert.equal(recommendations.best.executionPlan.blockers.length, 0);
  assert.deepEqual(recommendations.best.executionPlan.warnings, ['spread <= 5pp']);
  assert.equal(
    recommendations.best.gates.find((gate) => gate.name === 'spread <= 5pp')?.severity,
    'warning'
  );
});

test('buildChicagoRecommendations blocks execution when ask depth cannot fill recommended size', () => {
  const recommendations = buildChicagoRecommendations({
    prediction: {
      confidence: 0.8,
      dayPhase: 'midday',
      bucketProbabilities: {
        bucketA: 0.5
      },
      sourceFreshness: {
        isStale: false
      }
    },
    markets: {
      buckets: [{
        conditionId: 'bucketA',
        marketSlug: 'market-a',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        bestAsk: 0.38,
        spread: 0.03,
        askDepth: 2,
        ruleFlags: detectRuleFlags('Resolves using KMDW from the National Weather Service.')
      }]
    }
  });

  assert.equal(recommendations.best.status, 'rejected');
  assert.equal(recommendations.best.executionPlan.executable, false);
  assert.equal(recommendations.best.executionPlan.limitPrice, 0.38);
  assert.equal(recommendations.best.executionPlan.depthCoverage, 0.38);
  assert.match(recommendations.best.executionPlan.blockers.join('; '), /ask depth/);
});

test('buildChicagoTradeIntentPayload creates live-routable draft from executable KMDW signal', () => {
  const recommendation = buildChicagoRecommendations({
    targetDate: '2026-05-20',
    prediction: {
      confidence: 0.8,
      dayPhase: 'midday',
      bucketProbabilities: {
        bucketA: 0.5
      },
      sourceFreshness: {
        isStale: false
      }
    },
    markets: {
      buckets: [{
        conditionId: 'bucketA',
        marketSlug: 'market-a',
        eventSlug: 'event-a',
        marketQuestion: 'Highest temperature at KMDW on May 20?',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        bestAsk: 0.38,
        spread: 0.03,
        askDepth: 100,
        designatedSource: buildDesignatedSource(detectRuleFlags('Resolves using CLIMDW from weather.gov for Chicago-Midway.')),
        ruleFlags: detectRuleFlags('Resolves using KMDW from the National Weather Service.')
      }]
    }
  }).best;
  const payload = buildChicagoTradeIntentPayload({
    targetDate: '2026-05-20',
    station: {
      stationId: 'KMDW'
    },
    markets: {
      buckets: [{
        conditionId: 'bucketA',
        marketSlug: 'market-a',
        eventSlug: 'event-a',
        marketQuestion: 'Highest temperature at KMDW on May 20?'
      }]
    },
    recommendations: {
      best: recommendation
    }
  }, recommendation);
  const intent = buildTradeIntentPayload(payload);

  assert.equal(payload.status, 'draft');
  assert.equal(payload.confirmedAt, null);
  assert.equal(payload.executionRequest.constraints.liveTradingAllowed, true);
  assert.equal(payload.executionRequest.constraints.requiresManualSubmission, false);
  assert.equal(payload.executionRequest.constraints.liveReduceAllowed, true);
  assert.equal(payload.executionRequest.constraints.liveFlattenAllowed, true);
  assert.equal(payload.executionRequest.constraints.automatedExitAllowed, true);
  assert.equal(payload.executionRequest.constraints.venueOrderSubmissionAllowed, true);
  assert.equal(payload.executionRequest.constraints.pollingMarketDataRequired, true);
  assert.equal(payload.executionRequest.constraints.streamingMarketDataAllowed, false);
  assert.equal(payload.executionRequest.constraints.weatherProviderId, 'kmdw-nws-climdw');
  assert.equal(payload.executionRequest.constraints.marketDataPolicyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(payload.executionRequest.constraints.marketDataTransport, 'polling');
  assert.equal(payload.executionRequest.positionLifecycle.policyId, 'kmdw-live-position-lifecycle-v1');
  assert.equal(payload.executionRequest.positionLifecycle.liveFlattenAllowed, true);
  assert.equal(payload.executionRequest.marketDataPolicy.policyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(payload.executionRequest.marketDataPolicy.streamingEnabled, false);
  assert.equal(payload.executionRequest.marketDataPolicy.streaming.supported, false);
  assert.equal(intent.status, 'draft');
  assert.equal(intent.confirmedAt, null);
  assert.equal(intent.executionRequest.requestType, 'market-buy-intent');
  assert.equal(intent.executionRequest.constraints.liveTradingAllowed, true);
  assert.equal(intent.executionRequest.constraints.requiresManualSubmission, false);
  assert.equal(intent.executionRequest.constraints.venueOrderSubmissionAllowed, true);
  assert.equal(intent.executionRequest.marketDataPolicy.policyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(intent.executionRequest.marketDataPolicy.streaming.enabled, false);
  assert.equal(getTradeIntentExecutionBlocker(intent), 'Only confirmed trade intents can be submitted for live trading.');
});

test('buildKmdwPositionLifecycle recommends reduce and flatten windows with live routing', () => {
  const lateAfternoon = buildKmdwPositionLifecycle({
    targetDate: '2026-05-20',
    dayPhase: 'late-afternoon',
    timeToResolutionMs: 3 * 60 * 60 * 1000,
    prediction: {
      thresholdDiagnostics: {
        status: 'contested'
      },
      sourceFreshness: {
        isStale: false
      }
    }
  });
  const evening = buildKmdwPositionLifecycle({
    targetDate: '2026-05-20',
    dayPhase: 'evening',
    timeToResolutionMs: 60 * 60 * 1000,
    prediction: {
      thresholdDiagnostics: {
        status: 'knife-edge'
      },
      sourceFreshness: {
        isStale: true
      }
    }
  });

  assert.equal(lateAfternoon.recommendedAction, 'manual-reduce-before-late-print');
  assert.equal(lateAfternoon.liveReduceAllowed, true);
  assert.equal(lateAfternoon.automatedExitAllowed, true);
  assert.match(lateAfternoon.instruction, /Late-print risk/);
  assert.equal(evening.recommendedAction, 'manual-flatten-before-final-print');
  assert.equal(evening.liveFlattenAllowed, true);
  assert.match(evening.instruction, /Final-print risk/);
  assert.match(evening.instruction, /Threshold is knife-edge/);
});

test('KMDW market data policy uses polling and explicitly disables streaming', () => {
  const polymarketPolicy = getPolymarketMarketDataPolicy({
    polymarketMarketDataPollIntervalMs: 7000,
    polymarketMarketDataStatusPollIntervalMs: 9000,
    polymarketMarketDataBoardPollIntervalMs: 180000
  });
  const kmdwPolicy = buildKmdwMarketDataPolicy({
    polymarketMarketDataPollIntervalMs: 7000,
    chicagoWeatherRefreshIntervalMs: 180000,
    chicagoWeatherHotRefreshIntervalMs: 60000
  }, {
    dayPhase: 'late-afternoon',
    snapshotPollIntervalMs: 45000
  });
  const intentPolicy = buildKmdwIntentMarketDataPolicy({
    executionRequest: {
      marketDataPolicy: {
        streamingEnabled: true,
        polling: {
          quotePollIntervalMs: 6500
        },
        streaming: {
          enabled: true,
          supported: true,
          websocketClient: true
        }
      }
    }
  });

  assert.equal(polymarketPolicy.transport, 'polling');
  assert.equal(polymarketPolicy.polling.quotePollIntervalMs, 7000);
  assert.equal(polymarketPolicy.polling.statusPollIntervalMs, 9000);
  assert.equal(polymarketPolicy.polling.boardPollIntervalMs, 180000);
  assert.equal(polymarketPolicy.streaming.enabled, false);
  assert.equal(polymarketPolicy.streaming.supported, false);
  assert.match(polymarketPolicy.streaming.reason, /Streaming market data is not implemented/);
  assert.equal(kmdwPolicy.policyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(kmdwPolicy.parentPolicyId, 'polymarket-us-rest-polling-v1');
  assert.equal(kmdwPolicy.stationId, 'KMDW');
  assert.equal(kmdwPolicy.polling.kmdwSnapshotPollIntervalMs, 45000);
  assert.equal(kmdwPolicy.streamingEnabled, false);
  assert.equal(kmdwPolicy.streaming.websocketClient, false);
  assert.equal(intentPolicy.policyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(intentPolicy.polling.quotePollIntervalMs, 6500);
  assert.equal(intentPolicy.streamingEnabled, false);
  assert.equal(intentPolicy.streaming.enabled, false);
  assert.equal(intentPolicy.streaming.supported, false);
  assert.equal(intentPolicy.streaming.websocketClient, false);
});

test('buildTradeIntentPayload enables KMDW live routing fields', () => {
  const intent = buildTradeIntentPayload({
    status: 'confirmed',
    confirmedAt: '2026-05-20T15:00:00.000Z',
    eventSlug: 'event-a',
    marketSlug: 'market-a',
    conditionId: 'bucketA',
    marketQuestion: 'Highest temperature at KMDW on May 20?',
    outcomeLabel: '60-61',
    tradeAmount: 2,
    tradeSuggestion: {
      amount: 2,
      stopLossProbability: 0.3,
      takeProfitProbability: 0.5
    },
    executionRequest: {
      requestType: 'market-buy-intent',
      readyForExecution: true,
      constraints: {
        liveTradingAllowed: true,
        requiresManualSubmission: false,
        venueOrderSubmissionAllowed: true
      }
    }
  });

  assert.equal(intent.executionRequest.requestType, 'market-buy-intent');
  assert.equal(intent.executionRequest.readyForExecution, true);
  assert.equal(intent.executionRequest.constraints.kmdwPaperManualOnly, false);
  assert.equal(intent.executionRequest.constraints.liveTradingAllowed, true);
  assert.equal(intent.executionRequest.constraints.requiresManualSubmission, false);
  assert.equal(intent.executionRequest.constraints.venueOrderSubmissionAllowed, true);
  assert.equal(intent.executionRequest.constraints.liveReduceAllowed, true);
  assert.equal(intent.executionRequest.constraints.liveFlattenAllowed, true);
  assert.equal(intent.executionRequest.constraints.automatedExitAllowed, true);
  assert.equal(intent.executionRequest.constraints.pollingMarketDataRequired, true);
  assert.equal(intent.executionRequest.constraints.streamingMarketDataAllowed, false);
  assert.equal(intent.executionRequest.constraints.marketDataPolicyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(intent.executionRequest.constraints.marketDataTransport, 'polling');
  assert.equal(intent.executionRequest.marketDataPolicy.policyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(intent.executionRequest.marketDataPolicy.streaming.enabled, false);
  assert.equal(intent.liveTradingPolicy.liveRoutingBlocked, false);
  assert.equal(intent.liveTradingPolicy.liveTradingAllowed, true);
  assert.equal(getTradeIntentLiveTradingPolicy(intent).scope, 'kmdw-weather');
  assert.equal(getTradeIntentExecutionBlocker(intent), null);
});

test('getTradeIntentExecutionBlocker allows confirmed KMDW live intents', () => {
  const intent = buildTradeIntentPayload({
    status: 'confirmed',
    confirmedAt: '2026-05-20T15:00:00.000Z',
    eventSlug: 'event-a',
    marketSlug: 'market-a',
    conditionId: 'bucketA',
    marketQuestion: 'Highest temperature at KMDW on May 20?',
    outcomeLabel: '60-61',
    tradeAmount: 2,
    tradeSuggestion: {
      amount: 2,
      stopLossProbability: 0.3,
      takeProfitProbability: 0.5
    },
    executionRequest: {
      constraints: {
        liveTradingAllowed: false,
        requiresManualSubmission: true
      }
    }
  });

  assert.equal(intent.executionRequest.constraints.liveTradingAllowed, true);
  assert.equal(intent.executionRequest.constraints.requiresManualSubmission, false);
  assert.equal(getTradeIntentExecutionBlocker(intent), null);
});

test('getTradeIntentLiveRoutingBlocker allows tracked KMDW exits', () => {
  const hardened = hardenTradeIntentLiveRouting({
    id: 'tracked-kmdw',
    status: 'tracking',
    confirmedAt: '2026-05-20T15:00:00.000Z',
    eventSlug: 'event-a',
    marketSlug: 'market-a',
    conditionId: 'bucketA',
    marketQuestion: 'Highest temperature at KMDW on May 20?',
    outcomeLabel: '60-61',
    tradeAmount: 2,
    tradeSuggestion: {
      amount: 2,
      stopLossProbability: 0.3,
      takeProfitProbability: 0.5
    },
    executionRequest: {
      requestType: 'market-buy-intent',
      readyForExecution: true,
      constraints: {
        liveTradingAllowed: true,
        requiresManualSubmission: false
      }
    },
    monitoring: {
      state: 'active'
    }
  });

  assert.equal(hardened.executionRequest.readyForExecution, true);
  assert.equal(hardened.executionRequest.constraints.liveRoutingBlocked, false);
  assert.equal(hardened.executionRequest.constraints.liveReduceAllowed, true);
  assert.equal(hardened.executionRequest.constraints.liveFlattenAllowed, true);
  assert.equal(hardened.executionRequest.constraints.automatedExitAllowed, true);
  assert.equal(hardened.executionRequest.constraints.pollingMarketDataRequired, true);
  assert.equal(hardened.executionRequest.constraints.streamingMarketDataAllowed, false);
  assert.equal(hardened.executionRequest.constraints.marketDataPolicyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(hardened.executionRequest.constraints.marketDataTransport, 'polling');
  assert.equal(hardened.executionRequest.marketDataPolicy.policyId, 'kmdw-rest-polling-market-data-v1');
  assert.equal(hardened.executionRequest.marketDataPolicy.streamingEnabled, false);
  assert.equal(hardened.executionRequest.marketDataPolicy.streaming.supported, false);
  assert.equal(getTradeIntentLiveRoutingBlocker(hardened), null);
});

test('summarizeChicagoBacktestRows scores settled bucket recommendations', () => {
  const summary = summarizeChicagoBacktestRows([{
    prediction_id: 'prediction-a',
    event_date: '2026-05-18',
    market_slug: 'market-a',
    condition_id: 'bucket-a',
    outcome_label: '78 to 79',
    action: 'recommend-buy-yes',
    status: 'passed',
    fair_probability: 0.7,
    weather_probability: 0.6,
    market_price: 0.4,
    edge: 0.3,
    expected_high: 78.2,
    actual_high: 79,
    raw_json: {
      lowTemp: 78,
      highTemp: 79
    }
  }, {
    prediction_id: 'prediction-b',
    event_date: '2026-05-18',
    market_slug: 'market-b',
    condition_id: 'bucket-b',
    outcome_label: '80 to 81',
    action: 'watch',
    status: 'rejected',
    fair_probability: 0.2,
    weather_probability: 0.3,
    market_price: 0.5,
    edge: -0.3,
    expected_high: 78.2,
    actual_high: 79,
    raw_json: {
      lowTemp: 80,
      highTemp: 81
    }
  }]);

  assert.equal(summary.recommendationCount, 2);
  assert.equal(summary.actionableCount, 1);
  assert.equal(summary.settledCount, 2);
  assert.equal(summary.settledActionableCount, 1);
  assert.equal(summary.hitRate, 1);
  assert.equal(summary.oneSharePnl, 0.6);
  assert.equal(summary.forecastMae, 0.8);
  assert.equal(summary.benchmarks.fusedModel.brierScore, 0.065);
  assert.equal(summary.benchmarks.weatherOnly.brierScore, 0.125);
  assert.equal(summary.benchmarks.marketOnly.brierScore, 0.305);
  assert.equal(summary.benchmarks.edgeVsMarket.brierImprovement, 0.24);
  assert.equal(summary.benchmarks.edgeVsWeatherOnly.brierImprovement, 0.06);
  assert.equal(summary.benchmarks.edgeVsMarket.lowerBrierWinner, 'fused-model');
  assert.equal(summary.benchmarks.edgeVsWeatherOnly.lowerBrierWinner, 'fused-model');
  assert.equal(summary.benchmarks.fusedModel.calibration.meanAbsoluteCalibrationError, 0.25);
  assert.deepEqual(summary.benchmarks.fusedModel.calibration.bins.map((bin) => bin.bin), ['20-30%', '70-80%']);
  assert.equal(summary.benchmarks.weatherOnly.calibration.meanAbsoluteCalibrationError, 0.35);
  assert.equal(summary.benchmarks.marketOnly.calibration.meanAbsoluteCalibrationError, 0.55);
});

test('summarizeChicagoBacktestRows includes net trading metrics after costs', () => {
  const summary = summarizeChicagoBacktestRows([{
    prediction_id: 'prediction-a',
    event_date: '2026-05-18',
    prediction_time: '2026-05-18T17:00:00.000Z',
    condition_id: 'bucket-a',
    action: 'recommend-buy-yes',
    status: 'passed',
    fair_probability: 0.7,
    market_price: 0.4,
    actual_high: 79,
    raw_json: {
      lowTemp: 78,
      highTemp: 79,
      estimatedCost: 0.02
    }
  }, {
    prediction_id: 'prediction-b',
    event_date: '2026-05-19',
    prediction_time: '2026-05-19T17:00:00.000Z',
    condition_id: 'bucket-b',
    action: 'recommend-buy-yes',
    status: 'passed',
    fair_probability: 0.65,
    market_price: 0.55,
    actual_high: 77,
    raw_json: {
      lowTemp: 80,
      highTemp: 81,
      costBreakdown: {
        totalCost: 0.01
      }
    }
  }]);

  assert.equal(summary.trading.grossOneSharePnl, 0.05);
  assert.equal(summary.trading.netOneSharePnl, 0.02);
  assert.equal(summary.trading.averageNetPnlPerActionable, 0.01);
  assert.equal(summary.trading.maxDrawdown, 0.56);
  assert.equal(summary.trading.sharpeLike, 0.0248);
  assert.deepEqual(summary.trading.equityCurve.map((row) => row.cumulativeNetPnl), [0.58, 0.02]);
  assert.equal(summary.fillAdjusted.attemptedActionableCount, 2);
  assert.equal(summary.fillAdjusted.filledActionableCount, 2);
  assert.equal(summary.fillAdjusted.noFillCount, 0);
  assert.equal(summary.rows[0].estimatedCost, 0.02);
  assert.equal(summary.rows[1].netOneSharePnl, -0.56);
});

test('summarizeChicagoBacktestRows reports fill-adjusted metrics from execution plans', () => {
  const summary = summarizeChicagoBacktestRows([{
    prediction_id: 'prediction-a',
    event_date: '2026-05-18',
    prediction_time: '2026-05-18T17:00:00.000Z',
    condition_id: 'bucket-a',
    action: 'recommend-buy-yes',
    status: 'passed',
    fair_probability: 0.7,
    market_price: 0.4,
    actual_high: 79,
    raw_json: {
      lowTemp: 78,
      highTemp: 79,
      estimatedCost: 0.02,
      executionPlan: {
        executable: true
      }
    }
  }, {
    prediction_id: 'prediction-b',
    event_date: '2026-05-19',
    prediction_time: '2026-05-19T17:00:00.000Z',
    condition_id: 'bucket-b',
    action: 'recommend-buy-yes',
    status: 'passed',
    fair_probability: 0.65,
    market_price: 0.55,
    actual_high: 77,
    raw_json: {
      lowTemp: 80,
      highTemp: 81,
      estimatedCost: 0.01,
      executionPlan: {
        executable: false,
        blockers: ['ask depth below recommended size']
      }
    }
  }]);

  assert.equal(summary.settledActionableCount, 2);
  assert.equal(summary.fillAdjusted.attemptedActionableCount, 2);
  assert.equal(summary.fillAdjusted.filledActionableCount, 1);
  assert.equal(summary.fillAdjusted.noFillCount, 1);
  assert.equal(summary.fillAdjusted.fillRate, 0.5);
  assert.equal(summary.fillAdjusted.trading.netOneSharePnl, 0.58);
  assert.deepEqual(summary.fillAdjusted.topNoFillReasons, [{
    reason: 'ask depth below recommended size',
    count: 1
  }]);
  assert.equal(summary.rows[1].executionExecutable, false);
  assert.equal(summary.rows[1].netOneSharePnl, null);
});

test('summarizeChicagoSourceAuditRows flags changed and blocked KMDW source text', () => {
  const summary = summarizeChicagoSourceAuditRows([{
    event_date: '2026-05-20',
    condition_id: 'bucket-a',
    market_slug: 'market-a',
    outcome_label: '70 to 71',
    low_temp: 70,
    high_temp: 71,
    rule_text_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    source_verified: true,
    designated_station_id: 'KMDW',
    designated_source_provider: 'NWS CLIMDW',
    source_trade_gate: 'paper-signals-allowed',
    captured_at: '2026-05-20T14:00:00.000Z'
  }, {
    event_date: '2026-05-20',
    condition_id: 'bucket-a',
    market_slug: 'market-a',
    outcome_label: '70 to 71',
    low_temp: 70,
    high_temp: 71,
    rule_text_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    source_verified: true,
    designated_station_id: 'KMDW',
    designated_source_provider: 'NWS CLIMDW',
    source_trade_gate: 'paper-signals-allowed',
    captured_at: '2026-05-20T15:00:00.000Z'
  }, {
    event_date: '2026-05-20',
    condition_id: 'bucket-b',
    market_slug: 'market-b',
    outcome_label: '72 to 73',
    low_temp: 72,
    high_temp: 73,
    rule_text_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    source_verified: false,
    designated_station_id: null,
    source_trade_gate: 'live-trading-blocked',
    captured_at: '2026-05-20T15:00:00.000Z'
  }]);

  assert.equal(summary.marketCount, 2);
  assert.equal(summary.changedCount, 1);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.verifiedCount, 1);
  assert.equal(summary.markets[0].conditionId, 'bucket-a');
  assert.equal(summary.markets[0].status, 'changed-source-text');
  assert.equal(summary.markets[0].sourceTextHash, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.deepEqual(summary.markets[0].distinctSourceTextHashes, [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  ]);
  assert.equal(summary.markets[1].status, 'blocked');
});

test('normalizeCdoDailyRows maps NOAA CDO daily summaries to KMDW archive records', () => {
  const rows = normalizeCdoDailyRows([{
    date: '2026-05-20T00:00:00',
    datatype: 'TMAX',
    station: 'GHCND:USW00014819',
    value: 77
  }, {
    date: '2026-05-20T00:00:00',
    datatype: 'TMIN',
    station: 'GHCND:USW00014819',
    value: 52
  }, {
    date: '2026-05-20T00:00:00',
    datatype: 'PRCP',
    station: 'GHCND:USW00014819',
    value: 0.05
  }], {
    stationId: 'GHCND:USW00014819',
    fetchedAt: '2026-06-04T12:00:00.000Z'
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].archiveDate, '2026-05-20');
  assert.equal(rows[0].stationId, 'GHCND:USW00014819');
  assert.equal(rows[0].source, 'ncei-cdo-ghcnd');
  assert.equal(rows[0].maxTempF, 77);
  assert.equal(rows[0].minTempF, 52);
  assert.equal(rows[0].precipitationIn, 0.05);
  assert.equal(rows[0].rawData.length, 3);
});

test('chunkDateRange splits NOAA CDO daily requests at the one-year limit', () => {
  assert.deepEqual(chunkDateRange('2025-01-01', '2026-01-10'), [{
    dateFrom: '2025-01-01',
    dateTo: '2025-12-31'
  }, {
    dateFrom: '2026-01-01',
    dateTo: '2026-01-10'
  }]);
});

test('persistChicagoDailyArchive stores de-duplicated KMDW archive rows in JSONL fallback', async () => {
  const weatherDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probis-kmdw-archive-'));
  const env = {
    databaseUrl: '',
    weatherDataDir
  };

  await persistChicagoDailyArchive(env, {
    source: 'ncei-cdo-ghcnd',
    stationId: 'GHCND:USW00014819',
    records: [{
      stationId: 'GHCND:USW00014819',
      archiveStationId: 'GHCND:USW00014819',
      archiveDate: '2026-05-20',
      source: 'ncei-cdo-ghcnd',
      maxTempF: 76,
      fetchedAt: '2026-06-04T12:00:00.000Z'
    }, {
      stationId: 'GHCND:USW00014819',
      archiveStationId: 'GHCND:USW00014819',
      archiveDate: '2026-05-20',
      source: 'ncei-cdo-ghcnd',
      maxTempF: 77,
      fetchedAt: '2026-06-04T13:00:00.000Z'
    }]
  });

  const archive = await getChicagoDailyArchive(env, {
    dateFrom: '2026-05-20',
    dateTo: '2026-05-20'
  });

  assert.equal(archive.enabled, true);
  assert.equal(archive.storage, 'jsonl');
  assert.equal(archive.recordCount, 1);
  assert.equal(archive.records[0].archiveDate, '2026-05-20');
  assert.equal(archive.records[0].maxTempF, 77);
});

test('persistChicagoSnapshot mirrors KMDW rows into SQLite and Parquet local analytics store', async () => {
  const weatherDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probis-kmdw-local-store-'));
  const env = {
    databaseUrl: '',
    weatherDataDir,
    weatherLocalSqlitePath: path.join(weatherDataDir, 'kmdw.sqlite'),
    weatherLocalParquetDir: path.join(weatherDataDir, 'parquet'),
    weatherLocalStoreEnabled: true,
    weatherLocalParquetEnabled: true
  };
  const snapshot = {
    generatedAt: '2026-05-20T16:00:00.000Z',
    targetDate: '2026-05-20',
    station: {
      stationId: 'KMDW'
    },
    observations: {
      observedHighSoFar: 75,
      currentObservedTemp: 73
    },
    settlement: {
      status: 'pending'
    },
    markets: {
      status: 'ready',
      buckets: [{
        marketSlug: 'kmdw-60-61',
        conditionId: 'bucket-a',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        bestAsk: 0.42,
        marketProbability: 0.4,
        spread: 0.03,
        designatedSource: {
          verified: true
        }
      }]
    },
    prediction: {
      predictionTime: '2026-05-20T16:00:00.000Z',
      stationId: 'KMDW',
      dayPhase: 'midday',
      expectedHigh: 76.4,
      stdDev: 2.1,
      confidence: 0.72
    },
    recommendations: {
      recommendations: [{
        marketSlug: 'kmdw-60-61',
        conditionId: 'bucket-a',
        outcomeLabel: '60-61',
        action: 'watch',
        status: 'rejected',
        fairProbability: 0.47,
        marketPrice: 0.42,
        edge: 0.05,
        maxEntryPrice: 0.39,
        suggestedSize: 0
      }]
    }
  };

  const persistence = await persistChicagoSnapshot(env, snapshot);
  const sqliteStat = await fs.stat(env.weatherLocalSqlitePath);
  const snapshotParquetStat = await fs.stat(path.join(env.weatherLocalParquetDir, 'kmdw_snapshots.parquet'));
  const marketParquetStat = await fs.stat(path.join(env.weatherLocalParquetDir, 'kmdw_market_snapshots.parquet'));
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const sqliteBytes = await fs.readFile(env.weatherLocalSqlitePath);
  const db = new SQL.Database(sqliteBytes);

  try {
    assert.equal(persistence.storage, 'jsonl');
    assert.equal(persistence.localAnalytics.enabled, true);
    assert.equal(persistence.localAnalytics.storage, 'sqlite-parquet');
    assert.equal(sqliteStat.size > 0, true);
    assert.equal(snapshotParquetStat.size > 0, true);
    assert.equal(marketParquetStat.size > 0, true);
    assert.equal(db.exec('select count(*) from kmdw_snapshots')[0].values[0][0], 1);
    assert.equal(db.exec('select count(*) from kmdw_market_snapshots')[0].values[0][0], 1);
    assert.equal(db.exec('select count(*) from kmdw_predictions')[0].values[0][0], 1);
    assert.equal(db.exec('select count(*) from kmdw_trade_recommendations')[0].values[0][0], 1);
  } finally {
    db.close();
  }
});

test('normalizeOpenMeteoPreviousRunsRows maps hourly KMDW forecast vintages by lead day', () => {
  const rows = normalizeOpenMeteoPreviousRunsRows({
    latitude: 41.7862,
    longitude: -87.7524,
    timezone: 'America/Chicago',
    generationtime_ms: 12.3,
    hourly_units: {
      time: 'iso8601',
      temperature_2m_previous_day1: '°F'
    },
    hourly: {
      time: ['2026-05-20T00:00', '2026-05-20T01:00'],
      temperature_2m_previous_day1: [57.4, 55.3]
    }
  }, {
    model: 'gfs_seamless',
    fetchedAt: '2026-06-05T12:00:00.000Z',
    leadDays: [1]
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].stationId, 'KMDW');
  assert.equal(rows[0].source, 'open-meteo-previous-runs');
  assert.equal(rows[0].targetDate, '2026-05-20');
  assert.equal(rows[0].validTimeLocal, '2026-05-20T00:00');
  assert.equal(rows[0].leadDays, 1);
  assert.equal(rows[0].forecastTempF, 57.4);
  assert.equal(rows[0].rawData.unit, '°F');
});

test('parseLeadDays and forecast vintage chunking normalize backfill requests', () => {
  assert.deepEqual(parseLeadDays('1,3,7'), [1, 3, 7]);
  assert.deepEqual(chunkForecastVintageDateRange('2026-05-01', '2026-06-05'), [{
    dateFrom: '2026-05-01',
    dateTo: '2026-05-31'
  }, {
    dateFrom: '2026-06-01',
    dateTo: '2026-06-05'
  }]);
});

test('persistChicagoForecastVintageArchive stores KMDW vintages and summarizes against archive actuals', async () => {
  const weatherDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probis-kmdw-vintage-'));
  const env = {
    databaseUrl: '',
    weatherDataDir
  };

  await persistChicagoDailyArchive(env, {
    source: 'ncei-cdo-ghcnd',
    stationId: 'GHCND:USW00014819',
    records: [{
      stationId: 'GHCND:USW00014819',
      archiveStationId: 'GHCND:USW00014819',
      archiveDate: '2026-05-20',
      source: 'ncei-cdo-ghcnd',
      maxTempF: 60,
      fetchedAt: '2026-06-04T12:00:00.000Z'
    }]
  });
  await persistChicagoForecastVintageArchive(env, {
    source: 'open-meteo-previous-runs',
    stationId: 'KMDW',
    model: 'gfs_seamless',
    leadDays: [1, 2],
    records: [{
      stationId: 'KMDW',
      source: 'open-meteo-previous-runs',
      model: 'gfs_seamless',
      targetDate: '2026-05-20',
      validTimeLocal: '2026-05-20T00:00',
      leadDays: 1,
      forecastTempF: 57,
      fetchedAt: '2026-06-05T10:00:00.000Z'
    }, {
      stationId: 'KMDW',
      source: 'open-meteo-previous-runs',
      model: 'gfs_seamless',
      targetDate: '2026-05-20',
      validTimeLocal: '2026-05-20T00:00',
      leadDays: 1,
      forecastTempF: 58,
      fetchedAt: '2026-06-05T11:00:00.000Z'
    }, {
      stationId: 'KMDW',
      source: 'open-meteo-previous-runs',
      model: 'gfs_seamless',
      targetDate: '2026-05-20',
      validTimeLocal: '2026-05-20T01:00',
      leadDays: 1,
      forecastTempF: 61,
      fetchedAt: '2026-06-05T11:00:00.000Z'
    }, {
      stationId: 'KMDW',
      source: 'open-meteo-previous-runs',
      model: 'gfs_seamless',
      targetDate: '2026-05-20',
      validTimeLocal: '2026-05-20T00:00',
      leadDays: 2,
      forecastTempF: 55,
      fetchedAt: '2026-06-05T11:00:00.000Z'
    }]
  });

  const vintages = await getChicagoForecastVintages(env, {
    dateFrom: '2026-05-20',
    dateTo: '2026-05-20'
  });
  const dayOne = vintages.dailySummaries.find((summary) => summary.leadDays === 1);

  assert.equal(vintages.enabled, true);
  assert.equal(vintages.storage, 'jsonl');
  assert.equal(vintages.recordCount, 3);
  assert.equal(vintages.dailySummaries.length, 2);
  assert.equal(dayOne.forecastHighF, 61);
  assert.equal(dayOne.actualHighF, 60);
  assert.equal(dayOne.errorF, 1);
  assert.deepEqual(vintages.summary.maeByLeadDay, [{
    leadDays: 1,
    count: 1,
    maeF: 1,
    biasF: 1
  }, {
    leadDays: 2,
    count: 1,
    maeF: 5,
    biasF: -5
  }]);
});

test('buildHistoricalBoardArchiveFromBuckets reconstructs full KMDW boards from quote and trade history', () => {
  const buckets = [{
    marketSlug: 'chicago-high-60-61',
    eventSlug: 'chicago-high-may-20',
    conditionId: 'condition-a',
    targetDate: '2026-05-20',
    outcomeLabel: '60-61',
    lowTemp: 60,
    highTemp: 61,
    yesTokenId: 'token-a',
    rulesTextHash: 'rules-a',
    designatedSource: {
      verified: true,
      verificationStatus: 'verified-kmdw-midway',
      tradeGate: 'paper-signals-allowed'
    }
  }, {
    marketSlug: 'chicago-high-62-63',
    eventSlug: 'chicago-high-may-20',
    conditionId: 'condition-b',
    targetDate: '2026-05-20',
    outcomeLabel: '62-63',
    lowTemp: 62,
    highTemp: 63,
    yesTokenId: 'token-b',
    rulesTextHash: 'rules-b',
    designatedSource: {
      verified: true,
      verificationStatus: 'verified-kmdw-midway',
      tradeGate: 'paper-signals-allowed'
    }
  }];
  const archive = buildHistoricalBoardArchiveFromBuckets(buckets, {
    dateFrom: '2026-05-20',
    dateTo: '2026-05-20',
    startTs: 1_790_000_000,
    endTs: 1_790_000_180,
    priceHistoryByTokenId: {
      'token-a': [{
        t: 1_790_000_000,
        p: 0.42
      }, {
        t: 1_790_000_120,
        p: 0.51
      }],
      'token-b': [{
        timestamp: 1_790_000_060,
        price: 0.35
      }]
    },
    trades: [{
      tradeId: 'trade-a',
      conditionId: 'condition-a',
      tokenId: 'token-a',
      timestamp: 1_790_000_180,
      price: 0.52,
      size: 12,
      side: 'BUY'
    }]
  });

  assert.equal(archive.summary.contractCount, 2);
  assert.equal(archive.summary.pricePointCount, 3);
  assert.equal(archive.summary.tradeCount, 1);
  assert.equal(archive.summary.boardSnapshotCount, 4);
  assert.equal(archive.boardSnapshots[0].contracts.length, 2);
  assert.equal(archive.boardSnapshots.at(-1).contracts[0].reconstructedPrice, 0.51);
  assert.equal(archive.boardSnapshots.at(-1).contracts[0].lastTradePrice, 0.52);
  assert.equal(archive.boardSnapshots.at(-1).contracts[0].cumulativeTradeSize, 12);
  assert.deepEqual(normalizePricePoints([{ t: 1_790_000_000, p: '0.4' }])[0], {
    timestamp: 1_790_000_000,
    time: '2026-09-21T14:13:20.000Z',
    price: 0.4
  });
  assert.equal(normalizeTradeRows([{ timestamp: 1_790_000_000, price: '0.5', size: '3' }])[0].size, 3);
});

test('persistChicagoHistoricalMarketBoards stores reconstructed boards in JSONL fallback', async () => {
  const weatherDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probis-kmdw-boards-'));
  const env = {
    databaseUrl: '',
    weatherDataDir
  };
  const archive = buildHistoricalBoardArchiveFromBuckets([{
    marketSlug: 'chicago-high-60-61',
    conditionId: 'condition-a',
    targetDate: '2026-05-20',
    outcomeLabel: '60-61',
    lowTemp: 60,
    highTemp: 61,
    yesTokenId: 'token-a',
    designatedSource: {
      verified: true,
      verificationStatus: 'verified-kmdw-midway',
      tradeGate: 'paper-signals-allowed'
    }
  }], {
    dateFrom: '2026-05-20',
    dateTo: '2026-05-20',
    startTs: 1_790_000_000,
    endTs: 1_790_000_120,
    priceHistoryByTokenId: {
      'token-a': [{
        timestamp: 1_790_000_000,
        price: 0.44
      }]
    },
    trades: []
  });

  const persistence = await persistChicagoHistoricalMarketBoards(env, archive);
  const boards = await getChicagoHistoricalMarketBoards(env, {
    dateFrom: '2026-05-20',
    dateTo: '2026-05-20'
  });

  assert.equal(persistence.storage, 'jsonl');
  assert.equal(persistence.boardSnapshotCount, 1);
  assert.equal(boards.archiveCount, 1);
  assert.equal(boards.summary.contractCount, 1);
  assert.equal(boards.summary.pricePointCount, 1);
  assert.deepEqual(boards.summary.eventDates, ['2026-05-20']);
});

test('trainTabularWeatherModel fits a versioned KMDW logistic calibration artifact', () => {
  const rows = Array.from({ length: 24 }, (_, index) => {
    const target = index % 2 === 1 ? 1 : 0;
    const simulationProbability = target ? 0.76 + (index % 3) * 0.03 : 0.18 + (index % 3) * 0.03;

    return {
      eventDate: `2026-05-${String(1 + Math.floor(index / 2)).padStart(2, '0')}`,
      predictionTime: `2026-05-${String(1 + Math.floor(index / 2)).padStart(2, '0')}T12:00:00.000Z`,
      target,
      actualOutcome: target === 1,
      baselineProbabilities: {
        fusedModel: simulationProbability,
        weatherOnly: simulationProbability,
        marketOnly: 0.5
      },
      features: {
        simulation_probability: simulationProbability,
        market_probability: 0.5,
        gross_simulation_edge: simulationProbability - 0.5,
        estimated_cost: 0.02,
        expected_high: target ? 72 : 58,
        std_dev: 2,
        observed_high_so_far: target ? 70 : 56,
        range_min: 70,
        range_max: 72,
        range_width: 2,
        range_center: 71,
        range_distance_from_expected: target ? 1 : 13,
        day_phase_code: 2,
        spread: 0.02,
        is_yes_outcome: 1
      }
    };
  });
  const artifact = trainTabularWeatherModel(rows, {
    minSamples: 12,
    minClassSamples: 3,
    rollingFolds: 2,
    iterations: 250,
    learningRate: 0.08
  });
  const highScore = scoreTrainedWeatherModel(artifact, {
    simulation_probability: 0.82,
    market_probability: 0.5,
    gross_simulation_edge: 0.32,
    expected_high: 73,
    observed_high_so_far: 71,
    range_distance_from_expected: 1,
    is_yes_outcome: 1
  });
  const lowScore = scoreTrainedWeatherModel(artifact, {
    simulation_probability: 0.18,
    market_probability: 0.5,
    gross_simulation_edge: -0.32,
    expected_high: 58,
    observed_high_so_far: 56,
    range_distance_from_expected: 13,
    is_yes_outcome: 1
  });

  assert.equal(artifact.status, 'ready');
  assert.equal(artifact.training.sampleCount, 24);
  assert.equal(artifact.metrics.rolling.foldCount, 2);
  assert.equal(typeof artifact.metrics.holdout.productionLogistic.brierScore, 'number');
  assert.ok(highScore.probability > lowScore.probability);
});

test('trainTabularWeatherModel writes an insufficient-data artifact below sample thresholds', () => {
  const artifact = trainTabularWeatherModel([{
    eventDate: '2026-05-20',
    target: 1,
    actualOutcome: true,
    baselineProbabilities: {
      fusedModel: 0.7
    },
    features: {
      simulation_probability: 0.7
    }
  }], {
    minSamples: 4,
    minClassSamples: 2
  });

  assert.equal(artifact.status, 'insufficient_data');
  assert.equal(artifact.training.sampleCount, 1);
});

test('getChicagoModelTrainingRows assembles supervised KMDW rows from JSONL snapshots and archive actuals', async () => {
  const weatherDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probis-kmdw-training-'));
  const env = {
    databaseUrl: '',
    weatherDataDir
  };

  await persistChicagoDailyArchive(env, {
    source: 'ncei-cdo-ghcnd',
    stationId: 'GHCND:USW00014819',
    records: [{
      stationId: 'GHCND:USW00014819',
      archiveStationId: 'GHCND:USW00014819',
      archiveDate: '2026-05-20',
      source: 'ncei-cdo-ghcnd',
      maxTempF: 61,
      fetchedAt: '2026-06-04T12:00:00.000Z'
    }]
  });
  await persistChicagoForecastVintageArchive(env, {
    source: 'open-meteo-previous-runs',
    stationId: 'KMDW',
    model: 'gfs_seamless',
    leadDays: [1],
    records: [{
      stationId: 'KMDW',
      source: 'open-meteo-previous-runs',
      model: 'gfs_seamless',
      targetDate: '2026-05-20',
      validTimeLocal: '2026-05-20T15:00:00-05:00',
      leadDays: 1,
      forecastTempF: 64,
      fetchedAt: '2026-05-19T12:00:00.000Z'
    }]
  });

  const boardStartTs = Date.parse('2026-05-20T14:00:00.000Z') / 1000;
  const boardEndTs = Date.parse('2026-05-20T15:00:00.000Z') / 1000;
  const boardArchive = buildHistoricalBoardArchiveFromBuckets([{
    marketSlug: 'kmdw-bucket-a',
    conditionId: 'bucketA',
    targetDate: '2026-05-20',
    outcomeLabel: '60-61',
    lowTemp: 60,
    highTemp: 61,
    yesTokenId: 'token-bucket-a',
    designatedSource: {
      verified: true,
      verificationStatus: 'verified-kmdw-midway',
      tradeGate: 'paper-signals-allowed'
    }
  }], {
    dateFrom: '2026-05-20',
    dateTo: '2026-05-20',
    startTs: boardStartTs,
    endTs: boardEndTs,
    priceHistoryByTokenId: {
      'token-bucket-a': [{
        timestamp: boardStartTs,
        price: 0.44
      }, {
        timestamp: boardEndTs,
        price: 0.55
      }]
    }
  });
  await persistChicagoHistoricalMarketBoards(env, boardArchive);

  await persistChicagoSnapshot(env, {
    generatedAt: '2026-05-20T15:00:00.000Z',
    targetDate: '2026-05-20',
    station: {
      stationId: 'KMDW'
    },
    observations: {
      currentObservedTemp: 59,
      observedHighSoFar: 60,
      observationCount: 8
    },
    forecasts: {
      hourly: {
        forecastMaxF: 62,
        remainingMaxF: 62
      },
      grid: {
        forecastMaxF: 61,
        remainingMaxF: 61
      }
    },
    prediction: {
      predictionTime: '2026-05-20T15:00:00.000Z',
      targetDate: '2026-05-20',
      expectedHigh: 61.2,
      stdDev: 1.5,
      confidence: 0.72,
      dayPhase: 'midday',
      weatherBucketProbabilities: {
        bucketA: 0.7
      },
      marketImpliedBucketProbabilities: {
        bucketA: 0.42
      },
      bucketProbabilities: {
        bucketA: 0.68
      },
      temperatureDistribution: {
        60: 0.2,
        61: 0.5,
        62: 0.3
      },
      percentiles: {
        p10: 60,
        p50: 61,
        p90: 62
      },
      features: {
        wind_speed: 8,
        cloud_cover: 20,
        dew_point: 51,
        pressure_hpa: 1012
      }
    },
    recommendations: {
      recommendations: [{
        marketSlug: 'kmdw-bucket-a',
        conditionId: 'bucketA',
        outcomeLabel: '60-61',
        lowTemp: 60,
        highTemp: 61,
        fairProbability: 0.68,
        marketPrice: 0.42,
        edge: 0.26,
        spread: 0.02,
        bidDepth: 30,
        askDepth: 25,
        costBreakdown: {
          totalCost: 0.01
        }
      }]
    }
  });

  const trainingRows = await getChicagoModelTrainingRows(env, {
    dateFrom: '2026-05-20',
    dateTo: '2026-05-20'
  });

  assert.equal(trainingRows.storage, 'jsonl');
  assert.equal(trainingRows.rowCount, 1);
  assert.equal(trainingRows.rows[0].target, 1);
  assert.equal(trainingRows.rows[0].actualHighSource, 'ncei-cdo-ghcnd');
  assert.equal(trainingRows.rows[0].features.market_probability, 0.55);
  assert.equal(trainingRows.rows[0].features.openmeteo_forecast_high, 64);
  assert.ok(Math.abs(trainingRows.rows[0].features.forecast_disagreement - 2.8) < 0.000001);
  assert.ok(Math.abs(trainingRows.rows[0].features.range_distance_from_expected - 0.7) < 0.000001);
});

test('summarizeChicagoSignalDriftSnapshots reports insufficient KMDW history', () => {
  const summary = summarizeChicagoSignalDriftSnapshots([{
    generatedAt: '2026-05-20T14:00:00.000Z',
    targetDate: '2026-05-20',
    prediction: {
      expectedHigh: 70.2,
      thresholdDiagnostics: { status: 'stable' },
      sourceFreshness: { isStale: false }
    },
    recommendations: {
      best: {
        conditionId: 'bucket-a',
        outcomeLabel: '70 to 71',
        action: 'watch',
        fairProbability: 0.51,
        marketPrice: 0.49,
        edge: 0.02,
        riskAdjustedEdge: 0.01
      }
    }
  }]);

  assert.equal(summary.status, 'insufficient-history');
  assert.equal(summary.snapshotCount, 1);
  assert.equal(summary.materialChange, false);
  assert.deepEqual(summary.changes, []);
});

test('summarizeChicagoSignalDriftSnapshots detects material KMDW signal moves', () => {
  const summary = summarizeChicagoSignalDriftSnapshots([{
    generatedAt: '2026-05-20T15:00:00.000Z',
    targetDate: '2026-05-20',
    prediction: {
      expectedHigh: 71.6,
      thresholdDiagnostics: {
        status: 'knife-edge',
        nearestBoundary: { boundaryF: 71.5, distanceF: 0.1 },
        topBucketMargin: 0.01
      },
      sourceFreshness: { isStale: true }
    },
    recommendations: {
      best: {
        conditionId: 'bucket-b',
        outcomeLabel: '72 to 73',
        lowTemp: 72,
        highTemp: 73,
        action: 'recommend-buy-yes',
        status: 'passed',
        fairProbability: 0.66,
        marketPrice: 0.55,
        edge: 0.11,
        riskAdjustedEdge: 0.08
      }
    }
  }, {
    generatedAt: '2026-05-20T14:00:00.000Z',
    targetDate: '2026-05-20',
    prediction: {
      expectedHigh: 70.2,
      thresholdDiagnostics: {
        status: 'stable',
        nearestBoundary: { boundaryF: 71.5, distanceF: 1.3 },
        topBucketMargin: 0.12
      },
      sourceFreshness: { isStale: false }
    },
    recommendations: {
      best: {
        conditionId: 'bucket-a',
        outcomeLabel: '70 to 71',
        lowTemp: 70,
        highTemp: 71,
        action: 'watch',
        status: 'blocked',
        fairProbability: 0.52,
        marketPrice: 0.47,
        edge: 0.05,
        riskAdjustedEdge: 0.02
      }
    }
  }]);

  assert.equal(summary.status, 'material-move');
  assert.equal(summary.materialChange, true);
  assert.equal(summary.latest.bestBucket.conditionId, 'bucket-b');
  assert.equal(summary.previous.bestBucket.conditionId, 'bucket-a');
  assert.deepEqual(summary.changes.map((change) => change.name), [
    'best-bucket',
    'action',
    'risk-adjusted-edge',
    'market-price',
    'fair-probability',
    'expected-high',
    'threshold-status',
    'source-stale'
  ]);
  assert.equal(summary.changes.find((change) => change.name === 'risk-adjusted-edge').delta, 0.06);
  assert.equal(summary.changes.find((change) => change.name === 'risk-adjusted-edge').material, true);
  assert.equal(summary.changes.find((change) => change.name === 'source-stale').material, true);
});

test('buildChicagoAlertSummary emits KMDW alerts for drift, source hash changes, and threshold danger', () => {
  const alertSummary = buildChicagoAlertSummary({
    snapshot: {
      generatedAt: '2026-05-20T15:00:00.000Z',
      targetDate: '2026-05-20',
      prediction: {
        predictionTime: '2026-05-20T15:00:00.000Z',
        expectedHigh: 71.6,
        thresholdDiagnostics: {
          status: 'knife-edge',
          topBucket: {
            conditionId: 'bucket-b',
            outcomeLabel: '72 to 73'
          },
          nearestBoundary: {
            boundary: 71.5,
            distanceF: 0.1
          },
          topBucketMargin: 0.01
        }
      }
    },
    drift: {
      enabled: true,
      date: '2026-05-20',
      generatedAt: '2026-05-20T15:00:00.000Z',
      latestAt: '2026-05-20T15:00:00.000Z',
      status: 'material-move',
      materialChange: true,
      changes: [{
        name: 'best-bucket',
        from: { conditionId: 'bucket-a' },
        to: { conditionId: 'bucket-b' },
        material: true
      }, {
        name: 'risk-adjusted-edge',
        from: 0.02,
        to: 0.08,
        delta: 0.06,
        material: true
      }]
    },
    sourceAudit: {
      enabled: true,
      date: '2026-05-20',
      generatedAt: '2026-05-20T15:00:00.000Z',
      changedCount: 1,
      markets: [{
        eventDate: '2026-05-20',
        conditionId: 'bucket-a',
        outcomeLabel: '70 to 71',
        hashChanged: true,
        status: 'changed-source-text',
        latestCapturedAt: '2026-05-20T15:00:00.000Z',
        distinctSourceTextHashes: [
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        ]
      }]
    }
  });

  assert.equal(alertSummary.enabled, true);
  assert.equal(alertSummary.date, '2026-05-20');
  assert.equal(alertSummary.alertCount, 3);
  assert.equal(alertSummary.criticalCount, 3);
  assert.deepEqual(alertSummary.alerts.map((alert) => alert.type).sort(), [
    'signal-drift',
    'source-hash-change',
    'threshold-danger'
  ]);
  assert.equal(alertSummary.alerts.find((alert) => alert.type === 'threshold-danger').severity, 'critical');
});

test('persistChicagoAlerts stores active KMDW alerts and resolves stale JSONL alerts', async () => {
  const weatherDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probis-kmdw-alerts-'));
  const env = {
    databaseUrl: '',
    weatherDataDir
  };
  const alert = {
    id: 'kmdw:2026-05-20:threshold-danger:knife-edge:bucket-a',
    stationId: 'KMDW',
    eventDate: '2026-05-20',
    alertKey: 'kmdw:2026-05-20:threshold-danger:knife-edge:bucket-a',
    type: 'threshold-danger',
    severity: 'critical',
    status: 'active',
    title: 'KMDW threshold danger',
    message: 'bucket-a is knife-edge.',
    triggeredAt: '2026-05-20T15:00:00.000Z',
    raw: {
      thresholdStatus: 'knife-edge'
    }
  };

  const firstPersistence = await persistChicagoAlerts(env, [alert], {
    date: '2026-05-20',
    generatedAt: '2026-05-20T15:00:00.000Z'
  });
  const activeAlerts = await getChicagoAlerts(env, {
    date: '2026-05-20',
    status: 'active'
  });

  assert.equal(firstPersistence.storage, 'jsonl');
  assert.equal(firstPersistence.activeCount, 1);
  assert.equal(activeAlerts.alerts.length, 1);
  assert.equal(activeAlerts.alerts[0].status, 'active');

  await persistChicagoAlerts(env, [], {
    date: '2026-05-20',
    generatedAt: '2026-05-20T16:00:00.000Z'
  });
  const clearedAlerts = await getChicagoAlerts(env, {
    date: '2026-05-20',
    status: 'active'
  });
  const resolvedAlerts = await getChicagoAlerts(env, {
    date: '2026-05-20',
    status: 'resolved'
  });

  assert.equal(clearedAlerts.alerts.length, 0);
  assert.equal(resolvedAlerts.alerts.length, 1);
  assert.equal(resolvedAlerts.alerts[0].resolvedAt, '2026-05-20T16:00:00.000Z');
});
