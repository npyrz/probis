import { createHash } from 'node:crypto';

import axios from 'axios';

import { fetchClobMarketSnapshots } from '../polymarket/clob.js';
import { getPolymarketMarketDataPolicy } from '../polymarket/client.js';
import {
  createWeatherProvider,
  fetchWeatherProviderSnapshotInputs,
  registerWeatherProvider,
  resolveWeatherProvider
} from './providers.js';

export const CHICAGO_STATION = {
  city: 'Chicago',
  stationId: 'KMDW',
  cliProduct: 'CLIMDW',
  stationName: 'Chicago Midway International Airport',
  latitude: 41.7868,
  longitude: -87.7522,
  timezone: 'America/Chicago',
  climateStandardUtcOffsetHours: -6
};

export const CLIMDW_URL = 'https://forecast.weather.gov/product.php?format=CI&glossary=1&highlight=off&issuedby=MDW&product=CLI&site=NWS&version=1';

const WEATHER_TIMEOUT_MS = 6000;
const MARKET_TIMEOUT_MS = 8000;
const POINT_METADATA_TTL_MS = 6 * 60 * 60 * 1000;
const DISTRIBUTION_MIN_TEMP = 35;
const DISTRIBUTION_MAX_TEMP = 115;
const LIVE_OBSERVATION_STALE_MINUTES = 90;
const FORECAST_STALE_MINUTES = 240;
const DEFAULT_FORECAST_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_RESEARCH_BANKROLL_USD = 100;
const FRACTIONAL_KELLY_SHRINK = 0.15;
const MAX_STAKE_FRACTION = 0.02;
const MIN_FILL_DEPTH_COVERAGE = 1;
const MIN_EXECUTION_COST = 0.005;
const MAX_EXECUTION_COST = 0.08;
const DEFAULT_MARKET_CATALOG_DAYS_AHEAD = 4;
const MAX_MARKET_CATALOG_DAYS_AHEAD = 14;
const KMDW_POSITION_LIFECYCLE_POLICY_ID = 'kmdw-live-position-lifecycle-v1';
const KMDW_MARKET_DATA_POLICY_ID = 'kmdw-rest-polling-market-data-v1';
const MONTH_INDEX = new Map([
  ['jan', 0],
  ['january', 0],
  ['feb', 1],
  ['february', 1],
  ['mar', 2],
  ['march', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['jun', 5],
  ['june', 5],
  ['jul', 6],
  ['july', 6],
  ['aug', 7],
  ['august', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11]
]);

let cachedPointMetadata = {
  expiresAt: 0,
  value: null
};
const cachedForecasts = new Map();

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveIntegerMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hashText(value) {
  const text = String(value ?? '').trim();
  return text ? createHash('sha256').update(text).digest('hex') : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function celsiusToFahrenheit(value) {
  return typeof value === 'number' ? (value * 9 / 5) + 32 : null;
}

function metersPerSecondToMph(value) {
  return typeof value === 'number' ? value * 2.236936 : null;
}

function kmhToMph(value) {
  return typeof value === 'number' ? value * 0.621371 : null;
}

function pascalToHpa(value) {
  return typeof value === 'number' ? value / 100 : null;
}

function getPartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number.parseInt(byType.year, 10),
    month: Number.parseInt(byType.month, 10),
    day: Number.parseInt(byType.day, 10),
    hour: Number.parseInt(byType.hour, 10),
    minute: Number.parseInt(byType.minute, 10),
    second: Number.parseInt(byType.second, 10)
  };
}

function getDateStringInTimeZone(date, timeZone = CHICAGO_STATION.timezone) {
  const parts = getPartsInTimeZone(date, timeZone);
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function normalizeDateString(value, fallback = getDateStringInTimeZone(new Date())) {
  const candidate = String(value ?? '').trim();
  const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return fallback;
  }

  const date = new Date(`${candidate}T00:00:00Z`);

  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number.parseInt(match[1], 10)
    || date.getUTCMonth() + 1 !== Number.parseInt(match[2], 10)
    || date.getUTCDate() !== Number.parseInt(match[3], 10)
  ) {
    return fallback;
  }

  return candidate;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getPartsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function getUtcInstantForStandardLocalMidnight(dateString) {
  const [year, month, day] = dateString.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, month - 1, day, Math.abs(CHICAGO_STATION.climateStandardUtcOffsetHours), 0, 0, 0));
}

function formatLocalDateTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_STATION.timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

export function getChicagoClimateDayWindow(targetDate) {
  const date = normalizeDateString(targetDate);
  const start = getUtcInstantForStandardLocalMidnight(date);
  const endExclusive = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const end = new Date(endExclusive.getTime() - 1);
  const offsetAtStartHours = getTimeZoneOffsetMs(start, CHICAGO_STATION.timezone) / (60 * 60 * 1000);
  const isDstAtStart = offsetAtStartHours > CHICAGO_STATION.climateStandardUtcOffsetHours;

  return {
    targetDate: date,
    timezone: CHICAGO_STATION.timezone,
    standardTimeBasis: 'midnight-to-midnight Central Standard Time',
    isDstAtStart,
    start: start.toISOString(),
    end: end.toISOString(),
    endExclusive: endExclusive.toISOString(),
    startLocal: formatLocalDateTime(start),
    endLocal: formatLocalDateTime(end),
    rule: isDstAtStart
      ? 'During daylight saving time, the NWS climate day maps to 1:00 AM CDT through 12:59 AM CDT the next day.'
      : 'During standard time, the NWS climate day maps to local midnight through 11:59 PM CST.'
  };
}

function createNwsClient(env) {
  return axios.create({
    baseURL: env.nwsApiBaseUrl ?? 'https://api.weather.gov',
    timeout: WEATHER_TIMEOUT_MS,
    headers: {
      Accept: 'application/geo+json, application/json, text/plain',
      'User-Agent': env.weatherUserAgent ?? 'probis-weather-edge/0.1 (local)'
    }
  });
}

function createGatewayClient(env) {
  return axios.create({
    baseURL: env.polymarketUsGatewayUrl ?? 'https://gateway.polymarket.us',
    timeout: MARKET_TIMEOUT_MS,
    headers: {
      Accept: 'application/json'
    }
  });
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function compactText(...values) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(' ');
}

function htmlToPlainText(value) {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|pre|tr|li|table|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function buildDateResult(year, monthIndex, day) {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return null;
  }

  const date = new Date(Date.UTC(year, monthIndex, day));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== monthIndex
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function normalizeTwoDigitYear(value) {
  const year = Number.parseInt(value, 10);
  return String(value).length === 2 ? 2000 + year : year;
}

export function extractDateFromText(text, fallbackYear = new Date().getUTCFullYear()) {
  const value = String(text ?? '');
  const isoDate = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);

  if (isoDate) {
    return buildDateResult(
      Number.parseInt(isoDate[1], 10),
      Number.parseInt(isoDate[2], 10) - 1,
      Number.parseInt(isoDate[3], 10)
    );
  }

  const monthDayYear = value.match(/\b([A-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+'?(\d{2}|\d{4})\b/i);

  if (monthDayYear) {
    return buildDateResult(
      normalizeTwoDigitYear(monthDayYear[3]),
      MONTH_INDEX.get(monthDayYear[1].toLowerCase()),
      Number.parseInt(monthDayYear[2], 10)
    );
  }

  const monthDay = value.match(/\b([A-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);

  if (monthDay) {
    return buildDateResult(
      fallbackYear,
      MONTH_INDEX.get(monthDay[1].toLowerCase()),
      Number.parseInt(monthDay[2], 10)
    );
  }

  return null;
}

export function parseTemperatureBucket(label) {
  const value = String(label ?? '')
    .replace(/[°º]/g, '')
    .replace(/\bdegrees?\b/gi, '')
    .replace(/\bfahrenheit\b/gi, '')
    .replace(/\bf\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value) {
    return null;
  }

  const rangeMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|\bto\b)\s*(-?\d+(?:\.\d+)?)/i)
    ?? value.match(/between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)/i);

  if (rangeMatch) {
    return {
      lowTemp: Number.parseInt(rangeMatch[1], 10),
      highTemp: Number.parseInt(rangeMatch[2], 10),
      inclusiveLow: true,
      inclusiveHigh: true
    };
  }

  const lowerMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:or\s+)?(?:lower|below|under|less)/i)
    ?? value.match(/(?:at\s+most|no\s+more\s+than|below|under|less\s+than)\s+(-?\d+(?:\.\d+)?)/i);

  if (lowerMatch) {
    return {
      lowTemp: null,
      highTemp: Number.parseInt(lowerMatch[1], 10),
      inclusiveLow: false,
      inclusiveHigh: true
    };
  }

  const upperMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:\+|(?:or\s+)?(?:higher|above|over|more|greater))/i)
    ?? value.match(/(?:at\s+least|above|over|greater\s+than)\s+(-?\d+(?:\.\d+)?)/i);

  if (upperMatch) {
    return {
      lowTemp: Number.parseInt(upperMatch[1], 10),
      highTemp: null,
      inclusiveLow: true,
      inclusiveHigh: false
    };
  }

  const exactMatch = value.match(/^(-?\d+(?:\.\d+)?)$/);

  if (exactMatch) {
    const temp = Number.parseInt(exactMatch[1], 10);
    return {
      lowTemp: temp,
      highTemp: temp,
      inclusiveLow: true,
      inclusiveHigh: true
    };
  }

  return null;
}

function parseCliDate(value) {
  return extractDateFromText(String(value ?? '').replace(/\s+/g, ' '));
}

export function parseClimdwProduct(rawText, requestedDate = null) {
  const rawTextValue = String(rawText ?? '');
  const text = htmlToPlainText(rawTextValue);
  const headerMatch = text.match(/THE\s+CHICAGO[-\s]+MIDWAY(?:\s+INTL|\s+INTERNATIONAL)?\s+CLIMATE\s+SUMMARY\s+FOR\s+(.+?)(?:\r?\n|$)/i);
  const cliDateLabel = headerMatch?.[1]?.replace(/\.+$/g, '').trim() ?? null;
  const cliDate = parseCliDate(cliDateLabel);
  const tempSection = text.match(/TEMPERATURE\s*\(F\)([\s\S]*?)(?:\n\s*(?:PRECIPITATION|SNOWFALL|DEGREE\s+DAYS|WIND|SKY|WEATHER\s+CONDITIONS)\b|$)/i)?.[1] ?? '';
  const yesterdayBlock = tempSection.match(/YESTERDAY([\s\S]*?)(?:\n\s*(?:NORMAL|RECORD|MONTH\s+TO\s+DATE|YEAR\s+TO\s+DATE)\b|$)/i)?.[1] ?? tempSection;
  const maxMatch = yesterdayBlock.match(/(?:^|\n)\s*MAXIMUM\s+(-?\d+)\b/i);
  const maxTempF = maxMatch ? Number.parseInt(maxMatch[1], 10) : null;
  const sourceTextHash = hashText(rawTextValue);
  const parsed = Boolean(cliDate && typeof maxTempF === 'number');
  const dateMatches = !requestedDate || !cliDate || cliDate === requestedDate;

  return {
    product: CHICAGO_STATION.cliProduct,
    stationId: CHICAGO_STATION.stationId,
    requestedDate: requestedDate ?? null,
    cliDate,
    cliDateLabel,
    maxTempF,
    parsed,
    dateMatches,
    status: parsed ? (dateMatches ? 'settled' : 'date-mismatch') : 'unparsed',
    sourceTextHash,
    rawTextLength: rawTextValue.length
  };
}

async function fetchClimdwSettlement(env, targetDate) {
  const sourceUrl = env.climdwUrl ?? CLIMDW_URL;

  try {
    const response = await axios.get(sourceUrl, {
      timeout: WEATHER_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: (value) => value,
      headers: {
        Accept: 'text/plain, text/html',
        'User-Agent': env.weatherUserAgent ?? 'probis-weather-edge/0.1 (local)'
      }
    });
    const parsed = parseClimdwProduct(response.data, targetDate);

    return {
      ...parsed,
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      rawText: response.data
    };
  } catch (error) {
    return {
      product: CHICAGO_STATION.cliProduct,
      stationId: CHICAGO_STATION.stationId,
      requestedDate: targetDate,
      cliDate: null,
      cliDateLabel: null,
      maxTempF: null,
      parsed: false,
      dateMatches: false,
      status: 'unavailable',
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      sourceTextHash: null,
      rawTextLength: 0,
      rawText: null,
      error: error instanceof Error ? error.message : 'Unable to fetch CLIMDW'
    };
  }
}

