import axios from 'axios';

const NWS_BASE_URL = 'https://api.weather.gov';
const OPEN_METEO_BASE_URL = 'https://api.open-meteo.com';
const OPEN_METEO_ARCHIVE_BASE_URL = 'https://archive-api.open-meteo.com';
const WEATHER_TIMEOUT_MS = 4500;
const DEFAULT_TIMEZONE = 'America/Chicago';
const HIGH_TEMP_METRIC = 'highest-temperature';
const HISTORICAL_LOOKBACK_YEARS = 10;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function average(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function celsiusToFahrenheit(value) {
  return typeof value === 'number' ? (value * 9 / 5) + 32 : null;
}

function convertTemperature(value, unit) {
  const numeric = toNumberOrNull(value);

  if (typeof numeric !== 'number') {
    return null;
  }

  return String(unit ?? '').toUpperCase() === 'C' ? celsiusToFahrenheit(numeric) : numeric;
}

function createNwsClient(env) {
  return axios.create({
    baseURL: NWS_BASE_URL,
    timeout: WEATHER_TIMEOUT_MS,
    headers: {
      Accept: 'application/geo+json, application/json',
      'User-Agent': env.weatherUserAgent ?? 'probis-weather-edge/0.1'
    }
  });
}

function createOpenMeteoClient() {
  return axios.create({
    baseURL: OPEN_METEO_BASE_URL,
    timeout: WEATHER_TIMEOUT_MS,
    headers: {
      Accept: 'application/json'
    }
  });
}

function createOpenMeteoArchiveClient() {
  return axios.create({
    baseURL: OPEN_METEO_ARCHIVE_BASE_URL,
    timeout: WEATHER_TIMEOUT_MS,
    headers: {
      Accept: 'application/json'
    }
  });
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

function getDateStringInTimeZone(date, timeZone) {
  const parts = getPartsInTimeZone(date, timeZone);
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getPartsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(dateString, timeZone, hour = 0, minute = 0, second = 0) {
  const match = String(dateString ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = new Date(localAsUtcMs - getTimeZoneOffsetMs(new Date(localAsUtcMs), timeZone));

  for (let index = 0; index < 2; index += 1) {
    candidate = new Date(localAsUtcMs - getTimeZoneOffsetMs(candidate, timeZone));
  }

  return candidate;
}

function getTargetDayBounds(targetDate, timeZone) {
  const start = zonedDateTimeToUtc(targetDate, timeZone, 0, 0, 0);
  const end = zonedDateTimeToUtc(targetDate, timeZone, 23, 59, 59);

  if (!start || !end) {
    return null;
  }

  return { start, end };
}

function shiftYear(dateString, deltaYears) {
  const match = String(dateString ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10) + deltaYears;
  const monthIndex = Number.parseInt(match[2], 10) - 1;
  const day = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, monthIndex, day));

  if (date.getUTCMonth() !== monthIndex) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compareDateStrings(left, right) {
  if (!left || !right || left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function getDayPhase(targetDate, timeZone) {
  const now = new Date();
  const today = getDateStringInTimeZone(now, timeZone);
  const comparison = compareDateStrings(targetDate, today);

  if (comparison > 0) {
    return 'future';
  }

  if (comparison < 0) {
    return 'past';
  }

  const localHour = getPartsInTimeZone(now, timeZone).hour;

  if (localHour < 11) {
    return 'morning';
  }

  if (localHour < 15) {
    return 'midday';
  }

  if (localHour < 19) {
    return 'late-afternoon';
  }

  return 'evening';
}

function normalizeStationMetadata(payload, stationCode) {
  const properties = payload?.properties ?? {};
  const coordinates = Array.isArray(payload?.geometry?.coordinates) ? payload.geometry.coordinates : [];
  const longitude = toNumberOrNull(coordinates[0]);
  const latitude = toNumberOrNull(coordinates[1]);

  return {
    stationId: stationCode,
    stationName: properties.name ?? null,
    timezone: properties.timeZone ?? DEFAULT_TIMEZONE,
    latitude,
    longitude
  };
}

async function fetchStationMetadata(env, stationCode) {
  const client = createNwsClient(env);
  const response = await client.get(`/stations/${encodeURIComponent(stationCode)}`);
  return normalizeStationMetadata(response.data, stationCode);
}

async function fetchNwsObservations(env, stationCode, targetDate, timezone) {
  const bounds = getTargetDayBounds(targetDate, timezone);

  if (!bounds) {
    return {
      currentObservedTemp: null,
      observedHighSoFar: null,
      observationCount: 0,
      latestObservationAt: null
    };
  }

  const now = new Date();
  const end = new Date(Math.min(now.getTime(), bounds.end.getTime()));

  if (end.getTime() < bounds.start.getTime()) {
    return {
      currentObservedTemp: null,
      observedHighSoFar: null,
      observationCount: 0,
      latestObservationAt: null
    };
  }

  const client = createNwsClient(env);
  const response = await client.get(`/stations/${encodeURIComponent(stationCode)}/observations`, {
    params: {
      start: bounds.start.toISOString(),
      end: end.toISOString(),
      limit: 500
    }
  });
  const observations = (Array.isArray(response.data?.features) ? response.data.features : [])
    .map((feature) => {
      const properties = feature?.properties ?? {};
      const timestamp = properties.timestamp;
      const tempF = celsiusToFahrenheit(toNumberOrNull(properties.temperature?.value));

      return {
        timestamp,
        timestampMs: Date.parse(String(timestamp ?? '')),
        temperatureF: tempF,
        relativeHumidity: toNumberOrNull(properties.relativeHumidity?.value),
        windSpeedMps: toNumberOrNull(properties.windSpeed?.value),
        dewPointF: celsiusToFahrenheit(toNumberOrNull(properties.dewpoint?.value)),
        pressurePa: toNumberOrNull(properties.barometricPressure?.value)
      };
    })
    .filter((observation) => Number.isFinite(observation.timestampMs) && typeof observation.temperatureF === 'number')
    .filter((observation) => getDateStringInTimeZone(new Date(observation.timestampMs), timezone) === targetDate)
    .sort((left, right) => left.timestampMs - right.timestampMs);

  const latest = observations.at(-1) ?? null;
  const observedHighSoFar = observations.length > 0
    ? Math.max(...observations.map((observation) => observation.temperatureF))
    : null;

  return {
    currentObservedTemp: latest?.temperatureF ?? null,
    observedHighSoFar,
    observationCount: observations.length,
    latestObservationAt: latest?.timestamp ?? null,
    humidity: latest?.relativeHumidity ?? null,
    windSpeedMps: latest?.windSpeedMps ?? null,
    dewPointF: latest?.dewPointF ?? null,
    pressurePa: latest?.pressurePa ?? null
  };
}

async function fetchNwsHourlyForecast(env, latitude, longitude, targetDate, timezone) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return {
      forecastHigh: null,
      remainingForecastHigh: null,
      remainingPeriodCount: 0,
      forecastPeriodCount: 0
    };
  }

  const client = createNwsClient(env);
  const pointsResponse = await client.get(`/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`);
  const forecastHourlyUrl = pointsResponse.data?.properties?.forecastHourly;

  if (!forecastHourlyUrl) {
    return {
      forecastHigh: null,
      remainingForecastHigh: null,
      remainingPeriodCount: 0,
      forecastPeriodCount: 0
    };
  }

  const forecastResponse = await axios.get(forecastHourlyUrl, {
    timeout: WEATHER_TIMEOUT_MS,
    headers: {
      Accept: 'application/geo+json, application/json',
      'User-Agent': env.weatherUserAgent ?? 'probis-weather-edge/0.1'
    }
  });
  const now = new Date();
  const periods = (Array.isArray(forecastResponse.data?.properties?.periods)
    ? forecastResponse.data.properties.periods
    : [])
    .map((period) => {
      const startTime = period.startTime;
      const startMs = Date.parse(String(startTime ?? ''));

      return {
        startTime,
        startMs,
        temperatureF: convertTemperature(period.temperature, period.temperatureUnit),
        windSpeedText: period.windSpeed ?? null,
        shortForecast: period.shortForecast ?? null
      };
    })
    .filter((period) => Number.isFinite(period.startMs) && typeof period.temperatureF === 'number')
    .filter((period) => getDateStringInTimeZone(new Date(period.startMs), timezone) === targetDate);
  const remaining = periods.filter((period) => period.startMs >= now.getTime());
  const allTemperatures = periods.map((period) => period.temperatureF);
  const remainingTemperatures = remaining.map((period) => period.temperatureF);

  return {
    forecastHigh: allTemperatures.length > 0 ? Math.max(...allTemperatures) : null,
    remainingForecastHigh: remainingTemperatures.length > 0 ? Math.max(...remainingTemperatures) : null,
    remainingPeriodCount: remaining.length,
    forecastPeriodCount: periods.length,
    nextForecastAt: remaining[0]?.startTime ?? null,
    nextForecastTemp: remaining[0]?.temperatureF ?? null,
    shortForecast: remaining[0]?.shortForecast ?? periods[0]?.shortForecast ?? null,
    windSpeedText: remaining[0]?.windSpeedText ?? periods[0]?.windSpeedText ?? null
  };
}

function getOpenMeteoHourlyValues(payload, index) {
  const hourly = payload?.hourly ?? {};

  return {
    temperatureF: toNumberOrNull(hourly.temperature_2m?.[index]),
    humidity: toNumberOrNull(hourly.relative_humidity_2m?.[index]),
    dewPointF: toNumberOrNull(hourly.dew_point_2m?.[index]),
    precipitationChance: toNumberOrNull(hourly.precipitation_probability?.[index]),
    cloudCover: toNumberOrNull(hourly.cloud_cover?.[index]),
    windSpeedMph: toNumberOrNull(hourly.wind_speed_10m?.[index]),
    pressureHpa: toNumberOrNull(hourly.surface_pressure?.[index])
  };
}

async function fetchOpenMeteoForecast(latitude, longitude, targetDate, timezone) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return {
      forecastHigh: null,
      remainingForecastHigh: null,
      hourlyCount: 0,
      remainingHourlyCount: 0
    };
  }

  const client = createOpenMeteoClient();
  const response = await client.get('/v1/forecast', {
    params: {
      latitude,
      longitude,
      hourly: [
        'temperature_2m',
        'relative_humidity_2m',
        'dew_point_2m',
        'precipitation_probability',
        'cloud_cover',
        'wind_speed_10m',
        'surface_pressure'
      ].join(','),
      daily: 'temperature_2m_max',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      timezone: 'auto',
      forecast_days: 16
    }
  });
  const hourlyTimes = Array.isArray(response.data?.hourly?.time) ? response.data.hourly.time : [];
  const now = new Date();
  const today = getDateStringInTimeZone(now, timezone);
  const localHour = getPartsInTimeZone(now, timezone).hour;
  const hourly = hourlyTimes
    .map((time, index) => {
      const values = getOpenMeteoHourlyValues(response.data, index);
      const hourMatch = String(time).match(/T(\d{2}):/);
      const localForecastHour = hourMatch ? Number.parseInt(hourMatch[1], 10) : null;

      return {
        time,
        targetDate: String(time).slice(0, 10),
        localForecastHour,
        ...values
      };
    })
    .filter((point) => point.targetDate === targetDate && typeof point.temperatureF === 'number');
  const remaining = hourly.filter((point) => {
    if (targetDate > today) {
      return true;
    }

    if (targetDate < today) {
      return false;
    }

    return typeof point.localForecastHour === 'number' && point.localForecastHour >= localHour;
  });
  const dailyTimes = Array.isArray(response.data?.daily?.time) ? response.data.daily.time : [];
  const dailyIndex = dailyTimes.findIndex((time) => time === targetDate);
  const dailyHigh = dailyIndex !== -1
    ? toNumberOrNull(response.data?.daily?.temperature_2m_max?.[dailyIndex])
    : null;
  const latestRemaining = remaining[0] ?? hourly[0] ?? null;

  return {
    forecastHigh: dailyHigh ?? (hourly.length > 0 ? Math.max(...hourly.map((point) => point.temperatureF)) : null),
    remainingForecastHigh: remaining.length > 0 ? Math.max(...remaining.map((point) => point.temperatureF)) : null,
    hourlyCount: hourly.length,
    remainingHourlyCount: remaining.length,
    humidity: latestRemaining?.humidity ?? null,
    dewPointF: latestRemaining?.dewPointF ?? null,
    precipitationChance: latestRemaining?.precipitationChance ?? null,
    cloudCover: latestRemaining?.cloudCover ?? null,
    windSpeedMph: latestRemaining?.windSpeedMph ?? null,
    pressureHpa: latestRemaining?.pressureHpa ?? null
  };
}

function getOpenMeteoArchiveRows(payload) {
  const times = Array.isArray(payload?.daily?.time) ? payload.daily.time : [];
  const highs = Array.isArray(payload?.daily?.temperature_2m_max) ? payload.daily.temperature_2m_max : [];

  return times
    .map((date, index) => ({
      date,
      tmax: toNumberOrNull(highs[index])
    }))
    .filter((row) => row.date && typeof row.tmax === 'number');
}

async function fetchOpenMeteoArchiveDaily(latitude, longitude, start, end, timezone) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !start || !end) {
    return {
      rows: [],
      metadata: null
    };
  }

  const client = createOpenMeteoArchiveClient();
  const response = await client.get('/v1/archive', {
    params: {
      latitude,
      longitude,
      start_date: start,
      end_date: end,
      daily: 'temperature_2m_max',
      temperature_unit: 'fahrenheit',
      timezone: timezone ?? 'auto'
    }
  });

  return {
    rows: getOpenMeteoArchiveRows(response.data),
    metadata: {
      latitude: toNumberOrNull(response.data?.latitude),
      longitude: toNumberOrNull(response.data?.longitude),
      elevation: toNumberOrNull(response.data?.elevation),
      timezone: response.data?.timezone ?? null
    }
  };
}

