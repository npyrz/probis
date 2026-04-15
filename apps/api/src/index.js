import express from 'express';

import { getEnv } from './config/env.js';
import { logStartup } from './lib/logger.js';
import healthRouter from './routes/health.js';

const env = getEnv();
const app = express();

app.use(express.json());

app.get('/', (_request, response) => {
  response.json({
    name: 'probis-api',
    status: 'ready',
    endpoints: ['/health']
  });
});

app.use(healthRouter);

app.listen(env.port, () => {
  logStartup(env);
  console.log(`[probis] API listening on http://localhost:${env.port}`);
});