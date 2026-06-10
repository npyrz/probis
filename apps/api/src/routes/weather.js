import { Router } from 'express';

import { getEnv } from '../config/env.js';
import {
  buildChicagoMarketCatalog,
  buildChicagoMarketCatalogFromBuckets,
  buildChicagoSnapshot,
  buildChicagoTradeIntentPayload,
  getChicagoSettlement
} from '../services/weather/chicago.js';
import { getChicagoWeatherTrackerStatus } from '../services/weather/chicago-monitor.js';
import {
  getChicagoAlerts,
  getChicagoBacktest,
  getChicagoDailyArchive,
  getChicagoForecastVintages,
  getChicagoHistoricalMarketBoards,
  getChicagoHistory,
  getChicagoSignalDrift,
  getChicagoSourceAudit,
  persistChicagoDailyArchive,
  persistChicagoForecastVintageArchive,
  persistChicagoHistoricalMarketBoards,
  persistChicagoSnapshot
} from '../services/persistence/postgres.js';
import {
  evaluateCurrentWeatherModel,
  getWeatherModelLifecycle,
  runChicagoWeatherModelTraining
} from '../services/ml/weather-training.js';
import { evaluateChicagoWeatherAlerts } from '../services/weather/chicago-alerts.js';
import { fetchKmdwForecastVintageArchive } from '../services/weather/forecast-vintage.js';
import { fetchKmdwHistoricalBoardArchive } from '../services/weather/historical-boards.js';
import { fetchKmdwNoaaDailyArchive } from '../services/weather/noaa-archive.js';
import { listWeatherProviders } from '../services/weather/providers.js';
import { createTradeIntent } from '../services/trade-intents.js';

const router = Router();