function parseNwsObservation(feature, stationId = CHICAGO_STATION.stationId) {
  const properties = feature?.properties ?? {};
  const timestamp = properties.timestamp ?? null;
  const observedAtMs = Date.parse(String(timestamp ?? ''));
  const tempF = celsiusToFahrenheit(toNumberOrNull(properties.temperature?.value));

  if (!Number.isFinite(observedAtMs) || typeof tempF !== 'number') {
    return null;
  }

  return {
    stationId,
    observedAt: new Date(observedAtMs).toISOString(),
    observedAtMs,
    tempF: round(tempF, 1),
    dewpointF: round(celsiusToFahrenheit(toNumberOrNull(properties.dewpoint?.value)), 1),
    windSpeedMph: round(metersPerSecondToMph(toNumberOrNull(properties.windSpeed?.value)), 1),
    windDirection: toNumberOrNull(properties.windDirection?.value),
    pressureHpa: round(pascalToHpa(toNumberOrNull(properties.barometricPressure?.value)), 1),
    rawMetar: properties.rawMessage ?? null,
    textDescription: properties.textDescription ?? null,
    raw: {
      timestamp,
      temperature: properties.temperature ?? null,
      dewpoint: properties.dewpoint ?? null,
      windSpeed: properties.windSpeed ?? null,
      windDirection: properties.windDirection ?? null,
      barometricPressure: properties.barometricPressure ?? null,
      rawMessage: properties.rawMessage ?? null
    }
  };
}

async function fetchStationObservations(env, climateDayWindow, stationId = CHICAGO_STATION.stationId) {
  const client = createNwsClient(env);
  const startMs = Date.parse(climateDayWindow.start);
  const endExclusiveMs = Date.parse(climateDayWindow.endExclusive);
  const queryEnd = new Date(Math.min(Date.now(), endExclusiveMs)).toISOString();

  if (Date.now() < startMs) {
    return {
      source: 'nws-station-observations',
      stationId,
      status: 'future-window',
      observations: [],
      currentObservedTemp: null,
      observedHighSoFar: null,
      latestObservationAt: null,
      observationCount: 0,
      freshness: {
        latestAgeMinutes: null,
        isStale: false,
        thresholdMinutes: LIVE_OBSERVATION_STALE_MINUTES
      }
    };
  }

  try {
    const response = await client.get(`/stations/${stationId}/observations`, {
      params: {
        start: climateDayWindow.start,
        end: queryEnd,
        limit: 500
      }
    });
    const observations = (Array.isArray(response.data?.features) ? response.data.features : [])
      .map((feature) => parseNwsObservation(feature, stationId))
      .filter(Boolean)
      .filter((observation) => observation.observedAtMs >= startMs && observation.observedAtMs < endExclusiveMs)
      .sort((left, right) => left.observedAtMs - right.observedAtMs);
    const latest = observations.at(-1) ?? null;
    const observedHighSoFar = observations.length > 0
      ? Math.max(...observations.map((observation) => observation.tempF))
      : null;
    const latestAgeMinutes = latest ? (Date.now() - latest.observedAtMs) / 60000 : null;

    return {
      source: 'nws-station-observations',
      stationId,
      status: observations.length > 0 ? 'ready' : 'empty',
      observations,
      currentObservedTemp: latest?.tempF ?? null,
      observedHighSoFar,
      latestObservationAt: latest?.observedAt ?? null,
      observationCount: observations.length,
      latestRawMetar: latest?.rawMetar ?? null,
      latestDewpointF: latest?.dewpointF ?? null,
      latestWindSpeedMph: latest?.windSpeedMph ?? null,
      latestWindDirection: latest?.windDirection ?? null,
      latestPressureHpa: latest?.pressureHpa ?? null,
      freshness: {
        latestAgeMinutes: typeof latestAgeMinutes === 'number' ? round(latestAgeMinutes, 1) : null,
        isStale: typeof latestAgeMinutes === 'number' ? latestAgeMinutes > LIVE_OBSERVATION_STALE_MINUTES : false,
        thresholdMinutes: LIVE_OBSERVATION_STALE_MINUTES
      }
    };
  } catch (error) {
    return {
      source: 'nws-station-observations',
      stationId,
      status: 'unavailable',
      observations: [],
      currentObservedTemp: null,
      observedHighSoFar: null,
      latestObservationAt: null,
      observationCount: 0,
      freshness: {
        latestAgeMinutes: null,
        isStale: true,
        thresholdMinutes: LIVE_OBSERVATION_STALE_MINUTES
      },
      error: error instanceof Error ? error.message : `Unable to fetch ${stationId} observations`
    };
  }
}

async function fetchKmdwObservations(env, climateDayWindow) {
  return fetchStationObservations(env, climateDayWindow, CHICAGO_STATION.stationId);
}

async function getNwsPointMetadata(env) {
  if (cachedPointMetadata.value && cachedPointMetadata.expiresAt > Date.now()) {
    return cachedPointMetadata.value;
  }

  const client = createNwsClient(env);
  const response = await client.get(`/points/${CHICAGO_STATION.latitude.toFixed(4)},${CHICAGO_STATION.longitude.toFixed(4)}`);
  const properties = response.data?.properties ?? {};
  const metadata = {
    source: 'nws-points',
    fetchedAt: new Date().toISOString(),
    forecastHourly: properties.forecastHourly ?? null,
    forecastGridData: properties.forecastGridData ?? null,
    gridId: properties.gridId ?? null,
    gridX: properties.gridX ?? null,
    gridY: properties.gridY ?? null,
    timezone: properties.timeZone ?? CHICAGO_STATION.timezone
  };

  cachedPointMetadata = {
    value: metadata,
    expiresAt: Date.now() + POINT_METADATA_TTL_MS
  };

  return metadata;
}

function overlapsWindow(startMs, endMs, climateDayWindow) {
  const windowStartMs = Date.parse(climateDayWindow.start);
  const windowEndMs = Date.parse(climateDayWindow.endExclusive);
  return startMs < windowEndMs && endMs > windowStartMs;
}

function normalizeHourlyPeriod(period, climateDayWindow) {
  const startMs = Date.parse(String(period?.startTime ?? ''));
  const endMs = Date.parse(String(period?.endTime ?? ''));
  const temp = toNumberOrNull(period?.temperature);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || typeof temp !== 'number') {
    return null;
  }

  if (!overlapsWindow(startMs, endMs, climateDayWindow)) {
    return null;
  }

  return {
    stationId: CHICAGO_STATION.stationId,
    source: 'nws-hourly',
    issueTime: null,
    validStart: new Date(startMs).toISOString(),
    validEnd: new Date(endMs).toISOString(),
    forecastTempF: String(period.temperatureUnit ?? '').toUpperCase() === 'C'
      ? round(celsiusToFahrenheit(temp), 1)
      : round(temp, 1),
    dewpointF: null,
    windSpeedMph: null,
    windDirection: null,
    cloudCover: null,
    precipProbability: toNumberOrNull(period?.probabilityOfPrecipitation?.value),
    pressureHpa: null,
    shortForecast: period?.shortForecast ?? null,
    raw: {
      number: period?.number ?? null,
      name: period?.name ?? null,
      startTime: period?.startTime ?? null,
      endTime: period?.endTime ?? null,
      temperature: period?.temperature ?? null,
      temperatureUnit: period?.temperatureUnit ?? null,
      windSpeed: period?.windSpeed ?? null,
      windDirection: period?.windDirection ?? null,
      shortForecast: period?.shortForecast ?? null
    }
  };
}

