import { buildWeatherMlFeatures, scoreWeatherMlOutcome } from '../ml/weather-model.js';

const WEATHER_HIGH_TEMP_MODEL = 'station-high-temp-probability';
const SIMULATION_COUNT = 10_000;

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

function normalizeProbabilities(outcomes) {
  const total = outcomes.reduce((sum, outcome) => sum + Math.max(0, outcome.rawEstimate ?? 0), 0);

  if (!total) {
    return outcomes.map((outcome) => {
      const estimatedCost = outcome.estimatedCost ?? 0;

      return {
        ...outcome,
        estimatedProbability: outcome.currentProbability,
        grossEdge: 0,
        edge: -estimatedCost
      };
    });
  }

  return outcomes.map((outcome) => {
    const estimatedProbability = Math.max(0, outcome.rawEstimate ?? 0) / total;
    const currentProbability = outcome.currentProbability ?? 0;
    const grossEdge = estimatedProbability - currentProbability;
    const estimatedCost = outcome.estimatedCost ?? 0;

    return {
      ...outcome,
      estimatedProbability,
      grossEdge,
      estimatedCost,
      edge: grossEdge - estimatedCost
    };
  });
}

function normalizeMarketCategory(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getWeatherOutcome(outcome, weatherMarket) {
  if (!weatherMarket || !Array.isArray(weatherMarket.outcomes)) {
    return null;
  }

  return weatherMarket.outcomes.find((candidate) => candidate.label === outcome.label) ?? null;
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createSeededRandom(seedValue) {
  let state = seedValue >>> 0;

  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleNormal(random) {
  const left = Math.max(random(), Number.EPSILON);
  const right = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

function applyTemperaturePrecision(value, precision) {
  const normalizedPrecision = String(precision ?? '').toLowerCase();

  if (normalizedPrecision.includes('tenth')) {
    return Math.round(value * 10) / 10;
  }

  return Math.round(value);
}

function rangeContains(value, range) {
  if (!range || typeof value !== 'number') {
    return false;
  }

  if (typeof range.min === 'number') {
    if (range.inclusiveMin === false ? value <= range.min : value < range.min) {
      return false;
    }
  }

  if (typeof range.max === 'number') {
    if (range.inclusiveMax === false ? value >= range.max : value > range.max) {
      return false;
    }
  }

  return true;
}

function getOutcomeRange(label, weatherMarket) {
  return weatherMarket?.outcomes?.find((outcome) => outcome.label === label)?.range ?? null;
}

function getYesRange(weatherMarket) {
  return weatherMarket?.outcomes?.find((outcome) => {
    return String(outcome?.label ?? '').trim().toLowerCase() === 'yes' && outcome.range;
  })?.range ?? null;
}

function getOutcomeMatch(value, outcomeLabel, weatherMarket) {
  const normalizedLabel = String(outcomeLabel ?? '').trim().toLowerCase();
  const directRange = getOutcomeRange(outcomeLabel, weatherMarket);

  if (directRange) {
    return rangeContains(value, directRange);
  }

  if (normalizedLabel === 'no') {
    const yesRange = getYesRange(weatherMarket);
    return yesRange ? !rangeContains(value, yesRange) : false;
  }

  return false;
}

function resolveExpectedHigh(weatherSnapshot) {
  const modelExpectedHigh = weatherSnapshot?.model?.expectedHigh;

  if (typeof modelExpectedHigh === 'number') {
    return modelExpectedHigh;
  }

  return average([
    weatherSnapshot?.observedHighSoFar,
    weatherSnapshot?.nwsRemainingForecastHigh,
    weatherSnapshot?.openMeteoRemainingForecastHigh,
    weatherSnapshot?.nwsForecastHigh,
    weatherSnapshot?.openMeteoForecastHigh
  ]);
}

function getMlCalibrationForSnapshot(options, weatherSnapshot) {
  const stationId = weatherSnapshot?.stationId;
  const byStation = options?.mlCalibrationByStationId;

  if (stationId && byStation && typeof byStation.get === 'function') {
    return byStation.get(stationId) ?? options?.mlCalibration ?? null;
  }

  return options?.mlCalibration ?? null;
}

function getCalibrationWeight(calibration) {
  const sampleCount = calibration?.sampleCount ?? 0;
  return clamp(sampleCount / 100, 0, 0.65);
}

function buildWeatherHighTempPrediction(weatherMarket, weatherSnapshot, marketOutcomes, options = {}) {
  if (
    !weatherMarket
    || weatherMarket.metric !== 'highest-temperature'
    || !weatherSnapshot
    || weatherSnapshot.status === 'insufficient-rules'
  ) {
    return null;
  }

  const calibration = getMlCalibrationForSnapshot(options, weatherSnapshot);
  const calibrationWeight = getCalibrationWeight(calibration);
  const rawExpectedHigh = resolveExpectedHigh(weatherSnapshot);
  const expectedHigh = typeof rawExpectedHigh === 'number'
    ? rawExpectedHigh + ((calibration?.expectedHighBias ?? 0) * calibrationWeight)
    : null;
  const stdDev = typeof weatherSnapshot?.model?.stdDev === 'number' ? weatherSnapshot.model.stdDev : 4;

  if (typeof expectedHigh !== 'number') {
    return null;
  }

  const counts = new Map(marketOutcomes.map((outcome) => [outcome.label, 0]));
  const seed = hashString([
    weatherMarket.conditionId,
    weatherSnapshot.stationId,
    weatherSnapshot.targetDate,
    expectedHigh.toFixed(1),
    stdDev.toFixed(1)
  ].join('|'));
  const random = createSeededRandom(seed);
  const observedHighSoFar = typeof weatherSnapshot.observedHighSoFar === 'number'
    ? weatherSnapshot.observedHighSoFar
    : null;
  const simulationValues = [];
  const temperatureCounts = new Map();

  for (let index = 0; index < SIMULATION_COUNT; index += 1) {
    const sampledFutureHigh = expectedHigh + sampleNormal(random) * stdDev;
    const finalHigh = observedHighSoFar === null
      ? sampledFutureHigh
      : Math.max(observedHighSoFar, sampledFutureHigh);
    const resolvedHigh = applyTemperaturePrecision(finalHigh, weatherMarket.precision);
    const integerHigh = Math.round(resolvedHigh);

    simulationValues.push(resolvedHigh);
    temperatureCounts.set(integerHigh, (temperatureCounts.get(integerHigh) ?? 0) + 1);

    for (const outcome of marketOutcomes) {
      if (getOutcomeMatch(resolvedHigh, outcome.label, weatherMarket)) {
        counts.set(outcome.label, (counts.get(outcome.label) ?? 0) + 1);
        break;
      }
    }
  }

  const outcomeProbabilities = Object.fromEntries(
    marketOutcomes.map((outcome) => [outcome.label, (counts.get(outcome.label) ?? 0) / SIMULATION_COUNT])
  );
  const temperatureDistribution = Object.fromEntries(
    [...temperatureCounts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([temp, count]) => [String(temp), count / SIMULATION_COUNT])
  );
  const bucketProbabilities = Object.fromEntries(
    marketOutcomes.map((outcome) => [
      outcome.conditionId ?? outcome.tokenId ?? outcome.label,
      outcomeProbabilities[outcome.label] ?? 0
    ])
  );
  const confidence = clamp(
    average([
      weatherSnapshot?.model?.confidence,
      weatherSnapshot.observationCount > 0 ? 0.72 : 0.48,
      typeof weatherSnapshot.nwsForecastHigh === 'number' || typeof weatherSnapshot.openMeteoForecastHigh === 'number'
        ? 0.68
        : 0.42
    ]) ?? 0.35,
    0.08,
    0.93
  );
  const sortedValues = [...simulationValues].sort((left, right) => left - right);

  return {
    modelFamily: WEATHER_HIGH_TEMP_MODEL,
    expectedHigh,
    stdDev,
    confidence,
    simulationCount: SIMULATION_COUNT,
    sourceRiskBuffer: weatherSnapshot?.model?.sourceRiskBuffer ?? 0.05,
    temperatureDistribution,
    bucketProbabilities,
    climateDayWindow: weatherSnapshot?.climateDayWindow ?? null,
    sourceFreshness: weatherSnapshot?.sourceFreshness ?? {
      isStale: Array.isArray(weatherSnapshot?.sourceErrors) && weatherSnapshot.sourceErrors.length > 0,
      staleReasons: Array.isArray(weatherSnapshot?.sourceErrors)
        ? weatherSnapshot.sourceErrors.map((entry) => `${entry.source}: ${entry.error}`)
        : []
    },
    mlCalibration: calibration
      ? {
          sampleCount: calibration.sampleCount ?? 0,
          expectedHighBias: calibration.expectedHighBias ?? 0,
          probabilityBias: calibration.probabilityBias ?? 0,
          weight: calibrationWeight
        }
      : null,
    outcomeProbabilities,
    percentiles: {
      p10: sortedValues[Math.floor(SIMULATION_COUNT * 0.1)],
      p50: sortedValues[Math.floor(SIMULATION_COUNT * 0.5)],
      p90: sortedValues[Math.floor(SIMULATION_COUNT * 0.9)]
    }
  };
}

function estimateTradingCost({ outcome, marketSnapshot, weatherMarket, weatherSnapshot, weatherPrediction }) {
  const spread = typeof outcome?.spread === 'number'
    ? outcome.spread
    : typeof marketSnapshot?.spread === 'number'
      ? marketSnapshot.spread
      : null;
  const liquidity = typeof outcome?.askDepth === 'number' || typeof outcome?.bidDepth === 'number'
    ? (outcome.askDepth ?? 0) + (outcome.bidDepth ?? 0)
    : typeof marketSnapshot?.liquidity === 'number'
      ? marketSnapshot.liquidity
      : null;
  const spreadCost = typeof spread === 'number' ? clamp(spread, 0, 0.12) : 0.025;
  const slippageCost = typeof liquidity === 'number'
    ? liquidity < 100
      ? 0.04
      : liquidity < 500
        ? 0.025
        : liquidity < 2_000
          ? 0.015
          : 0.008
    : 0.025;
  const sourceRiskBuffer = weatherPrediction?.sourceRiskBuffer
    ?? weatherSnapshot?.model?.sourceRiskBuffer
    ?? (weatherMarket?.stationCode && weatherMarket?.resolutionSourceUrl ? 0.035 : 0.075);
  const estimatedCost = clamp(spreadCost + slippageCost + sourceRiskBuffer, 0.02, 0.2);

  return {
    estimatedCost,
    costBreakdown: {
      spreadCost,
      slippageCost,
      sourceRiskBuffer,
      fees: 0
    }
  };
}

function scoreOutcome(outcome, marketSnapshot, weatherMarket, weatherSnapshot, weatherPrediction, options = {}) {
  const summary = outcome.historySummary ?? {};
  const currentProbability = outcome.currentProbability ?? 0;
  const momentum = summary.absoluteChange ?? 0;
  const volatility = summary.highPrice !== null && summary.lowPrice !== null
    ? summary.highPrice - summary.lowPrice
    : 0;
  const pointCount = summary.pointCount ?? 0;
  const sampleStrength = Math.min(pointCount, 7) / 7;
  const quality = average(
    [marketSnapshot?.liquidityShare, marketSnapshot?.volumeShare].filter((value) => typeof value === 'number')
  ) ?? 0;
  const historicalAnchor = average(
    [summary.firstPrice, summary.latestPrice, summary.highPrice, summary.lowPrice].filter(
      (value) => typeof value === 'number'
    )
  ) ?? currentProbability;
  const weatherOutcome = getWeatherOutcome(outcome, weatherMarket);
  const marketCategory = normalizeMarketCategory(marketSnapshot?.category ?? null);
  const weatherProbability = weatherPrediction?.outcomeProbabilities?.[outcome.label] ?? null;
  const hasWeatherPrediction = typeof weatherProbability === 'number';
  const hasWeatherContext = Boolean(weatherMarket);
  const modelFamily = hasWeatherPrediction
    ? WEATHER_HIGH_TEMP_MODEL
    : hasWeatherContext
      ? 'weather-rules'
      : 'market-microstructure';
  const cost = estimateTradingCost({
    outcome,
    marketSnapshot,
    weatherMarket,
    weatherSnapshot,
    weatherPrediction
  });

  if (hasWeatherPrediction) {
    const mlFeatureVector = buildWeatherMlFeatures({
      outcome,
      marketSnapshot,
      weatherOutcome,
      weatherSnapshot,
      weatherPrediction,
      simulationProbability: weatherProbability,
      currentProbability,
      estimatedCost: cost.estimatedCost
    });
    const mlScore = weatherOutcome?.range
      ? scoreWeatherMlOutcome(options.weatherMlModel, mlFeatureVector)
      : null;
    const mlBlendWeight = mlScore?.blendWeight ?? 0;
    const rawEstimate = mlScore
      ? (weatherProbability * (1 - mlBlendWeight)) + (mlScore.probability * mlBlendWeight)
      : weatherProbability;

    return {
      label: outcome.label,
      tokenId: outcome.tokenId,
      currentProbability,
      historySummary: summary,
      rawEstimate: clamp(rawEstimate, 0, 1),
      confidence: weatherPrediction.confidence,
      estimatedCost: cost.estimatedCost,
      features: {
        momentum,
        volatility,
        quality,
        sampleStrength,
        historicalAnchor,
        marketCategory,
        modelFamily,
        weatherMetric: weatherMarket?.metric ?? null,
        weatherStationCode: weatherSnapshot?.stationId ?? weatherMarket?.stationCode ?? null,
        weatherStationName: weatherSnapshot?.stationName ?? weatherMarket?.stationName ?? null,
        weatherTargetDate: weatherSnapshot?.targetDate ?? weatherMarket?.targetDate ?? null,
        weatherTargetDateLabel: weatherMarket?.targetDateLabel ?? null,
        weatherUnit: weatherMarket?.unit ?? null,
        weatherResolutionSourceName: weatherMarket?.resolutionSourceName ?? null,
        weatherResolutionSourceUrl: weatherMarket?.resolutionSourceUrl ?? null,
        weatherPrecision: weatherMarket?.precision ?? null,
        weatherFinalizationRule: weatherMarket?.finalizationRule ?? null,
        weatherOutcomeRange: weatherOutcome?.range ?? null,
        weatherExpectedHigh: weatherPrediction.expectedHigh,
        weatherStdDev: weatherPrediction.stdDev,
        weatherObservedHighSoFar: weatherSnapshot?.observedHighSoFar ?? null,
        weatherCurrentObservedTemp: weatherSnapshot?.currentObservedTemp ?? null,
        weatherNwsForecastHigh: weatherSnapshot?.nwsForecastHigh ?? null,
        weatherOpenMeteoForecastHigh: weatherSnapshot?.openMeteoForecastHigh ?? null,
        weatherHistoricalHighForSameDay: weatherSnapshot?.historicalHighForSameDay ?? null,
        weatherRecentStationBias: weatherSnapshot?.recentStationBias ?? null,
        weatherLatestObservationAt: weatherSnapshot?.latestObservationAt ?? null,
        weatherDayPhase: weatherSnapshot?.model?.dayPhase ?? null,
        weatherSimulationCount: weatherPrediction.simulationCount,
        weatherSimulationProbability: weatherProbability,
        weatherTemperatureDistribution: weatherPrediction.temperatureDistribution,
        weatherBucketProbabilities: weatherPrediction.bucketProbabilities,
        weatherClimateDayWindow: weatherPrediction.climateDayWindow,
        weatherSourceFreshness: weatherPrediction.sourceFreshness,
        weatherPercentiles: weatherPrediction.percentiles,
        mlCalibration: weatherPrediction.mlCalibration,
        weatherMlProbability: mlScore?.probability ?? null,
        weatherMlBlendWeight: mlBlendWeight,
        weatherMlModelId: mlScore?.modelId ?? null,
        weatherMlModelType: mlScore?.modelType ?? null,
        weatherMlTrainedAt: mlScore?.trainedAt ?? null,
        weatherMlSampleCount: mlScore?.sampleCount ?? null,
        weatherMlFeatures: mlFeatureVector,
        bestBid: outcome.bestBid ?? null,
        bestAsk: outcome.bestAsk ?? null,
        midpoint: outcome.midpoint ?? null,
        spread: outcome.spread ?? null,
        bidDepth: outcome.bidDepth ?? null,
        askDepth: outcome.askDepth ?? null,
        estimatedCost: cost.estimatedCost,
        costBreakdown: cost.costBreakdown
      }
    };
  }

  const trendWeight = 0.25 + quality * 0.35 + sampleStrength * 0.1;
  const anchorWeight = 0.18 + sampleStrength * 0.12;
  const volatilityPenalty = Math.min(0.35, volatility * 0.35);

  let rawEstimate = currentProbability;
  rawEstimate += momentum * trendWeight;
  rawEstimate += (historicalAnchor - currentProbability) * anchorWeight;
  rawEstimate = rawEstimate * (1 - volatilityPenalty) + 0.5 * volatilityPenalty;

  const baseConfidence = clamp(
    0.12
      + quality * 0.35
      + sampleStrength * 0.2
      - volatility * 0.25
      + (hasWeatherContext ? 0.02 : 0),
    0.04,
    0.55
  );

  return {
    label: outcome.label,
    tokenId: outcome.tokenId,
    currentProbability,
    historySummary: summary,
    rawEstimate: clamp(rawEstimate, 0.01, 0.99),
    confidence: baseConfidence,
    estimatedCost: cost.estimatedCost,
    features: {
      momentum,
      volatility,
      quality,
      sampleStrength,
      historicalAnchor,
      marketCategory,
      modelFamily,
      weatherMetric: weatherMarket?.metric ?? null,
      weatherStationCode: weatherMarket?.stationCode ?? null,
      weatherStationName: weatherMarket?.stationName ?? null,
      weatherTargetDate: weatherMarket?.targetDate ?? null,
      weatherTargetDateLabel: weatherMarket?.targetDateLabel ?? null,
      weatherUnit: weatherMarket?.unit ?? null,
      weatherResolutionSourceName: weatherMarket?.resolutionSourceName ?? null,
      weatherResolutionSourceUrl: weatherMarket?.resolutionSourceUrl ?? null,
      weatherPrecision: weatherMarket?.precision ?? null,
      weatherFinalizationRule: weatherMarket?.finalizationRule ?? null,
      weatherOutcomeRange: weatherOutcome?.range ?? null,
      bestBid: outcome.bestBid ?? null,
      bestAsk: outcome.bestAsk ?? null,
      midpoint: outcome.midpoint ?? null,
      spread: outcome.spread ?? null,
      bidDepth: outcome.bidDepth ?? null,
      askDepth: outcome.askDepth ?? null,
      estimatedCost: cost.estimatedCost,
      costBreakdown: cost.costBreakdown
    }
  };
}

function getMarketOpportunity(outcomes) {
  const ranked = outcomes
    .filter((outcome) => outcome.edge >= 0.05)
    .map((outcome) => ({
      ...outcome,
      score: outcome.edge * outcome.confidence
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? null;
}

export function buildStatisticalModel(event, aggregation, options = {}) {
  const marketSnapshots = aggregation?.liquiditySnapshot?.markets ?? [];
  const historicalMarkets = aggregation?.historicalPrices?.markets ?? [];
  const weatherMarkets = aggregation?.weatherContext?.markets ?? [];
  const weatherSnapshots = aggregation?.weatherSnapshots ?? [];

  const markets = historicalMarkets.map((market) => {
    const marketSnapshot = marketSnapshots.find((candidate) => candidate.conditionId === market.conditionId);
    const weatherMarket = weatherMarkets.find((candidate) => candidate.conditionId === market.conditionId)
      ?? market.weatherContext
      ?? null;
    const weatherSnapshot = weatherSnapshots.find((candidate) => candidate.conditionId === market.conditionId)
      ?? market.weatherSnapshot
      ?? null;
    const weatherPrediction = buildWeatherHighTempPrediction(weatherMarket, weatherSnapshot, market.outcomes, options);
    const scoredOutcomes = market.outcomes.map((outcome) =>
      scoreOutcome(outcome, marketSnapshot, weatherMarket, weatherSnapshot, weatherPrediction, options)
    );
    const normalizedOutcomes = normalizeProbabilities(scoredOutcomes).sort(
      (left, right) => right.estimatedProbability - left.estimatedProbability
    );
    const adjustedWeatherPrediction = weatherPrediction
      ? {
          ...weatherPrediction,
          adjustedOutcomeProbabilities: Object.fromEntries(
            normalizedOutcomes.map((outcome) => [outcome.label, outcome.estimatedProbability])
          ),
          weatherMlModel: options.weatherMlModel
            ? {
                status: options.weatherMlModel.status,
                modelId: options.weatherMlModel.modelId,
                modelType: options.weatherMlModel.modelType,
                trainedAt: options.weatherMlModel.trainedAt,
                blendWeight: options.weatherMlModel.blendWeight,
                sampleCount: options.weatherMlModel.training?.sampleCount ?? null
              }
            : null
        }
      : null;
    const marketConfidence = average(normalizedOutcomes.map((outcome) => outcome.confidence)) ?? 0;
    const bestOpportunity = getMarketOpportunity(normalizedOutcomes);

    return {
      conditionId: market.conditionId,
      question: market.question,
      weatherContext: weatherMarket,
      weatherSnapshot,
      weatherPrediction: adjustedWeatherPrediction,
      confidence: marketConfidence,
      opportunity: bestOpportunity,
      outcomes: normalizedOutcomes
    };
  });

  const bestOpportunity = markets
    .filter((market) => market.opportunity)
    .map((market) => ({
      conditionId: market.conditionId,
      question: market.question,
      confidence: market.confidence,
      ...market.opportunity
    }))
    .sort((left, right) => right.score - left.score)[0] ?? null;

  return {
    generatedAt: new Date().toISOString(),
    methodology: {
      name: 'polymarket-us-weather-edge-v1',
      inputs: [
        'polymarket_us_market_probability',
        'polymarket_us_liquidity',
        'parsed_wunderground_resolution_url',
        'station_id',
        'target_date',
        'observed_high_so_far',
        'nws_hourly_forecast',
        'open_meteo_hourly_forecast',
        'outcome_temperature_ranges',
        'estimated_cost',
        'ml_calibration_from_settled_paper_predictions',
        'weather_ml_artifact_from_python_worker'
      ],
      description:
        'Models Polymarket US highest-temperature weather markets by parsing the resolving station/source from market rules, ingesting station observations and forecasts, simulating final_high=max(observed_high_so_far,predicted_future_hourly_max), optionally blending a Python-trained ML calibration artifact into outcome probabilities, and ranking only net edge after estimated spread, slippage, and source-risk cost.'
    },
    summary: {
      eventSlug: event.slug,
      liveMarketCount: markets.length,
      bestOpportunity,
      highestConfidenceMarket: [...markets].sort((left, right) => right.confidence - left.confidence)[0] ?? null
    },
    markets
  };
}
