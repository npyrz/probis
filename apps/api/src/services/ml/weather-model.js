import { readFile, stat } from 'node:fs/promises';

const DEFAULT_BLEND_WEIGHT = 0.35;
const MAX_BLEND_WEIGHT = 0.75;
const WEATHER_ML_FEATURE_NAMES = [
  'simulation_probability',
  'market_probability',
  'gross_simulation_edge',
  'estimated_cost',
  'expected_high',
  'std_dev',
  'observed_high_so_far',
  'current_observed_temp',
  'nws_forecast_high',
  'openmeteo_forecast_high',
  'nws_remaining_forecast_high',
  'openmeteo_remaining_forecast_high',
  'historical_high_for_same_day',
  'recent_station_bias',
  'humidity',
  'wind_speed_mph',
  'cloud_cover',
  'dew_point_f',
  'pressure_hpa',
  'precipitation_chance',
  'observation_count',
  'forecast_disagreement',
  'source_risk_buffer',
  'range_min',
  'range_max',
  'range_width',
  'range_center',
  'range_distance_from_expected',
  'day_phase_code',
  'simulation_p10',
  'simulation_p50',
  'simulation_p90',
  'spread',
  'bid_depth',
  'ask_depth',
  'is_yes_outcome'
];

let cachedModel = {
  path: null,
  mtimeMs: null,
  model: null
};

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }

  const z = Math.exp(value);
  return z / (1 + z);
}

function normalizeCoefficients(payload, featureNames) {
  if (payload?.coefficients && typeof payload.coefficients === 'object' && !Array.isArray(payload.coefficients)) {
    return Object.fromEntries(
      Object.entries(payload.coefficients)
        .map(([key, value]) => [key, toNumberOrNull(value)])
        .filter(([, value]) => typeof value === 'number')
    );
  }

  if (Array.isArray(payload?.coefficients)) {
    return Object.fromEntries(
      payload.coefficients
        .map((value, index) => [featureNames[index], toNumberOrNull(value)])
        .filter(([key, value]) => key && typeof value === 'number')
    );
  }

  return {};
}

function normalizeWeatherMlModel(payload, modelPath) {
  const featureNames = Array.isArray(payload?.featureNames)
    ? payload.featureNames.map((name) => String(name)).filter(Boolean)
    : [];
  const probabilityModel = payload?.probabilityModel ?? payload ?? {};
  const coefficients = normalizeCoefficients(probabilityModel, featureNames);
  const intercept = toNumberOrNull(probabilityModel.intercept) ?? 0;
  const status = String(payload?.status ?? '').trim().toLowerCase();
  const ready = status === 'ready' && featureNames.length > 0 && Object.keys(coefficients).length > 0;

  return {
    schemaVersion: payload?.schemaVersion ?? 1,
    status: ready ? 'ready' : (status || 'unavailable'),
    modelId: payload?.modelId ?? payload?.id ?? null,
    modelType: payload?.modelType ?? probabilityModel?.modelType ?? 'logistic-calibrator',
    trainedAt: payload?.trainedAt ?? null,
    modelPath,
    featureNames,
    imputationValues: payload?.imputationValues && typeof payload.imputationValues === 'object'
      ? payload.imputationValues
      : {},
    featureTransforms: payload?.featureTransforms && typeof payload.featureTransforms === 'object'
      ? payload.featureTransforms
      : {},
    probabilityModel: {
      intercept,
      coefficients
    },
    blendWeight: clamp(
      toNumberOrNull(payload?.blendWeight ?? payload?.productionBlendWeight) ?? DEFAULT_BLEND_WEIGHT,
      0,
      MAX_BLEND_WEIGHT
    ),
    training: payload?.training ?? null,
    metrics: payload?.metrics ?? null
  };
}

