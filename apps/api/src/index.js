import express from 'express';
import cors from 'cors';

import { getEnv } from './config/env.js';
import { logStartup } from './lib/logger.js';
import aiRouter from './routes/ai.js';
import healthRouter from './routes/health.js';
import polymarketRouter from './routes/polymarket.js';
import tradesRouter from './routes/trades.js';
import weatherRouter from './routes/weather.js';
import { startOpportunityScanner } from './services/polymarket/opportunity-scanner.js';
import { startChicagoWeatherTracker } from './services/weather/chicago-monitor.js';

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
      '/api/polymarket/scanner',
      '/api/polymarket/paper-accuracy',
      '/api/polymarket/events/resolve',
      '/api/polymarket/events/aggregation',
      '/api/weather/providers',
      '/api/weather/chicago/status',
      '/api/weather/chicago/markets',
      '/api/weather/chicago/settlement',
      '/api/weather/chicago/snapshot',
      '/api/weather/chicago/intents',
      '/api/weather/chicago/history',
      '/api/weather/chicago/source-audit',
      '/api/weather/chicago/alerts',
      '/api/weather/chicago/alerts/evaluate',
      '/api/weather/chicago/model',
      '/api/weather/chicago/model/train',
      '/api/weather/chicago/model/evaluate',
      '/api/weather/chicago/archive',
      '/api/weather/chicago/archive/backfill',
      '/api/weather/chicago/historical-boards',
      '/api/weather/chicago/historical-boards/backfill',
      '/api/weather/chicago/forecast-vintages',
      '/api/weather/chicago/forecast-vintages/backfill',
      '/api/weather/chicago/drift',
      '/api/weather/chicago/signals',
      '/api/weather/chicago/backtest',
      '/api/weather/backtest',
      '/api/recommendations/chicago',
      '/api/ai/status',
      '/api/ai/test',
      '/api/ai/analyze-event',
      '/api/trades/intents'
    ]
  });
});

app.use(healthRouter);
app.use(polymarketRouter);
app.use(weatherRouter);
app.use(aiRouter);
app.use(tradesRouter);

startOpportunityScanner(env);
startChicagoWeatherTracker(env);

app.listen(env.port, () => {
  logStartup(env);
  console.log(`[probis] API listening on http://localhost:${env.port}`);
});