function parseIsoDurationMs(duration) {
  const match = String(duration ?? '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);

  if (!match) {
    return 60 * 60 * 1000;
  }

  const days = Number.parseInt(match[1] ?? '0', 10);
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  const seconds = Number.parseInt(match[4] ?? '0', 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function parseValidTimeInterval(validTime) {
  const [startRaw, durationRaw] = String(validTime ?? '').split('/');
  const startMs = Date.parse(startRaw);

  if (!Number.isFinite(startMs)) {
    return null;
  }

  const durationMs = parseIsoDurationMs(durationRaw);
  return {
    startMs,
    endMs: startMs + durationMs,
    validStart: new Date(startMs).toISOString(),
    validEnd: new Date(startMs + durationMs).toISOString()
  };
}

function getNwsGridConverter(unitCode) {
  const normalized = String(unitCode ?? '').toLowerCase();

  if (normalized.includes('degc')) {
    return celsiusToFahrenheit;
  }

  if (normalized.includes('km_h')) {
    return kmhToMph;
  }

  if (normalized.includes('pa')) {
    return pascalToHpa;
  }

  return (value) => value;
}

function normalizeGridSeries(property, climateDayWindow, fieldName) {
  const values = Array.isArray(property?.values) ? property.values : [];
  const convert = getNwsGridConverter(property?.uom);

  return values
    .map((entry) => {
      const interval = parseValidTimeInterval(entry?.validTime);
      const value = convert(toNumberOrNull(entry?.value));

      if (!interval || typeof value !== 'number' || !overlapsWindow(interval.startMs, interval.endMs, climateDayWindow)) {
        return null;
      }

      return {
        ...interval,
        [fieldName]: round(value, fieldName === 'windDirection' || fieldName === 'cloudCover' || fieldName === 'precipProbability' ? 0 : 1),
        rawValue: entry?.value ?? null,
        unitCode: property?.uom ?? null
      };
    })
    .filter(Boolean);
}

function nearestGridValue(rows, startMs, key) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const exact = rows.find((row) => row.startMs <= startMs && row.endMs > startMs);

  if (exact && typeof exact[key] === 'number') {
    return exact[key];
  }

  return rows
    .map((row) => ({
      value: row[key],
      distance: Math.abs(row.startMs - startMs)
    }))
    .filter((row) => typeof row.value === 'number')
    .sort((left, right) => left.distance - right.distance)[0]?.value ?? null;
}

async function fetchNwsForecasts(env, climateDayWindow) {
  const metadata = await getNwsPointMetadata(env);
  const headers = {
    Accept: 'application/geo+json, application/json',
    'User-Agent': env.weatherUserAgent ?? 'probis-weather-edge/0.1 (local)'
  };
  const [hourlyResult, gridResult] = await Promise.allSettled([
    metadata.forecastHourly
      ? axios.get(metadata.forecastHourly, { timeout: WEATHER_TIMEOUT_MS, headers })
      : Promise.reject(new Error('NWS hourly forecast URL unavailable')),
    metadata.forecastGridData
      ? axios.get(metadata.forecastGridData, { timeout: WEATHER_TIMEOUT_MS, headers })
      : Promise.reject(new Error('NWS grid forecast URL unavailable'))
  ]);
  const nowMs = Date.now();
  const hourlyRows = hourlyResult.status === 'fulfilled'
    ? (Array.isArray(hourlyResult.value.data?.properties?.periods) ? hourlyResult.value.data.properties.periods : [])
      .map((period) => normalizeHourlyPeriod(period, climateDayWindow))
      .filter(Boolean)
    : [];
  const gridProperties = gridResult.status === 'fulfilled' ? gridResult.value.data?.properties ?? {} : {};
  const gridTemperature = normalizeGridSeries(gridProperties.temperature, climateDayWindow, 'forecastTempF');
  const gridDewpoint = normalizeGridSeries(gridProperties.dewpoint, climateDayWindow, 'dewpointF');
  const gridWindSpeed = normalizeGridSeries(gridProperties.windSpeed, climateDayWindow, 'windSpeedMph');
  const gridWindDirection = normalizeGridSeries(gridProperties.windDirection, climateDayWindow, 'windDirection');
  const gridCloudCover = normalizeGridSeries(gridProperties.skyCover, climateDayWindow, 'cloudCover');
  const gridPrecip = normalizeGridSeries(gridProperties.probabilityOfPrecipitation, climateDayWindow, 'precipProbability');
  const gridPressure = normalizeGridSeries(gridProperties.pressure, climateDayWindow, 'pressureHpa');
  const gridRows = gridTemperature.map((row) => ({
    stationId: CHICAGO_STATION.stationId,
    source: 'nws-grid',
    issueTime: gridProperties.updateTime ?? gridProperties.validTimes ?? null,
    validStart: row.validStart,
    validEnd: row.validEnd,
    startMs: row.startMs,
    endMs: row.endMs,
    forecastTempF: row.forecastTempF,
    dewpointF: nearestGridValue(gridDewpoint, row.startMs, 'dewpointF'),
    windSpeedMph: nearestGridValue(gridWindSpeed, row.startMs, 'windSpeedMph'),
    windDirection: nearestGridValue(gridWindDirection, row.startMs, 'windDirection'),
    cloudCover: nearestGridValue(gridCloudCover, row.startMs, 'cloudCover'),
    precipProbability: nearestGridValue(gridPrecip, row.startMs, 'precipProbability'),
    pressureHpa: nearestGridValue(gridPressure, row.startMs, 'pressureHpa'),
    raw: {
      validStart: row.validStart,
      validEnd: row.validEnd,
      temperatureUnitCode: row.unitCode
    }
  }));
  const hourlyTemps = hourlyRows
    .map((row) => row.forecastTempF)
    .filter((value) => typeof value === 'number');
  const gridTemps = gridRows
    .map((row) => row.forecastTempF)
    .filter((value) => typeof value === 'number');
  const remainingHourlyTemps = hourlyRows
    .filter((row) => Date.parse(row.validEnd) >= nowMs)
    .map((row) => row.forecastTempF)
    .filter((value) => typeof value === 'number');
  const remainingGridTemps = gridRows
    .filter((row) => Date.parse(row.validEnd) >= nowMs)
    .map((row) => row.forecastTempF)
    .filter((value) => typeof value === 'number');
  const forecastErrors = [
    hourlyResult.status === 'rejected' ? `hourly: ${hourlyResult.reason?.message ?? 'unavailable'}` : null,
    gridResult.status === 'rejected' ? `grid: ${gridResult.reason?.message ?? 'unavailable'}` : null
  ].filter(Boolean);
  const newestForecastAt = [
    ...hourlyRows.map((row) => row.validStart),
    ...gridRows.map((row) => row.validStart)
  ]
    .map((value) => Date.parse(String(value ?? '')))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0] ?? null;
  const newestAgeMinutes = newestForecastAt ? (Date.now() - newestForecastAt) / 60000 : null;

  return {
    source: 'nws-api',
    status: hourlyRows.length > 0 || gridRows.length > 0 ? 'ready' : 'degraded',
    metadata,
    forecastRows: [...hourlyRows, ...gridRows],
    hourly: {
      rows: hourlyRows,
      forecastMaxF: hourlyTemps.length > 0 ? Math.max(...hourlyTemps) : null,
      remainingMaxF: remainingHourlyTemps.length > 0 ? Math.max(...remainingHourlyTemps) : null,
      rowCount: hourlyRows.length
    },
    grid: {
      rows: gridRows,
      forecastMaxF: gridTemps.length > 0 ? Math.max(...gridTemps) : null,
      remainingMaxF: remainingGridTemps.length > 0 ? Math.max(...remainingGridTemps) : null,
      rowCount: gridRows.length
    },
    features: {
      forecast_max_nws_hourly: hourlyTemps.length > 0 ? Math.max(...hourlyTemps) : null,
      forecast_max_nws_grid: gridTemps.length > 0 ? Math.max(...gridTemps) : null,
      dew_point: average([
        ...hourlyRows.map((row) => row.dewpointF),
        ...gridRows.map((row) => row.dewpointF)
      ]),
      wind_speed: average([
        ...hourlyRows.map((row) => row.windSpeedMph),
        ...gridRows.map((row) => row.windSpeedMph)
      ]),
      wind_direction: average(gridRows.map((row) => row.windDirection)),
      cloud_cover: average(gridRows.map((row) => row.cloudCover)),
      precip_probability: average([
        ...hourlyRows.map((row) => row.precipProbability),
        ...gridRows.map((row) => row.precipProbability)
      ]),
      pressure_trend: null
    },
    freshness: {
      newestForecastAt: newestForecastAt ? new Date(newestForecastAt).toISOString() : null,
      newestAgeMinutes: typeof newestAgeMinutes === 'number' ? round(newestAgeMinutes, 1) : null,
      isStale: typeof newestAgeMinutes === 'number' ? newestAgeMinutes > FORECAST_STALE_MINUTES : false,
      thresholdMinutes: FORECAST_STALE_MINUTES
    },
    errors: forecastErrors
  };
}

function getForecastRefreshIntervalMs(env) {
  const value = Number(env?.chicagoForecastRefreshIntervalMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_FORECAST_REFRESH_INTERVAL_MS;
}

function getForecastCacheKey(env, climateDayWindow) {
  return [
    env?.nwsApiBaseUrl ?? 'https://api.weather.gov',
    CHICAGO_STATION.stationId,
    climateDayWindow.targetDate
  ].join('|');
}

async function fetchNwsForecastsCached(env, climateDayWindow, options = {}) {
  const cacheKey = getForecastCacheKey(env, climateDayWindow);
  const now = Date.now();
  const ttlMs = getForecastRefreshIntervalMs(env);
  const cached = cachedForecasts.get(cacheKey);

  if (!options.force && cached && cached.expiresAt > now) {
    return {
      ...cached.value,
      cache: {
        status: 'hit',
        cachedAt: cached.cachedAt,
        expiresAt: new Date(cached.expiresAt).toISOString(),
        ttlMs
      }
    };
  }

  const forecast = await fetchNwsForecasts(env, climateDayWindow);
  const cachedAt = new Date().toISOString();

  cachedForecasts.set(cacheKey, {
    cachedAt,
    expiresAt: now + ttlMs,
    value: forecast
  });

  return {
    ...forecast,
    cache: {
      status: cached ? 'refresh' : 'miss',
      cachedAt,
      expiresAt: new Date(now + ttlMs).toISOString(),
      ttlMs
    }
  };
}

function buildUnavailableNwsForecastResult(env, error) {
  return {
    source: 'nws-api',
    status: 'unavailable',
    cache: {
      status: 'error',
      ttlMs: getForecastRefreshIntervalMs(env)
    },
    metadata: null,
    forecastRows: [],
    hourly: { rows: [], forecastMaxF: null, remainingMaxF: null, rowCount: 0 },
    grid: { rows: [], forecastMaxF: null, remainingMaxF: null, rowCount: 0 },
    features: {
      forecast_max_nws_hourly: null,
      forecast_max_nws_grid: null,
      dew_point: null,
      wind_speed: null,
      wind_direction: null,
      cloud_cover: null,
      precip_probability: null,
      pressure_trend: null
    },
    freshness: {
      newestForecastAt: null,
      newestAgeMinutes: null,
      isStale: true,
      thresholdMinutes: FORECAST_STALE_MINUTES
    },
    errors: [error instanceof Error ? error.message : 'Unable to fetch NWS forecasts']
  };
}

async function fetchNbmForecast(env) {
  if (!env.nbmEnabled) {
    return {
      source: 'noaa-nbm',
      status: 'disabled',
      enabled: false,
      rows: [],
      features: {
        forecast_max_nbm: null,
        nbm_p10: null,
        nbm_p50: null,
        nbm_p90: null
      }
    };
  }

  if (!env.nbmJsonUrl) {
    return {
      source: 'noaa-nbm',
      status: 'not-configured',
      enabled: true,
      rows: [],
      features: {
        forecast_max_nbm: null,
        nbm_p10: null,
        nbm_p50: null,
        nbm_p90: null
      }
    };
  }

  try {
    const response = await axios.get(env.nbmJsonUrl, {
      timeout: WEATHER_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        'User-Agent': env.weatherUserAgent ?? 'probis-weather-edge/0.1 (local)'
      }
    });
    const payload = response.data ?? {};

    return {
      source: 'noaa-nbm',
      status: 'ready',
      enabled: true,
      rows: Array.isArray(payload.rows) ? payload.rows : [],
      features: {
        forecast_max_nbm: toNumberOrNull(payload.forecast_max_nbm ?? payload.forecastMaxF),
        nbm_p10: toNumberOrNull(payload.nbm_p10 ?? payload.p10),
        nbm_p50: toNumberOrNull(payload.nbm_p50 ?? payload.p50),
        nbm_p90: toNumberOrNull(payload.nbm_p90 ?? payload.p90)
      }
    };
  } catch (error) {
    return {
      source: 'noaa-nbm',
      status: 'unavailable',
      enabled: true,
      rows: [],
      features: {
        forecast_max_nbm: null,
        nbm_p10: null,
        nbm_p50: null,
        nbm_p90: null
      },
      error: error instanceof Error ? error.message : 'Unable to fetch configured NBM JSON feed'
    };
  }
}

function getSearchPayloadItems(payload) {
  const seen = new Set();
  const items = [];

  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const hasMarketShape = Boolean(value.question || value.title || value.slug)
      && (Array.isArray(value.markets) || value.outcomes || value.marketSides || value.clobTokenIds);

    if (hasMarketShape) {
      items.push(value);
    }

    for (const key of ['events', 'markets', 'results', 'data', 'items']) {
      if (value[key]) {
        visit(value[key]);
      }
    }
  }

  visit(payload);
  return items;
}

function normalizeOutcome(outcome, index, labelFallback = null, priceFallback = null, tokenFallback = null) {
  if (outcome && typeof outcome === 'object') {
    const label = String(outcome.label ?? outcome.outcome ?? outcome.description ?? labelFallback ?? '').trim();

    if (!label) {
      return null;
    }

    return {
      label,
      tokenId: outcome.tokenId ?? outcome.token_id ?? outcome.assetId ?? outcome.asset_id ?? tokenFallback ?? null,
      probability: toNumberOrNull(outcome.probability ?? outcome.currentProbability ?? outcome.price ?? priceFallback),
      sideId: outcome.sideId ?? outcome.id ?? index
    };
  }

  const label = String(outcome ?? labelFallback ?? '').trim();

  if (!label) {
    return null;
  }

  return {
    label,
    tokenId: tokenFallback ?? null,
    probability: toNumberOrNull(priceFallback),
    sideId: index
  };
}

function getQuoteValue(value) {
  if (value && typeof value === 'object') {
    return toNumberOrNull(value.value ?? value.price ?? value.amount);
  }

  return toNumberOrNull(value);
}

function getGatewayQuote(market, label) {
  const normalizedLabel = normalizeText(label);
  const matchingSide = Array.isArray(market?.marketSides)
    ? market.marketSides.find((side) => normalizeText(side?.description ?? side?.name) === normalizedLabel)
    : null;
  const bestBid = normalizedLabel === 'yes'
    ? getQuoteValue(market?.bestBidQuote) ?? getQuoteValue(matchingSide?.price)
    : getQuoteValue(matchingSide?.price);
  const bestAsk = normalizedLabel === 'yes'
    ? getQuoteValue(market?.bestAskQuote) ?? getQuoteValue(matchingSide?.quote)
    : getQuoteValue(matchingSide?.quote);

  return {
    bestBid,
    bestAsk,
    spread: typeof bestBid === 'number' && typeof bestAsk === 'number'
      ? Math.max(0, bestAsk - bestBid)
      : null,
    midpoint: typeof bestBid === 'number' && typeof bestAsk === 'number'
      ? round((bestBid + bestAsk) / 2, 4)
      : null,
    source: bestBid !== null || bestAsk !== null ? 'polymarket-us-gateway-quotes' : null
  };
}