function normalizeDateQuery(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function normalizeNumberQuery(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeTextQuery(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeIntegerQuery(value) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeBooleanQuery(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeLeadDaysQuery(value) {
  if (value === undefined || value === null || value === true || value === '') {
    return undefined;
  }

  const values = (Array.isArray(value) ? value : String(value).split(','))
    .flatMap((entry) => typeof entry === 'string' ? entry.split(',') : [entry])
    .map((entry) => Number.parseInt(String(entry).trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 7);

  return values.length > 0 ? [...new Set(values)].sort((left, right) => left - right) : undefined;
}

function normalizeAlertStatusQuery(value) {
  const text = normalizeTextQuery(value);

  if (!text) {
    return undefined;
  }

  if (text.toLowerCase() === 'all') {
    return null;
  }

  return text;
}

function sendError(response, error, fallbackMessage) {
  response.status(502).json({
    ok: false,
    error: error instanceof Error ? error.message : fallbackMessage
  });
}

router.get('/api/weather/providers', (_request, response) => {
  response.json({
    ok: true,
    providers: listWeatherProviders()
  });
});

router.get('/api/weather/chicago/status', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const snapshot = await buildChicagoSnapshot(env, { date });
    const persistence = await persistChicagoSnapshot(env, snapshot);
    const alerts = await evaluateChicagoWeatherAlerts(env, {
      snapshot,
      persistSnapshot: false
    });

    response.json({
      ok: true,
      status: {
        generatedAt: snapshot.generatedAt,
        provider: snapshot.provider,
        station: snapshot.station,
        targetDate: snapshot.targetDate,
        climateDayWindow: snapshot.climateDayWindow,
        settlementStatus: snapshot.settlement.status,
        observationStatus: snapshot.observations.status,
        forecastStatus: snapshot.forecasts.status,
        marketStatus: snapshot.markets.status,
        predictionStatus: snapshot.prediction.expectedHigh === null ? 'degraded' : 'ready',
        sourceFreshness: snapshot.prediction.sourceFreshness,
        tracker: getChicagoWeatherTrackerStatus(),
        alerts: {
          activeCount: alerts.stored?.summary?.activeCount ?? alerts.activeCount,
          criticalCount: alerts.stored?.summary?.criticalCount ?? alerts.criticalCount,
          warningCount: alerts.stored?.summary?.warningCount ?? alerts.warningCount
        },
        persistence
      }
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather status');
  }
});

router.get('/api/weather/chicago/markets', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);

    if (date) {
      const snapshot = await buildChicagoSnapshot(env, { date });
      const persistence = await persistChicagoSnapshot(env, snapshot);
      const catalog = buildChicagoMarketCatalogFromBuckets(snapshot.markets.buckets, {
        dateFrom: snapshot.targetDate,
        dateTo: snapshot.targetDate
      });

      response.json({
        ok: true,
        targetDate: snapshot.targetDate,
        station: snapshot.station,
        markets: snapshot.markets,
        catalog,
        persistence
      });
      return;
    }

    const catalog = await buildChicagoMarketCatalog(env, {
      dateFrom: normalizeDateQuery(request.query.dateFrom),
      dateTo: normalizeDateQuery(request.query.dateTo),
      daysAhead: normalizeNumberQuery(request.query.daysAhead)
    });

    response.json({
      ok: true,
      station: catalog.station,
      targetDate: catalog.dateFrom,
      markets: catalog,
      catalog
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather markets');
  }
});

router.get('/api/weather/chicago/markets/:slug', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const requestedSlug = String(request.params.slug ?? '').trim();
    const catalog = date
      ? null
      : await buildChicagoMarketCatalog(env, {
        dateFrom: normalizeDateQuery(request.query.dateFrom),
        dateTo: normalizeDateQuery(request.query.dateTo),
        daysAhead: normalizeNumberQuery(request.query.daysAhead)
      });
    const catalogMarket = catalog?.buckets?.find((bucket) => (
      bucket.marketSlug === requestedSlug
      || bucket.conditionId === requestedSlug
      || bucket.eventSlug === requestedSlug
    )) ?? null;
    const snapshot = await buildChicagoSnapshot(env, { date: date ?? catalogMarket?.targetDate });
    const persistence = await persistChicagoSnapshot(env, snapshot);
    const market = snapshot.markets.buckets.find((bucket) => (
      bucket.marketSlug === requestedSlug
      || bucket.conditionId === requestedSlug
      || bucket.eventSlug === requestedSlug
    )) ?? catalogMarket;

    if (!market) {
      response.status(404).json({
        ok: false,
        error: `No Chicago weather market was found for "${requestedSlug}".`
      });
      return;
    }

    response.json({
      ok: true,
      targetDate: snapshot.targetDate,
      station: snapshot.station,
      market,
      catalog,
      prediction: {
        ...snapshot.prediction,
        temperatureDistribution: undefined
      },
      recommendation: snapshot.recommendations.recommendations.find((candidate) => candidate.conditionId === market.conditionId) ?? null,
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather market');
  }
});

router.get('/api/weather/chicago/settlement', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const settlement = await getChicagoSettlement(env, { date });

    response.json({
      ok: true,
      settlement: {
        ...settlement,
        rawText: undefined
      }
    });
  } catch (error) {
    sendError(response, error, 'Unable to parse CLIMDW settlement');
  }
});

router.get('/api/weather/chicago/snapshot', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const snapshot = await buildChicagoSnapshot(env, { date });
    const persistence = await persistChicagoSnapshot(env, snapshot);
    const alerts = await evaluateChicagoWeatherAlerts(env, {
      snapshot,
      persistSnapshot: false
    });

    response.json({
      ok: true,
      snapshot,
      alerts,
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to build Chicago weather snapshot');
  }
});

router.post('/api/weather/chicago/reprice', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.body?.date ?? request.query.date);
    const snapshot = await buildChicagoSnapshot(env, { date, force: true });
    const persistence = await persistChicagoSnapshot(env, snapshot);
    const alerts = await evaluateChicagoWeatherAlerts(env, {
      snapshot,
      persistSnapshot: false
    });

    response.json({
      ok: true,
      snapshot,
      signals: snapshot.recommendations,
      alerts,
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to reprice Chicago weather markets');
  }
});

router.post('/api/weather/chicago/intents', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.body?.date ?? request.query.date);
    const conditionId = String(request.body?.conditionId ?? '').trim();
    const tradeAmount = normalizeNumberQuery(request.body?.tradeAmount ?? request.query.tradeAmount);
    const snapshot = await buildChicagoSnapshot(env, { date, force: true });
    const persistence = await persistChicagoSnapshot(env, snapshot);
    const recommendation = conditionId
      ? snapshot.recommendations.recommendations.find((candidate) => candidate.conditionId === conditionId)
      : snapshot.recommendations.best;
    const payload = buildChicagoTradeIntentPayload(snapshot, recommendation);

    if (tradeAmount !== undefined && tradeAmount <= 0) {
      throw new Error('KMDW trade draft requires a positive tradeAmount.');
    }

    const sizedPayload = tradeAmount
      ? {
          ...payload,
          tradeAmount,
          tradeSuggestion: {
            ...payload.tradeSuggestion,
            amount: tradeAmount
          }
        }
      : payload;
    const intent = await createTradeIntent(sizedPayload);

    response.status(201).json({
      ok: true,
      targetDate: snapshot.targetDate,
      station: snapshot.station,
      recommendation,
      intent,
      persistence
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create KMDW trade draft';
    const status = message.includes('requires an executable paper signal') ? 409 : 400;

    response.status(status).json({
      ok: false,
      error: message
    });
  }
});