async function fetchOpenMeteoHistoricalContext({ latitude, longitude, targetDate, timezone }) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return {
      available: false,
      historicalHighForSameDay: null,
      recentStationBias: null,
      sampleCount: 0,
      source: 'open-meteo-archive-coordinates-unavailable'
    };
  }

  const start = shiftYear(targetDate, -HISTORICAL_LOOKBACK_YEARS);
  const end = shiftYear(targetDate, -1);
  const monthDay = String(targetDate).slice(5);
  const historical = await fetchOpenMeteoArchiveDaily(latitude, longitude, start, end, timezone);
  const historicalRows = historical.rows;
  const sameDayRows = historicalRows.filter((row) => String(row.date).slice(5) === monthDay);
  const historicalHighForSameDay = average(sameDayRows.map((row) => row.tmax));
  const yesterday = addDays(getDateStringInTimeZone(new Date(), timezone ?? DEFAULT_TIMEZONE), -1);
  const targetPreviousDay = addDays(targetDate, -1);
  const recentEnd = compareDateStrings(targetPreviousDay, yesterday) <= 0 ? targetPreviousDay : yesterday;
  const recentStart = addDays(recentEnd, -30);
  const recent = await fetchOpenMeteoArchiveDaily(latitude, longitude, recentStart, recentEnd, timezone);
  const recentRows = recent.rows;
  const recentAverageHigh = average(recentRows.map((row) => row.tmax));
  const samePeriodHistoricalRows = historicalRows.filter((row) => {
    const day = String(row.date).slice(5);
    return day >= String(recentStart).slice(5) && day <= String(recentEnd).slice(5);
  });
  const samePeriodHistoricalAverageHigh = average(samePeriodHistoricalRows.map((row) => row.tmax));
  const recentStationBias = typeof recentAverageHigh === 'number' && typeof samePeriodHistoricalAverageHigh === 'number'
    ? recentAverageHigh - samePeriodHistoricalAverageHigh
    : null;

  return {
    available: historicalRows.length > 0 || recentRows.length > 0,
    historicalHighForSameDay,
    recentStationBias,
    recentAverageHigh,
    samePeriodHistoricalAverageHigh,
    sampleCount: sameDayRows.length,
    recentSampleCount: recentRows.length,
    gridLatitude: historical.metadata?.latitude ?? recent.metadata?.latitude ?? null,
    gridLongitude: historical.metadata?.longitude ?? recent.metadata?.longitude ?? null,
    gridElevation: historical.metadata?.elevation ?? recent.metadata?.elevation ?? null,
    source: 'open-meteo-archive'
  };
}