function normalizeMarketObject(raw, parentEvent = null, index = 0) {
  const market = raw?.markets && Array.isArray(raw.markets) ? null : raw;

  if (!market) {
    return null;
  }

  const labels = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const objectOutcomes = Array.isArray(market.outcomes) && market.outcomes.some((outcome) => outcome && typeof outcome === 'object')
    ? market.outcomes
    : labels;
  let outcomes = objectOutcomes
    .map((outcome, outcomeIndex) => normalizeOutcome(outcome, outcomeIndex, labels[outcomeIndex], prices[outcomeIndex], tokenIds[outcomeIndex]))
    .filter(Boolean);

  if (outcomes.length === 0 && Array.isArray(market.marketSides)) {
    outcomes = market.marketSides
      .map((side, sideIndex) => normalizeOutcome({
        label: side.description ?? side.name,
        probability: side.price,
        tokenId: side.tokenId ?? side.token_id ?? side.assetId,
        sideId: side.id
      }, sideIndex))
      .filter(Boolean);
  }

  if (outcomes.length === 0) {
    return null;
  }

  const yesQuote = getGatewayQuote(market, 'Yes');

  return {
    id: market.id ?? null,
    eventId: parentEvent?.id ?? market.eventId ?? null,
    eventSlug: parentEvent?.slug ?? market.eventSlug ?? market.event_slug ?? null,
    eventTitle: parentEvent?.title ?? market.eventTitle ?? market.event_title ?? null,
    slug: market.slug ?? market.marketSlug ?? market.market_slug ?? `chicago-market-${index + 1}`,
    conditionId: String(market.conditionId ?? market.condition_id ?? market.id ?? market.slug ?? `chicago-market-${index + 1}`),
    question: market.question ?? market.title ?? '',
    title: market.title ?? null,
    subtitle: market.subtitle ?? null,
    description: market.description ?? parentEvent?.description ?? null,
    rules: market.rules ?? market.marketRules ?? parentEvent?.rules ?? null,
    resolutionSource: market.resolutionSource ?? market.resolution_source ?? parentEvent?.resolutionSource ?? null,
    active: market.active !== false && parentEvent?.active !== false,
    closed: Boolean(market.closed ?? parentEvent?.closed),
    liquidity: toNumberOrNull(market.liquidity ?? parentEvent?.liquidity),
    volume: toNumberOrNull(market.volume ?? parentEvent?.volume),
    endDate: market.endDate ?? parentEvent?.endDate ?? null,
    bestBid: yesQuote.bestBid,
    bestAsk: yesQuote.bestAsk,
    spread: yesQuote.spread,
    midpoint: yesQuote.midpoint,
    quoteSource: yesQuote.source,
    outcomes
  };
}

function collectMarketsFromSearch(payload) {
  const items = getSearchPayloadItems(payload);
  const markets = [];

  items.forEach((item, index) => {
    if (Array.isArray(item.markets)) {
      item.markets.forEach((market, marketIndex) => {
        const normalized = normalizeMarketObject(market, item, marketIndex);

        if (normalized) {
          markets.push(normalized);
        }
      });
      return;
    }

    const normalized = normalizeMarketObject(item, null, index);

    if (normalized) {
      markets.push(normalized);
    }
  });

  return markets;
}

function findYesOutcome(market) {
  return market.outcomes.find((outcome) => normalizeText(outcome.label) === 'yes')
    ?? market.outcomes[0]
    ?? null;
}

export function detectRuleFlags(text) {
  const normalized = normalizeText(text);
  const mentionsKmdw = /\bkmdw\b/.test(normalized)
    || normalized.includes('midway')
    || normalized.includes('chicago-midway')
    || normalized.includes('chicago midway');
  const mentionsClimdw = /\bclimdw\b/.test(normalized) || normalized.includes('chicago-midway climate summary');
  const mentionsNonMidwayStation = false;
  const mentionsWeatherGov = normalized.includes('weather.gov') || normalized.includes('national weather service');
  const mentionsWunderground = normalized.includes('wunderground') || normalized.includes('weather underground');
  const hasKmdwSource = mentionsKmdw || mentionsClimdw;

  return {
    mentionsKmdw,
    mentionsClimdw,
    mentionsNonMidwayStation,
    mentionsWeatherGov,
    mentionsWunderground,
    hasKmdwSource,
    ruleAmbiguity: !hasKmdwSource || mentionsNonMidwayStation
  };
}

export function buildDesignatedSource(ruleFlags = {}, sourceTextHash = null) {
  const mentionsNonMidwayStation = ruleFlags.mentionsNonMidwayStation === true;
  const verified = ruleFlags.hasKmdwSource === true && !mentionsNonMidwayStation;
  const provider = ruleFlags.mentionsWeatherGov
    ? 'National Weather Service'
    : ruleFlags.mentionsWunderground
      ? 'Weather Underground'
      : verified
        ? 'Contract rule text'
        : null;
  const verificationStatus = mentionsNonMidwayStation
    ? 'rejected-non-midway-source'
    : verified
      ? 'verified-kmdw-midway'
      : 'manual-review-required';

  return {
    verified,
    verificationStatus,
    provider,
    stationId: verified ? CHICAGO_STATION.stationId : null,
    stationName: verified ? CHICAGO_STATION.stationName : null,
    cliProduct: ruleFlags.mentionsClimdw ? CHICAGO_STATION.cliProduct : null,
    sourceTextHash,
    tradeGate: verified ? 'paper-signals-allowed' : 'live-trading-blocked',
    evidence: {
      mentionsKmdw: ruleFlags.mentionsKmdw === true,
      mentionsClimdw: ruleFlags.mentionsClimdw === true,
      mentionsWeatherGov: ruleFlags.mentionsWeatherGov === true,
      mentionsWunderground: ruleFlags.mentionsWunderground === true,
      mentionsNonMidwayStation
    },
    notes: verified
      ? 'Rule text explicitly points to Chicago Midway / KMDW.'
      : mentionsNonMidwayStation
        ? 'Rule text points away from Chicago Midway; live trading is blocked.'
        : 'Rule text does not explicitly identify Chicago Midway / KMDW; live trading is blocked.'
  };
}

export function normalizeBucketMarket(market, targetDate) {
  const text = compactText(
    market.title,
    market.subtitle,
    market.question,
    market.description,
    market.rules,
    market.resolutionSource
  );
  const bucket = [
    market.title,
    market.subtitle,
    market.question,
    ...market.outcomes.map((outcome) => outcome.label)
  ]
    .map(parseTemperatureBucket)
    .find(Boolean);

  if (!bucket) {
    return null;
  }

  const marketDate = extractDateFromText(text) ?? null;

  if (targetDate && marketDate && marketDate !== targetDate) {
    return null;
  }

  const yesOutcome = findYesOutcome(market);
  const flags = detectRuleFlags(text);
  const rulesTextHash = hashText(text);
  const designatedSource = buildDesignatedSource(flags, rulesTextHash);

  return {
    marketSlug: market.slug,
    eventSlug: market.eventSlug,
    eventTitle: market.eventTitle,
    conditionId: market.conditionId,
    marketQuestion: market.question,
    marketTitle: market.title,
    marketSubtitle: market.subtitle,
    targetDate: marketDate ?? targetDate ?? null,
    outcomeLabel: market.title ?? market.subtitle ?? market.question ?? yesOutcome?.label ?? 'Bucket',
    lowTemp: bucket.lowTemp,
    highTemp: bucket.highTemp,
    inclusiveLow: bucket.inclusiveLow,
    inclusiveHigh: bucket.inclusiveHigh,
    yesTokenId: yesOutcome?.tokenId ?? null,
    marketProbability: market.midpoint ?? yesOutcome?.probability ?? null,
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    spread: market.spread,
    midpoint: market.midpoint,
    bidDepth: null,
    askDepth: null,
    liquidity: market.liquidity,
    volume: market.volume,
    endDate: market.endDate,
    rulesText: text,
    rulesTextHash,
    ruleFlags: flags,
    designatedSource,
    source: 'polymarket-us-search',
    quoteSource: market.quoteSource
  };
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function mergeBucketMarket(existing, candidate) {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(candidate)) {
    if (!isPresent(merged[key]) && isPresent(value)) {
      merged[key] = value;
    }
  }

  if (candidate.ruleFlags?.hasKmdwSource && !existing.ruleFlags?.hasKmdwSource) {
    merged.ruleFlags = candidate.ruleFlags;
  }

  if (candidate.designatedSource?.verified && !existing.designatedSource?.verified) {
    merged.designatedSource = candidate.designatedSource;
  }

  return merged;
}

export function dedupeChicagoMarketBuckets(bucketMarkets) {
  const byKey = new Map();

  for (const bucket of Array.isArray(bucketMarkets) ? bucketMarkets : []) {
    const key = String(bucket?.conditionId ?? bucket?.marketSlug ?? '').trim();

    if (!key) {
      continue;
    }

    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeBucketMarket(existing, bucket) : bucket);
  }

  return [...byKey.values()];
}

function getBucketLowerSortValue(bucket) {
  return typeof bucket.lowTemp === 'number' ? bucket.lowTemp : Number.NEGATIVE_INFINITY;
}

function getBucketUpperSortValue(bucket) {
  return typeof bucket.highTemp === 'number' ? bucket.highTemp : Number.POSITIVE_INFINITY;
}

function sortChicagoMarketBuckets(bucketMarkets) {
  return [...bucketMarkets].sort((left, right) => {
    const leftDate = String(left.targetDate ?? '');
    const rightDate = String(right.targetDate ?? '');

    if (leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }

    const lowerDiff = getBucketLowerSortValue(left) - getBucketLowerSortValue(right);

    if (lowerDiff !== 0) {
      return lowerDiff;
    }

    return getBucketUpperSortValue(left) - getBucketUpperSortValue(right);
  });
}

function normalizeCatalogDaysAhead(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_MARKET_CATALOG_DAYS_AHEAD), 10);
  const daysAhead = Number.isFinite(parsed) ? parsed : DEFAULT_MARKET_CATALOG_DAYS_AHEAD;
  return Math.trunc(clamp(daysAhead, 0, MAX_MARKET_CATALOG_DAYS_AHEAD));
}

function resolveCatalogDateRange(options = {}) {
  const daysAhead = normalizeCatalogDaysAhead(options.daysAhead);
  const today = normalizeDateString(options.date ?? options.dateFrom);
  const dateFrom = normalizeDateString(options.dateFrom ?? options.date ?? today, today);
  const dateTo = normalizeDateString(options.dateTo, addDays(dateFrom, daysAhead));

  return dateTo < dateFrom
    ? { dateFrom: dateTo, dateTo: dateFrom, daysAhead }
    : { dateFrom, dateTo, daysAhead };
}

function summarizeCatalogVerification(buckets) {
  const verifiedCount = buckets.filter((bucket) => bucket.designatedSource?.verified === true).length;
  const blockedCount = buckets.filter((bucket) => bucket.designatedSource?.verified !== true).length;

  return {
    verifiedCount,
    blockedCount,
    allVerified: buckets.length > 0 && blockedCount === 0
  };
}

export function buildChicagoMarketCatalogFromBuckets(bucketMarkets, options = {}) {
  const { dateFrom, dateTo, daysAhead } = resolveCatalogDateRange(options);
  const includeUndated = options.includeUndated === true;
  const buckets = sortChicagoMarketBuckets(
    (Array.isArray(bucketMarkets) ? bucketMarkets : [])
      .filter((bucket) => {
        if (!bucket?.targetDate) {
          return includeUndated;
        }

        return bucket.targetDate >= dateFrom && bucket.targetDate <= dateTo;
      })
  );
  const byDate = new Map();

  for (const bucket of buckets) {
    const key = bucket.targetDate ?? 'undated';

    if (!byDate.has(key)) {
      byDate.set(key, []);
    }

    byDate.get(key).push(bucket);
  }

  const dateGroups = [...byDate.entries()]
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .map(([targetDate, markets]) => {
      const verification = summarizeCatalogVerification(markets);

      return {
        targetDate: targetDate === 'undated' ? null : targetDate,
        bucketCount: markets.length,
        quoteCount: markets.filter((market) => typeof market.bestBid === 'number' || typeof market.bestAsk === 'number').length,
        verifiedCount: verification.verifiedCount,
        blockedCount: verification.blockedCount,
        markets
      };
    });
  const verification = summarizeCatalogVerification(buckets);

  return {
    generatedAt: new Date().toISOString(),
    source: 'polymarket-us-search',
    station: CHICAGO_STATION,
    dateFrom,
    dateTo,
    daysAhead,
    bucketCount: buckets.length,
    dateGroupCount: dateGroups.length,
    verification,
    dateGroups,
    buckets
  };
}

