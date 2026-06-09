import fs from 'node:fs/promises';
import path from 'node:path';

import { getChicagoModelTrainingRows } from '../persistence/postgres.js';
import { loadWeatherMlModel, scoreWeatherMlOutcome, WEATHER_ML_FEATURE_NAMES } from './weather-model.js';

const DEFAULT_MIN_SAMPLES = 40;
const DEFAULT_MIN_CLASS_SAMPLES = 5;
const DEFAULT_HOLDOUT_FRACTION = 0.25;
const DEFAULT_ROLLING_FOLDS = 4;
const DEFAULT_ITERATIONS = 900;
const DEFAULT_LEARNING_RATE = 0.08;
const DEFAULT_L2 = 0.001;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }

  const z = Math.exp(value);
  return z / (1 + z);
}

function median(values) {
  const sorted = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return 0;
  }

  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function average(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function round(value, digits = 6) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sortedRows(rows) {
  return [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => row && (row.target === 0 || row.target === 1 || typeof row.actualOutcome === 'boolean'))
    .map((row) => ({
      ...row,
      target: row.target === 0 || row.target === 1 ? row.target : row.actualOutcome ? 1 : 0
    }))
    .sort((left, right) => {
      const dateComparison = String(left.eventDate ?? '').localeCompare(String(right.eventDate ?? ''));

      if (dateComparison !== 0) {
        return dateComparison;
      }

      return String(left.predictionTime ?? '').localeCompare(String(right.predictionTime ?? ''));
    });
}

function classCounts(rows) {
  const positiveCount = rows.filter((row) => row.target === 1).length;

  return {
    positiveCount,
    negativeCount: rows.length - positiveCount
  };
}

function buildImputationValues(rows) {
  return Object.fromEntries(WEATHER_ML_FEATURE_NAMES.map((featureName) => [
    featureName,
    median(rows.map((row) => toNumberOrNull(row.features?.[featureName])))
  ]));
}

function buildFeatureTransforms(rows, imputationValues) {
  return Object.fromEntries(WEATHER_ML_FEATURE_NAMES.map((featureName) => {
    const values = rows.map((row) => toNumberOrNull(row.features?.[featureName]) ?? imputationValues[featureName] ?? 0);
    const mean = average(values) ?? 0;
    const variance = average(values.map((value) => (value - mean) ** 2)) ?? 0;
    const scale = Math.sqrt(variance);

    return [
      featureName,
      {
        mean,
        scale: scale > 0 ? scale : 1
      }
    ];
  }));
}

function matrixFromRows(rows, imputationValues, featureTransforms) {
  return rows.map((row) => WEATHER_ML_FEATURE_NAMES.map((featureName) => {
    const value = toNumberOrNull(row.features?.[featureName]) ?? imputationValues[featureName] ?? 0;
    const transform = featureTransforms[featureName] ?? {};
    const scale = toNumberOrNull(transform.scale) ?? 1;
    const mean = toNumberOrNull(transform.mean) ?? 0;

    return scale > 0 ? (value - mean) / scale : value - mean;
  }));
}

function predictWithCoefficients(matrix, intercept, coefficients) {
  return matrix.map((row) => {
    let logit = intercept;

    for (let index = 0; index < row.length; index += 1) {
      logit += row[index] * coefficients[index];
    }

    return clamp(sigmoid(logit), 0.001, 0.999);
  });
}

function fitLogisticRegression(matrix, targets, {
  iterations = DEFAULT_ITERATIONS,
  learningRate = DEFAULT_LEARNING_RATE,
  l2 = DEFAULT_L2
} = {}) {
  const featureCount = WEATHER_ML_FEATURE_NAMES.length;
  const coefficients = Array.from({ length: featureCount }, () => 0);
  let intercept = 0;
  const positiveCount = targets.filter((value) => value === 1).length;
  const negativeCount = targets.length - positiveCount;
  const positiveWeight = positiveCount > 0 ? targets.length / (2 * positiveCount) : 1;
  const negativeWeight = negativeCount > 0 ? targets.length / (2 * negativeCount) : 1;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Array.from({ length: featureCount }, () => 0);
    let interceptGradient = 0;

    for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
      const probability = predictWithCoefficients([matrix[rowIndex]], intercept, coefficients)[0];
      const target = targets[rowIndex];
      const weight = target === 1 ? positiveWeight : negativeWeight;
      const error = (probability - target) * weight;

      interceptGradient += error;

      for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
        gradient[featureIndex] += error * matrix[rowIndex][featureIndex];
      }
    }

    const step = learningRate / Math.sqrt(iteration + 1);
    const denominator = Math.max(1, matrix.length);
    intercept -= step * (interceptGradient / denominator);

    for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
      const regularized = (gradient[featureIndex] / denominator) + (l2 * coefficients[featureIndex]);
      coefficients[featureIndex] -= step * regularized;
    }
  }

  return {
    intercept,
    coefficients
  };
}

