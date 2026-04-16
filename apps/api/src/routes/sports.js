import { Router } from 'express';

import { getEnv } from '../config/env.js';
import { resolveEventAnalytics } from '../services/polymarket/event-data.js';
import { runSportsBacktest } from '../services/sports/backtest.js';
import { loadPolymarketUsTeamUniverse, loadSportsHistoryStore } from '../services/sports/history-store.js';
import { importNbaHistory } from '../services/sports/nba-importer.js';

const router = Router();

router.get('/api/sports/status', async (_request, response) => {
  try {
    const [teamUniverse, historyStore] = await Promise.all([
      loadPolymarketUsTeamUniverse(),
      loadSportsHistoryStore()
    ]);

    response.json({
      ok: true,
      sports: {
        teamUniverseGeneratedAt: teamUniverse.generatedAt ?? null,
        teamCount: Array.isArray(teamUniverse.teams) ? teamUniverse.teams.length : 0,
        marketCount: teamUniverse.marketCount ?? 0,
        historyGeneratedAt: historyStore.generatedAt ?? null,
        historyGameCount: Array.isArray(historyStore.games) ? historyStore.games.length : 0
      }
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to load sports status'
    });
  }
});

router.post('/api/sports/import/nba', async (request, response) => {
  try {
    const result = await importNbaHistory({
      season: request.body?.season,
      startDate: request.body?.startDate,
      endDate: request.body?.endDate,
      batchSize: request.body?.batchSize
    });

    response.status(201).json({
      ok: true,
      result
    });
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to import NBA history'
    });
  }
});

router.get('/api/sports/events/inspect', async (request, response) => {
  try {
    const env = getEnv();
    const input = request.query.input ?? request.query.url ?? request.query.slug;

    if (typeof input !== 'string') {
      response.status(400).json({
        ok: false,
        error: 'Provide an event URL or slug with the input query parameter.'
      });
      return;
    }

    const analytics = await resolveEventAnalytics(env, input, { forceRefresh: request.query.refresh === 'true' });
    const sportsMarkets = Array.isArray(analytics.aggregation?.sportsContext?.markets)
      ? analytics.aggregation.sportsContext.markets
      : [];

    response.json({
      ok: true,
      event: {
        slug: analytics.event.slug,
        title: analytics.event.title,
        startDate: analytics.event.startDate,
        endDate: analytics.event.endDate
      },
      sportsContext: analytics.aggregation?.sportsContext ?? null,
      recognizedMarkets: sportsMarkets,
      modelMarkets: analytics.statisticalModel.markets
        .filter((market) => market.sportsContext)
        .map((market) => ({
          conditionId: market.conditionId,
          question: market.question,
          confidence: market.confidence,
          sportsContext: market.sportsContext,
          outcomes: market.outcomes.map((outcome) => ({
            label: outcome.label,
            currentProbability: outcome.currentProbability,
            estimatedProbability: outcome.estimatedProbability,
            edge: outcome.edge,
            confidence: outcome.confidence,
            features: outcome.features
          }))
        }))
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to inspect sports event'
    });
  }
});

router.post('/api/sports/backtest', async (request, response) => {
  try {
    const result = await runSportsBacktest({
      league: String(request.body?.league ?? 'NBA').toUpperCase(),
      startDate: request.body?.startDate,
      endDate: request.body?.endDate,
      phase: String(request.body?.phase ?? 'all').toLowerCase(),
      minTrainingGames: Number.parseInt(request.body?.minTrainingGames ?? '10', 10),
      calibrationBucketSize: Number.parseFloat(request.body?.calibrationBucketSize ?? '0.1')
    });

    response.json({
      ok: true,
      result
    });
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to run sports backtest'
    });
  }
});

export default router;