async function fetchChicagoMarketBuckets(env, targetDate) {
  const client = createGatewayClient(env);
  const query = env.chicagoMarketSearchQuery ?? 'highest temperature chicago';
  const pathCandidates = ['/v1/search', '/search'];
  let rawPayload = null;
  let lastError = null;

  for (const path of pathCandidates) {
    try {
      const response = await client.get(path, {
        params: {
          query,
          limit: Number.isFinite(env.chicagoMarketSearchLimit) ? env.chicagoMarketSearchLimit : 60
        }
      });
      rawPayload = response.data;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!rawPayload) {
    return {
      source: 'polymarket-us-search',
      status: 'unavailable',
      query,
      buckets: [],
      error: lastError instanceof Error ? lastError.message : 'Unable to fetch Chicago market search results'
    };
  }

  const markets = collectMarketsFromSearch(rawPayload)
    .filter((market) => {
      const text = normalizeText(compactText(market.question, market.title, market.subtitle, market.description, market.rules, market.eventTitle));
      return text.includes('chicago') && (text.includes('temperature') || text.includes('high temp') || text.includes('highest'));
    });
  const bucketMarkets = dedupeChicagoMarketBuckets(markets
    .map((market) => normalizeBucketMarket(market, targetDate))
    .filter(Boolean));
  const clobMarkets = bucketMarkets.map((bucket) => ({
    conditionId: bucket.conditionId,
    outcomes: [{
      label: 'Yes',
      tokenId: bucket.yesTokenId,
      probability: bucket.marketProbability
    }]
  }));
  const clobSnapshots = await fetchClobMarketSnapshots(env, clobMarkets, { includeHistory: false });
  const buckets = bucketMarkets.map((bucket) => {
    const clobSnapshot = bucket.yesTokenId ? clobSnapshots.byTokenId.get(String(bucket.yesTokenId)) : null;

    return {
      ...bucket,
      marketProbability: clobSnapshot?.midpoint ?? bucket.marketProbability,
      bestBid: clobSnapshot?.bestBid ?? bucket.bestBid,
      bestAsk: clobSnapshot?.bestAsk ?? bucket.bestAsk,
      spread: clobSnapshot?.spread ?? bucket.spread,
      midpoint: clobSnapshot?.midpoint ?? bucket.midpoint,
      bidDepth: clobSnapshot?.bidDepth ?? null,
      askDepth: clobSnapshot?.askDepth ?? null,
      bookSource: clobSnapshot?.source ?? bucket.quoteSource ?? null
    };
  });

  return {
    source: 'polymarket-us-search',
    status: buckets.length > 0 ? 'ready' : 'empty',
    query,
    bucketCount: buckets.length,
    buckets
  };
}

export async function buildChicagoMarketCatalog(env, options = {}) {
  const fetchedMarkets = await fetchChicagoMarketBuckets(env, null);
  const catalog = buildChicagoMarketCatalogFromBuckets(fetchedMarkets.buckets, options);
  const status = fetchedMarkets.status === 'unavailable'
    ? 'unavailable'
    : catalog.bucketCount > 0
      ? 'ready'
      : 'empty';

  return {
    ...catalog,
    status,
    query: fetchedMarkets.query,
    fetchStatus: fetchedMarkets.status,
    rawBucketCount: fetchedMarkets.bucketCount ?? fetchedMarkets.buckets?.length ?? 0,
    error: fetchedMarkets.error ?? null
  };
}

export function getChicagoDayPhase(climateDayWindow) {
  const now = Date.now();
  const start = Date.parse(climateDayWindow.start);
  const end = Date.parse(climateDayWindow.endExclusive);

  if (now < start) {
    return 'future';
  }

  if (now >= end) {
    return 'complete';
  }

  const progress = (now - start) / (end - start);

  if (progress < 0.35) {
    return 'morning';
  }

  if (progress < 0.65) {
    return 'midday';
  }

  if (progress < 0.84) {
    return 'late-afternoon';
  }

  return 'evening';
}

export function buildKmdwPositionLifecycle({
  prediction = null,
  targetDate = null,
  dayPhase = null,
  timeToResolutionMs = null,
  generatedAt = new Date().toISOString()
} = {}) {
  const activePhase = dayPhase ?? prediction?.dayPhase ?? 'unknown';
  const activeTargetDate = targetDate ?? prediction?.targetDate ?? null;
  const thresholdStatus = prediction?.thresholdDiagnostics?.status ?? null;
  const sourceStale = prediction?.sourceFreshness?.isStale === true;
  const phaseActions = {
    future: {
      state: 'no-live-position',
      manualAction: 'wait',
      recommendedAction: 'wait-for-live-climate-day',
      urgency: 'low',
      instruction: 'No KMDW position should be opened before the target climate day.'
    },
    morning: {
      state: 'live-review',
      manualAction: 'review-entry',
      recommendedAction: 'manual-review-only',
      urgency: 'base',
      instruction: 'Review KMDW observation freshness and market depth before live routing.'
    },
    midday: {
      state: 'live-manage',
      manualAction: 'hold-or-reduce',
      recommendedAction: 'manual-risk-review',
      urgency: 'base',
      instruction: 'Manage KMDW exposure with live routing available after manual button confirmation.'
    },
    'late-afternoon': {
      state: 'live-reduce-window',
      manualAction: 'reduce',
      recommendedAction: 'manual-reduce-before-late-print',
      urgency: 'hot-window',
      instruction: 'Late-print risk is elevated. Consider reducing live exposure before the next KMDW observation or CLIMDW update.'
    },
    evening: {
      state: 'live-flatten-window',
      manualAction: 'flatten',
      recommendedAction: 'manual-flatten-before-final-print',
      urgency: 'critical-window',
      instruction: 'Final-print risk is elevated. Consider flattening live exposure before settlement ambiguity increases.'
    },
    complete: {
      state: 'live-close-after-settlement',
      manualAction: 'close-live',
      recommendedAction: 'close-paper-position-after-climdw',
      urgency: 'settlement',
      instruction: 'The KMDW climate day is complete. Close or reconcile live exposure after CLIMDW settlement.'
    }
  };
  const base = phaseActions[activePhase] ?? {
    state: 'live-review',
    manualAction: 'review',
    recommendedAction: 'manual-review-required',
    urgency: 'base',
    instruction: 'Review KMDW live exposure before routing.'
  };
  const thresholdAdjustment = thresholdStatus === 'knife-edge'
    ? ' Threshold is knife-edge; prefer reducing or flattening exposure.'
    : thresholdStatus === 'contested'
      ? ' Threshold is contested; avoid adding exposure without manual review.'
      : '';
  const freshnessAdjustment = sourceStale
    ? ' Source freshness is stale; do not add exposure without review.'
    : '';

  return {
    policyId: KMDW_POSITION_LIFECYCLE_POLICY_ID,
    stationId: CHICAGO_STATION.stationId,
    mode: 'live-routing',
    targetDate: activeTargetDate,
    dayPhase: activePhase,
    state: base.state,
    manualAction: base.manualAction,
    recommendedAction: base.recommendedAction,
    urgency: base.urgency,
    livePositionAllowed: true,
    liveReduceAllowed: true,
    liveFlattenAllowed: true,
    automatedExitAllowed: true,
    timeToResolutionMs: typeof timeToResolutionMs === 'number' ? timeToResolutionMs : null,
    generatedAt,
    instruction: `${base.instruction}${thresholdAdjustment}${freshnessAdjustment}`,
    rules: [
      'KMDW signals can route live from Probis after manual button confirmation.',
      'Use current source, quote, and depth checks before submitting live entry orders.',
      'Late-afternoon exposure should be reviewed before late prints.',
      'Evening exposure should be reviewed before final print or settlement ambiguity.'
    ]
  };
}

function getForecastDisagreement(values) {
  const valid = values.filter((value) => typeof value === 'number');

  if (valid.length < 2) {
    return null;
  }

  return Math.max(...valid) - Math.min(...valid);
}

function normalPdf(x, mean, stdDev) {
  const z = (x - mean) / stdDev;
  return Math.exp(-0.5 * z * z);
}

function normalizeDistribution(distribution) {
  const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);

  if (!total) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(distribution).map(([key, value]) => [key, round(value / total, 6)])
  );
}

function buildIntegerDistribution({ expectedHigh, stdDev, observedHighSoFar, settlement }) {
  if (settlement?.status === 'settled' && typeof settlement.maxTempF === 'number') {
    return {
      [String(settlement.maxTempF)]: 1
    };
  }

  const safeExpectedHigh = typeof expectedHigh === 'number' ? expectedHigh : 70;
  const safeStdDev = clamp(typeof stdDev === 'number' ? stdDev : 4, 0.35, 9);
  const minTemp = Math.max(DISTRIBUTION_MIN_TEMP, Math.floor(safeExpectedHigh - safeStdDev * 6));
  const maxTemp = Math.min(DISTRIBUTION_MAX_TEMP, Math.ceil(safeExpectedHigh + safeStdDev * 6));
  const raw = {};

  for (let temp = minTemp; temp <= maxTemp; temp += 1) {
    if (typeof observedHighSoFar === 'number' && temp < Math.round(observedHighSoFar)) {
      raw[temp] = 0;
      continue;
    }

    raw[temp] = normalPdf(temp, safeExpectedHigh, safeStdDev);
  }

  return normalizeDistribution(raw);
}

export function bucketProbability(distribution, lowTemp, highTemp) {
  let probability = 0;

  for (const [tempText, value] of Object.entries(distribution ?? {})) {
    const temp = Number.parseInt(tempText, 10);

    if (!Number.isFinite(temp)) {
      continue;
    }

    if (typeof lowTemp === 'number' && temp < lowTemp) {
      continue;
    }

    if (typeof highTemp === 'number' && temp > highTemp) {
      continue;
    }

    probability += value;
  }

  return round(probability, 6) ?? 0;
}

function getPercentile(distribution, percentile) {
  let cumulative = 0;
  const rows = Object.entries(distribution)
    .map(([temp, probability]) => [Number.parseInt(temp, 10), probability])
    .filter(([temp, probability]) => Number.isFinite(temp) && typeof probability === 'number')
    .sort((left, right) => left[0] - right[0]);

  for (const [temp, probability] of rows) {
    cumulative += probability;

    if (cumulative >= percentile) {
      return temp;
    }
  }

  return rows.at(-1)?.[0] ?? null;
}

function getTemperatureDistributionRows(distribution) {
  return Object.entries(distribution ?? {})
    .map(([temp, probability]) => ({
      temp: Number.parseInt(temp, 10),
      probability
    }))
    .filter((row) => Number.isFinite(row.temp) && typeof row.probability === 'number')
    .sort((left, right) => left.temp - right.temp);
}

function getBucketBoundaryValues(bucket) {
  return [
    typeof bucket?.lowTemp === 'number' ? bucket.lowTemp - 0.5 : null,
    typeof bucket?.highTemp === 'number' ? bucket.highTemp + 0.5 : null
  ].filter((value) => typeof value === 'number');
}

function getBoundaryMass(distributionRows, boundary, radiusF = 1) {
  return distributionRows
    .filter((row) => Math.abs(row.temp - boundary) <= radiusF)
    .reduce((sum, row) => sum + row.probability, 0);
}

export function buildThresholdDiagnostics({
  temperatureDistribution,
  bucketProbabilities,
  marketBuckets,
  expectedHigh
}) {
  const buckets = Array.isArray(marketBuckets) ? marketBuckets : [];
  const distributionRows = getTemperatureDistributionRows(temperatureDistribution);
  const bucketRows = buckets
    .map((bucket) => ({
      conditionId: bucket.conditionId,
      outcomeLabel: bucket.outcomeLabel,
      lowTemp: bucket.lowTemp,
      highTemp: bucket.highTemp,
      probability: toNumberOrNull(bucketProbabilities?.[bucket.conditionId]) ?? 0
    }))
    .sort((left, right) => right.probability - left.probability);
  const topBucket = bucketRows[0] ?? null;
  const runnerUpBucket = bucketRows[1] ?? null;
  const topBucketMargin = topBucket && runnerUpBucket
    ? topBucket.probability - runnerUpBucket.probability
    : null;
  const boundaries = buckets.flatMap((bucket) => getBucketBoundaryValues(bucket));
  const nearestBoundary = typeof expectedHigh === 'number' && boundaries.length > 0
    ? boundaries
      .map((boundary) => ({
        boundary,
        distanceF: Math.abs(expectedHigh - boundary),
        probabilityMassWithin1F: getBoundaryMass(distributionRows, boundary, 1)
      }))
      .sort((left, right) => left.distanceF - right.distanceF)[0]
    : null;
  const boundaryMass = nearestBoundary?.probabilityMassWithin1F ?? null;
  const knifeEdge = (typeof topBucketMargin === 'number' && topBucketMargin < 0.08)
    || (typeof nearestBoundary?.distanceF === 'number' && nearestBoundary.distanceF <= 0.75)
    || (typeof boundaryMass === 'number' && boundaryMass >= 0.25);
  const contested = knifeEdge
    || (typeof topBucketMargin === 'number' && topBucketMargin < 0.15)
    || (typeof boundaryMass === 'number' && boundaryMass >= 0.15);
  const status = knifeEdge ? 'knife-edge' : contested ? 'contested' : 'stable';

  return {
    status,
    topBucket,
    runnerUpBucket,
    topBucketMargin: round(topBucketMargin, 6),
    nearestBoundary: nearestBoundary ? {
      boundary: nearestBoundary.boundary,
      distanceF: round(nearestBoundary.distanceF, 2),
      probabilityMassWithin1F: round(nearestBoundary.probabilityMassWithin1F, 6)
    } : null,
    bucketConcentration: round(topBucket?.probability ?? null, 6),
    note: status === 'knife-edge'
      ? 'Posterior is close to a KMDW bucket boundary or split across adjacent buckets.'
      : status === 'contested'
        ? 'Top KMDW bucket is not clearly separated from the runner-up.'
        : 'Top KMDW bucket is separated from nearby thresholds.'
  };
}

