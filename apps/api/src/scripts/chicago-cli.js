export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      continue;
    }

    const [rawKey, ...rawValueParts] = arg.slice(2).split('=');
    const key = rawKey.trim();

    if (!key) {
      continue;
    }

    args[key] = rawValueParts.length > 0 ? rawValueParts.join('=') : true;
  }

  return args;
}

export function normalizeCliDate(value, name) {
  if (value === undefined || value === null || value === true || value === '') {
    return null;
  }

  const normalized = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${name} must use YYYY-MM-DD.`);
  }

  return normalized;
}

export function normalizeCliNumber(value, name) {
  if (value === undefined || value === null || value === true || value === '') {
    return null;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    throw new Error(`${name} must be numeric.`);
  }

  return numeric;
}

export function printCliJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

export function failCli(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
