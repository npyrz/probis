import { Router } from 'express';

import {
  createTradeIntent,
  deleteTradeIntent,
  executeTradeIntent,
  listTradeIntents,
  updateTradeIntent
} from '../services/trade-intents.js';

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

router.patch('/api/trades/intents/:id', async (request, response) => {
  try {
    const intent = await updateTradeIntent(request.params.id, request.body ?? {});

    response.json({
      ok: true,
      intent
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update trade intent';
    const status = message.includes('was not found') ? 404 : 400;

    response.status(status).json({
      ok: false,
      error: message
    });
  }
});

router.delete('/api/trades/intents/:id', async (request, response) => {
  try {
    const intent = await deleteTradeIntent(request.params.id);

    response.json({
      ok: true,
      intent
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to delete trade intent';
    const status = message.includes('was not found') ? 404 : 400;

    response.status(status).json({
      ok: false,
      error: message
    });
  }
});

router.post('/api/trades/intents/:id/execute', async (request, response) => {
  try {
    const intent = await executeTradeIntent(request.params.id);

    response.json({
      ok: true,
      intent
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to execute trade intent';
    const status = message.includes('was not found') ? 404 : 400;

    response.status(status).json({
      ok: false,
      error: message
    });
  }
});

export default router;