function getBucketMarketPrice(bucket) {
  if (typeof bucket.midpoint === 'number') {
    return bucket.midpoint;
  }

  if (typeof bucket.marketProbability === 'number') {
    return bucket.marketProbability;
  }

  if (typeof bucket.bestBid === 'number' && typeof bucket.bestAsk === 'number') {
    return (bucket.bestBid + bucket.bestAsk) / 2;
  }

  return typeof bucket.bestAsk === 'number' ? bucket.bestAsk : bucket.bestBid ?? null;
}

export function buildMarketImpliedBucketProbabilities(marketBuckets) {
  const rows = (Array.isArray(marketBuckets) ? marketBuckets : [])
    .map((bucket) => ({
      conditionId: bucket.conditionId,
      probability: getBucketMarketPrice(bucket)
    }))
    .filter((row) => row.conditionId && typeof row.probability === 'number' && row.probability > 0 && row.probability < 1);
  const total = rows.reduce((sum, row) => sum + row.probability, 0);

  if (total <= 0) {
    return {};
  }

  return Object.fromEntries(rows.map((row) => [row.conditionId, round(row.probability / total, 6)]));
}

function getAverageSpread(marketBuckets) {
  return average((Array.isArray(marketBuckets) ? marketBuckets : [])
    .map((bucket) => bucket.spread)
    .filter((value) => typeof value === 'number'));
}

function getMarketBlendWeight({ dayPhase, marketBuckets, sourceFreshness }) {
  const buckets = Array.isArray(marketBuckets) ? marketBuckets : [];

  if (buckets.length === 0 || dayPhase === 'complete') {
    return 0;
  }

  const quotedCount = buckets.filter((bucket) => typeof getBucketMarketPrice(bucket) === 'number').length;
  const quoteCoverage = quotedCount / buckets.length;
  const averageSpread = getAverageSpread(buckets);
  const spreadQuality = typeof averageSpread === 'number' ? 1 - clamp(averageSpread / 0.12, 0, 1) : 0.55;
  const quality = clamp(0.7 * quoteCoverage + 0.3 * spreadQuality, 0, 1);
  let baseWeight;

  switch (dayPhase) {
    case 'future':
      baseWeight = 0.35;
      break;
    case 'morning':
      baseWeight = 0.28;
      break;
    case 'midday':
      baseWeight = 0.22;
      break;
    case 'late-afternoon':
      baseWeight = 0.16;
      break;
    case 'evening':
      baseWeight = 0.1;
      break;
    default:
      baseWeight = 0.2;
      break;
  }

  if (sourceFreshness?.isStale === true) {
    baseWeight += 0.12;
  }

  return round(clamp(baseWeight * quality, 0, 0.45), 4) ?? 0;
}

export function fuseBucketProbabilities(weatherProbabilities, marketProbabilities, marketBlendWeight) {
  const fused = {};
  const keys = new Set([
    ...Object.keys(weatherProbabilities ?? {}),
    ...Object.keys(marketProbabilities ?? {})
  ]);

  for (const key of keys) {
    const weatherProbability = weatherProbabilities?.[key] ?? 0;
    const marketProbability = marketProbabilities?.[key];
    const blendWeight = typeof marketProbability === 'number' ? marketBlendWeight : 0;
    fused[key] = round((1 - blendWeight) * weatherProbability + blendWeight * (marketProbability ?? 0), 6) ?? 0;
  }

  return fused;
}

function getModelUncertainty({ dayPhase, forecastDisagreement, observations, forecasts, settlement }) {
  if (settlement?.status === 'settled' && typeof settlement.maxTempF === 'number') {
    return 0.2;
  }

  let stdDev;

  switch (dayPhase) {
    case 'complete':
      stdDev = 0.7;
      break;
    case 'evening':
      stdDev = 0.9;
      break;
    case 'late-afternoon':
      stdDev = 1.25;
      break;
    case 'midday':
      stdDev = 1.9;
      break;
    case 'morning':
      stdDev = 2.6;
      break;
    case 'future':
      stdDev = 3.25;
      break;
    default:
      stdDev = 3.5;
      break;
  }

  if (typeof forecastDisagreement === 'number') {
    stdDev += Math.min(2, forecastDisagreement * 0.25);
  }

  if (observations.status === 'unavailable') {
    stdDev += 0.6;
  }

  if (forecasts.status !== 'ready') {
    stdDev += 1.1;
  }

  return round(clamp(stdDev, 0.35, 8), 2);
}

function buildSourceFreshness({ dayPhase, observations, forecasts, settlement }) {
  const liveWeatherStale = dayPhase !== 'future' && dayPhase !== 'complete' && observations.freshness?.isStale === true;
  const forecastStale = dayPhase !== 'complete' && forecasts.freshness?.isStale === true;
  const settlementStale = dayPhase === 'complete' && settlement.status !== 'settled';
  const staleReasons = [
    liveWeatherStale ? 'latest KMDW observation is stale for a live climate day' : null,
    forecastStale ? 'NWS forecast data appears stale or unavailable' : null,
    settlementStale ? 'CLIMDW settlement is not available for the completed climate day' : null
  ].filter(Boolean);

  return {
    isStale: staleReasons.length > 0,
    staleReasons,
    observations: observations.freshness ?? null,
    forecast: forecasts.freshness ?? null,
    settlement: {
      status: settlement.status,
      fetchedAt: settlement.fetchedAt ?? null,
      cliDate: settlement.cliDate ?? null
    }
  };
}

function buildTemperaturePrediction({ climateDayWindow, observations, forecasts, nbm, settlement, marketBuckets }) {
  const dayPhase = getChicagoDayPhase(climateDayWindow);
  const forecastValues = [
    forecasts.hourly.forecastMaxF,
    forecasts.grid.forecastMaxF,
    forecasts.hourly.remainingMaxF,
    forecasts.grid.remainingMaxF,
    nbm.features.forecast_max_nbm,
    nbm.features.nbm_p50
  ];
  const forecastHigh = average(forecastValues);
  const remainingForecastHigh = average([
    forecasts.hourly.remainingMaxF,
    forecasts.grid.remainingMaxF,
    nbm.features.forecast_max_nbm
  ]);
  const observedHighSoFar = observations.observedHighSoFar;
  const settlementHigh = settlement?.status === 'settled' && typeof settlement.maxTempF === 'number'
    ? settlement.maxTempF
    : null;
  const expectedHigh = settlementHigh
    ?? (typeof observedHighSoFar === 'number' && typeof remainingForecastHigh === 'number'
      ? Math.max(observedHighSoFar, remainingForecastHigh)
      : typeof observedHighSoFar === 'number' && dayPhase === 'complete'
        ? observedHighSoFar
        : typeof observedHighSoFar === 'number' && typeof forecastHigh === 'number'
          ? Math.max(observedHighSoFar, forecastHigh)
          : forecastHigh ?? observedHighSoFar ?? null);
  const forecastDisagreement = getForecastDisagreement([
    forecasts.hourly.forecastMaxF,
    forecasts.grid.forecastMaxF,
    nbm.features.forecast_max_nbm,
    nbm.features.nbm_p50
  ]);
  const stdDev = getModelUncertainty({
    dayPhase,
    forecastDisagreement,
    observations,
    forecasts,
    settlement
  });
  const sourceFreshness = buildSourceFreshness({
    dayPhase,
    observations,
    forecasts,
    settlement
  });
  const temperatureDistribution = buildIntegerDistribution({
    expectedHigh,
    stdDev,
    observedHighSoFar,
    settlement
  });
  const bucketProbabilities = Object.fromEntries(
    marketBuckets.map((bucket) => [
      bucket.conditionId,
      bucketProbability(temperatureDistribution, bucket.lowTemp, bucket.highTemp)
    ])
  );
  const marketImpliedBucketProbabilities = buildMarketImpliedBucketProbabilities(marketBuckets);
  const marketBlendWeight = getMarketBlendWeight({
    dayPhase,
    marketBuckets,
    sourceFreshness
  });
  const fusedBucketProbabilities = fuseBucketProbabilities(
    bucketProbabilities,
    marketImpliedBucketProbabilities,
    marketBlendWeight
  );
  const thresholdDiagnostics = buildThresholdDiagnostics({
    temperatureDistribution,
    bucketProbabilities: fusedBucketProbabilities,
    marketBuckets,
    expectedHigh
  });
  const confidence = typeof expectedHigh === 'number'
    ? clamp(0.82 - (stdDev / 12) - (sourceFreshness.isStale ? 0.12 : 0) + (marketBlendWeight * 0.08), 0.12, 0.96)
    : 0.08;

  return {
    modelVersion: 'chicago-kmdw-fused-distribution-v2',
    stationId: CHICAGO_STATION.stationId,
    targetDate: climateDayWindow.targetDate,
    predictionTime: new Date().toISOString(),
    dayPhase,
    expectedHigh: round(expectedHigh, 2),
    stdDev,
    confidence: round(confidence, 4),
    observedHighSoFar,
    forecastHigh: round(forecastHigh, 2),
    remainingForecastHigh: round(remainingForecastHigh, 2),
    forecastDisagreement: round(forecastDisagreement, 2),
    temperatureDistribution,
    weatherBucketProbabilities: bucketProbabilities,
    marketImpliedBucketProbabilities,
    fusedBucketProbabilities,
    bucketProbabilities: fusedBucketProbabilities,
    marketBlendWeight,
    thresholdDiagnostics,
    percentiles: {
      p10: getPercentile(temperatureDistribution, 0.1),
      p50: getPercentile(temperatureDistribution, 0.5),
      p90: getPercentile(temperatureDistribution, 0.9)
    },
    climateDayWindow,
    sourceFreshness,
    features: {
      forecast_max_nws_hourly: forecasts.features.forecast_max_nws_hourly,
      forecast_max_nws_grid: forecasts.features.forecast_max_nws_grid,
      forecast_max_nbm: nbm.features.forecast_max_nbm,
      nbm_p10: nbm.features.nbm_p10,
      nbm_p50: nbm.features.nbm_p50,
      nbm_p90: nbm.features.nbm_p90,
      current_temp_kmdw: observations.currentObservedTemp,
      observed_high_so_far: observations.observedHighSoFar,
      dew_point: observations.latestDewpointF ?? forecasts.features.dew_point,
      wind_speed: observations.latestWindSpeedMph ?? forecasts.features.wind_speed,
      wind_direction: observations.latestWindDirection ?? forecasts.features.wind_direction,
      cloud_cover: forecasts.features.cloud_cover,
      precip_probability: forecasts.features.precip_probability,
      pressure_trend: forecasts.features.pressure_trend,
      pressure_hpa: observations.latestPressureHpa,
      season_day_of_year: Math.ceil((Date.parse(`${climateDayWindow.targetDate}T00:00:00Z`) - Date.UTC(Number(climateDayWindow.targetDate.slice(0, 4)), 0, 0)) / 86400000),
      month: Number.parseInt(climateDayWindow.targetDate.slice(5, 7), 10),
      source_stale: sourceFreshness.isStale ? 1 : 0
    }
  };
}

