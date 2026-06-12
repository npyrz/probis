import { getEnv } from '../config/env.js';
import { persistChicagoHistoricalMarketBoards } from '../services/persistence/postgres.js';
import { fetchKmdwHistoricalBoardArchive } from '../services/weather/historical-boards.js';
import { failCli, normalizeCliDate, normalizeCliNumber, parseCliArgs, printCliJson } from './chicago-cli.js';

function normalizeCliInteger(value, name) {
  const numeric = normalizeCliNumber(value, name);
  return typeof numeric === 'number' ? Math.trunc(numeric) : null;
}

function normalizeCliBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === true || value === '') {
    return fallback;
  }

  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeCliText(value) {
  if (value === undefined || value === null || value === true || value === '') {
    return null;
  }

  return String(value).trim() || null;
}

try {
  const args = parseCliArgs();
  const dateFrom = normalizeCliDate(args['date-from'] ?? args.dateFrom, '--date-from');
  const dateTo = normalizeCliDate(args['date-to'] ?? args.dateTo, '--date-to');
  const archive = await fetchKmdwHistoricalBoardArchive(getEnv(), {
    dateFrom,
    dateTo,
    startTs: normalizeCliInteger(args['start-ts'] ?? args.startTs, '--start-ts'),
    endTs: normalizeCliInteger(args['end-ts'] ?? args.endTs, '--end-ts'),
    lookbackDays: normalizeCliInteger(args['lookback-days'] ?? args.lookbackDays, '--lookback-days'),
    fidelityMinutes: normalizeCliInteger(args.fidelity ?? args['fidelity-minutes'] ?? args.fidelityMinutes, '--fidelity-minutes'),
    interval: normalizeCliText(args.interval),
    includeTrades: normalizeCliBoolean(args['include-trades'] ?? args.includeTrades, true)
  });
  const persistence = await persistChicagoHistoricalMarketBoards(getEnv(), archive);

  printCliJson({
    ok: true,
    source: archive.source,
    stationId: archive.stationId,
    dateFrom: archive.dateFrom,
    dateTo: archive.dateTo,
    startTime: archive.startTime,
    endTime: archive.endTime,
    summary: archive.summary,
    persistence
  });
} catch (error) {
  failCli(error);
}
