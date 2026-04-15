import { Router } from 'express';

import { getEnv } from '../config/env.js';
import { getPolymarketStatus } from '../services/polymarket/client.js';

const router = Router();

router.get('/health', async (_request, response) => {
  const env = getEnv();
  const polymarket = await getPolymarketStatus(env);

  response.json({
    ok: true,
    service: 'probis-api',
    timestamp: new Date().toISOString(),
    polymarket,
    ollama: {
      baseUrl: env.ollamaBaseUrl,
      model: env.ollamaModel
    }
  });
});

export default router;