import { Router } from 'express';

import { getEnv } from '../config/env.js';
import { combineDecisionRecommendation } from '../services/decision-engine.js';
import { buildDecisionEnginePrompt, buildEventAnalysisPrompt, getOllamaStatus, runAiJson, runAiTest } from '../services/ollama.js';
import { resolveEventAnalytics } from '../services/polymarket/event-data.js';

const router = Router();

router.get('/api/ai/status', async (_request, response) => {
  const env = getEnv();
  const status = await getOllamaStatus(env);

  response.json({
    ok: status.reachable,
    status
  });
});

router.post('/api/ai/test', async (request, response) => {
  try {
    const env = getEnv();
    const prompt =
      typeof request.body?.prompt === 'string' && request.body.prompt.trim().length > 0
        ? request.body.prompt.trim()
        : 'Reply with exactly: Probis AI online.';
    const result = await runAiTest(env, prompt);

    response.json({
      ok: true,
      result
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to run AI test'
    });
  }
});

router.post('/api/ai/analyze-event', async (request, response) => {
  try {
    const env = getEnv();
    const input = request.body?.input ?? request.body?.url ?? request.body?.slug;

    if (typeof input !== 'string') {
      response.status(400).json({
        ok: false,
        error: 'Provide an event URL or slug in the request body.'
      });
      return;
    }

    const forceRefresh = request.body?.refresh === true;
    const analytics = await resolveEventAnalytics(env, input, { forceRefresh });
    const prompt = buildEventAnalysisPrompt(analytics.event, analytics.aggregation, analytics.statisticalModel);
    const result = await runAiTest(env, prompt);
    const decisionPrompt = buildDecisionEnginePrompt(analytics.event, analytics.aggregation, analytics.statisticalModel);
    const decisionResult = await runAiJson(env, decisionPrompt);
    const decisionEngine = combineDecisionRecommendation(
      analytics.event,
      analytics.aggregation,
      analytics.statisticalModel,
      decisionResult.parsed,
      decisionResult.response
    );

    response.json({
      ok: true,
      event: analytics.event,
      sportsSync: analytics.sportsSync ?? null,
      aggregation: analytics.aggregation,
      statisticalModel: analytics.statisticalModel,
      analysis: result.response,
      decisionEngine,
      model: result.resolvedModel,
      requestedModel: result.requestedModel
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to analyze event'
    });
  }
});

export default router;