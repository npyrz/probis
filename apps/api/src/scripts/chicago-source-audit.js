import { getEnv } from '../config/env.js';
import { getChicagoSourceAudit } from '../services/persistence/postgres.js';
import { failCli, normalizeCliDate, parseCliArgs, printCliJson } from './chicago-cli.js';

try {
  const args = parseCliArgs();
  const date = normalizeCliDate(args.date, '--date');
  const audit = await getChicagoSourceAudit(getEnv(), { date });

  printCliJson({
    ok: true,
    audit
  });
} catch (error) {
  failCli(error);
}