function resolveExpectedHigh({ observations, nwsForecast, openMeteoForecast, historicalContext, dayPhase }) {
  const forecastHigh = average([
    nwsForecast.forecastHigh,
    openMeteoForecast.forecastHigh,
    nwsForecast.remainingForecastHigh,
    openMeteoForecast.remainingForecastHigh
  ]);
  const remainingHigh = average([
    nwsForecast.remainingForecastHigh,
    openMeteoForecast.remainingForecastHigh
  ]);
  const observedHighSoFar = observations.observedHighSoFar;
  const historicalAnchor = typeof historicalContext?.historicalHighForSameDay === 'number'
    ? historicalContext.historicalHighForSameDay + (historicalContext.recentStationBias ?? 0)
    : null;

  if (dayPhase === 'past' || dayPhase === 'evening') {
    return typeof observedHighSoFar === 'number'
      ? observedHighSoFar
      : forecastHigh;
  }

  if (dayPhase === 'morning' || dayPhase === 'future') {
    const anchoredForecast = average([
      ...(typeof forecastHigh === 'number' ? [forecastHigh, forecastHigh, forecastHigh] : []),
      ...(typeof historicalAnchor === 'number' ? [historicalAnchor] : [])
    ]);

    if (typeof anchoredForecast === 'number') {
      return typeof observedHighSoFar === 'number'
        ? Math.max(observedHighSoFar, anchoredForecast)
        : anchoredForecast;
    }
  }

  if (typeof observedHighSoFar === 'number' && typeof remainingHigh === 'number') {
    return Math.max(observedHighSoFar, remainingHigh);
  }

  if (typeof observedHighSoFar === 'number' && typeof forecastHigh === 'number') {
    return Math.max(observedHighSoFar, forecastHigh);
  }

  return forecastHigh ?? observedHighSoFar ?? null;
}