function getLiquidityScore(value) {
  if (typeof value !== 'number' || value <= 0) {
    return 0.45;
  }

  return clamp(Math.log10(value + 1) / 4, 0, 1);
}

function getSpreadScore(value) {
  if (typeof value !== 'number') {
    return 0.55;
  }

  return 1 - clamp(value / 0.08, 0, 1);
}

function getTimingScore(dayPhase) {
  switch (dayPhase) {
    case 'late-afternoon':
    case 'evening':
      return 0.9;
    case 'midday':
      return 0.76;
    case 'morning':
      return 0.58;
    case 'future':
      return 0.4;
    case 'complete':
      return 0.25;
    default:
      return 0.45;
  }
}

function scoreRecommendation({ edge, confidence, spread, liquidity, askDepth, dayPhase }) {
  const expectedValueScore = clamp((edge ?? 0) / 0.14, 0, 1);
  const liquidityScore = Math.max(getLiquidityScore(liquidity), getLiquidityScore(askDepth));
  const modelAgreementScore = getSpreadScore(spread);
  const timingScore = getTimingScore(dayPhase);

  return round(
    0.45 * expectedValueScore
    + 0.2 * clamp(confidence ?? 0, 0, 1)
    + 0.15 * liquidityScore
    + 0.1 * modelAgreementScore
    + 0.1 * timingScore,
    4
  );
}

function fractionalKellyStake({ probability, price, bankroll = DEFAULT_RESEARCH_BANKROLL_USD }) {
  if (
    typeof probability !== 'number'
    || typeof price !== 'number'
    || probability <= price
    || price <= 0
    || price >= 1
  ) {
    return {
      kellyFraction: 0,
      suggestedSize: 0
    };
  }

  const fullKellyFraction = (probability - price) / (1 - price);
  const shrunkFraction = clamp(fullKellyFraction * FRACTIONAL_KELLY_SHRINK, 0, MAX_STAKE_FRACTION);

  return {
    kellyFraction: round(shrunkFraction, 4),
    suggestedSize: round(bankroll * shrunkFraction, 2)
  };
}

function estimateExecutionCost(bucket) {
  const spreadCost = typeof bucket?.spread === 'number'
    ? clamp(bucket.spread * 0.35, 0, 0.04)
    : 0.01;
  const depthPenalty = typeof bucket?.askDepth === 'number' && bucket.askDepth < 20 ? 0.01 : 0;
  const liquidityPenalty = typeof bucket?.liquidity === 'number' && bucket.liquidity < 100 ? 0.005 : 0;
  const total = spreadCost + depthPenalty + liquidityPenalty;

  return {
    totalCost: round(clamp(total, MIN_EXECUTION_COST, MAX_EXECUTION_COST), 4),
    spreadCost: round(spreadCost, 4),
    depthPenalty: round(depthPenalty, 4),
    liquidityPenalty: round(liquidityPenalty, 4),
    feeCost: 0
  };
}

function getRecommendationRefreshAgeMs(dayPhase) {
  switch (dayPhase) {
    case 'late-afternoon':
    case 'evening':
      return 60 * 1000;
    case 'future':
      return 15 * 60 * 1000;
    case 'complete':
      return 15 * 60 * 1000;
    default:
      return 3 * 60 * 1000;
  }
}

function getTimeToResolutionMs({ prediction, bucket }) {
  const resolutionAt = prediction?.climateDayWindow?.endExclusive ?? bucket?.endDate ?? null;
  const resolutionMs = Date.parse(String(resolutionAt ?? ''));

  if (!Number.isFinite(resolutionMs)) {
    return null;
  }

  return Math.max(0, resolutionMs - Date.now());
}

export function buildKmdwMarketDataPolicy(env = {}, options = {}) {
  const basePolicy = getPolymarketMarketDataPolicy(env);
  const dayPhase = options.dayPhase ?? options.prediction?.dayPhase ?? null;
  const snapshotPollIntervalMs = positiveIntegerMs(
    options.snapshotPollIntervalMs,
    getRecommendationRefreshAgeMs(dayPhase)
  );
  const streamingReason = 'Streaming KMDW market data is not implemented. KMDW weather markets use REST polling for the near-term plan.';

  return {
    ...basePolicy,
    policyId: KMDW_MARKET_DATA_POLICY_ID,
    parentPolicyId: basePolicy.policyId,
    scope: 'kmdw-weather-market-data',
    stationId: 'KMDW',
    transport: 'polling',
    mode: 'rest-polling',
    pollingEnabled: true,
    streamingEnabled: false,
    polling: {
      ...basePolicy.polling,
      kmdwSnapshotPollIntervalMs: snapshotPollIntervalMs,
      kmdwDefaultSnapshotPollIntervalMs: positiveIntegerMs(env.chicagoWeatherRefreshIntervalMs, 180000),
      kmdwHotSnapshotPollIntervalMs: positiveIntegerMs(env.chicagoWeatherHotRefreshIntervalMs, 60000),
      kmdwUpcomingSnapshotPollIntervalMs: positiveIntegerMs(env.chicagoWeatherUpcomingRefreshIntervalMs, 900000),
      kmdwSettledSnapshotPollIntervalMs: positiveIntegerMs(env.chicagoWeatherSettledRefreshIntervalMs, 900000)
    },
    streaming: {
      ...basePolicy.streaming,
      enabled: false,
      supported: false,
      websocketClient: false,
      reason: streamingReason
    },
    note: streamingReason
  };
}

function buildExecutionPlan({
  bucket,
  prediction,
  fairProbability,
  marketPrice,
  maxEntryPrice,
  sizing,
  passed,
  gates,
  marketDataPolicy
}) {
  const bestAsk = typeof bucket?.bestAsk === 'number' ? bucket.bestAsk : null;
  const bestBid = typeof bucket?.bestBid === 'number' ? bucket.bestBid : null;
  const referenceEntry = bestAsk ?? marketPrice ?? null;
  const limitPrice = typeof maxEntryPrice === 'number'
    ? round(Math.min(referenceEntry ?? maxEntryPrice, maxEntryPrice), 4)
    : null;
  const suggestedNotional = toNumberOrNull(sizing?.suggestedSize) ?? 0;
  const desiredContracts = typeof limitPrice === 'number' && limitPrice > 0 && suggestedNotional > 0
    ? suggestedNotional / limitPrice
    : 0;
  const askDepth = toNumberOrNull(bucket?.askDepth);
  const depthCoverage = typeof askDepth === 'number' && desiredContracts > 0
    ? askDepth / desiredContracts
    : null;
  const depthOk = depthCoverage === null || depthCoverage >= MIN_FILL_DEPTH_COVERAGE;
  const askAboveLimit = typeof bestAsk === 'number' && typeof limitPrice === 'number' && bestAsk > limitPrice;
  const failedGateNames = (Array.isArray(gates) ? gates : [])
    .filter((gate) => !gate.passed)
    .map((gate) => gate.name);
  const blockers = [
    passed ? null : `gate failed: ${failedGateNames.join(', ') || 'unknown'}`,
    typeof bestAsk === 'number' ? null : 'no firm ask quote',
    askAboveLimit ? 'ask is above limit' : null,
    depthOk ? null : 'ask depth below recommended size'
  ].filter(Boolean);
  const refreshAgeMs = getRecommendationRefreshAgeMs(prediction?.dayPhase);
  const generatedAt = new Date();
  const timeToResolutionMs = getTimeToResolutionMs({ prediction, bucket });
  const executable = blockers.length === 0;
  const resolvedMarketDataPolicy = marketDataPolicy ?? buildKmdwMarketDataPolicy({}, {
    dayPhase: prediction?.dayPhase,
    snapshotPollIntervalMs: refreshAgeMs
  });
  const positionLifecycle = buildKmdwPositionLifecycle({
    prediction,
    timeToResolutionMs,
    generatedAt: generatedAt.toISOString()
  });

  return {
    mode: 'live-routing',
    venue: 'polymarket-us',
    side: 'buy-yes',
    orderType: 'limit',
    executable,
    liveTradingAllowed: executable,
    canPaperSignal: passed === true,
    limitPrice,
    maxEntryPrice,
    referenceMarketPrice: marketPrice ?? null,
    fairProbability,
    suggestedNotional,
    desiredContracts: round(desiredContracts, 4),
    availableAskDepth: askDepth,
    depthCoverage: round(depthCoverage, 4),
    bestBid,
    bestAsk,
    spread: bucket?.spread ?? null,
    maxQuoteAgeMs: refreshAgeMs,
    marketDataPolicy: resolvedMarketDataPolicy,
    validUntil: new Date(generatedAt.getTime() + refreshAgeMs).toISOString(),
    timeToResolutionMs,
    positionLifecycle,
    urgency: prediction?.dayPhase === 'late-afternoon' || prediction?.dayPhase === 'evening'
      ? 'hot-window'
      : prediction?.dayPhase === 'future'
        ? 'upcoming'
        : 'base',
    blockers,
    instruction: executable
      ? 'Live route allowed from Probis after manual button confirmation; use a limit no higher than limitPrice.'
      : 'Do not route: refresh quote/source data and wait for all execution blockers to clear.'
  };
}

export function buildChicagoRecommendations(snapshot) {
  const prediction = snapshot?.prediction;
  const buckets = Array.isArray(snapshot?.markets?.buckets) ? snapshot.markets.buckets : [];
  const marketDataPolicy = snapshot?.marketDataPolicy ?? buildKmdwMarketDataPolicy({}, {
    dayPhase: prediction?.dayPhase
  });
  const sourceRiskHaircut = 0;

  if (!prediction || buckets.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      config: {
        minEdge: 0.06,
        maxSpread: 0.05,
        minConfidence: 0.55,
        minExecutionCost: MIN_EXECUTION_COST,
        maxExecutionCost: MAX_EXECUTION_COST,
        fractionalKellyShrink: FRACTIONAL_KELLY_SHRINK,
        maxStakeFraction: MAX_STAKE_FRACTION,
        researchBankroll: DEFAULT_RESEARCH_BANKROLL_USD,
        marketDataPolicy
      },
      recommendations: [],
      best: null
    };
  }

  const recommendations = buckets.map((bucket) => {
    const fairProbability = prediction.bucketProbabilities[bucket.conditionId] ?? 0;
    const marketPrice = typeof bucket.bestAsk === 'number'
      ? bucket.bestAsk
      : bucket.marketProbability;
    const edge = typeof marketPrice === 'number' ? fairProbability - marketPrice : null;
    const executionCost = estimateExecutionCost(bucket);
    const riskAdjustedEdge = typeof edge === 'number'
      ? edge - executionCost.totalCost - sourceRiskHaircut
      : null;
    const spreadOk = typeof bucket.spread === 'number' ? bucket.spread <= 0.05 : true;
    const edgeOk = typeof riskAdjustedEdge === 'number' && riskAdjustedEdge >= 0.06;
    const confidenceOk = prediction.confidence >= 0.55;
    const sourceFresh = prediction.sourceFreshness?.isStale !== true;
    const ruleOk = bucket.designatedSource?.verified === true
      || (bucket.ruleFlags?.hasKmdwSource === true && bucket.ruleFlags?.ruleAmbiguity !== true);
    const liquidityValue = bucket.askDepth ?? bucket.liquidity ?? null;
    const liquidityOk = typeof liquidityValue === 'number' ? liquidityValue >= 10 : true;
    const gates = [
      { name: 'edge >= 6pp', passed: edgeOk },
      { name: 'spread <= 5pp', passed: spreadOk },
      { name: 'fresh weather/market data', passed: sourceFresh },
      { name: 'sufficient liquidity/depth', passed: liquidityOk },
      { name: 'no KMDW/CLIMDW rule ambiguity', passed: ruleOk },
      { name: 'confidence >= 55%', passed: confidenceOk }
    ];
    const passed = gates.every((gate) => gate.passed);
    const score = scoreRecommendation({
      edge: riskAdjustedEdge,
      confidence: prediction.confidence,
      spread: bucket.spread,
      liquidity: bucket.liquidity,
      askDepth: bucket.askDepth,
      dayPhase: prediction.dayPhase
    });
    const maxEntryPrice = typeof fairProbability === 'number'
      ? round(Math.max(0.01, fairProbability - 0.06 - executionCost.totalCost - sourceRiskHaircut), 4)
      : null;
    const rawSizing = fractionalKellyStake({
      probability: fairProbability,
      price: marketPrice
    });
    const sizing = passed
      ? rawSizing
      : {
        kellyFraction: 0,
        suggestedSize: 0
      };
    const executionPlan = buildExecutionPlan({
      bucket,
      prediction,
      fairProbability,
      marketPrice,
      maxEntryPrice,
      sizing: rawSizing,
      passed,
      gates,
      marketDataPolicy
    });

    return {
      marketSlug: bucket.marketSlug,
      conditionId: bucket.conditionId,
      outcomeLabel: bucket.outcomeLabel,
      lowTemp: bucket.lowTemp,
      highTemp: bucket.highTemp,
      action: passed ? 'recommend-buy-yes' : 'watch',
      fairProbability,
      marketPrice,
      edge: round(edge, 6),
      riskAdjustedEdge: round(riskAdjustedEdge, 6),
      estimatedCost: executionCost.totalCost,
      costBreakdown: executionCost,
      sourceRiskHaircut,
      sourceVerification: bucket.designatedSource ?? null,
      evPerContract: round(riskAdjustedEdge, 6),
      maxEntryPrice,
      executionPlan,
      suggestedSize: sizing.suggestedSize,
      kellyFraction: sizing.kellyFraction,
      confidenceScore: prediction.confidence,
      liquidityScore: getLiquidityScore(bucket.askDepth ?? bucket.liquidity),
      timingScore: getTimingScore(prediction.dayPhase),
      score,
      gates,
      status: passed ? 'passed' : 'rejected',
      reason: passed
        ? `Fair ${Math.round(fairProbability * 100)}% vs entry ${Math.round(marketPrice * 100)}%.`
        : gates.filter((gate) => !gate.passed).map((gate) => gate.name).join('; ')
    };
  }).sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'passed' ? -1 : 1;
    }

    return (right.score ?? 0) - (left.score ?? 0);
  });

  return {
    generatedAt: new Date().toISOString(),
    config: {
      minEdge: 0.06,
      maxSpread: 0.05,
      minConfidence: 0.55,
      minExecutionCost: MIN_EXECUTION_COST,
      maxExecutionCost: MAX_EXECUTION_COST,
      sourceRiskHaircut,
      fractionalKellyShrink: FRACTIONAL_KELLY_SHRINK,
      maxStakeFraction: MAX_STAKE_FRACTION,
      researchBankroll: DEFAULT_RESEARCH_BANKROLL_USD,
      mode: 'live-routing',
      marketDataPolicy
    },
    recommendations,
    best: recommendations[0] ?? null
  };
}