router.get('/api/weather/chicago/history', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const history = await getChicagoHistory(env, { date });

    response.json({
      ok: true,
      history
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather history');
  }
});

router.get('/api/weather/chicago/source-audit', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const audit = await getChicagoSourceAudit(env, { date });

    response.json({
      ok: true,
      audit
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago source audit');
  }
});

router.get('/api/weather/chicago/alerts', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const evaluate = normalizeBooleanQuery(request.query.evaluate) === true;
    const status = normalizeAlertStatusQuery(request.query.status);
    const alerts = evaluate
      ? await evaluateChicagoWeatherAlerts(env, {
        date,
        force: normalizeBooleanQuery(request.query.force) === true,
        persistSnapshot: true
      })
      : await getChicagoAlerts(env, {
        date,
        status: status === undefined ? 'active' : status,
        limit: normalizeIntegerQuery(request.query.limit) ?? 50
      });

    response.json({
      ok: true,
      alerts
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather alerts');
  }
});

router.post('/api/weather/chicago/alerts/evaluate', async (request, response) => {
  try {
    const env = getEnv();
    const alerts = await evaluateChicagoWeatherAlerts(env, {
      date: normalizeDateQuery(request.body?.date ?? request.query.date),
      force: normalizeBooleanQuery(request.body?.force ?? request.query.force) === true,
      persistSnapshot: true
    });

    response.json({
      ok: true,
      alerts
    });
  } catch (error) {
    sendError(response, error, 'Unable to evaluate Chicago weather alerts');
  }
});