function fitModel(rows, options = {}) {
  const imputationValues = buildImputationValues(rows);
  const featureTransforms = buildFeatureTransforms(rows, imputationValues);
  const matrix = matrixFromRows(rows, imputationValues, featureTransforms);
  const targets = rows.map((row) => row.target);
  const fitted = fitLogisticRegression(matrix, targets, options);

  return {
    ...fitted,
    imputationValues,
    featureTransforms
  };
}

function scoreRowsWithFitted(rows, fitted) {
  const matrix = matrixFromRows(rows, fitted.imputationValues, fitted.featureTransforms);
  return predictWithCoefficients(matrix, fitted.intercept, fitted.coefficients);
}

function probabilityLogLoss(probability, target) {
  const safeProbability = clamp(probability, 0.000001, 0.999999);
  return target === 1 ? -Math.log(safeProbability) : -Math.log(1 - safeProbability);
}

function aucScore(targets, probabilities) {
  const pairs = targets.map((target, index) => ({
    target,
    probability: probabilities[index]
  })).sort((left, right) => left.probability - right.probability);
  const positiveCount = targets.filter((target) => target === 1).length;
  const negativeCount = targets.length - positiveCount;

  if (positiveCount === 0 || negativeCount === 0) {
    return null;
  }

  let rankSum = 0;

  pairs.forEach((pair, index) => {
    if (pair.target === 1) {
      rankSum += index + 1;
    }
  });

  return (rankSum - (positiveCount * (positiveCount + 1)) / 2) / (positiveCount * negativeCount);
}

function calibrationBins(rows, probabilities) {
  const bins = Array.from({ length: 10 }, (_, index) => ({
    binStart: index / 10,
    binEnd: (index + 1) / 10,
    count: 0,
    probabilitySum: 0,
    targetSum: 0
  }));

  probabilities.forEach((probability, index) => {
    const target = rows[index]?.target;

    if (target !== 0 && target !== 1) {
      return;
    }

    const binIndex = Math.min(9, Math.max(0, Math.floor(probability * 10)));
    bins[binIndex].count += 1;
    bins[binIndex].probabilitySum += probability;
    bins[binIndex].targetSum += target;
  });

  const populatedBins = bins
    .filter((bin) => bin.count > 0)
    .map((bin) => {
      const averageProbability = bin.probabilitySum / bin.count;
      const observedRate = bin.targetSum / bin.count;

      return {
        bin: `${Math.round(bin.binStart * 100)}-${Math.round(bin.binEnd * 100)}%`,
        count: bin.count,
        averageProbability: round(averageProbability, 4),
        observedRate: round(observedRate, 4),
        calibrationError: round(Math.abs(averageProbability - observedRate), 4)
      };
    });

  return {
    meanAbsoluteCalibrationError: round(average(populatedBins.map((bin) => bin.calibrationError)), 4),
    bins: populatedBins
  };
}

