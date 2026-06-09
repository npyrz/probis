const OPEN_METEO_PREVIOUS_RUNS_BASE_URL = 'https://previous-runs-api.open-meteo.com';
const OPEN_METEO_PREVIOUS_RUNS_SOURCE = 'open-meteo-previous-runs';
const KMDW_STATION_ID = 'KMDW';
const KMDW_LATITUDE = 41.7862;
const KMDW_LONGITUDE = -87.7524;
const KMDW_TIMEZONE = 'America/Chicago';
const DEFAULT_MODEL = 'gfs_seamless';
const DEFAULT_LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7];
const MAX_DAYS_PER_REQUEST = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseDate(value) {
  const normalized = normalizeDate(value);

  if (!normalized) {
    return null;
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDays(date, days) {
  return new Date(date.getTime() + (days * DAY_MS));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function chunkDateRange(dateFrom, dateTo, maxDays = MAX_DAYS_PER_REQUEST) {
  const start = parseDate(dateFrom);
  const end = parseDate(dateTo);

  if (!start || !end) {
    throw new Error('Forecast vintage backfill requires valid --date-from and --date-to values.');
  }

  if (start.getTime() > end.getTime()) {
    throw new Error('--date-from must be on or before --date-to.');
  }

  const chunks = [];
  let cursor = start;

  while (cursor.getTime() <= end.getTime()) {
    const chunkEnd = new Date(Math.min(addDays(cursor, maxDays - 1).getTime(), end.getTime()));
    chunks.push({
      dateFrom: isoDate(cursor),
      dateTo: isoDate(chunkEnd)
    });
    cursor = addDays(chunkEnd, 1);
  }

  return chunks;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseLeadDays(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => Number.parseInt(String(entry), 10))
      .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 7);
  }

  if (typeof value === 'string' && value.trim()) {
    return parseLeadDays(value.split(','));
  }

  return DEFAULT_LEAD_DAYS;
}

function getBaseUrl(env) {
  return String(env?.openMeteoPreviousRunsBaseUrl ?? OPEN_METEO_PREVIOUS_RUNS_BASE_URL).replace(/\/+$/, '');
}

function getModel(env, override = null) {
  return String(override ?? env?.openMeteoForecastVintageModel ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function getLeadDays(env, override = null) {
  const parsed = parseLeadDays(override ?? env?.openMeteoForecastVintageLeadDays);
  return parsed.length > 0 ? [...new Set(parsed)].sort((left, right) => left - right) : DEFAULT_LEAD_DAYS;
}

function buildHourlyVariables(leadDays) {
  return leadDays.map((leadDay) => `temperature_2m_previous_day${leadDay}`);
}

function normalizeOpenMeteoPreviousRunsRows(payload, {
  stationId = KMDW_STATION_ID,
  source = OPEN_METEO_PREVIOUS_RUNS_SOURCE,
  model = DEFAULT_MODEL,
  fetchedAt = new Date().toISOString(),
  leadDays = DEFAULT_LEAD_DAYS
} = {}) {
  const times = Array.isArray(payload?.hourly?.time) ? payload.hourly.time : [];
  const units = payload?.hourly_units ?? {};
  const rows = [];

  for (const leadDay of leadDays) {
    const key = `temperature_2m_previous_day${leadDay}`;
    const values = Array.isArray(payload?.hourly?.[key]) ? payload.hourly[key] : [];

    times.forEach((time, index) => {
      const forecastTempF = toNumberOrNull(values[index]);
      const targetDate = normalizeDate(String(time ?? '').slice(0, 10));

      if (!targetDate || typeof forecastTempF !== 'number') {
        return;
      }

      rows.push({
        stationId,
        source,
        model,
        targetDate,
        validTimeLocal: String(time),
        leadDays: leadDay,
        forecastTempF,
        fetchedAt,
        rawData: {
          variable: key,
          unit: units[key] ?? null,
          latitude: payload?.latitude ?? null,
          longitude: payload?.longitude ?? null,
          timezone: payload?.timezone ?? null,
          generationTimeMs: payload?.generationtime_ms ?? null
        }
      });
    });
  }

  return rows.sort((left, right) => {
    const dateComparison = left.targetDate.localeCompare(right.targetDate);

    if (dateComparison !== 0) {
      return dateComparison;
    }

    if (left.leadDays !== right.leadDays) {
      return left.leadDays - right.leadDays;
    }

    return left.validTimeLocal.localeCompare(right.validTimeLocal);
  });
}

async function fetchPreviousRunsChunk(env, {
  dateFrom,
  dateTo,
  model,
  leadDays
}) {
  const requestUrl = new URL(`${getBaseUrl(env)}/v1/forecast`);
  requestUrl.searchParams.set('latitude', String(KMDW_LATITUDE));
  requestUrl.searchParams.set('longitude', String(KMDW_LONGITUDE));
  requestUrl.searchParams.set('start_date', dateFrom);
  requestUrl.searchParams.set('end_date', dateTo);
  requestUrl.searchParams.set('timezone', KMDW_TIMEZONE);
  requestUrl.searchParams.set('temperature_unit', 'fahrenheit');
  requestUrl.searchParams.set('hourly', buildHourlyVariables(leadDays).join(','));
  requestUrl.searchParams.set('models', model);

  const response = await fetch(requestUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': env?.weatherUserAgent ?? 'probis-weather-edge/0.1 (local)'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Open-Meteo previous-runs request failed with HTTP ${response.status}: ${body.slice(0, 240)}`);
  }

  return response.json();
}

export async function fetchKmdwForecastVintageArchive(env, {
  dateFrom,
  dateTo,
  leadDays = null,
  model = null
} = {}) {
  const activeModel = getModel(env, model);
  const activeLeadDays = getLeadDays(env, leadDays);
  const fetchedAt = new Date().toISOString();
  const chunks = chunkDateRange(dateFrom, dateTo);
  const records = [];
  const rawResponses = [];

  for (const chunk of chunks) {
    const payload = await fetchPreviousRunsChunk(env, {
      ...chunk,
      model: activeModel,
      leadDays: activeLeadDays
    });
    rawResponses.push({
      dateFrom: chunk.dateFrom,
      dateTo: chunk.dateTo,
      generationTimeMs: payload?.generationtime_ms ?? null
    });
    records.push(...normalizeOpenMeteoPreviousRunsRows(payload, {
      model: activeModel,
      fetchedAt,
      leadDays: activeLeadDays
    }));
  }

  return {
    source: OPEN_METEO_PREVIOUS_RUNS_SOURCE,
    stationId: KMDW_STATION_ID,
    model: activeModel,
    dateFrom: normalizeDate(dateFrom),
    dateTo: normalizeDate(dateTo),
    leadDays: activeLeadDays,
    fetchedAt,
    requestedChunks: chunks,
    rawResponses,
    recordCount: records.length,
    records
  };
}

export {
  DEFAULT_LEAD_DAYS,
  DEFAULT_MODEL,
  KMDW_LATITUDE,
  KMDW_LONGITUDE,
  OPEN_METEO_PREVIOUS_RUNS_SOURCE,
  chunkDateRange,
  normalizeOpenMeteoPreviousRunsRows,
  parseLeadDays
};