function resolveModelStdDev({ dayPhase, forecastDisagreement, hasObservations, hasForecast, historicalSampleCount }) {
  let stdDev;

  switch (dayPhase) {
    case 'past':
      stdDev = 0.45;
      break;
    case 'evening':
      stdDev = 0.65;
      break;
    case 'late-afternoon':
      stdDev = 1.1;
      break;
    case 'midday':
      stdDev = 1.8;
      break;
    case 'morning':
      stdDev = 2.6;
      break;
    default:
      stdDev = 3.5;
      break;
  }

  if (typeof forecastDisagreement === 'number') {
    stdDev += Math.min(2, forecastDisagreement * 0.35);
  }

  if (!hasObservations) {
    stdDev += 0.55;
  }

  if (!hasForecast) {
    stdDev += 1.25;
  }

  if (historicalSampleCount >= 5) {
    stdDev -= 0.25;
  }

  return Number(clamp(stdDev, 0.35, 7).toFixed(2));
}

function resolveSourceRiskBuffer({ stationCode, targetDate, resolutionSourceUrl, observations, hasForecast, sourceErrors }) {
  let buffer = 0.02;

  if (!stationCode || !targetDate || !resolutionSourceUrl) {
    buffer += 0.04;
  }

  if (!observations || observations.observationCount === 0) {
    buffer += 0.015;
  }

  if (!hasForecast) {
    buffer += 0.02;
  }

  if (sourceErrors.length > 0) {
    buffer += Math.min(0.03, sourceErrors.length * 0.01);
  }

  return Number(clamp(buffer, 0.02, 0.12).toFixed(4));
}

