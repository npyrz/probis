import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import parquet from 'parquetjs-lite';
import initSqlJs from 'sql.js';

let sqlPromise = null;

const SQLITE_FILE_NAME = 'kmdw-analytics.sqlite';
const PARQUET_DIRECTORY_NAME = 'parquet';

const TABLE_SCHEMAS = {
  kmdw_snapshots: {
    id: { type: 'UTF8' },
    captured_at: { type: 'UTF8', optional: true },
    target_date: { type: 'UTF8', optional: true },
    station_id: { type: 'UTF8', optional: true },
    day_phase: { type: 'UTF8', optional: true },
    observed_high_f: { type: 'DOUBLE', optional: true },
    current_temp_f: { type: 'DOUBLE', optional: true },
    expected_high_f: { type: 'DOUBLE', optional: true },
    confidence: { type: 'DOUBLE', optional: true },
    settlement_status: { type: 'UTF8', optional: true },
    market_status: { type: 'UTF8', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  },
  kmdw_market_snapshots: {
    id: { type: 'UTF8' },
    captured_at: { type: 'UTF8', optional: true },
    target_date: { type: 'UTF8', optional: true },
    market_slug: { type: 'UTF8', optional: true },
    condition_id: { type: 'UTF8', optional: true },
    outcome_label: { type: 'UTF8', optional: true },
    low_temp_f: { type: 'DOUBLE', optional: true },
    high_temp_f: { type: 'DOUBLE', optional: true },
    best_bid: { type: 'DOUBLE', optional: true },
    best_ask: { type: 'DOUBLE', optional: true },
    market_probability: { type: 'DOUBLE', optional: true },
    spread: { type: 'DOUBLE', optional: true },
    bid_depth: { type: 'DOUBLE', optional: true },
    ask_depth: { type: 'DOUBLE', optional: true },
    quote_source: { type: 'UTF8', optional: true },
    source_verified: { type: 'BOOLEAN', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  },
  kmdw_predictions: {
    id: { type: 'UTF8' },
    captured_at: { type: 'UTF8', optional: true },
    prediction_time: { type: 'UTF8', optional: true },
    target_date: { type: 'UTF8', optional: true },
    station_id: { type: 'UTF8', optional: true },
    model_version: { type: 'UTF8', optional: true },
    expected_high_f: { type: 'DOUBLE', optional: true },
    std_dev: { type: 'DOUBLE', optional: true },
    confidence: { type: 'DOUBLE', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  },
  kmdw_trade_recommendations: {
    id: { type: 'UTF8' },
    captured_at: { type: 'UTF8', optional: true },
    target_date: { type: 'UTF8', optional: true },
    market_slug: { type: 'UTF8', optional: true },
    condition_id: { type: 'UTF8', optional: true },
    outcome_label: { type: 'UTF8', optional: true },
    action: { type: 'UTF8', optional: true },
    status: { type: 'UTF8', optional: true },
    fair_probability: { type: 'DOUBLE', optional: true },
    market_price: { type: 'DOUBLE', optional: true },
    edge: { type: 'DOUBLE', optional: true },
    max_entry_price: { type: 'DOUBLE', optional: true },
    suggested_size: { type: 'DOUBLE', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  },
  kmdw_daily_archives: {
    id: { type: 'UTF8' },
    station_id: { type: 'UTF8', optional: true },
    archive_station_id: { type: 'UTF8', optional: true },
    archive_date: { type: 'UTF8', optional: true },
    source: { type: 'UTF8', optional: true },
    max_temp_f: { type: 'DOUBLE', optional: true },
    min_temp_f: { type: 'DOUBLE', optional: true },
    precipitation_in: { type: 'DOUBLE', optional: true },
    snow_in: { type: 'DOUBLE', optional: true },
    fetched_at: { type: 'UTF8', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  },
  kmdw_forecast_vintages: {
    id: { type: 'UTF8' },
    station_id: { type: 'UTF8', optional: true },
    source: { type: 'UTF8', optional: true },
    model: { type: 'UTF8', optional: true },
    target_date: { type: 'UTF8', optional: true },
    valid_time_local: { type: 'UTF8', optional: true },
    lead_days: { type: 'DOUBLE', optional: true },
    forecast_temp_f: { type: 'DOUBLE', optional: true },
    fetched_at: { type: 'UTF8', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  },
  kmdw_historical_market_boards: {
    id: { type: 'UTF8' },
    station_id: { type: 'UTF8', optional: true },
    source: { type: 'UTF8', optional: true },
    date_from: { type: 'UTF8', optional: true },
    date_to: { type: 'UTF8', optional: true },
    contract_count: { type: 'DOUBLE', optional: true },
    token_count: { type: 'DOUBLE', optional: true },
    price_point_count: { type: 'DOUBLE', optional: true },
    trade_count: { type: 'DOUBLE', optional: true },
    board_snapshot_count: { type: 'DOUBLE', optional: true },
    generated_at: { type: 'UTF8', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  },
  kmdw_alerts: {
    id: { type: 'UTF8' },
    station_id: { type: 'UTF8', optional: true },
    event_date: { type: 'UTF8', optional: true },
    alert_key: { type: 'UTF8', optional: true },
    alert_type: { type: 'UTF8', optional: true },
    severity: { type: 'UTF8', optional: true },
    status: { type: 'UTF8', optional: true },
    title: { type: 'UTF8', optional: true },
    message: { type: 'UTF8', optional: true },
    triggered_at: { type: 'UTF8', optional: true },
    resolved_at: { type: 'UTF8', optional: true },
    raw_json: { type: 'UTF8', optional: true }
  }
};

function isEnabled(env) {
  return env?.weatherLocalStoreEnabled !== false;
}

function getWeatherDataDir(env) {
  return env?.weatherDataDir ?? path.join(process.cwd(), 'data/weather');
}

export function getLocalAnalyticsPaths(env = {}) {
  const weatherDataDir = getWeatherDataDir(env);
  return {
    sqlitePath: env?.weatherLocalSqlitePath ?? path.join(weatherDataDir, SQLITE_FILE_NAME),
    parquetDir: env?.weatherLocalParquetDir ?? path.join(weatherDataDir, PARQUET_DIRECTORY_NAME)
  };
}

export function getLocalAnalyticsStoreStatus(env = {}) {
  const paths = getLocalAnalyticsPaths(env);

  return {
    enabled: isEnabled(env),
    storage: 'sqlite-parquet',
    sqlite: {
      enabled: isEnabled(env),
      path: paths.sqlitePath
    },
    parquet: {
      enabled: isEnabled(env) && env?.weatherLocalParquetEnabled !== false,
      path: paths.parquetDir,
      duckdbReadable: true
    },
    tables: Object.keys(TABLE_SCHEMAS)
  };
}

function stableId(...values) {
  return createHash('sha256')
    .update(values.map((value) => String(value ?? '')).join('|'))
    .digest('hex');
}

function nullable(value) {
  return value === undefined ? null : value;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeJson(value) {
  return JSON.stringify(value ?? null);
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }

  return sqlPromise;
}

async function openDatabase(env) {
  const SQL = await getSql();
  const { sqlitePath } = getLocalAnalyticsPaths(env);
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true });

  try {
    const buffer = await fs.readFile(sqlitePath);
    return new SQL.Database(buffer);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    return new SQL.Database();
  }
}

async function saveDatabase(env, db) {
  const { sqlitePath } = getLocalAnalyticsPaths(env);
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
  await fs.writeFile(sqlitePath, Buffer.from(db.export()));
}

function createTableSql(tableName, schema) {
  const columns = Object.entries(schema).map(([name, definition]) => {
    if (name === 'id') {
      return 'id text primary key';
    }

    if (definition.type === 'DOUBLE') {
      return `${name} real`;
    }

    if (definition.type === 'BOOLEAN') {
      return `${name} integer`;
    }

    return `${name} text`;
  });

  return `create table if not exists ${tableName} (${columns.join(', ')})`;
}

function initializeSchema(db) {
  db.run('pragma journal_mode = delete');

  for (const [tableName, schema] of Object.entries(TABLE_SCHEMAS)) {
    db.run(createTableSql(tableName, schema));
  }
}

function insertRows(db, tableName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  const columns = Object.keys(TABLE_SCHEMAS[tableName]);
  const placeholders = columns.map(() => '?').join(',');
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column}=excluded.${column}`)
    .join(',');
  const statement = db.prepare(`
    insert into ${tableName} (${columns.join(',')})
    values (${placeholders})
    on conflict(id) do update set ${updates}
  `);

  try {
    for (const row of rows) {
      statement.run(columns.map((column) => {
        const value = row[column];
        return typeof value === 'boolean' ? (value ? 1 : 0) : nullable(value);
      }));
    }
  } finally {
    statement.free();
  }

  return rows.length;
}

function rowsFromExecResult(result) {
  const table = result?.[0];

  if (!table) {
    return [];
  }

  return table.values.map((values) => Object.fromEntries(
    table.columns.map((column, index) => [column, values[index]])
  ));
}

function normalizeParquetRow(schema, row) {
  return Object.fromEntries(Object.entries(schema).map(([column, definition]) => {
    const value = row[column];

    if (value === undefined || value === null) {
      return [column, null];
    }

    if (definition.type === 'DOUBLE') {
      return [column, numberOrNull(value)];
    }

    if (definition.type === 'BOOLEAN') {
      return [column, value === true || value === 1 || value === '1'];
    }

    return [column, String(value)];
  }));
}

async function exportParquetTables(env, db, tableNames) {
  if (env?.weatherLocalParquetEnabled === false) {
    return {
      enabled: false,
      reason: 'WEATHER_LOCAL_PARQUET_ENABLED=false'
    };
  }

  const { parquetDir } = getLocalAnalyticsPaths(env);
  await fs.mkdir(parquetDir, { recursive: true });
  const files = [];

  for (const tableName of tableNames) {
    const schema = TABLE_SCHEMAS[tableName];
    const rows = rowsFromExecResult(db.exec(`select * from ${tableName} order by id asc`));
    const file = path.join(parquetDir, `${tableName}.parquet`);
    const writer = await parquet.ParquetWriter.openFile(new parquet.ParquetSchema(schema), file);

    try {
      for (const row of rows) {
        await writer.appendRow(normalizeParquetRow(schema, row));
      }
    } finally {
      await writer.close();
    }

    files.push({
      table: tableName,
      file,
      rowCount: rows.length
    });
  }

  return {
    enabled: true,
    duckdbReadable: true,
    directory: parquetDir,
    files
  };
}

async function writeLocalAnalytics(env, rowsByTable) {
  if (!isEnabled(env)) {
    return {
      enabled: false,
      reason: 'WEATHER_LOCAL_STORE_ENABLED=false'
    };
  }

  const db = await openDatabase(env);
  const tables = Object.keys(rowsByTable).filter((tableName) => TABLE_SCHEMAS[tableName]);
  const rowCounts = {};

  try {
    initializeSchema(db);

    for (const tableName of tables) {
      rowCounts[tableName] = insertRows(db, tableName, rowsByTable[tableName]);
    }

    const parquetResult = await exportParquetTables(env, db, tables);
    await saveDatabase(env, db);
    const paths = getLocalAnalyticsPaths(env);

    return {
      enabled: true,
      storage: 'sqlite-parquet',
      sqlite: {
        path: paths.sqlitePath,
        tableRowWrites: rowCounts
      },
      parquet: parquetResult
    };
  } finally {
    db.close();
  }
}

export async function safelyWriteLocalAnalytics(env, rowsByTable) {
  try {
    return await writeLocalAnalytics(env, rowsByTable);
  } catch (error) {
    return {
      enabled: false,
      storage: 'sqlite-parquet',
      error: error instanceof Error ? error.message : 'Unable to write local analytics store'
    };
  }
}

export async function persistLocalChicagoSnapshot(env, snapshot) {
  const capturedAt = snapshot?.generatedAt ?? new Date().toISOString();
  const targetDate = snapshot?.targetDate ?? null;
  const stationId = snapshot?.station?.stationId ?? snapshot?.prediction?.stationId ?? 'KMDW';
  const prediction = snapshot?.prediction ?? {};
  const observations = snapshot?.observations ?? {};

  return safelyWriteLocalAnalytics(env, {
    kmdw_snapshots: [{
      id: stableId('snapshot', targetDate, capturedAt),
      captured_at: capturedAt,
      target_date: targetDate,
      station_id: stationId,
      day_phase: prediction.dayPhase ?? null,
      observed_high_f: numberOrNull(observations.observedHighSoFar),
      current_temp_f: numberOrNull(observations.currentObservedTemp),
      expected_high_f: numberOrNull(prediction.expectedHigh),
      confidence: numberOrNull(prediction.confidence),
      settlement_status: snapshot?.settlement?.status ?? null,
      market_status: snapshot?.markets?.status ?? null,
      raw_json: safeJson(snapshot)
    }],
    kmdw_market_snapshots: (Array.isArray(snapshot?.markets?.buckets) ? snapshot.markets.buckets : []).map((bucket) => ({
      id: stableId('market', targetDate, capturedAt, bucket.conditionId ?? bucket.marketSlug),
      captured_at: capturedAt,
      target_date: targetDate,
      market_slug: bucket.marketSlug ?? null,
      condition_id: bucket.conditionId ?? null,
      outcome_label: bucket.outcomeLabel ?? null,
      low_temp_f: numberOrNull(bucket.lowTemp),
      high_temp_f: numberOrNull(bucket.highTemp),
      best_bid: numberOrNull(bucket.bestBid),
      best_ask: numberOrNull(bucket.bestAsk),
      market_probability: numberOrNull(bucket.marketProbability ?? bucket.midpoint),
      spread: numberOrNull(bucket.spread),
      bid_depth: numberOrNull(bucket.bidDepth),
      ask_depth: numberOrNull(bucket.askDepth),
      quote_source: bucket.bookSource ?? bucket.quoteSource ?? null,
      source_verified: bucket.designatedSource?.verified ?? null,
      raw_json: safeJson(bucket)
    })),
    kmdw_predictions: prediction ? [{
      id: stableId('prediction', targetDate, capturedAt),
      captured_at: capturedAt,
      prediction_time: prediction.predictionTime ?? capturedAt,
      target_date: targetDate,
      station_id: prediction.stationId ?? stationId,
      model_version: prediction.modelVersion ?? null,
      expected_high_f: numberOrNull(prediction.expectedHigh),
      std_dev: numberOrNull(prediction.stdDev),
      confidence: numberOrNull(prediction.confidence),
      raw_json: safeJson(prediction)
    }] : [],
    kmdw_trade_recommendations: (Array.isArray(snapshot?.recommendations?.recommendations) ? snapshot.recommendations.recommendations : []).map((recommendation) => ({
      id: stableId('recommendation', targetDate, capturedAt, recommendation.conditionId ?? recommendation.marketSlug),
      captured_at: capturedAt,
      target_date: targetDate,
      market_slug: recommendation.marketSlug ?? null,
      condition_id: recommendation.conditionId ?? null,
      outcome_label: recommendation.outcomeLabel ?? null,
      action: recommendation.action ?? null,
      status: recommendation.status ?? null,
      fair_probability: numberOrNull(recommendation.fairProbability),
      market_price: numberOrNull(recommendation.marketPrice),
      edge: numberOrNull(recommendation.edge),
      max_entry_price: numberOrNull(recommendation.maxEntryPrice),
      suggested_size: numberOrNull(recommendation.suggestedSize),
      raw_json: safeJson(recommendation)
    }))
  });
}

export async function persistLocalChicagoDailyArchive(env, records) {
  return safelyWriteLocalAnalytics(env, {
    kmdw_daily_archives: (Array.isArray(records) ? records : []).map((record) => ({
      id: stableId('archive', record.stationId, record.archiveDate, record.source),
      station_id: record.stationId ?? 'KMDW',
      archive_station_id: record.archiveStationId ?? null,
      archive_date: record.archiveDate ?? null,
      source: record.source ?? null,
      max_temp_f: numberOrNull(record.maxTempF),
      min_temp_f: numberOrNull(record.minTempF),
      precipitation_in: numberOrNull(record.precipitationIn),
      snow_in: numberOrNull(record.snowIn),
      fetched_at: record.fetchedAt ?? null,
      raw_json: safeJson(record)
    }))
  });
}

export async function persistLocalChicagoForecastVintages(env, records) {
  return safelyWriteLocalAnalytics(env, {
    kmdw_forecast_vintages: (Array.isArray(records) ? records : []).map((record) => ({
      id: stableId('forecast-vintage', record.stationId, record.source, record.model, record.targetDate, record.validTimeLocal, record.leadDays),
      station_id: record.stationId ?? 'KMDW',
      source: record.source ?? null,
      model: record.model ?? null,
      target_date: record.targetDate ?? null,
      valid_time_local: record.validTimeLocal ?? null,
      lead_days: numberOrNull(record.leadDays),
      forecast_temp_f: numberOrNull(record.forecastTempF),
      fetched_at: record.fetchedAt ?? null,
      raw_json: safeJson(record)
    }))
  });
}

export async function persistLocalChicagoHistoricalMarketBoards(env, archive) {
  const summary = archive?.summary ?? {};

  return safelyWriteLocalAnalytics(env, {
    kmdw_historical_market_boards: [{
      id: stableId('historical-board', archive?.stationId, archive?.source, archive?.dateFrom, archive?.dateTo, archive?.startTs, archive?.endTs),
      station_id: archive?.stationId ?? 'KMDW',
      source: archive?.source ?? 'polymarket-historical-board-reconstruction',
      date_from: archive?.dateFrom ?? null,
      date_to: archive?.dateTo ?? null,
      contract_count: numberOrNull(summary.contractCount),
      token_count: numberOrNull(summary.tokenCount),
      price_point_count: numberOrNull(summary.pricePointCount),
      trade_count: numberOrNull(summary.tradeCount),
      board_snapshot_count: numberOrNull(summary.boardSnapshotCount),
      generated_at: archive?.generatedAt ?? null,
      raw_json: safeJson(archive)
    }]
  });
}

export async function persistLocalChicagoAlerts(env, alerts) {
  return safelyWriteLocalAnalytics(env, {
    kmdw_alerts: (Array.isArray(alerts) ? alerts : []).map((alert) => ({
      id: alert.id ?? stableId('alert', alert.eventDate, alert.alertKey, alert.triggeredAt),
      station_id: alert.stationId ?? 'KMDW',
      event_date: alert.eventDate ?? null,
      alert_key: alert.alertKey ?? null,
      alert_type: alert.type ?? alert.alertType ?? null,
      severity: alert.severity ?? null,
      status: alert.status ?? 'active',
      title: alert.title ?? null,
      message: alert.message ?? null,
      triggered_at: alert.triggeredAt ?? null,
      resolved_at: alert.resolvedAt ?? null,
      raw_json: safeJson(alert.raw ?? alert)
    }))
  });
}