export function evaluateProbabilities(rows, probabilities) {
  const valid = rows
    .map((row, index) => ({
      target: row.target,
      probability: toNumberOrNull(probabilities[index])
    }))
    .filter((row) => (row.target === 0 || row.target === 1) && typeof row.probability === 'number');

  if (valid.length === 0) {
    return {
      sampleCount: 0,
      brierScore: null,
      logLoss: null,
      auc: null,
      calibration: {
        meanAbsoluteCalibrationError: null,
        bins: []
      }
    };
  }

  const validRows = valid.map((row) => ({ target: row.target }));
  const validProbabilities = valid.map((row) => row.probability);
  const targets = valid.map((row) => row.target);

  return {
    sampleCount: valid.length,
    brierScore: round(average(valid.map((row) => (row.probability - row.target) ** 2)), 6),
    logLoss: round(average(valid.map((row) => probabilityLogLoss(row.probability, row.target))), 6),
    auc: round(aucScore(targets, validProbabilities), 6),
    calibration: calibrationBins(validRows, validProbabilities)
  };
}

function getBaselineProbabilities(rows, key) {
  return rows.map((row) => toNumberOrNull(row.baselineProbabilities?.[key]));
}

function evaluateBaselines(rows) {
  return {
    fusedModel: evaluateProbabilities(rows, getBaselineProbabilities(rows, 'fusedModel')),
    weatherOnly: evaluateProbabilities(rows, getBaselineProbabilities(rows, 'weatherOnly')),
    marketOnly: evaluateProbabilities(rows, getBaselineProbabilities(rows, 'marketOnly'))
  };
}

function splitChronologicalHoldout(rows, holdoutFraction = DEFAULT_HOLDOUT_FRACTION) {
  if (rows.length < 8) {
    return {
      trainRows: rows,
      holdoutRows: rows,
      evaluationScope: 'training'
    };
  }

  const holdoutCount = Math.max(2, Math.min(rows.length - 2, Math.round(rows.length * holdoutFraction)));

  return {
    trainRows: rows.slice(0, rows.length - holdoutCount),
    holdoutRows: rows.slice(rows.length - holdoutCount),
    evaluationScope: 'chronological-holdout'
  };
}

function buildRollingEvaluation(rows, {
  foldCount = DEFAULT_ROLLING_FOLDS,
  minTrainingRows = DEFAULT_MIN_SAMPLES,
  minClassSamples = DEFAULT_MIN_CLASS_SAMPLES,
  holdoutFraction = DEFAULT_HOLDOUT_FRACTION
} = {}) {
  if (foldCount <= 0 || rows.length < minTrainingRows + 2) {
    return {
      foldCount: 0,
      folds: [],
      aggregate: null
    };
  }

  const remainingRows = rows.length - minTrainingRows;
  const foldSize = Math.max(1, Math.floor(remainingRows / foldCount));
  const folds = [];
  const pooledRows = [];
  const pooledProbabilities = [];

  for (let foldIndex = 0; foldIndex < foldCount; foldIndex += 1) {
    const evalStart = minTrainingRows + foldIndex * foldSize;
    const evalEnd = foldIndex === foldCount - 1 ? rows.length : Math.min(rows.length, evalStart + foldSize);
    const trainRows = rows.slice(0, evalStart);
    const evalRows = rows.slice(evalStart, evalEnd);
    const counts = classCounts(trainRows);

    if (
      evalRows.length === 0
      || counts.positiveCount < minClassSamples
      || counts.negativeCount < minClassSamples
    ) {
      continue;
    }

    const fitted = fitModel(trainRows, {
      holdoutFraction
    });
    const probabilities = scoreRowsWithFitted(evalRows, fitted);
    const metrics = evaluateProbabilities(evalRows, probabilities);
    const baselineMetrics = evaluateBaselines(evalRows);

    pooledRows.push(...evalRows);
    pooledProbabilities.push(...probabilities);
    folds.push({
      foldIndex,
      trainCount: trainRows.length,
      evalCount: evalRows.length,
      evalDateFrom: evalRows[0]?.eventDate ?? null,
      evalDateTo: evalRows.at(-1)?.eventDate ?? null,
      metrics,
      baselines: baselineMetrics
    });
  }

  return {
    foldCount: folds.length,
    folds,
    aggregate: folds.length > 0 ? {
      metrics: evaluateProbabilities(pooledRows, pooledProbabilities),
      baselines: evaluateBaselines(pooledRows)
    } : null
  };
}

