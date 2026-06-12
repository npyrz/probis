import { getEnv } from '../config/env.js';
import { runChicagoWeatherModelTraining } from '../services/ml/weather-training.js';
import { failCli, normalizeCliDate, normalizeCliNumber, parseCliArgs, printCliJson } from './chicago-cli.js';

function normalizeCliInteger(value, name) {
  const numeric = normalizeCliNumber(value, name);
  return typeof numeric === 'number' ? Math.trunc(numeric) : null;
}

try {
  const args = parseCliArgs();
  const env = getEnv();
  const result = await runChicagoWeatherModelTraining(env, {
    dateFrom: normalizeCliDate(args['date-from'] ?? args.dateFrom, '--date-from'),
    dateTo: normalizeCliDate(args['date-to'] ?? args.dateTo, '--date-to'),
    limit: normalizeCliInteger(args.limit, '--limit') ?? env.weatherMlTrainingLimit,
    minSamples: normalizeCliInteger(args['min-samples'] ?? args.minSamples, '--min-samples') ?? env.weatherMlMinSamples,
    minClassSamples: normalizeCliInteger(args['min-class-samples'] ?? args.minClassSamples, '--min-class-samples') ?? env.weatherMlMinClassSamples,
    rollingFolds: normalizeCliInteger(args['rolling-folds'] ?? args.rollingFolds, '--rolling-folds') ?? env.weatherMlRollingFolds,
    holdoutFraction: normalizeCliNumber(args['holdout-fraction'] ?? args.holdoutFraction, '--holdout-fraction') ?? env.weatherMlHoldoutFraction,
    output: typeof args.output === 'string' && args.output.trim() ? args.output.trim() : null
  });

  printCliJson({
    ok: result.ok,
    model: {
      status: result.artifact.status,
      modelId: result.artifact.modelId,
      modelType: result.artifact.modelType,
      trainedAt: result.artifact.trainedAt,
      blendWeight: result.artifact.blendWeight ?? null,
      training: result.artifact.training,
      metrics: result.artifact.metrics
    },
    trainingRows: result.trainingRows,
    paths: result.paths
  });
} catch (error) {
  failCli(error);
}
