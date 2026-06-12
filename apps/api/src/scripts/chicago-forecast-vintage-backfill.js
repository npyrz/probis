import { getEnv } from '../config/env.js';
import { persistChicagoForecastVintageArchive } from '../services/persistence/postgres.js';
import { fetchKmdwForecastVintageArchive } from '../services/weather/forecast-vintage.js';
import { failCli, normalizeCliDate, parseCliArgs, printCliJson } from './chicago-cli.js';

function normalizeCliLeadDays(value) {
  if (value === undefined || value === null || value === true || value === '') {
    return null;
  }

  const leadDays = String(value)
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 7);

  if (leadDays.length === 0) {
    throw new Error('--lead-days must contain one or more integers from 0 through 7.');
  }

  return [...new Set(leadDays)].sort((left, right) => left - right);
}

function normalizeCliModel(value) {
  if (value === undefined || value === null || value === true || value === '') {
    return null;
  }

  return String(value).trim() || null;
}

try {
  const args = parseCliArgs();
  const dateFrom = normalizeCliDate(args['date-from'] ?? args.dateFrom, '--date-from');
  const dateTo = normalizeCliDate(args['date-to'] ?? args.dateTo, '--date-to');
  const leadDays = normalizeCliLeadDays(args['lead-days'] ?? args.leadDays);
  const model = normalizeCliModel(args.model);
  const env = getEnv();
  const archive = await fetchKmdwForecastVintageArchive(env, {
    dateFrom,
    dateTo,
    leadDays,
    model
  });
  const persistence = await persistChicagoForecastVintageArchive(env, archive);

  printCliJson({
    ok: true,
    source: archive.source,
    stationId: archive.stationId,
    model: archive.model,
    dateFrom: archive.dateFrom,
    dateTo: archive.dateTo,
    leadDays: archive.leadDays,
    requestedChunks: archive.requestedChunks,
    recordCount: archive.records.length,
    firstRecord: archive.records[0] ?? null,
    lastRecord: archive.records[archive.records.length - 1] ?? null,
    persistence
  });
} catch (error) {
  failCli(error);
}
