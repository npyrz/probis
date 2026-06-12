import { getEnv } from '../config/env.js';
import { evaluateCurrentWeatherModel } from '../services/ml/weather-training.js';
import { failCli, normalizeCliDate, normalizeCliNumber, parseCliArgs, printCliJson } from './chicago-cli.js';

function normalizeCliInteger(value, name) {
  const numeric = normalizeCliNumber(value, name);
  return typeof numeric === 'number' ? Math.trunc(numeric) : null;
}

try {
  const args = parseCliArgs();
  const result = await evaluateCurrentWeatherModel(getEnv(), {
    dateFrom: normalizeCliDate(args['date-from'] ?? args.dateFrom, '--date-from'),
    dateTo: normalizeCliDate(args['date-to'] ?? args.dateTo, '--date-to'),
    limit: normalizeCliInteger(args.limit, '--limit'),
    modelPath: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : null
  });

  printCliJson(result);
} catch (error) {
  failCli(error);
}
