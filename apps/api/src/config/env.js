import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '../../../../');
const envFileName = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';

dotenv.config({ path: path.join(repoRoot, envFileName) });

const requiredKeys = ['POLYMARKET_US_KEY_ID', 'POLYMARKET_US_SECRET_KEY'];

export function getEnv() {
  const weatherMlModelPath = process.env.WEATHER_ML_MODEL_PATH
    ? path.resolve(repoRoot, process.env.WEATHER_ML_MODEL_PATH)
    : path.join(repoRoot, 'data/models/weather-high-temp-calibrator.json');
  const weatherMlRegistryPath = process.env.WEATHER_ML_REGISTRY_PATH
    ? path.resolve(repoRoot, process.env.WEATHER_ML_REGISTRY_PATH)
    : path.join(repoRoot, 'data/models/weather-model-registry.json');
  const weatherMlEvaluationPath = process.env.WEATHER_ML_EVALUATION_PATH
    ? path.resolve(repoRoot, process.env.WEATHER_ML_EVALUATION_PATH)
    : path.join(repoRoot, 'data/models/weather-model-evaluations.jsonl');
  const weatherDataDir = process.env.WEATHER_DATA_DIR
    ? path.resolve(repoRoot, process.env.WEATHER_DATA_DIR)
    : path.join(repoRoot, 'data/weather');
  const weatherLocalSqlitePath = process.env.WEATHER_LOCAL_SQLITE_PATH
    ? path.resolve(repoRoot, process.env.WEATHER_LOCAL_SQLITE_PATH)
    : path.join(weatherDataDir, 'kmdw-analytics.sqlite');
  const weatherLocalParquetDir = process.env.WEATHER_LOCAL_PARQUET_DIR
    ? path.resolve(repoRoot, process.env.WEATHER_LOCAL_PARQUET_DIR)
    : path.join(weatherDataDir, 'parquet');
  const env = {
    port: Number.parseInt(process.env.PORT ?? '4000', 10),
    analyticsCacheTtlMs: Number.parseInt(process.env.ANALYTICS_CACHE_TTL_MS ?? '300000', 10),
    opportunityScannerIntervalMs: Number.parseInt(process.env.OPPORTUNITY_SCANNER_INTERVAL_MS ?? '600000', 10),
    opportunityScannerUniverseLimit: Number.parseInt(process.env.OPPORTUNITY_SCANNER_UNIVERSE_LIMIT ?? '0', 10),
    opportunityScannerBatchSize: Number.parseInt(process.env.OPPORTUNITY_SCANNER_BATCH_SIZE ?? '200', 10),
    opportunityScannerConcurrency: Number.parseInt(process.env.OPPORTUNITY_SCANNER_CONCURRENCY ?? '8', 10),
    opportunityScannerMaxOpportunities: Number.parseInt(process.env.OPPORTUNITY_SCANNER_MAX_OPPORTUNITIES ?? '0', 10),
    chicagoWeatherRefreshIntervalMs: Number.parseInt(process.env.CHICAGO_WEATHER_REFRESH_INTERVAL_MS ?? '180000', 10),
    chicagoWeatherHotRefreshIntervalMs: Number.parseInt(process.env.CHICAGO_WEATHER_HOT_REFRESH_INTERVAL_MS ?? '60000', 10),
    chicagoWeatherUpcomingRefreshIntervalMs: Number.parseInt(process.env.CHICAGO_WEATHER_UPCOMING_REFRESH_INTERVAL_MS ?? '900000', 10),
    chicagoWeatherSettledRefreshIntervalMs: Number.parseInt(process.env.CHICAGO_WEATHER_SETTLED_REFRESH_INTERVAL_MS ?? '900000', 10),
    chicagoForecastRefreshIntervalMs: Number.parseInt(process.env.CHICAGO_FORECAST_REFRESH_INTERVAL_MS ?? '600000', 10),
    polymarketUsKeyId: process.env.POLYMARKET_US_KEY_ID ?? '',
    polymarketUsSecretKey: process.env.POLYMARKET_US_SECRET_KEY ?? '',
    polymarketUsBaseUrl: process.env.POLYMARKET_US_BASE_URL ?? 'https://api.polymarket.us',
    polymarketUsGatewayUrl: process.env.POLYMARKET_US_GATEWAY_URL ?? 'https://gateway.polymarket.us',
    polymarketClobBaseUrl: process.env.POLYMARKET_CLOB_BASE_URL ?? 'https://clob.polymarket.com',
    polymarketDataApiBaseUrl: process.env.POLYMARKET_DATA_API_BASE_URL ?? 'https://data-api.polymarket.com',
    polymarketMarketDataPollIntervalMs: Number.parseInt(process.env.POLYMARKET_MARKET_DATA_POLL_INTERVAL_MS ?? '5000', 10),
    polymarketMarketDataStatusPollIntervalMs: Number.parseInt(process.env.POLYMARKET_MARKET_DATA_STATUS_POLL_INTERVAL_MS ?? '5000', 10),
    polymarketMarketDataBoardPollIntervalMs: Number.parseInt(process.env.POLYMARKET_MARKET_DATA_BOARD_POLL_INTERVAL_MS ?? '120000', 10),
    databaseUrl: process.env.DATABASE_URL ?? '',
    weatherUserAgent: process.env.WEATHER_USER_AGENT ?? 'probis-weather-edge/0.1 (local)',
    nwsApiBaseUrl: process.env.NWS_API_BASE_URL ?? 'https://api.weather.gov',
    noaaCdoApiBaseUrl: process.env.NOAA_CDO_API_BASE_URL ?? 'https://www.ncei.noaa.gov/cdo-web/api/v2',
    noaaCdoToken: process.env.NOAA_CDO_TOKEN ?? '',
    noaaCdoKmdwStationId: process.env.NOAA_CDO_KMDW_STATION_ID ?? 'GHCND:USW00014819',
    openMeteoPreviousRunsBaseUrl: process.env.OPEN_METEO_PREVIOUS_RUNS_BASE_URL ?? 'https://previous-runs-api.open-meteo.com',
    openMeteoForecastVintageModel: process.env.OPEN_METEO_FORECAST_VINTAGE_MODEL ?? 'gfs_seamless',
    openMeteoForecastVintageLeadDays: process.env.OPEN_METEO_FORECAST_VINTAGE_LEAD_DAYS ?? '1,2,3,4,5,6,7',
    climdwUrl: process.env.CLIMDW_URL ?? 'https://forecast.weather.gov/product.php?format=CI&glossary=1&highlight=off&issuedby=MDW&product=CLI&site=NWS&version=1',
    weatherProviderId: process.env.WEATHER_PROVIDER_ID ?? 'kmdw-nws-climdw',
    chicagoMarketSearchQuery: process.env.CHICAGO_MARKET_SEARCH_QUERY ?? 'highest temperature chicago',
    chicagoMarketSearchQueries: process.env.CHICAGO_MARKET_SEARCH_QUERIES ?? '',
    chicagoMarketSearchLimit: Number.parseInt(process.env.CHICAGO_MARKET_SEARCH_LIMIT ?? '60', 10),
    nbmEnabled: String(process.env.NBM_ENABLED ?? '').trim().toLowerCase() === 'true',
    nbmJsonUrl: process.env.NBM_JSON_URL ?? '',
    weatherDataDir,
    weatherLocalStoreEnabled: String(process.env.WEATHER_LOCAL_STORE_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    weatherLocalSqlitePath,
    weatherLocalParquetDir,
    weatherLocalParquetEnabled: String(process.env.WEATHER_LOCAL_PARQUET_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    weatherMlModelPath,
    weatherMlRegistryPath,
    weatherMlEvaluationPath,
    weatherMlMinSamples: Number.parseInt(process.env.WEATHER_ML_MIN_SAMPLES ?? '40', 10),
    weatherMlMinClassSamples: Number.parseInt(process.env.WEATHER_ML_MIN_CLASS_SAMPLES ?? '5', 10),
    weatherMlTrainingLimit: Number.parseInt(process.env.WEATHER_ML_TRAINING_LIMIT ?? '5000', 10),
    weatherMlRollingFolds: Number.parseInt(process.env.WEATHER_ML_ROLLING_FOLDS ?? '4', 10),
    weatherMlHoldoutFraction: Number.parseFloat(process.env.WEATHER_ML_HOLDOUT_FRACTION ?? '0.25'),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'gemma3:latest'
  };

  const missing = requiredKeys.filter((key) => !process.env[key]);

  return {
    ...env,
    hasTradingCredentials: missing.length === 0,
    hasUsTradingCredentials: Boolean(env.polymarketUsKeyId && env.polymarketUsSecretKey),
    missing
  };
}
