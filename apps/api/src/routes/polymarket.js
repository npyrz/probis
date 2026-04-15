import { Router } from 'express';

import { getEnv } from '../config/env.js';
import { getPolymarketStatus } from '../services/polymarket/client.js';
import { fetchActiveEvents, fetchEventByInput } from '../services/polymarket/gamma.js';

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

export default router;