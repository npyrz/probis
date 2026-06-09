import { getEnv } from '../config/env.js';
import { getChicagoAlerts } from '../services/persistence/postgres.js';
import { evaluateChicagoWeatherAlerts } from '../services/weather/chicago-alerts.js';
import { failCli, normalizeCliDate, parseCliArgs, printCliJson } from './chicago-cli.js';

try {
  const args = parseCliArgs();
  const date = normalizeCliDate(args.date, '--date');
  const evaluate = args.evaluate === true || args.evaluate === 'true';
  const force = args.force === true || args.force === 'true';
  const status = args.status === 'all' ? null : args.status ?? 'active';
  const limit = Number.parseInt(String(args.limit ?? '50'), 10);
  const env = getEnv();
  const alerts = evaluate
    ? await evaluateChicagoWeatherAlerts(env, {
      date,
      force,
      persistSnapshot: true
    })
    : await getChicagoAlerts(env, {
      date,
      status,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50
    });

  printCliJson({
    ok: true,
    alerts
  });
} catch (error) {
  failCli(error);
}