function computeBlendWeight(sampleCount, holdoutMetrics, baselineMetrics) {
  const modelBrier = holdoutMetrics?.brierScore;
  const fusedBrier = baselineMetrics?.fusedModel?.brierScore;
  let base = clamp(sampleCount / 800, 0.12, 0.65);

  if (typeof modelBrier === 'number' && typeof fusedBrier === 'number') {
    if (modelBrier < fusedBrier) {
      base += 0.08;
    } else {
      base -= 0.08;
    }
  }

  return round(clamp(base, 0.05, 0.72), 4);
}

function insufficientArtifact(reason, rows, options) {
  const counts = classCounts(rows);

  return {
    schemaVersion: 2,
    status: 'insufficient_data',
    reason,
    modelId: `kmdw-tabular-insufficient-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`,
    modelType: 'kmdw-tabular-logistic-regression',
    target: 'kmdw_bucket_actual_outcome',
    trainedAt: new Date().toISOString(),
    featureNames: WEATHER_ML_FEATURE_NAMES,
    training: {
      source: 'chicago-kmdw-supervised-archive',
      sampleCount: rows.length,
      positiveCount: counts.positiveCount,
      negativeCount: counts.negativeCount,
      minSamples: options.minSamples,
      minClassSamples: options.minClassSamples
    },
    metrics: {
      baselines: evaluateBaselines(rows)
    }
  };
}

