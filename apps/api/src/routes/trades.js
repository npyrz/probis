import { Router } from 'express';

import { createTradeIntent, listTradeIntents } from '../services/trade-intents.js';

const router = Router();

router.get('/api/trades/intents', async (request, response) => {
  try {
    const limit = Number.parseInt(request.query.limit ?? '10', 10);
    const intents = await listTradeIntents(limit);

    response.json({
      ok: true,
      intents
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to load trade intents'
    });
  }
});

router.post('/api/trades/intents', async (request, response) => {
  try {
    const intent = await createTradeIntent(request.body ?? {});

    response.status(201).json({
      ok: true,
      intent
    });
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to create trade intent'
    });
  }
});

export default router;