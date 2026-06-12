import { getEnv } from '../config/env.js';
import { persistChicagoDailyArchive } from '../services/persistence/postgres.js';
import { fetchKmdwNoaaDailyArchive } from '../services/weather/noaa-archive.js';
import { failCli, normalizeCliDate, parseCliArgs, printCliJson } from './chicago-cli.js';

try {
  const args = parseCliArgs();
  const dateFrom = normalizeCliDate(args['date-from'] ?? args.dateFrom, '--date-from');
  const dateTo = normalizeCliDate(args['date-to'] ?? args.dateTo, '--date-to');
  const env = getEnv();
  const archive = await fetchKmdwNoaaDailyArchive(env, {
    dateFrom,
    dateTo,
    token: typeof args.token === 'string' ? args.token : null,
    stationId: typeof args.station === 'string' ? args.station : null
  });
  const persistence = await persistChicagoDailyArchive(env, archive);

  printCliJson({
    ok: true,
    source: archive.source,
    datasetId: archive.datasetId,
    stationId: archive.stationId,
    dateFrom: archive.dateFrom,
    dateTo: archive.dateTo,
    rawResultCount: archive.rawResultCount,
    recordCount: archive.records.length,
    firstRecord: archive.records[0] ?? null,
    lastRecord: archive.records[archive.records.length - 1] ?? null,
    persistence
  });
} catch (error) {
  failCli(error);
}