export function trainTabularWeatherModel(rows, options = {}) {
  const normalizedRows = sortedRows(rows);
  const minSamples = Number.parseInt(String(options.minSamples ?? DEFAULT_MIN_SAMPLES), 10);
  const minClassSamples = Number.parseInt(String(options.minClassSamples ?? DEFAULT_MIN_CLASS_SAMPLES), 10);
  const counts = classCounts(normalizedRows);

  if (normalizedRows.length < minSamples) {
    return insufficientArtifact('not enough settled KMDW training rows', normalizedRows, {
      minSamples,
      minClassSamples
    });
  }

  if (counts.positiveCount < minClassSamples || counts.negativeCount < minClassSamples) {
    return insufficientArtifact('not enough positive and negative KMDW outcomes', normalizedRows, {
      minSamples,
      minClassSamples
    });
  }

  const { trainRows, holdoutRows, evaluationScope } = splitChronologicalHoldout(normalizedRows, options.holdoutFraction);
  const holdoutTrainCounts = classCounts(trainRows);
  const evalFitted = holdoutTrainCounts.positiveCount >= minClassSamples && holdoutTrainCounts.negativeCount >= minClassSamples
    ? fitModel(trainRows, options)
    : fitModel(normalizedRows, options);
  const holdoutProbabilities = scoreRowsWithFitted(holdoutRows, evalFitted);
  const holdoutMetrics = evaluateProbabilities(holdoutRows, holdoutProbabilities);
  const baselineMetrics = evaluateBaselines(holdoutRows);
  const productionFitted = fitModel(normalizedRows, options);
  const rolling = buildRollingEvaluation(normalizedRows, {
    foldCount: Number.parseInt(String(options.rollingFolds ?? DEFAULT_ROLLING_FOLDS), 10),
    minTrainingRows: Math.max(minSamples, Number.parseInt(String(options.minRollingTrainingRows ?? minSamples), 10)),
    minClassSamples,
    holdoutFraction: options.holdoutFraction
  });
  const modelId = `kmdw-tabular-logistic-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
  const coefficients = Object.fromEntries(WEATHER_ML_FEATURE_NAMES.map((featureName, index) => [
    featureName,
    round(productionFitted.coefficients[index], 10)
  ]));
  const dateFrom = normalizedRows[0]?.eventDate ?? null;
  const dateTo = normalizedRows.at(-1)?.eventDate ?? null;

  return {
    schemaVersion: 2,
    status: 'ready',
    modelId,
    modelType: 'kmdw-tabular-logistic-regression',
    target: 'kmdw_bucket_actual_outcome',
    trainedAt: new Date().toISOString(),
    featureNames: WEATHER_ML_FEATURE_NAMES,
    imputationValues: productionFitted.imputationValues,
    featureTransforms: productionFitted.featureTransforms,
    probabilityModel: {
      modelType: 'scaled-logistic-regression',
      intercept: round(productionFitted.intercept, 10),
      coefficients
    },
    blendWeight: computeBlendWeight(normalizedRows.length, holdoutMetrics, baselineMetrics),
    training: {
      source: 'chicago-kmdw-supervised-archive',
      sampleCount: normalizedRows.length,
      trainCount: trainRows.length,
      holdoutCount: holdoutRows.length,
      positiveCount: counts.positiveCount,
      negativeCount: counts.negativeCount,
      minSamples,
      minClassSamples,
      evaluationScope,
      dateFrom,
      dateTo
    },
    metrics: {
      holdout: {
        productionLogistic: holdoutMetrics,
        baselines: baselineMetrics
      },
      rolling
    }
  };
}

export function scoreTrainedWeatherModel(model, features) {
  return scoreWeatherMlOutcome(model, features);
}

export function evaluateWeatherModelArtifact(model, rows) {
  const normalizedRows = sortedRows(rows);
  const probabilities = normalizedRows.map((row) => scoreTrainedWeatherModel(model, row.features)?.probability ?? null);

  return {
    generatedAt: new Date().toISOString(),
    modelId: model?.modelId ?? null,
    modelType: model?.modelType ?? null,
    sampleCount: normalizedRows.length,
    dateFrom: normalizedRows[0]?.eventDate ?? null,
    dateTo: normalizedRows.at(-1)?.eventDate ?? null,
    metrics: {
      productionLogistic: evaluateProbabilities(normalizedRows, probabilities),
      baselines: evaluateBaselines(normalizedRows)
    }
  };
}

function getModelDirectory(env) {
  return path.dirname(env?.weatherMlModelPath ?? path.join(process.cwd(), 'data/models/weather-high-temp-calibrator.json'));
}

function getRegistryPath(env) {
  return env?.weatherMlRegistryPath ?? path.join(getModelDirectory(env), 'weather-model-registry.json');
}

function getEvaluationPath(env) {
  return env?.weatherMlEvaluationPath ?? path.join(getModelDirectory(env), 'weather-model-evaluations.jsonl');
}

async function readJson(pathName, fallback) {
  try {
    return JSON.parse(await fs.readFile(pathName, 'utf8'));
  } catch {
    return fallback;
  }
}

async function appendJsonl(pathName, row) {
  await fs.mkdir(path.dirname(pathName), { recursive: true });
  await fs.appendFile(pathName, `${JSON.stringify(row)}\n`, 'utf8');
}

async function writeJson(pathName, payload) {
  await fs.mkdir(path.dirname(pathName), { recursive: true });
  await fs.writeFile(pathName, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function compactModelRecord(artifact, paths = {}) {
  return {
    modelId: artifact.modelId ?? null,
    status: artifact.status,
    modelType: artifact.modelType ?? null,
    trainedAt: artifact.trainedAt ?? null,
    target: artifact.target ?? null,
    sampleCount: artifact.training?.sampleCount ?? 0,
    positiveCount: artifact.training?.positiveCount ?? 0,
    negativeCount: artifact.training?.negativeCount ?? 0,
    dateFrom: artifact.training?.dateFrom ?? null,
    dateTo: artifact.training?.dateTo ?? null,
    blendWeight: artifact.blendWeight ?? null,
    holdoutBrierScore: artifact.metrics?.holdout?.productionLogistic?.brierScore ?? null,
    rollingBrierScore: artifact.metrics?.rolling?.aggregate?.metrics?.brierScore ?? null,
    canonicalPath: paths.canonicalPath ?? null,
    versionPath: paths.versionPath ?? null
  };
}

async function updateRegistry(env, artifact, paths) {
  const registryPath = getRegistryPath(env);
  const registry = await readJson(registryPath, {
    schemaVersion: 1,
    activeModelId: null,
    models: []
  });
  const record = compactModelRecord(artifact, paths);
  const models = [
    record,
    ...(Array.isArray(registry.models) ? registry.models.filter((model) => model.modelId !== record.modelId) : [])
  ].slice(0, 50);
  const nextRegistry = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    activeModelId: artifact.status === 'ready' ? artifact.modelId : registry.activeModelId ?? null,
    models
  };

  await writeJson(registryPath, nextRegistry);
  return {
    path: registryPath,
    registry: nextRegistry
  };
}

export async function runChicagoWeatherModelTraining(env, options = {}) {
  const trainingRows = await getChicagoModelTrainingRows(env, {
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    limit: options.limit
  });
  const artifact = trainTabularWeatherModel(trainingRows.rows, {
    minSamples: options.minSamples ?? env?.weatherMlMinSamples,
    minClassSamples: options.minClassSamples ?? env?.weatherMlMinClassSamples,
    rollingFolds: options.rollingFolds ?? env?.weatherMlRollingFolds,
    holdoutFraction: options.holdoutFraction ?? env?.weatherMlHoldoutFraction,
    iterations: options.iterations,
    learningRate: options.learningRate,
    l2: options.l2
  });
  const canonicalPath = options.output ?? env?.weatherMlModelPath ?? path.join(process.cwd(), 'data/models/weather-high-temp-calibrator.json');
  const versionPath = path.join(getModelDirectory({ ...env, weatherMlModelPath: canonicalPath }), `${artifact.modelId}.json`);
  const evaluationPath = getEvaluationPath(env);
  const evaluationRecord = compactModelRecord(artifact, {
    canonicalPath,
    versionPath
  });

  await writeJson(versionPath, artifact);
  await writeJson(canonicalPath, artifact);
  await appendJsonl(evaluationPath, {
    ...evaluationRecord,
    generatedAt: new Date().toISOString(),
    metrics: artifact.metrics ?? null
  });
  const registry = await updateRegistry(env, artifact, {
    canonicalPath,
    versionPath
  });

  return {
    ok: artifact.status === 'ready',
    trainingRows: {
      rowCount: trainingRows.rowCount,
      summary: trainingRows.summary,
      storage: trainingRows.storage
    },
    artifact,
    paths: {
      canonicalPath,
      versionPath,
      evaluationPath,
      registryPath: registry.path
    },
    registry: registry.registry
  };
}

export async function evaluateCurrentWeatherModel(env, options = {}) {
  const [model, trainingRows] = await Promise.all([
    loadWeatherMlModel(options.modelPath ? { ...env, weatherMlModelPath: options.modelPath } : env),
    getChicagoModelTrainingRows(env, {
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      limit: options.limit
    })
  ]);

  if (!model) {
    return {
      ok: false,
      reason: 'No weather ML artifact is available.',
      trainingRows: {
        rowCount: trainingRows.rowCount,
        summary: trainingRows.summary
      }
    };
  }

  const evaluation = evaluateWeatherModelArtifact(model, trainingRows.rows);
  const evaluationPath = getEvaluationPath(env);

  await appendJsonl(evaluationPath, {
    ...compactModelRecord(model),
    generatedAt: evaluation.generatedAt,
    evaluation
  });

  return {
    ok: true,
    model: {
      status: model.status,
      modelId: model.modelId,
      modelType: model.modelType,
      trainedAt: model.trainedAt,
      blendWeight: model.blendWeight,
      sampleCount: model.training?.sampleCount ?? null
    },
    trainingRows: {
      rowCount: trainingRows.rowCount,
      summary: trainingRows.summary,
      storage: trainingRows.storage
    },
    evaluation,
    paths: {
      evaluationPath
    }
  };
}

export async function getWeatherModelLifecycle(env) {
  const model = await loadWeatherMlModel(env);
  const registry = await readJson(getRegistryPath(env), {
    schemaVersion: 1,
    activeModelId: null,
    models: []
  });

  return {
    enabled: Boolean(env?.weatherMlModelPath),
    model: model ? {
      status: model.status,
      modelId: model.modelId,
      modelType: model.modelType,
      trainedAt: model.trainedAt,
      blendWeight: model.blendWeight,
      metrics: model.metrics ?? null,
      training: model.training ?? null,
      modelPath: model.modelPath
    } : null,
    registry
  };
}
