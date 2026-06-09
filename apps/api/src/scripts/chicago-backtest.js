import { getEnv } from '../config/env.js';
import { getChicagoBacktest } from '../services/persistence/postgres.js';
import { failCli, normalizeCliDate, normalizeCliNumber, parseCliArgs, printCliJson } from './chicago-cli.js';

try {
  const args = parseCliArgs();
  const dateFrom = normalizeCliDate(args['date-from'] ?? args.dateFrom, '--date-from');
  const dateTo = normalizeCliDate(args['date-to'] ?? args.dateTo, '--date-to');
  const minEdge = normalizeCliNumber(args['min-edge'] ?? args.minEdge, '--min-edge');
  const backtest = await getChicagoBacktest(getEnv(), {
    dateFrom,
    dateTo,
    minEdge
  });

  printCliJson({
    ok: true,
    backtest
  });
} catch (error) {
  failCli(error);
}
