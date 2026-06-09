const NOAA_CDO_DAILY_DATASET = 'GHCND';
const NOAA_CDO_KMDW_STATION_ID = 'GHCND:USW00014819';
const NOAA_CDO_SOURCE = 'ncei-cdo-ghcnd';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOAA_CDO_MAX_DAYS_PER_REQUEST = 365;

function normalizeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  return value;
}

function parseDate(value) {
  const normalized = normalizeDate(value);

  if (!normalized) {
    return null;
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + (days * DAY_MS));
}

function chunkDateRange(dateFrom, dateTo, maxDays = NOAA_CDO_MAX_DAYS_PER_REQUEST) {
  const start = parseDate(dateFrom);
  const end = parseDate(dateTo);

  if (!start || !end) {
    throw new Error('NOAA archive backfill requires valid --date-from and --date-to values.');
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

function getCdoBaseUrl(env) {
  return String(env?.noaaCdoApiBaseUrl ?? 'https://www.ncei.noaa.gov/cdo-web/api/v2').replace(/\/+$/, '');
}

function getCdoToken(env, tokenOverride = null) {
  return String(tokenOverride ?? env?.noaaCdoToken ?? '').trim();
}

function getKmdwStationId(env, stationIdOverride = null) {
  return String(stationIdOverride ?? env?.noaaCdoKmdwStationId ?? NOAA_CDO_KMDW_STATION_ID).trim();
}

async function fetchCdoPage(env, {
  dateFrom,
  dateTo,
  stationId,
  token,
  offset = 1,
  limit = 1000
}) {
  const requestUrl = new URL(`${getCdoBaseUrl(env)}/data`);
  requestUrl.searchParams.set('datasetid', NOAA_CDO_DAILY_DATASET);
  requestUrl.searchParams.set('stationid', stationId);
  requestUrl.searchParams.set('startdate', dateFrom);
  requestUrl.searchParams.set('enddate', dateTo);
  requestUrl.searchParams.set('datatypeid', 'TMAX,TMIN,PRCP,SNOW');
  requestUrl.searchParams.set('units', 'standard');
  requestUrl.searchParams.set('limit', String(limit));
  requestUrl.searchParams.set('offset', String(offset));

  const response = await fetch(requestUrl, {
    headers: {
      token,
      Accept: 'application/json',
      'User-Agent': env?.weatherUserAgent ?? 'probis-weather-edge/0.1 (local)'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`NOAA CDO request failed with HTTP ${response.status}: ${body.slice(0, 240)}`);
  }

  return response.json();
}

function normalizeCdoDailyRows(rows, { stationId, fetchedAt }) {
  const byDate = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const archiveDate = normalizeDate(String(row?.date ?? '').slice(0, 10));
    const datatype = String(row?.datatype ?? '').trim().toUpperCase();

    if (!archiveDate || !datatype) {
      continue;
    }

    if (!byDate.has(archiveDate)) {
      byDate.set(archiveDate, {
        stationId,
        archiveStationId: row?.station ?? stationId,
        archiveDate,
        source: NOAA_CDO_SOURCE,
        maxTempF: null,
        minTempF: null,
        precipitationIn: null,
        snowIn: null,
        fetchedAt,
        rawData: []
      });
    }

    const record = byDate.get(archiveDate);
    const value = toNumberOrNull(row?.value);
    record.rawData.push(row);

    if (datatype === 'TMAX') {
      record.maxTempF = value;
    } else if (datatype === 'TMIN') {
      record.minTempF = value;
    } else if (datatype === 'PRCP') {
      record.precipitationIn = value;
    } else if (datatype === 'SNOW') {
      record.snowIn = value;
    }
  }

  return [...byDate.values()]
    .filter((record) => typeof record.maxTempF === 'number')
    .sort((left, right) => left.archiveDate.localeCompare(right.archiveDate));
}

async function fetchCdoRange(env, { dateFrom, dateTo, stationId, token }) {
  const records = [];
  let offset = 1;
  let totalCount = null;

  while (totalCount === null || offset <= totalCount) {
    const page = await fetchCdoPage(env, {
      dateFrom,
      dateTo,
      stationId,
      token,
      offset
    });
    const pageRows = Array.isArray(page?.results) ? page.results : [];
    records.push(...pageRows);
    totalCount = Number(page?.metadata?.resultset?.count ?? pageRows.length);

    if (pageRows.length === 0) {
      break;
    }

    offset += pageRows.length;
  }

  return records;
}

export async function fetchKmdwNoaaDailyArchive(env, {
  dateFrom,
  dateTo,
  token = null,
  stationId = null
} = {}) {
  const activeToken = getCdoToken(env, token);
  const activeStationId = getKmdwStationId(env, stationId);

  if (!activeToken) {
    throw new Error('NOAA_CDO_TOKEN is required for official NCEI archive backfill.');
  }

  const fetchedAt = new Date().toISOString();
  const chunks = chunkDateRange(dateFrom, dateTo);
  const allRows = [];

  for (const chunk of chunks) {
    const rows = await fetchCdoRange(env, {
      ...chunk,
      stationId: activeStationId,
      token: activeToken
    });
    allRows.push(...rows);
  }

  return {
    source: NOAA_CDO_SOURCE,
    datasetId: NOAA_CDO_DAILY_DATASET,
    stationId: activeStationId,
    dateFrom: normalizeDate(dateFrom),
    dateTo: normalizeDate(dateTo),
    fetchedAt,
    requestedChunks: chunks,
    rawResultCount: allRows.length,
    records: normalizeCdoDailyRows(allRows, {
      stationId: activeStationId,
      fetchedAt
    })
  };
}

export {
  NOAA_CDO_DAILY_DATASET,
  NOAA_CDO_KMDW_STATION_ID,
  NOAA_CDO_SOURCE,
  chunkDateRange,
  normalizeCdoDailyRows
};