function buildChicagoTradeSuggestion(recommendation) {
  const entryProbability = toNumberOrNull(recommendation?.marketPrice);
  const modelProbability = toNumberOrNull(recommendation?.fairProbability);
  const amount = Math.max(1, toNumberOrNull(recommendation?.suggestedSize) ?? 0);
  const stopLossProbability = typeof entryProbability === 'number'
    ? round(clamp(entryProbability - 0.08, 0.01, 0.97), 4)
    : 0.25;
  const takeProfitProbability = typeof entryProbability === 'number'
    ? round(clamp(entryProbability + 0.12, stopLossProbability + 0.01, 0.99), 4)
    : 0.75;
  const shares = typeof entryProbability === 'number' && entryProbability > 0
    ? amount / entryProbability
    : null;
  const profitIfCorrect = typeof shares === 'number' && typeof entryProbability === 'number'
    ? shares * (1 - entryProbability)
    : null;
  const stopLossLoss = typeof shares === 'number' && typeof entryProbability === 'number'
    ? shares * Math.max(0, entryProbability - stopLossProbability)
    : null;
  const takeProfitGain = typeof shares === 'number' && typeof entryProbability === 'number'
    ? shares * Math.max(0, takeProfitProbability - entryProbability)
    : null;
  const expectedProfit = typeof modelProbability === 'number'
    && typeof takeProfitGain === 'number'
    && typeof stopLossLoss === 'number'
    ? (modelProbability * takeProfitGain) - ((1 - modelProbability) * stopLossLoss)
    : null;

  return {
    amount: round(amount, 2),
    entryProbability,
    modelProbability,
    shares: round(shares, 4),
    profitIfCorrect: round(profitIfCorrect, 2),
    expectedProfit: round(expectedProfit, 2),
    stopLossProbability,
    takeProfitProbability,
    stopLossLoss: round(stopLossLoss, 2),
    takeProfitGain: round(takeProfitGain, 2),
    riskRewardRatio: typeof stopLossLoss === 'number' && stopLossLoss > 0 && typeof takeProfitGain === 'number'
      ? round(takeProfitGain / stopLossLoss, 2)
      : null,
    isRiskValid: true,
    bankrollHint: `${Math.round((amount / DEFAULT_RESEARCH_BANKROLL_USD) * 100)}% of research bankroll`
  };
}

export function buildChicagoTradeIntentPayload(snapshot, recommendation = snapshot?.recommendations?.best) {
  if (!snapshot?.targetDate || !recommendation) {
    throw new Error('A KMDW recommendation is required to create a trade draft.');
  }

  if (recommendation.action !== 'recommend-buy-yes' || recommendation.executionPlan?.executable !== true) {
    throw new Error('KMDW trade draft requires an executable paper signal.');
  }

  const bucket = (Array.isArray(snapshot?.markets?.buckets) ? snapshot.markets.buckets : [])
    .find((candidate) => candidate.conditionId === recommendation.conditionId) ?? {};
  const tradeSuggestion = buildChicagoTradeSuggestion(recommendation);
  const marketQuestion = recommendation.marketQuestion
    ?? bucket.marketQuestion
    ?? `KMDW high temperature on ${snapshot.targetDate}`;
  const marketDataPolicy = recommendation.executionPlan?.marketDataPolicy
    ?? snapshot?.marketDataPolicy
    ?? buildKmdwMarketDataPolicy({}, {
      prediction: snapshot?.prediction
    });

  return {
    status: 'draft',
    confirmedAt: null,
    weatherProvider: snapshot.provider ?? null,
    eventSlug: bucket.eventSlug ?? bucket.marketSlug ?? `kmdw-high-temp-${snapshot.targetDate}`,
    eventTitle: bucket.eventTitle ?? `KMDW High Temp ${snapshot.targetDate}`,
    input: bucket.eventSlug ?? bucket.marketSlug ?? `kmdw-high-temp-${snapshot.targetDate}`,
    marketSlug: recommendation.marketSlug ?? bucket.marketSlug ?? null,
    conditionId: recommendation.conditionId,
    marketQuestion,
    outcomeLabel: recommendation.outcomeLabel,
    action: recommendation.action,
    tradeAmount: tradeSuggestion.amount,
    recommendation: {
      ...recommendation,
      marketQuestion,
      currentProbability: recommendation.marketPrice,
      modelProbability: recommendation.fairProbability,
      combinedConfidence: recommendation.confidenceScore,
      thesis: `KMDW model fair ${Math.round((recommendation.fairProbability ?? 0) * 100)}% versus entry ${Math.round((recommendation.marketPrice ?? 0) * 100)}%.`,
      keyRisk: recommendation.executionPlan?.instruction ?? recommendation.reason,
      reasons: [
        recommendation.reason,
        recommendation.executionPlan?.instruction
      ].filter(Boolean)
    },
    tradeSuggestion,
    executionRequest: {
      ...recommendation.executionPlan,
      requestType: 'market-buy-intent',
      mode: 'live-routing',
      readyForExecution: false,
      preparedAt: new Date().toISOString(),
      weatherProvider: snapshot.provider ?? null,
      positionLifecycle: recommendation.executionPlan?.positionLifecycle ?? buildKmdwPositionLifecycle({
        prediction: snapshot?.prediction,
        targetDate: snapshot.targetDate
      }),
      marketDataPolicy,
      constraints: {
        requiresManualSubmission: false,
        credentialsConfigured: true,
        liveTradingAllowed: true,
        automatedExecutionAllowed: true,
        liveReduceAllowed: true,
        liveFlattenAllowed: true,
        automatedExitAllowed: true,
        kmdwPaperManualOnly: false,
        liveRoutingBlocked: false,
        venueOrderSubmissionAllowed: true,
        manualReviewRequired: false,
        pollingMarketDataRequired: true,
        streamingMarketDataAllowed: false,
        sourceVerified: recommendation.sourceVerification?.verified === true,
        sourceAuditRequired: true,
        weatherProviderId: snapshot.provider?.id ?? KMDW_WEATHER_PROVIDER.id,
        positionLifecyclePolicyId: recommendation.executionPlan?.positionLifecycle?.policyId ?? KMDW_POSITION_LIFECYCLE_POLICY_ID,
        marketDataPolicyId: marketDataPolicy.policyId,
        marketDataTransport: marketDataPolicy.transport,
        maxEntryPrice: recommendation.maxEntryPrice ?? null,
        limitPrice: recommendation.executionPlan?.limitPrice ?? null
      }
    },
    monitoring: null,
    analysis: 'Generated from the KMDW weather tracker as a live-routable signal.',
    generatedAt: new Date().toISOString()
  };
}

export const KMDW_WEATHER_PROVIDER = registerWeatherProvider(createWeatherProvider({
  id: 'kmdw-nws-climdw',
  name: 'KMDW NWS/CLIMDW Weather Provider',
  scope: 'kmdw-weather',
  station: CHICAGO_STATION,
  dataSources: [
    'nws-station-observations',
    'nws-api-forecast',
    'nws-climdw',
    'noaa-nbm-optional',
    'polymarket-us-kmdw-markets'
  ],
  capabilities: {
    climateDayWindow: 'central-standard-time',
    settlementSource: 'nws-climdw',
    observationSource: 'nws-station-observations',
    forecastSource: 'nws-api',
    modelForecastSource: 'noaa-nbm-optional',
    marketSource: 'polymarket-us-search-clob'
  },
  getTargetDate(date) {
    return normalizeDateString(date);
  },
  getClimateDayWindow(targetDate) {
    return getChicagoClimateDayWindow(targetDate);
  },
  fetchSettlement(env, { targetDate }) {
    return fetchClimdwSettlement(env, targetDate);
  },
  fetchObservations(env, { climateDayWindow }) {
    return fetchKmdwObservations(env, climateDayWindow);
  },
  async fetchForecasts(env, { climateDayWindow, force }) {
    try {
      return await fetchNwsForecastsCached(env, climateDayWindow, { force });
    } catch (error) {
      return buildUnavailableNwsForecastResult(env, error);
    }
  },
  fetchModelForecast(env) {
    return fetchNbmForecast(env);
  },
  fetchMarkets(env, { targetDate }) {
    return fetchChicagoMarketBuckets(env, targetDate);
  }
}));

export async function buildChicagoSnapshot(env, options = {}) {
  const weatherProvider = resolveWeatherProvider(env, options);
  const {
    provider,
    targetDate,
    climateDayWindow,
    settlement,
    observations,
    forecasts: forecastResult,
    modelForecast: nbm,
    markets
  } = await fetchWeatherProviderSnapshotInputs(weatherProvider, env, options);
  const prediction = buildTemperaturePrediction({
    climateDayWindow,
    observations,
    forecasts: forecastResult,
    nbm,
    settlement,
    marketBuckets: markets.buckets
  });
  const marketDataPolicy = buildKmdwMarketDataPolicy(env, {
    dayPhase: prediction.dayPhase
  });
  const recommendations = buildChicagoRecommendations({
    prediction,
    markets,
    marketDataPolicy
  });

  return {
    generatedAt: new Date().toISOString(),
    provider,
    station: provider.station ?? CHICAGO_STATION,
    targetDate,
    climateDayWindow,
    settlement: {
      ...settlement,
      rawText: undefined
    },
    observations,
    forecasts: forecastResult,
    nbm,
    markets,
    marketDataPolicy,
    prediction,
    recommendations
  };
}

export async function getChicagoSettlement(env, options = {}) {
  const weatherProvider = resolveWeatherProvider(env, options);
  const targetDate = weatherProvider.getTargetDate(options.date);
  const climateDayWindow = weatherProvider.getClimateDayWindow(targetDate);
  return weatherProvider.fetchSettlement(env, {
    ...options,
    targetDate,
    climateDayWindow
  });
}