router.get('/api/weather/chicago/model', async (_request, response) => {
  try {
    const env = getEnv();
    const lifecycle = await getWeatherModelLifecycle(env);

    response.json({
      ok: true,
      lifecycle
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather model lifecycle');
  }
});

router.post('/api/weather/chicago/model/train', async (request, response) => {
  try {
    const env = getEnv();
    const training = await runChicagoWeatherModelTraining(env, {
      dateFrom: normalizeDateQuery(request.body?.dateFrom ?? request.query.dateFrom),
      dateTo: normalizeDateQuery(request.body?.dateTo ?? request.query.dateTo),
      limit: normalizeIntegerQuery(request.body?.limit ?? request.query.limit) ?? env.weatherMlTrainingLimit,
      minSamples: normalizeIntegerQuery(request.body?.minSamples ?? request.query.minSamples) ?? env.weatherMlMinSamples,
      minClassSamples: normalizeIntegerQuery(request.body?.minClassSamples ?? request.query.minClassSamples) ?? env.weatherMlMinClassSamples,
      rollingFolds: normalizeIntegerQuery(request.body?.rollingFolds ?? request.query.rollingFolds) ?? env.weatherMlRollingFolds,
      holdoutFraction: normalizeNumberQuery(request.body?.holdoutFraction ?? request.query.holdoutFraction) ?? env.weatherMlHoldoutFraction
    });

    response.json({
      ok: true,
      training: {
        ok: training.ok,
        model: {
          status: training.artifact.status,
          modelId: training.artifact.modelId,
          modelType: training.artifact.modelType,
          trainedAt: training.artifact.trainedAt,
          blendWeight: training.artifact.blendWeight ?? null,
          training: training.artifact.training,
          metrics: training.artifact.metrics
        },
        trainingRows: training.trainingRows,
        paths: training.paths,
        registry: training.registry
      }
    });
  } catch (error) {
    sendError(response, error, 'Unable to train Chicago weather model');
  }
});

router.post('/api/weather/chicago/model/evaluate', async (request, response) => {
  try {
    const env = getEnv();
    const evaluation = await evaluateCurrentWeatherModel(env, {
      dateFrom: normalizeDateQuery(request.body?.dateFrom ?? request.query.dateFrom),
      dateTo: normalizeDateQuery(request.body?.dateTo ?? request.query.dateTo),
      limit: normalizeIntegerQuery(request.body?.limit ?? request.query.limit),
      modelPath: normalizeTextQuery(request.body?.modelPath ?? request.query.modelPath)
    });

    response.json({
      ok: true,
      evaluation
    });
  } catch (error) {
    sendError(response, error, 'Unable to evaluate Chicago weather model');
  }
});

router.get('/api/weather/chicago/archive', async (request, response) => {
  try {
    const env = getEnv();
    const archive = await getChicagoDailyArchive(env, {
      dateFrom: normalizeDateQuery(request.query.dateFrom),
      dateTo: normalizeDateQuery(request.query.dateTo)
    });

    response.json({
      ok: true,
      archive
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago NOAA archive');
  }
});

router.post('/api/weather/chicago/archive/backfill', async (request, response) => {
  try {
    const env = getEnv();
    const archive = await fetchKmdwNoaaDailyArchive(env, {
      dateFrom: normalizeDateQuery(request.body?.dateFrom ?? request.query.dateFrom),
      dateTo: normalizeDateQuery(request.body?.dateTo ?? request.query.dateTo),
      token: typeof request.body?.token === 'string' ? request.body.token : null
    });
    const persistence = await persistChicagoDailyArchive(env, archive);

    response.json({
      ok: true,
      archive: {
        source: archive.source,
        datasetId: archive.datasetId,
        stationId: archive.stationId,
        dateFrom: archive.dateFrom,
        dateTo: archive.dateTo,
        rawResultCount: archive.rawResultCount,
        recordCount: archive.records.length,
        firstRecord: archive.records[0] ?? null,
        lastRecord: archive.records[archive.records.length - 1] ?? null
      },
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to backfill Chicago NOAA archive');
  }
});

router.get('/api/weather/chicago/historical-boards', async (request, response) => {
  try {
    const env = getEnv();
    const historicalBoards = await getChicagoHistoricalMarketBoards(env, {
      dateFrom: normalizeDateQuery(request.query.dateFrom),
      dateTo: normalizeDateQuery(request.query.dateTo)
    });

    response.json({
      ok: true,
      historicalBoards
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago historical market boards');
  }
});

router.post('/api/weather/chicago/historical-boards/backfill', async (request, response) => {
  try {
    const env = getEnv();
    const archive = await fetchKmdwHistoricalBoardArchive(env, {
      dateFrom: normalizeDateQuery(request.body?.dateFrom ?? request.query.dateFrom),
      dateTo: normalizeDateQuery(request.body?.dateTo ?? request.query.dateTo),
      startTs: normalizeIntegerQuery(request.body?.startTs ?? request.query.startTs),
      endTs: normalizeIntegerQuery(request.body?.endTs ?? request.query.endTs),
      lookbackDays: normalizeIntegerQuery(request.body?.lookbackDays ?? request.query.lookbackDays),
      fidelityMinutes: normalizeIntegerQuery(request.body?.fidelityMinutes ?? request.query.fidelityMinutes),
      interval: normalizeTextQuery(request.body?.interval ?? request.query.interval),
      includeTrades: normalizeBooleanQuery(request.body?.includeTrades ?? request.query.includeTrades) ?? true
    });
    const persistence = await persistChicagoHistoricalMarketBoards(env, archive);

    response.json({
      ok: true,
      archive: {
        source: archive.source,
        stationId: archive.stationId,
        dateFrom: archive.dateFrom,
        dateTo: archive.dateTo,
        startTime: archive.startTime,
        endTime: archive.endTime,
        summary: archive.summary
      },
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to backfill Chicago historical market boards');
  }
});

router.get('/api/weather/chicago/forecast-vintages', async (request, response) => {
  try {
    const env = getEnv();
    const forecastVintages = await getChicagoForecastVintages(env, {
      dateFrom: normalizeDateQuery(request.query.dateFrom),
      dateTo: normalizeDateQuery(request.query.dateTo),
      leadDays: normalizeLeadDaysQuery(request.query.leadDays),
      model: normalizeTextQuery(request.query.model)
    });

    response.json({
      ok: true,
      forecastVintages
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago forecast vintages');
  }
});

router.post('/api/weather/chicago/forecast-vintages/backfill', async (request, response) => {
  try {
    const env = getEnv();
    const archive = await fetchKmdwForecastVintageArchive(env, {
      dateFrom: normalizeDateQuery(request.body?.dateFrom ?? request.query.dateFrom),
      dateTo: normalizeDateQuery(request.body?.dateTo ?? request.query.dateTo),
      leadDays: normalizeLeadDaysQuery(request.body?.leadDays ?? request.query.leadDays),
      model: normalizeTextQuery(request.body?.model ?? request.query.model)
    });
    const persistence = await persistChicagoForecastVintageArchive(env, archive);

    response.json({
      ok: true,
      archive: {
        source: archive.source,
        stationId: archive.stationId,
        model: archive.model,
        dateFrom: archive.dateFrom,
        dateTo: archive.dateTo,
        leadDays: archive.leadDays,
        requestedChunks: archive.requestedChunks,
        recordCount: archive.records.length,
        firstRecord: archive.records[0] ?? null,
        lastRecord: archive.records[archive.records.length - 1] ?? null
      },
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to backfill Chicago forecast vintages');
  }
});

router.get('/api/weather/chicago/drift', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const drift = await getChicagoSignalDrift(env, { date });

    response.json({
      ok: true,
      drift
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago signal drift');
  }
});

router.get('/api/weather/chicago/signals', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const snapshot = await buildChicagoSnapshot(env, { date });
    const persistence = await persistChicagoSnapshot(env, snapshot);
    const alerts = await evaluateChicagoWeatherAlerts(env, {
      snapshot,
      persistSnapshot: false
    });

    response.json({
      ok: true,
      targetDate: snapshot.targetDate,
      station: snapshot.station,
      climateDayWindow: snapshot.climateDayWindow,
      prediction: snapshot.prediction,
      recommendations: snapshot.recommendations,
      alerts,
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather signals');
  }
});

router.post('/api/weather/backtest', async (request, response) => {
  try {
    const env = getEnv();
    const backtest = await getChicagoBacktest(env, {
      dateFrom: normalizeDateQuery(request.body?.dateFrom ?? request.query.dateFrom),
      dateTo: normalizeDateQuery(request.body?.dateTo ?? request.query.dateTo),
      minEdge: normalizeNumberQuery(request.body?.minEdge ?? request.query.minEdge)
    });

    response.json({
      ok: true,
      backtest
    });
  } catch (error) {
    sendError(response, error, 'Unable to run Chicago weather backtest');
  }
});

router.get('/api/weather/chicago/backtest', async (request, response) => {
  try {
    const env = getEnv();
    const backtest = await getChicagoBacktest(env, {
      dateFrom: normalizeDateQuery(request.query.dateFrom),
      dateTo: normalizeDateQuery(request.query.dateTo),
      minEdge: normalizeNumberQuery(request.query.minEdge)
    });

    response.json({
      ok: true,
      backtest
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago weather backtest');
  }
});

router.get('/api/polymarket/chicago/snapshots', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const history = await getChicagoHistory(env, { date });

    response.json({
      ok: true,
      snapshots: {
        enabled: history.enabled,
        reason: history.reason,
        marketSnapshots: history.marketSnapshots,
        predictions: history.predictions,
        recommendations: history.recommendations
      }
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago market snapshots');
  }
});

router.get('/api/recommendations/chicago', async (request, response) => {
  try {
    const env = getEnv();
    const date = normalizeDateQuery(request.query.date);
    const snapshot = await buildChicagoSnapshot(env, { date });
    const persistence = await persistChicagoSnapshot(env, snapshot);

    response.json({
      ok: true,
      targetDate: snapshot.targetDate,
      station: snapshot.station,
      climateDayWindow: snapshot.climateDayWindow,
      prediction: snapshot.prediction,
      recommendations: snapshot.recommendations,
      persistence
    });
  } catch (error) {
    sendError(response, error, 'Unable to load Chicago recommendations');
  }
});

export default router;