export async function loadWeatherMlModel(env) {
  const modelPath = env?.weatherMlModelPath;

  if (!modelPath) {
    return null;
  }

  try {
    const metadata = await stat(modelPath);

    if (
      cachedModel.model
      && cachedModel.path === modelPath
      && cachedModel.mtimeMs === metadata.mtimeMs
    ) {
      return cachedModel.model;
    }

    const raw = await readFile(modelPath, 'utf8');
    const parsed = JSON.parse(raw);
    const model = normalizeWeatherMlModel(parsed, modelPath);

    cachedModel = {
      path: modelPath,
      mtimeMs: metadata.mtimeMs,
      model
    };

    return model;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[probis] Weather ML model unavailable: ${error instanceof Error ? error.message : 'invalid artifact'}`);
    }

    cachedModel = {
      path: modelPath,
      mtimeMs: null,
      model: null
    };

    return null;
  }
}

function getRangeValue(range, key) {
  const value = range?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getRangeWidth(range) {
  const min = getRangeValue(range, 'min');
  const max = getRangeValue(range, 'max');

  if (typeof min === 'number' && typeof max === 'number') {
    return Math.max(0, max - min);
  }

  return null;
}

function getRangeCenter(range) {
  const min = getRangeValue(range, 'min');
  const max = getRangeValue(range, 'max');

  if (typeof min === 'number' && typeof max === 'number') {
    return (min + max) / 2;
  }

  return min ?? max ?? null;
}

function getDayPhaseCode(value) {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'past':
      return -1;
    case 'morning':
      return 1;
    case 'midday':
      return 2;
    case 'late-afternoon':
      return 3;
    case 'evening':
      return 4;
    case 'future':
      return 5;
    default:
      return 0;
  }
}

export function buildWeatherMlFeatures({
  outcome,
  marketSnapshot,
  weatherOutcome,
  weatherSnapshot,
  weatherPrediction,
  simulationProbability,
  currentProbability,
  estimatedCost
}) {
  const range = weatherOutcome?.range ?? null;
  const rangeCenter = getRangeCenter(range);
  const expectedHigh = toNumberOrNull(weatherPrediction?.expectedHigh);

  return {
    simulation_probability: toNumberOrNull(simulationProbability),
    market_probability: toNumberOrNull(currentProbability),
    gross_simulation_edge: typeof simulationProbability === 'number' && typeof currentProbability === 'number'
      ? simulationProbability - currentProbability
      : null,
    estimated_cost: toNumberOrNull(estimatedCost),
    expected_high: expectedHigh,
    std_dev: toNumberOrNull(weatherPrediction?.stdDev),
    observed_high_so_far: toNumberOrNull(weatherSnapshot?.observedHighSoFar),
    current_observed_temp: toNumberOrNull(weatherSnapshot?.currentObservedTemp),
    nws_forecast_high: toNumberOrNull(weatherSnapshot?.nwsForecastHigh),
    openmeteo_forecast_high: toNumberOrNull(weatherSnapshot?.openMeteoForecastHigh),
    nws_remaining_forecast_high: toNumberOrNull(weatherSnapshot?.nwsRemainingForecastHigh),
    openmeteo_remaining_forecast_high: toNumberOrNull(weatherSnapshot?.openMeteoRemainingForecastHigh),
    historical_high_for_same_day: toNumberOrNull(weatherSnapshot?.historicalHighForSameDay),
    recent_station_bias: toNumberOrNull(weatherSnapshot?.recentStationBias),
    humidity: toNumberOrNull(weatherSnapshot?.humidity),
    wind_speed_mph: toNumberOrNull(weatherSnapshot?.windSpeedMph),
    cloud_cover: toNumberOrNull(weatherSnapshot?.cloudCover),
    dew_point_f: toNumberOrNull(weatherSnapshot?.dewPointF),
    pressure_hpa: toNumberOrNull(weatherSnapshot?.pressureHpa),
    precipitation_chance: toNumberOrNull(weatherSnapshot?.precipitationChance),
    observation_count: toNumberOrNull(weatherSnapshot?.observationCount),
    forecast_disagreement: toNumberOrNull(weatherSnapshot?.model?.forecastDisagreement),
    source_risk_buffer: toNumberOrNull(weatherPrediction?.sourceRiskBuffer ?? weatherSnapshot?.model?.sourceRiskBuffer),
    range_min: getRangeValue(range, 'min'),
    range_max: getRangeValue(range, 'max'),
    range_width: getRangeWidth(range),
    range_center: rangeCenter,
    range_distance_from_expected: typeof rangeCenter === 'number' && typeof expectedHigh === 'number'
      ? Math.abs(rangeCenter - expectedHigh)
      : null,
    day_phase_code: getDayPhaseCode(weatherSnapshot?.model?.dayPhase),
    simulation_p10: toNumberOrNull(weatherPrediction?.percentiles?.p10),
    simulation_p50: toNumberOrNull(weatherPrediction?.percentiles?.p50),
    simulation_p90: toNumberOrNull(weatherPrediction?.percentiles?.p90),
    spread: toNumberOrNull(outcome?.spread ?? marketSnapshot?.spread),
    bid_depth: toNumberOrNull(outcome?.bidDepth),
    ask_depth: toNumberOrNull(outcome?.askDepth),
    is_yes_outcome: String(outcome?.label ?? '').trim().toLowerCase() === 'yes' ? 1 : 0
  };
}

export function scoreWeatherMlOutcome(model, features) {
  if (!model || model.status !== 'ready') {
    return null;
  }

  const coefficients = model.probabilityModel?.coefficients ?? {};
  let logit = model.probabilityModel?.intercept ?? 0;

  for (const featureName of model.featureNames) {
    const coefficient = toNumberOrNull(coefficients[featureName]);

    if (typeof coefficient !== 'number') {
      continue;
    }

    let value = toNumberOrNull(features?.[featureName])
      ?? toNumberOrNull(model.imputationValues?.[featureName])
      ?? 0;
    const transform = model.featureTransforms?.[featureName] ?? null;
    const mean = toNumberOrNull(transform?.mean);
    const scale = toNumberOrNull(transform?.scale);

    if (typeof mean === 'number' && typeof scale === 'number' && scale > 0) {
      value = (value - mean) / scale;
    }

    logit += coefficient * value;
  }

  return {
    probability: clamp(sigmoid(logit), 0.001, 0.999),
    blendWeight: model.blendWeight,
    modelId: model.modelId,
    modelType: model.modelType,
    trainedAt: model.trainedAt,
    sampleCount: model.training?.sampleCount ?? null
  };
}

export {
  WEATHER_ML_FEATURE_NAMES
};