async function tryFetch(label, fn, sourceErrors) {
  try {
    return await fn();
  } catch (error) {
    sourceErrors.push({
      source: label,
      error: error instanceof Error ? error.message : 'Weather source request failed'
    });
    return null;
  }
}

async function buildWeatherSnapshot(env, weatherMarket) {
  const sourceErrors = [];
  const stationCode = String(weatherMarket?.stationCode ?? '').trim().toUpperCase();
  const targetDate = weatherMarket?.targetDate ?? null;

  if (weatherMarket?.metric !== HIGH_TEMP_METRIC || !stationCode || !targetDate) {
    return {
      conditionId: weatherMarket?.conditionId ?? null,
      status: 'insufficient-rules',
      generatedAt: new Date().toISOString(),
      metric: weatherMarket?.metric ?? null,
      stationId: stationCode || null,
      targetDate,
      sourceErrors: [{
        source: 'rules-parser',
        error: 'Highest-temperature modeling requires a station code and target date parsed from the market rules.'
      }],
      model: null
    };
  }

  const stationMetadata = await tryFetch(
    'nws-station',
    () => fetchStationMetadata(env, stationCode),
    sourceErrors
  ) ?? {
    stationId: stationCode,
    stationName: weatherMarket.stationName ?? null,
    timezone: DEFAULT_TIMEZONE,
    latitude: null,
    longitude: null
  };
  const timezone = stationMetadata.timezone ?? DEFAULT_TIMEZONE;
  const [observations, nwsForecast, openMeteoForecast, historicalContext] = await Promise.all([
    tryFetch('nws-observations', () => fetchNwsObservations(env, stationCode, targetDate, timezone), sourceErrors),
    tryFetch(
      'nws-hourly-forecast',
      () => fetchNwsHourlyForecast(env, stationMetadata.latitude, stationMetadata.longitude, targetDate, timezone),
      sourceErrors
    ),
    tryFetch(
      'open-meteo-forecast',
      () => fetchOpenMeteoForecast(stationMetadata.latitude, stationMetadata.longitude, targetDate, timezone),
      sourceErrors
    ),
    tryFetch(
      'open-meteo-archive-history',
      () => fetchOpenMeteoHistoricalContext({
        latitude: stationMetadata.latitude,
        longitude: stationMetadata.longitude,
        targetDate,
        timezone
      }),
      sourceErrors
    )
  ]);
  const normalizedObservations = observations ?? {
    currentObservedTemp: null,
    observedHighSoFar: null,
    observationCount: 0,
    latestObservationAt: null
  };
  const normalizedNwsForecast = nwsForecast ?? {
    forecastHigh: null,
    remainingForecastHigh: null,
    remainingPeriodCount: 0,
    forecastPeriodCount: 0
  };
  const normalizedOpenMeteoForecast = openMeteoForecast ?? {
    forecastHigh: null,
    remainingForecastHigh: null,
    hourlyCount: 0,
    remainingHourlyCount: 0
  };
  const dayPhase = getDayPhase(targetDate, timezone);
  const forecastHighs = [
    normalizedNwsForecast.forecastHigh,
    normalizedOpenMeteoForecast.forecastHigh
  ].filter((value) => typeof value === 'number');
  const forecastDisagreement = forecastHighs.length >= 2
    ? Math.abs(forecastHighs[0] - forecastHighs[1])
    : null;
  const hasForecast = forecastHighs.length > 0
    || typeof normalizedNwsForecast.remainingForecastHigh === 'number'
    || typeof normalizedOpenMeteoForecast.remainingForecastHigh === 'number';
  const expectedHigh = resolveExpectedHigh({
    observations: normalizedObservations,
    nwsForecast: normalizedNwsForecast,
    openMeteoForecast: normalizedOpenMeteoForecast,
    historicalContext,
    dayPhase
  });
  const stdDev = resolveModelStdDev({
    dayPhase,
    forecastDisagreement,
    hasObservations: normalizedObservations.observationCount > 0,
    hasForecast,
    historicalSampleCount: historicalContext?.sampleCount ?? 0
  });
  const sourceRiskBuffer = resolveSourceRiskBuffer({
    stationCode,
    targetDate,
    resolutionSourceUrl: weatherMarket.resolutionSourceUrl,
    observations: normalizedObservations,
    hasForecast,
    sourceErrors
  });
  const confidence = typeof expectedHigh === 'number'
    ? clamp(0.72 - (stdDev / 12) - sourceRiskBuffer, 0.15, 0.92)
    : 0.08;

  return {
    conditionId: weatherMarket.conditionId,
    status: typeof expectedHigh === 'number' ? 'ready' : 'degraded',
    generatedAt: new Date().toISOString(),
    metric: weatherMarket.metric,
    stationId: stationCode,
    stationName: stationMetadata.stationName ?? weatherMarket.stationName ?? null,
    latitude: stationMetadata.latitude,
    longitude: stationMetadata.longitude,
    timezone,
    targetDate,
    targetDateLabel: weatherMarket.targetDateLabel ?? null,
    resolutionSourceName: weatherMarket.resolutionSourceName ?? null,
    resolutionSourceUrl: weatherMarket.resolutionSourceUrl ?? null,
    currentObservedTemp: normalizedObservations.currentObservedTemp,
    observedHighSoFar: normalizedObservations.observedHighSoFar,
    latestObservationAt: normalizedObservations.latestObservationAt,
    observationCount: normalizedObservations.observationCount,
    nwsForecastHigh: normalizedNwsForecast.forecastHigh,
    nwsRemainingForecastHigh: normalizedNwsForecast.remainingForecastHigh,
    nwsRemainingPeriodCount: normalizedNwsForecast.remainingPeriodCount,
    openMeteoForecastHigh: normalizedOpenMeteoForecast.forecastHigh,
    openMeteoRemainingForecastHigh: normalizedOpenMeteoForecast.remainingForecastHigh,
    openMeteoRemainingHourlyCount: normalizedOpenMeteoForecast.remainingHourlyCount,
    humidity: normalizedObservations.humidity ?? normalizedOpenMeteoForecast.humidity ?? null,
    windSpeedMph: normalizedOpenMeteoForecast.windSpeedMph ?? null,
    cloudCover: normalizedOpenMeteoForecast.cloudCover ?? null,
    dewPointF: normalizedObservations.dewPointF ?? normalizedOpenMeteoForecast.dewPointF ?? null,
    pressureHpa: normalizedOpenMeteoForecast.pressureHpa ?? null,
    precipitationChance: normalizedOpenMeteoForecast.precipitationChance ?? null,
    historicalHighForSameDay: historicalContext?.historicalHighForSameDay ?? null,
    recentStationBias: historicalContext?.recentStationBias ?? null,
    historicalDataSource: historicalContext?.source ?? null,
    historicalSampleCount: historicalContext?.sampleCount ?? 0,
    historicalGridLatitude: historicalContext?.gridLatitude ?? null,
    historicalGridLongitude: historicalContext?.gridLongitude ?? null,
    historicalGridElevation: historicalContext?.gridElevation ?? null,
    shortForecast: normalizedNwsForecast.shortForecast ?? null,
    sourceErrors,
    model: {
      name: 'station-high-temp-ensemble-v1',
      dayPhase,
      expectedHigh: typeof expectedHigh === 'number' ? Number(expectedHigh.toFixed(2)) : null,
      stdDev,
      forecastDisagreement,
      sourceRiskBuffer,
      historicalHighForSameDay: historicalContext?.historicalHighForSameDay ?? null,
      recentStationBias: historicalContext?.recentStationBias ?? null,
      historicalSampleCount: historicalContext?.sampleCount ?? 0,
      confidence: Number(confidence.toFixed(4)),
      formula: 'final_high=max(observed_high_so_far,predicted_future_hourly_max)'
    }
  };
}

export async function buildWeatherSnapshots(env, weatherContext) {
  const markets = (Array.isArray(weatherContext?.markets) ? weatherContext.markets : [])
    .filter((market) => market?.metric === HIGH_TEMP_METRIC);

  if (markets.length === 0) {
    return [];
  }

  const snapshots = await Promise.all(markets.map((market) => buildWeatherSnapshot(env, market)));
  return snapshots;
}
