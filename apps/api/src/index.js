import express from 'express';
import cors from 'cors';

import { getEnv } from './config/env.js';
import { logStartup } from './lib/logger.js';
import aiRouter from './routes/ai.js';
import healthRouter from './routes/health.js';
import polymarketRouter from './routes/polymarket.js';

const env = getEnv();
const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_request, response) => {
  response.json({
    name: 'probis-api',
    status: 'ready',
    endpoints: [
      '/health',
      '/api/polymarket/status',
      '/api/polymarket/events',
      '/api/polymarket/events/resolve',
      '/api/polymarket/events/aggregation',
      '/api/ai/status',
      '/api/ai/test',
      '/api/ai/analyze-event'
    ]
  });
});

app.use(healthRouter);
app.use(polymarketRouter);
app.use(aiRouter);

app.listen(env.port, () => {
  logStartup(env);
  console.log(`[probis] API listening on http://localhost:${env.port}`);
});