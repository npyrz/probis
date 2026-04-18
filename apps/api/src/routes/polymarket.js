import { Router } from 'express';

import { getEnv } from '../config/env.js';
import { getPolymarketStatus } from '../services/polymarket/client.js';
import { fetchActiveEvents, fetchEventByInput } from '../services/polymarket/gamma.js';
import { invalidateEventAnalyticsCache, resolveEventAnalytics } from '../services/polymarket/event-data.js';
import { getOpportunityScannerSnapshot } from '../services/polymarket/opportunity-scanner.js';
import { getPolymarketUsAccountIdentity } from '../services/polymarket/us-orders.js';

const router = Router();

router.get('/api/polymarket/status', async (_request, response) => {
  try {
    const env = getEnv();
    const status = await getPolymarketStatus(env);

    response.json({
      ok: true,
      status
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown Polymarket error'
    });
  }
});

router.get('/api/polymarket/account-identity', async (_request, response) => {
  try {
    const env = getEnv();
    const identity = await getPolymarketUsAccountIdentity(env);

    response.json({
      ok: true,
      identity
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to fetch Polymarket account identity'
    });
  }
});

router.get('/api/polymarket/events', async (request, response) => {
  try {
    const env = getEnv();
    const limit = Number.parseInt(request.query.limit ?? '10', 10);
    const offset = Number.parseInt(request.query.offset ?? '0', 10);
    const events = await fetchActiveEvents(env, { limit, offset });

    response.json({
      ok: true,
      count: events.length,
      events
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to fetch Polymarket events'
    });
  }
});

router.get('/api/polymarket/scanner', async (request, response) => {
  try {
    const env = getEnv();
    const refresh = request.query.refresh === 'true';
    const wait = request.query.wait === 'true';
    const scanner = await getOpportunityScannerSnapshot(env, { refresh, wait });

    response.json({
      ok: true,
      scanner
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to load opportunity scanner snapshot'
    });
  }
});

router.get('/api/polymarket/events/resolve', async (request, response) => {
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

    const event = await fetchEventByInput(env, input);

    response.json({
      ok: true,
      event
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to resolve Polymarket event'
    });
  }
});

router.get('/api/polymarket/events/aggregation', async (request, response) => {
  try {
    const env = getEnv();
    const input = request.query.input ?? request.query.url ?? request.query.slug;
    const forceRefresh = request.query.refresh === 'true';

    if (typeof input !== 'string') {
      response.status(400).json({
        ok: false,
        error: 'Provide an event URL or slug with the input query parameter.'
      });
      return;
    }

    const analytics = await resolveEventAnalytics(env, input, { forceRefresh });

    response.json({
      ok: true,
      ...analytics
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to resolve Polymarket analytics'
    });
  }
});

router.post('/api/polymarket/events/aggregation/invalidate', async (request, response) => {
  const input = request.body?.input ?? request.body?.url ?? request.body?.slug ?? null;
  invalidateEventAnalyticsCache(typeof input === 'string' ? input : undefined);

  response.json({
    ok: true,
    invalidated: input ?? 'all'
  });
});

export default router;