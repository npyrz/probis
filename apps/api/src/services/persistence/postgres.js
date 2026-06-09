import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  getLocalAnalyticsStoreStatus,
  persistLocalChicagoAlerts,
  persistLocalChicagoDailyArchive,
  persistLocalChicagoForecastVintages,
  persistLocalChicagoHistoricalMarketBoards,
  persistLocalChicagoSnapshot
} from './local-analytics.js';

let pool = null;
let initPromise = null;
let postgresRetryAfter = 0;
let lastPostgresFailureReason = null;

const CHICAGO_SNAPSHOTS_FILE = 'chicago-snapshots.jsonl';
const CHICAGO_DAILY_ARCHIVE_FILE = 'chicago-daily-archive.jsonl';
const CHICAGO_FORECAST_VINTAGES_FILE = 'chicago-forecast-vintages.jsonl';
const CHICAGO_HISTORICAL_BOARDS_FILE = 'chicago-historical-boards.jsonl';
const CHICAGO_ALERTS_FILE = 'chicago-alerts.jsonl';
const POSTGRES_RETRY_DELAY_MS = 60_000;

function isConfigured(env) {
  return Boolean(env?.databaseUrl);
}

async function getPool(env) {
  if (!isConfigured(env)) {
    return null;
  }

  if (!pool) {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString: env.databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000
    });
  }

  return pool;
}

async function query(env, text, params = []) {
  const activePool = await getPool(env);

  if (!activePool) {
    return null;
  }

  return activePool.query(text, params);
}

export async function initializePersistence(env) {
  if (!isConfigured(env)) {
    return {
      enabled: false,
      reason: 'DATABASE_URL is not configured.',
      localAnalytics: getLocalAnalyticsStoreStatus(env)
    };
  }

  if (postgresRetryAfter > Date.now()) {
    return {
      enabled: false,
      reason: lastPostgresFailureReason ?? 'Postgres is temporarily unavailable.',
      localAnalytics: getLocalAnalyticsStoreStatus(env)
    };
  }

  if (!initPromise) {
    initPromise = (async () => {
      await query(env, `
        create table if not exists markets (
          id text primary key,
          polymarket_event_id text,
          slug text,
          question text,
          location_name text,
          station_id text,
          resolution_source text,
          market_date date,
          timezone text,
          status text,
          created_at timestamptz default now(),
          updated_at timestamptz default now()
        );

        create table if not exists outcomes (
          id text primary key,
          market_id text references markets(id) on delete cascade,
          label text,
          lower_temp numeric,
          upper_temp numeric,
          token_id text,
          market_price numeric,
          best_bid numeric,
          best_ask numeric,
          spread numeric,
          liquidity numeric,
          updated_at timestamptz default now()
        );

        create table if not exists weather_snapshots (
          id text primary key,
          market_id text references markets(id) on delete cascade,
          station_id text,
          timestamp timestamptz,
          observed_temp numeric,
          observed_high_so_far numeric,
          nws_forecast_high numeric,
          openmeteo_forecast_high numeric,
          historical_high numeric,
          recent_station_bias numeric,
          humidity numeric,
          wind_speed numeric,
          cloud_cover numeric,
          raw_json jsonb,
          created_at timestamptz default now()
        );

        create table if not exists predictions (
          id text primary key,
          market_id text references markets(id) on delete cascade,
          outcome_id text references outcomes(id) on delete cascade,
          timestamp timestamptz,
          station_id text,
          expected_high numeric,
          distribution_json jsonb,
          best_outcome text,
          model_probability numeric,
          market_probability numeric,
          edge numeric,
          confidence numeric,
          feature_json jsonb,
          model_version text,
          actual_high numeric,
          actual_outcome boolean,
          settled_at timestamptz,
          created_at timestamptz default now()
        );

        create table if not exists trades_or_alerts (
          id text primary key,
          market_id text references markets(id) on delete cascade,
          outcome_id text references outcomes(id) on delete set null,
          side text,
          price numeric,
          model_probability numeric,
          edge numeric,
          paper_trade boolean default true,
          status text default 'open',
          created_at timestamptz default now()
        );

        create table if not exists chicago_market_snapshots (
          id text primary key,
          market_slug text,
          condition_id text,
          event_date date,
          outcome_label text,
          low_temp numeric,
          high_temp numeric,
          best_bid numeric,
          best_ask numeric,
          last_price numeric,
          spread numeric,
          bid_depth numeric,
          ask_depth numeric,
          liquidity numeric,
          volume numeric,
          quote_source text,
          rule_text_hash text,
          rule_ambiguity boolean,
          has_kmdw_source boolean,
          source_verified boolean,
          source_verification_status text,
          designated_station_id text,
          designated_source_provider text,
          source_trade_gate text,
          captured_at timestamptz not null,
          raw_json jsonb
        );

        create index if not exists chicago_market_snapshots_event_date_idx
          on chicago_market_snapshots(event_date, captured_at desc);

        create table if not exists chicago_station_diagnostics (
          id text primary key,
          event_date date,
          primary_station_id text not null,
          comparison_station_id text not null,
          current_temp_f numeric,
          observed_high_so_far numeric,
          current_spread_f numeric,
          high_spread_f numeric,
          risk_level text,
          latest_observation_at timestamptz,
          captured_at timestamptz default now(),
          raw_json jsonb
        );

        create index if not exists chicago_station_diagnostics_event_date_idx
          on chicago_station_diagnostics(event_date, captured_at desc);

        create table if not exists chicago_observations (
          id text primary key,
          station_id text not null,
          observed_at timestamptz not null,
          temp_f numeric,
          dewpoint_f numeric,
          wind_speed numeric,
          wind_direction numeric,
          raw_metar text,
          raw_json jsonb,
          captured_at timestamptz default now(),
          unique(station_id, observed_at)
        );

        create table if not exists chicago_forecast_snapshots (
          id text primary key,
          station_id text not null,
          source text not null,
          issue_time text,
          valid_start timestamptz not null,
          valid_end timestamptz not null,
          forecast_temp numeric,
          dew_point numeric,
          wind_speed numeric,
          wind_direction numeric,
          cloud_cover numeric,
          precip_prob numeric,
          pressure numeric,
          raw_json jsonb,
          captured_at timestamptz default now(),
          unique(station_id, source, valid_start, valid_end)
        );

        create table if not exists chicago_settlements (
          id text primary key,
          station_id text not null,
          cli_product text not null,
          cli_date date not null,
          max_temp_f numeric,
          source_text_hash text,
          source_url text,
          settled_at timestamptz,
          raw_text text,
          captured_at timestamptz default now(),
          unique(station_id, cli_product, cli_date)
        );

        create table if not exists chicago_daily_archives (
          id text primary key,
          station_id text not null,
          archive_station_id text,
          archive_date date not null,
          source text not null,
          max_temp_f numeric,
          min_temp_f numeric,
          precipitation_in numeric,
          snow_in numeric,
          fetched_at timestamptz,
          raw_json jsonb,
          captured_at timestamptz default now(),
          unique(station_id, archive_date, source)
        );

        create index if not exists chicago_daily_archives_date_idx
          on chicago_daily_archives(archive_date, station_id);

        create table if not exists chicago_forecast_vintages (
          id text primary key,
          station_id text not null,
          source text not null,
          model text not null,
          target_date date not null,
          valid_time_local text not null,
          lead_days int not null,
          forecast_temp_f numeric,
          fetched_at timestamptz,
          raw_json jsonb,
          captured_at timestamptz default now(),
          unique(station_id, source, model, target_date, valid_time_local, lead_days)
        );

        create index if not exists chicago_forecast_vintages_target_lead_idx
          on chicago_forecast_vintages(target_date, lead_days);

        create table if not exists chicago_historical_market_boards (
          id text primary key,
          station_id text not null,
          source text not null,
          date_from date not null,
          date_to date not null,
          start_ts bigint,
          end_ts bigint,
          contract_count int,
          token_count int,
          price_point_count int,
          trade_count int,
          board_snapshot_count int,
          generated_at timestamptz,
          raw_json jsonb,
          captured_at timestamptz default now(),
          unique(station_id, source, date_from, date_to, start_ts, end_ts)
        );

        create index if not exists chicago_historical_market_boards_date_idx
          on chicago_historical_market_boards(date_from, date_to, station_id);

        create table if not exists chicago_alerts (
          id text primary key,
          station_id text not null default 'KMDW',
          event_date date,
          alert_key text not null,
          alert_type text not null,
          severity text not null,
          status text not null default 'active',
          title text not null,
          message text,
          triggered_at timestamptz not null,
          acknowledged_at timestamptz,
          resolved_at timestamptz,
          raw_json jsonb,
          created_at timestamptz default now(),
          updated_at timestamptz default now()
        );

        create index if not exists chicago_alerts_event_status_idx
          on chicago_alerts(event_date, status, triggered_at desc);

        create table if not exists chicago_predictions (
          id text primary key,
          prediction_time timestamptz not null,
          event_date date not null,
          station_id text not null,
          model_version text,
          expected_high numeric,
          std_dev numeric,
          temperature_distribution_json jsonb,
          bucket_probabilities_json jsonb,
          confidence_score numeric,
          source_freshness_json jsonb,
          raw_json jsonb,
          captured_at timestamptz default now()
        );

        create index if not exists chicago_predictions_event_date_idx
          on chicago_predictions(event_date, prediction_time desc);

        create table if not exists chicago_trade_recommendations (
          id text primary key,
          prediction_id text references chicago_predictions(id) on delete set null,
          market_slug text,
          condition_id text,
          outcome_label text,
          action text,
          fair_probability numeric,
          market_price numeric,
          edge numeric,
          max_entry_price numeric,
          suggested_size numeric,
          status text,
          reason text,
          raw_json jsonb,
          captured_at timestamptz default now()
        );

        alter table predictions add column if not exists feature_json jsonb;
        alter table predictions add column if not exists model_version text;
        alter table weather_snapshots add column if not exists historical_high numeric;
        alter table chicago_market_snapshots add column if not exists bid_depth numeric;
        alter table chicago_market_snapshots add column if not exists ask_depth numeric;
        alter table chicago_market_snapshots add column if not exists quote_source text;
        alter table chicago_market_snapshots add column if not exists rule_text_hash text;
        alter table chicago_market_snapshots add column if not exists rule_ambiguity boolean;
        alter table chicago_market_snapshots add column if not exists has_kmdw_source boolean;
        alter table chicago_market_snapshots add column if not exists source_verified boolean;
        alter table chicago_market_snapshots add column if not exists source_verification_status text;
        alter table chicago_market_snapshots add column if not exists designated_station_id text;
        alter table chicago_market_snapshots add column if not exists designated_source_provider text;
        alter table chicago_market_snapshots add column if not exists source_trade_gate text;
      `);

      return {
        enabled: true,
        localAnalytics: getLocalAnalyticsStoreStatus(env)
      };
    })();
  }

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    const message = error instanceof Error ? String(error.message ?? '').trim() : '';
    lastPostgresFailureReason = message || 'Postgres initialization failed.';
    postgresRetryAfter = Date.now() + POSTGRES_RETRY_DELAY_MS;
    return {
      enabled: false,
      reason: lastPostgresFailureReason,
      localAnalytics: getLocalAnalyticsStoreStatus(env)
    };
  }
}

function buildMarketId(eventSlug, conditionId) {
  return `${String(eventSlug ?? 'event').trim()}:${String(conditionId ?? randomUUID()).trim()}`;
}

function buildOutcomeId(marketId, label) {
  return `${marketId}:${String(label ?? 'outcome').trim().toLowerCase()}`;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getRange(outcome) {
  return outcome?.features?.weatherOutcomeRange ?? null;
}

function rangeContains(value, range) {
  if (!range || typeof value !== 'number') {
    return null;
  }

  if (typeof range.min === 'number' && (range.inclusiveMin === false ? value <= range.min : value < range.min)) {
    return false;
  }

  if (typeof range.max === 'number' && (range.inclusiveMax === false ? value >= range.max : value > range.max)) {
    return false;
  }

  return true;
}

function shouldSettleSnapshot(snapshot) {
  const targetDate = snapshot?.targetDate;

  if (!targetDate || typeof snapshot?.observedHighSoFar !== 'number') {
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  return targetDate < today;
}

export async function persistEventAnalytics(env, analytics) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return init;
  }

  const event = analytics?.event ?? {};
  const statisticalMarkets = Array.isArray(analytics?.statisticalModel?.markets)
    ? analytics.statisticalModel.markets
    : [];
  const marketsByConditionId = new Map(
    (Array.isArray(event?.markets) ? event.markets : []).map((market) => [market.conditionId, market])
  );
  const timestamp = analytics?.statisticalModel?.generatedAt ?? analytics?.aggregation?.generatedAt ?? new Date().toISOString();

  for (const modelMarket of statisticalMarkets) {
    const sourceMarket = marketsByConditionId.get(modelMarket.conditionId) ?? {};
    const weather = modelMarket.weatherContext ?? {};
    const snapshot = modelMarket.weatherSnapshot ?? {};
    const marketId = buildMarketId(event.slug, modelMarket.conditionId);

    await query(env, `
      insert into markets (
        id, polymarket_event_id, slug, question, location_name, station_id,
        resolution_source, market_date, timezone, status, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      on conflict (id) do update set
        polymarket_event_id = excluded.polymarket_event_id,
        slug = excluded.slug,
        question = excluded.question,
        location_name = excluded.location_name,
        station_id = excluded.station_id,
        resolution_source = excluded.resolution_source,
        market_date = excluded.market_date,
        timezone = excluded.timezone,
        status = excluded.status,
        updated_at = now()
    `, [
      marketId,
      event.id ?? null,
      sourceMarket.slug ?? event.slug ?? null,
      modelMarket.question ?? sourceMarket.question ?? null,
      weather.location ?? null,
      snapshot.stationId ?? weather.stationCode ?? null,
      weather.resolutionSourceUrl ?? weather.resolutionSourceName ?? null,
      snapshot.targetDate ?? weather.targetDate ?? null,
      snapshot.timezone ?? null,
      snapshot.status ?? (event.closed ? 'closed' : 'active')
    ]);

    if (snapshot?.stationId || snapshot?.observedHighSoFar !== undefined) {
      await query(env, `
        insert into weather_snapshots (
          id, market_id, station_id, timestamp, observed_temp, observed_high_so_far,
          nws_forecast_high, openmeteo_forecast_high, historical_high,
          recent_station_bias, humidity, wind_speed, cloud_cover, raw_json
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [
        randomUUID(),
        marketId,
        snapshot.stationId ?? weather.stationCode ?? null,
        snapshot.generatedAt ?? timestamp,
        toNumberOrNull(snapshot.currentObservedTemp),
        toNumberOrNull(snapshot.observedHighSoFar),
        toNumberOrNull(snapshot.nwsForecastHigh),
        toNumberOrNull(snapshot.openMeteoForecastHigh),
        toNumberOrNull(snapshot.historicalHighForSameDay),
        toNumberOrNull(snapshot.recentStationBias),
        toNumberOrNull(snapshot.humidity),
        toNumberOrNull(snapshot.windSpeedMph),
        toNumberOrNull(snapshot.cloudCover),
        JSON.stringify(snapshot)
      ]);
    }

    for (const outcome of (Array.isArray(modelMarket.outcomes) ? modelMarket.outcomes : [])) {
      const range = getRange(outcome);
      const outcomeId = buildOutcomeId(marketId, outcome.label);
      const actualHigh = shouldSettleSnapshot(snapshot) ? snapshot.observedHighSoFar : null;
      const actualOutcome = typeof actualHigh === 'number' ? rangeContains(actualHigh, range) : null;

      await query(env, `
        insert into outcomes (
          id, market_id, label, lower_temp, upper_temp, token_id, market_price,
          best_bid, best_ask, spread, liquidity, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        on conflict (id) do update set
          label = excluded.label,
          lower_temp = excluded.lower_temp,
          upper_temp = excluded.upper_temp,
          token_id = excluded.token_id,
          market_price = excluded.market_price,
          best_bid = excluded.best_bid,
          best_ask = excluded.best_ask,
          spread = excluded.spread,
          liquidity = excluded.liquidity,
          updated_at = now()
      `, [
        outcomeId,
        marketId,
        outcome.label ?? null,
        toNumberOrNull(range?.min),
        toNumberOrNull(range?.max),
        outcome.tokenId ?? null,
        toNumberOrNull(outcome.currentProbability),
        toNumberOrNull(outcome.bestBid ?? outcome.features?.bestBid),
        toNumberOrNull(outcome.bestAsk ?? outcome.features?.bestAsk),
        toNumberOrNull(outcome.spread ?? outcome.features?.spread),
        toNumberOrNull(sourceMarket.liquidity)
      ]);

      await query(env, `
        insert into predictions (
          id, market_id, outcome_id, timestamp, station_id, expected_high,
          distribution_json, best_outcome, model_probability, market_probability,
          edge, confidence, feature_json, model_version, actual_high, actual_outcome,
          settled_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      `, [
        randomUUID(),
        marketId,
        outcomeId,
        timestamp,
        snapshot.stationId ?? weather.stationCode ?? null,
        toNumberOrNull(modelMarket.weatherPrediction?.expectedHigh ?? snapshot.model?.expectedHigh),
        JSON.stringify(modelMarket.weatherPrediction?.adjustedOutcomeProbabilities ?? modelMarket.weatherPrediction?.outcomeProbabilities ?? {}),
        modelMarket.opportunity?.label ?? null,
        toNumberOrNull(outcome.estimatedProbability),
        toNumberOrNull(outcome.currentProbability),
        toNumberOrNull(outcome.edge),
        toNumberOrNull(outcome.confidence ?? modelMarket.confidence),
        JSON.stringify(outcome.features ?? {}),
        outcome.features?.weatherMlModelId
          ?? modelMarket.weatherPrediction?.weatherMlModel?.modelId
          ?? modelMarket.weatherPrediction?.modelFamily
          ?? null,
        toNumberOrNull(actualHigh),
        actualOutcome,
        actualOutcome === null ? null : new Date().toISOString()
      ]);
    }
  }

  return {
    enabled: true
  };
}

export async function persistPaperOpportunities(env, opportunities) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return init;
  }

  for (const opportunity of (Array.isArray(opportunities) ? opportunities : [])) {
    const marketId = buildMarketId(opportunity.eventSlug, opportunity.conditionId);
    const outcomeId = buildOutcomeId(marketId, opportunity.outcomeLabel);

    await query(env, `
      insert into trades_or_alerts (
        id, market_id, outcome_id, side, price, model_probability, edge, paper_trade, status
      ) values ($1,$2,$3,$4,$5,$6,$7,true,'open')
    `, [
      randomUUID(),
      marketId,
      outcomeId,
      'buy-yes',
      toNumberOrNull(opportunity.currentProbability),
      toNumberOrNull(opportunity.modelProbability),
      toNumberOrNull(opportunity.edge)
    ]);
  }

  return {
    enabled: true
  };
}

export async function getMlCalibrationStats(env, { stationId = null } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return {
      enabled: false,
      sampleCount: 0,
      probabilityBias: 0,
      expectedHighBias: 0
    };
  }

  const result = await query(env, `
    select
      count(*)::int as sample_count,
      avg((case when actual_outcome then 1.0 else 0.0 end) - model_probability)::float as probability_bias,
      avg(actual_high - expected_high)::float as expected_high_bias
    from predictions
    where actual_outcome is not null
      and model_probability is not null
      and ($1::text is null or station_id = $1)
  `, [stationId]);
  const row = result?.rows?.[0] ?? {};

  return {
    enabled: true,
    sampleCount: Number(row.sample_count ?? 0),
    probabilityBias: toNumberOrNull(row.probability_bias) ?? 0,
    expectedHighBias: toNumberOrNull(row.expected_high_bias) ?? 0
  };
}

export async function getPaperTradingAccuracy(env) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return {
      enabled: false,
      reason: init.reason,
      settledPredictionCount: 0,
      brierScore: null,
      accuracy: null,
      averageEdge: null
    };
  }

  const result = await query(env, `
    select
      count(*)::int as settled_prediction_count,
      avg(power(model_probability - case when actual_outcome then 1.0 else 0.0 end, 2))::float as brier_score,
      avg(case
        when (model_probability >= 0.5 and actual_outcome) or (model_probability < 0.5 and not actual_outcome)
        then 1.0 else 0.0
      end)::float as accuracy,
      avg(edge)::float as average_edge
    from predictions
    where actual_outcome is not null and model_probability is not null
  `);
  const row = result?.rows?.[0] ?? {};

  return {
    enabled: true,
    settledPredictionCount: Number(row.settled_prediction_count ?? 0),
    brierScore: toNumberOrNull(row.brier_score),
    accuracy: toNumberOrNull(row.accuracy),
    averageEdge: toNumberOrNull(row.average_edge)
  };
}

function safeJson(value) {
  return JSON.stringify(value ?? null);
}

function getWeatherDataDir(env) {
  return env?.weatherDataDir ?? path.join(process.cwd(), 'data/weather');
}

async function appendJsonl(env, fileName, row) {
  const directory = getWeatherDataDir(env);
  await fs.mkdir(directory, { recursive: true });
  await fs.appendFile(path.join(directory, fileName), `${JSON.stringify(row)}\n`, 'utf8');
}

async function writeJsonl(env, fileName, rows) {
  const directory = getWeatherDataDir(env);
  await fs.mkdir(directory, { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(path.join(directory, fileName), content ? `${content}\n` : '', 'utf8');
}

async function readJsonl(env, fileName) {
  try {
    const content = await fs.readFile(path.join(getWeatherDataDir(env), fileName), 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function persistChicagoSnapshotToFiles(env, snapshot, reason = null) {
  const capturedAt = snapshot?.generatedAt ?? new Date().toISOString();
  const localAnalytics = await persistLocalChicagoSnapshot(env, snapshot);

  await appendJsonl(env, CHICAGO_SNAPSHOTS_FILE, {
    capturedAt,
    targetDate: snapshot?.targetDate ?? null,
    snapshot
  });

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason,
    file: path.join(getWeatherDataDir(env), CHICAGO_SNAPSHOTS_FILE),
    localAnalytics
  };
}

function snapshotRows(records, date = null) {
  return records
    .map((record) => record?.snapshot ?? null)
    .filter(Boolean)
    .filter((snapshot) => !date || snapshot.targetDate === date)
    .sort((left, right) => String(right.generatedAt ?? '').localeCompare(String(left.generatedAt ?? '')));
}

function marketSnapshotRows(snapshots) {
  return snapshots.flatMap((snapshot) => (Array.isArray(snapshot?.markets?.buckets) ? snapshot.markets.buckets : []).map((bucket) => ({
    market_slug: bucket.marketSlug ?? null,
    condition_id: bucket.conditionId ?? null,
    event_date: snapshot.targetDate ?? null,
    outcome_label: bucket.outcomeLabel ?? null,
    low_temp: bucket.lowTemp ?? null,
    high_temp: bucket.highTemp ?? null,
    best_bid: bucket.bestBid ?? null,
    best_ask: bucket.bestAsk ?? null,
    last_price: bucket.marketProbability ?? bucket.midpoint ?? null,
    spread: bucket.spread ?? null,
    bid_depth: bucket.bidDepth ?? null,
    ask_depth: bucket.askDepth ?? null,
    liquidity: bucket.liquidity ?? null,
    volume: bucket.volume ?? null,
    quote_source: bucket.bookSource ?? bucket.quoteSource ?? null,
    rule_text_hash: bucket.rulesTextHash ?? bucket.designatedSource?.sourceTextHash ?? null,
    rule_ambiguity: bucket.ruleFlags?.ruleAmbiguity ?? null,
    has_kmdw_source: bucket.ruleFlags?.hasKmdwSource ?? null,
    source_verified: bucket.designatedSource?.verified ?? null,
    source_verification_status: bucket.designatedSource?.verificationStatus ?? null,
    designated_station_id: bucket.designatedSource?.stationId ?? null,
    designated_source_provider: bucket.designatedSource?.provider ?? null,
    source_trade_gate: bucket.designatedSource?.tradeGate ?? null,
    captured_at: snapshot.generatedAt ?? null,
    raw_json: bucket
  })));
}

function normalizeAuditDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}

function normalizeAuditTimestamp(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizeAuditBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }
  }

  return null;
}

function latestAuditRow(left, right) {
  const leftTime = Date.parse(left?.capturedAt ?? '');
  const rightTime = Date.parse(right?.capturedAt ?? '');

  if (!Number.isFinite(leftTime)) {
    return right;
  }

  if (!Number.isFinite(rightTime)) {
    return left;
  }

  return rightTime >= leftTime ? right : left;
}

function isPaperSignalGate(value) {
  return value === 'paper-signals-allowed' || value === 'paper-trading-allowed';
}

function sourceAuditRow(row) {
  const raw = parseMaybeJson(row?.raw_json) ?? {};
  const designatedSource = raw.designatedSource ?? {};
  const ruleFlags = raw.ruleFlags ?? {};

  return {
    key: String(row?.condition_id ?? raw.conditionId ?? row?.market_slug ?? raw.marketSlug ?? `${row?.event_date ?? 'undated'}:${row?.outcome_label ?? raw.outcomeLabel ?? 'bucket'}`),
    marketSlug: row?.market_slug ?? raw.marketSlug ?? null,
    conditionId: row?.condition_id ?? raw.conditionId ?? null,
    eventDate: normalizeAuditDate(row?.event_date ?? raw.targetDate),
    outcomeLabel: row?.outcome_label ?? raw.outcomeLabel ?? null,
    lowTemp: toNumberOrNull(row?.low_temp ?? raw.lowTemp),
    highTemp: toNumberOrNull(row?.high_temp ?? raw.highTemp),
    bestBid: toNumberOrNull(row?.best_bid ?? raw.bestBid),
    bestAsk: toNumberOrNull(row?.best_ask ?? raw.bestAsk),
    lastPrice: toNumberOrNull(row?.last_price ?? raw.marketProbability ?? raw.midpoint),
    spread: toNumberOrNull(row?.spread ?? raw.spread),
    quoteSource: row?.quote_source ?? raw.bookSource ?? raw.quoteSource ?? null,
    ruleTextHash: row?.rule_text_hash ?? raw.rulesTextHash ?? designatedSource.sourceTextHash ?? null,
    ruleAmbiguity: normalizeAuditBoolean(row?.rule_ambiguity) ?? normalizeAuditBoolean(ruleFlags.ruleAmbiguity),
    hasKmdwSource: normalizeAuditBoolean(row?.has_kmdw_source) ?? normalizeAuditBoolean(ruleFlags.hasKmdwSource),
    sourceVerified: normalizeAuditBoolean(row?.source_verified) ?? normalizeAuditBoolean(designatedSource.verified),
    sourceVerificationStatus: row?.source_verification_status ?? designatedSource.verificationStatus ?? null,
    stationId: row?.designated_station_id ?? designatedSource.stationId ?? null,
    provider: row?.designated_source_provider ?? designatedSource.provider ?? null,
    tradeGate: row?.source_trade_gate ?? designatedSource.tradeGate ?? null,
    capturedAt: normalizeAuditTimestamp(row?.captured_at ?? raw.capturedAt ?? raw.generatedAt)
  };
}

export function summarizeChicagoSourceAuditRows(rows) {
  const groups = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const normalized = sourceAuditRow(row);

    if (!normalized.key) {
      continue;
    }

    if (!groups.has(normalized.key)) {
      groups.set(normalized.key, {
        key: normalized.key,
        snapshots: [],
        hashes: new Set()
      });
    }

    const group = groups.get(normalized.key);
    group.snapshots.push(normalized);

    if (typeof normalized.ruleTextHash === 'string' && normalized.ruleTextHash.length > 0) {
      group.hashes.add(normalized.ruleTextHash);
    }
  }

  const markets = [...groups.values()].map((group) => {
    const latest = group.snapshots.reduce((currentLatest, row) => latestAuditRow(currentLatest, row), group.snapshots[0]);
    const orderedTimes = group.snapshots
      .map((row) => row.capturedAt)
      .filter(Boolean)
      .sort();
    const hashes = [...group.hashes].sort();
    const hashChanged = hashes.length > 1;
    const missingSourceHash = hashes.length === 0;
    const sourceVerified = latest.sourceVerified === true && isPaperSignalGate(latest.tradeGate);
    const blocked = !sourceVerified;
    const status = hashChanged
      ? 'changed-source-text'
      : missingSourceHash
        ? 'missing-source-hash'
        : blocked
          ? 'blocked'
          : 'verified';

    return {
      key: group.key,
      marketSlug: latest.marketSlug,
      conditionId: latest.conditionId,
      eventDate: latest.eventDate,
      outcomeLabel: latest.outcomeLabel,
      lowTemp: latest.lowTemp,
      highTemp: latest.highTemp,
      quote: {
        bestBid: latest.bestBid,
        bestAsk: latest.bestAsk,
        lastPrice: latest.lastPrice,
        spread: latest.spread,
        quoteSource: latest.quoteSource
      },
      sourceTextHash: latest.ruleTextHash,
      distinctSourceTextHashes: hashes,
      hashChanged,
      sourceVerified,
      sourceVerificationStatus: latest.sourceVerificationStatus,
      stationId: latest.stationId,
      provider: latest.provider,
      tradeGate: latest.tradeGate,
      ruleAmbiguity: latest.ruleAmbiguity,
      hasKmdwSource: latest.hasKmdwSource,
      status,
      snapshotCount: group.snapshots.length,
      firstSeenAt: orderedTimes[0] ?? null,
      lastSeenAt: orderedTimes[orderedTimes.length - 1] ?? latest.capturedAt,
      latestCapturedAt: latest.capturedAt
    };
  }).sort((left, right) => {
    const dateComparison = String(right.eventDate ?? '').localeCompare(String(left.eventDate ?? ''));

    if (dateComparison !== 0) {
      return dateComparison;
    }

    const leftLow = typeof left.lowTemp === 'number' ? left.lowTemp : Number.NEGATIVE_INFINITY;
    const rightLow = typeof right.lowTemp === 'number' ? right.lowTemp : Number.NEGATIVE_INFINITY;

    if (leftLow !== rightLow) {
      return leftLow - rightLow;
    }

    return String(left.conditionId ?? left.marketSlug ?? '').localeCompare(String(right.conditionId ?? right.marketSlug ?? ''));
  });

  return {
    generatedAt: new Date().toISOString(),
    marketCount: markets.length,
    changedCount: markets.filter((market) => market.hashChanged).length,
    blockedCount: markets.filter((market) => !market.sourceVerified).length,
    verifiedCount: markets.filter((market) => market.sourceVerified).length,
    missingHashCount: markets.filter((market) => market.status === 'missing-source-hash').length,
    markets
  };
}

function recommendationRowsFromSnapshot(snapshot) {
  return (Array.isArray(snapshot?.recommendations?.recommendations) ? snapshot.recommendations.recommendations : []).map((recommendation) => ({
    prediction_id: snapshot?.prediction?.predictionTime ?? snapshot?.generatedAt ?? null,
    event_date: snapshot?.targetDate ?? null,
    prediction_time: snapshot?.prediction?.predictionTime ?? snapshot?.generatedAt ?? null,
    expected_high: snapshot?.prediction?.expectedHigh ?? null,
    confidence_score: snapshot?.prediction?.confidence ?? null,
    prediction_raw_json: snapshot?.prediction ?? null,
    market_slug: recommendation.marketSlug ?? null,
    condition_id: recommendation.conditionId ?? null,
    outcome_label: recommendation.outcomeLabel ?? null,
    action: recommendation.action ?? null,
    fair_probability: recommendation.fairProbability ?? null,
    weather_probability: snapshot?.prediction?.weatherBucketProbabilities?.[recommendation.conditionId] ?? null,
    market_implied_probability: snapshot?.prediction?.marketImpliedBucketProbabilities?.[recommendation.conditionId] ?? null,
    market_price: recommendation.marketPrice ?? null,
    edge: recommendation.edge ?? null,
    status: recommendation.status ?? null,
    reason: recommendation.reason ?? null,
    raw_json: recommendation
  }));
}

function settlementMapFromSnapshots(snapshots) {
  const byDate = new Map();

  for (const snapshot of snapshots) {
    if (snapshot?.settlement?.parsed && snapshot.settlement.cliDate && typeof snapshot.settlement.maxTempF === 'number') {
      byDate.set(snapshot.settlement.cliDate, snapshot.settlement.maxTempF);
    }
  }

  return byDate;
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = toNumberOrNull(value);

    if (typeof numeric === 'number') {
      return numeric;
    }
  }

  return null;
}

function dayPhaseCode(value) {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'past':
    case 'complete':
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

function getRangeWidthValue(lowTemp, highTemp) {
  return typeof lowTemp === 'number' && typeof highTemp === 'number'
    ? Math.max(0, highTemp - lowTemp)
    : null;
}

function getRangeCenterValue(lowTemp, highTemp) {
  if (typeof lowTemp === 'number' && typeof highTemp === 'number') {
    return (lowTemp + highTemp) / 2;
  }

  return lowTemp ?? highTemp ?? null;
}

function getRecommendationCost(recommendation) {
  return firstNumber(
    recommendation?.estimatedCost,
    recommendation?.costBreakdown?.totalCost,
    recommendation?.executionCost?.totalCost,
    recommendation?.executionPlan?.estimatedCost,
    recommendation?.executionPlan?.costBreakdown?.totalCost
  ) ?? 0;
}

function buildChicagoModelTrainingRow({
  snapshot = null,
  prediction = null,
  recommendation = null,
  eventDate = null,
  predictionTime = null,
  actualHigh = null,
  actualHighSource = null,
  context = null
} = {}) {
  const activePrediction = prediction ?? snapshot?.prediction ?? {};
  const activeRecommendation = recommendation ?? {};
  const conditionId = activeRecommendation.conditionId ?? activeRecommendation.condition_id ?? null;
  const lowTemp = firstNumber(activeRecommendation.lowTemp, activeRecommendation.low_temp);
  const highTemp = firstNumber(activeRecommendation.highTemp, activeRecommendation.high_temp);
  const range = { lowTemp, highTemp };
  const normalizedActualHigh = toNumberOrNull(actualHigh);
  const actualOutcome = rangeContainsHigh(normalizedActualHigh, range);

  if (typeof actualOutcome !== 'boolean' || !conditionId) {
    return null;
  }

  const features = activePrediction.features ?? {};
  const observation = snapshot?.observations ?? {};
  const forecasts = snapshot?.forecasts ?? {};
  const rangeCenter = getRangeCenterValue(lowTemp, highTemp);
  const expectedHigh = firstNumber(activePrediction.expectedHigh, activeRecommendation.expectedHigh);
  const weatherProbability = firstNumber(
    activeRecommendation.weatherProbability,
    activeRecommendation.weatherOnlyProbability,
    activePrediction.weatherBucketProbabilities?.[conditionId],
    probabilityFromTemperatureDistribution(activePrediction.temperatureDistribution, range)
  );
  const marketProbability = firstNumber(
    context?.historicalMarketProbability,
    activeRecommendation.marketPrice,
    activeRecommendation.marketProbability,
    activePrediction.marketImpliedBucketProbabilities?.[conditionId]
  );
  const fusedProbability = firstNumber(
    activeRecommendation.fairProbability,
    activePrediction.bucketProbabilities?.[conditionId],
    activePrediction.fusedBucketProbabilities?.[conditionId]
  );
  const estimatedCost = getRecommendationCost(activeRecommendation);
  const predictionTimestamp = predictionTime
    ?? activePrediction.predictionTime
    ?? snapshot?.generatedAt
    ?? null;

  return {
    eventDate: eventDate ?? snapshot?.targetDate ?? activePrediction.targetDate ?? null,
    predictionTime: predictionTimestamp,
    conditionId,
    marketSlug: activeRecommendation.marketSlug ?? activeRecommendation.market_slug ?? null,
    outcomeLabel: activeRecommendation.outcomeLabel ?? activeRecommendation.outcome_label ?? null,
    actualHigh: normalizedActualHigh,
    actualHighSource,
    actualOutcome,
    target: actualOutcome ? 1 : 0,
    baselineProbabilities: {
      fusedModel: fusedProbability,
      weatherOnly: weatherProbability,
      marketOnly: marketProbability
    },
    features: {
      simulation_probability: weatherProbability,
      market_probability: marketProbability,
      gross_simulation_edge: typeof weatherProbability === 'number' && typeof marketProbability === 'number'
        ? weatherProbability - marketProbability
        : null,
      estimated_cost: estimatedCost,
      expected_high: expectedHigh,
      std_dev: firstNumber(activePrediction.stdDev),
      observed_high_so_far: firstNumber(observation.observedHighSoFar, activePrediction.observedHighSoFar),
      current_observed_temp: firstNumber(observation.currentObservedTemp, features.current_temp_kmdw),
      nws_forecast_high: firstNumber(activePrediction.forecastHigh, features.forecast_max_nws_hourly, forecasts.hourly?.forecastMaxF, forecasts.grid?.forecastMaxF),
      openmeteo_forecast_high: firstNumber(context?.forecastVintageHighF, activePrediction.openMeteoForecastHigh),
      nws_remaining_forecast_high: firstNumber(activePrediction.remainingForecastHigh, forecasts.hourly?.remainingMaxF, forecasts.grid?.remainingMaxF),
      openmeteo_remaining_forecast_high: firstNumber(activePrediction.openMeteoRemainingForecastHigh),
      historical_high_for_same_day: firstNumber(activePrediction.historicalHighForSameDay),
      recent_station_bias: firstNumber(activePrediction.recentStationBias),
      humidity: firstNumber(features.humidity),
      wind_speed_mph: firstNumber(features.wind_speed, observation.latestWindSpeedMph),
      cloud_cover: firstNumber(features.cloud_cover),
      dew_point_f: firstNumber(features.dew_point, observation.latestDewpointF),
      pressure_hpa: firstNumber(features.pressure_hpa, observation.latestPressureHpa),
      precipitation_chance: firstNumber(features.precip_probability),
      observation_count: firstNumber(observation.observationCount),
      forecast_disagreement: firstNumber(
        activePrediction.forecastDisagreement,
        typeof expectedHigh === 'number' && typeof context?.forecastVintageHighF === 'number'
          ? Math.abs(expectedHigh - context.forecastVintageHighF)
          : null
      ),
      source_risk_buffer: firstNumber(activeRecommendation.sourceRiskHaircut, activePrediction.sourceRiskBuffer),
      range_min: lowTemp,
      range_max: highTemp,
      range_width: getRangeWidthValue(lowTemp, highTemp),
      range_center: rangeCenter,
      range_distance_from_expected: typeof rangeCenter === 'number' && typeof expectedHigh === 'number'
        ? Math.abs(rangeCenter - expectedHigh)
        : null,
      day_phase_code: dayPhaseCode(activePrediction.dayPhase),
      simulation_p10: firstNumber(activePrediction.percentiles?.p10),
      simulation_p50: firstNumber(activePrediction.percentiles?.p50),
      simulation_p90: firstNumber(activePrediction.percentiles?.p90),
      spread: firstNumber(activeRecommendation.spread),
      bid_depth: firstNumber(activeRecommendation.bidDepth),
      ask_depth: firstNumber(activeRecommendation.askDepth),
      is_yes_outcome: 1
    },
    raw: {
      prediction: activePrediction,
      recommendation: activeRecommendation,
      context
    }
  };
}

function buildForecastVintageHighByDate(rows, actualRows = []) {
  const summaries = forecastVintageDailySummaries(rows, actualRows);
  const byDate = new Map();

  for (const summary of summaries.sort((left, right) => {
    const dateComparison = String(left.targetDate ?? '').localeCompare(String(right.targetDate ?? ''));

    if (dateComparison !== 0) {
      return dateComparison;
    }

    const leadPriority = (entry) => {
      if (entry.leadDays === 1) {
        return 0;
      }

      if (entry.leadDays === 0) {
        return 1;
      }

      return 2 + Math.abs(entry.leadDays - 1);
    };
    const priorityComparison = leadPriority(left) - leadPriority(right);

    if (priorityComparison !== 0) {
      return priorityComparison;
    }

    return String(left.model ?? '').localeCompare(String(right.model ?? ''));
  })) {
    if (!byDate.has(summary.targetDate) && typeof summary.forecastHighF === 'number') {
      byDate.set(summary.targetDate, summary.forecastHighF);
    }
  }

  return byDate;
}

function timestampSecondsFromValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function findHistoricalBoardQuote(records, { eventDate = null, conditionId = null, predictionTime = null } = {}) {
  const normalizedEventDate = normalizeAuditDate(eventDate);
  const predictionTs = timestampSecondsFromValue(predictionTime);

  if (!normalizedEventDate || !conditionId || !Number.isFinite(predictionTs)) {
    return null;
  }

  const candidates = [];

  for (const record of (Array.isArray(records) ? records : [])) {
    const snapshots = Array.isArray(record?.archive?.boardSnapshots) ? record.archive.boardSnapshots : [];

    for (const boardSnapshot of snapshots) {
      if (normalizeAuditDate(boardSnapshot?.eventDate) !== normalizedEventDate) {
        continue;
      }

      const boardTs = timestampSecondsFromValue(boardSnapshot?.timestamp ?? boardSnapshot?.reconstructedAt);

      if (!Number.isFinite(boardTs) || boardTs > predictionTs) {
        continue;
      }

      const contract = (Array.isArray(boardSnapshot?.contracts) ? boardSnapshot.contracts : [])
        .find((entry) => String(entry?.conditionId ?? '') === String(conditionId));
      const price = firstNumber(contract?.reconstructedPrice, contract?.lastTradePrice);

      if (!contract || typeof price !== 'number') {
        continue;
      }

      candidates.push({
        historicalMarketProbability: price,
        historicalMarketReconstructedAt: boardSnapshot.reconstructedAt ?? new Date(boardTs * 1000).toISOString(),
        historicalMarketSource: contract.reconstructedPrice !== null && contract.reconstructedPrice !== undefined
          ? contract.quoteSource ?? 'polymarket-clob-prices-history'
          : 'polymarket-trades',
        timestamp: boardTs
      });
    }
  }

  return candidates.sort((left, right) => right.timestamp - left.timestamp)[0] ?? null;
}

function buildChicagoModelTrainingContext({
  forecastVintageHighByDate = null,
  historicalBoardRows = [],
  eventDate = null,
  conditionId = null,
  predictionTime = null
} = {}) {
  const normalizedEventDate = normalizeAuditDate(eventDate);
  const boardQuote = findHistoricalBoardQuote(historicalBoardRows, {
    eventDate: normalizedEventDate,
    conditionId,
    predictionTime
  });

  return {
    forecastVintageHighF: normalizedEventDate && forecastVintageHighByDate instanceof Map
      ? forecastVintageHighByDate.get(normalizedEventDate) ?? null
      : null,
    historicalMarketProbability: boardQuote?.historicalMarketProbability ?? null,
    historicalMarketReconstructedAt: boardQuote?.historicalMarketReconstructedAt ?? null,
    historicalMarketSource: boardQuote?.historicalMarketSource ?? null
  };
}

function summarizeChicagoModelTrainingRows(rows) {
  const ordered = [...rows].sort((left, right) => String(left.eventDate ?? '').localeCompare(String(right.eventDate ?? '')));

  return {
    generatedAt: new Date().toISOString(),
    rowCount: rows.length,
    positiveCount: rows.filter((row) => row.target === 1).length,
    negativeCount: rows.filter((row) => row.target === 0).length,
    dateFrom: ordered[0]?.eventDate ?? null,
    dateTo: ordered.at(-1)?.eventDate ?? null,
    actualHighSourceCounts: rows.reduce((counts, row) => {
      const key = row.actualHighSource ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {})
  };
}

async function getChicagoModelTrainingRowsFromFiles(env, init, { dateFrom = null, dateTo = null, limit = null } = {}) {
  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const normalizedLimit = Number.parseInt(String(limit ?? ''), 10);
  const snapshots = snapshotRows(await readJsonl(env, CHICAGO_SNAPSHOTS_FILE))
    .filter((snapshot) => !normalizedDateFrom || snapshot.targetDate >= normalizedDateFrom)
    .filter((snapshot) => !normalizedDateTo || snapshot.targetDate <= normalizedDateTo);
  const settlementsByDate = settlementMapFromSnapshots(snapshots);
  const archiveRows = mergeDailyArchiveRows(await readJsonl(env, CHICAGO_DAILY_ARCHIVE_FILE));
  const archiveByDate = archiveSettlementMap(archiveRows);
  const forecastVintageRows = mergeForecastVintageRows(await readJsonl(env, CHICAGO_FORECAST_VINTAGES_FILE));
  const forecastVintageHighByDate = buildForecastVintageHighByDate(forecastVintageRows, archiveRows);
  const historicalBoardRows = mergeHistoricalBoardArchiveRows(await readJsonl(env, CHICAGO_HISTORICAL_BOARDS_FILE));
  const rows = snapshots
    .flatMap((snapshot) => {
      const actualHigh = archiveByDate.get(snapshot.targetDate) ?? settlementsByDate.get(snapshot.targetDate) ?? null;
      const actualHighSource = archiveByDate.has(snapshot.targetDate)
        ? 'ncei-cdo-ghcnd'
        : settlementsByDate.has(snapshot.targetDate)
          ? 'captured-climdw'
          : null;

      if (typeof actualHigh !== 'number') {
        return [];
      }

      return (Array.isArray(snapshot?.recommendations?.recommendations) ? snapshot.recommendations.recommendations : [])
        .map((recommendation) => {
          const predictionTime = snapshot?.prediction?.predictionTime ?? snapshot?.generatedAt ?? null;

          return buildChicagoModelTrainingRow({
            snapshot,
            recommendation,
            actualHigh,
            actualHighSource,
            context: buildChicagoModelTrainingContext({
              forecastVintageHighByDate,
              historicalBoardRows,
              eventDate: snapshot.targetDate,
              conditionId: recommendation?.conditionId ?? recommendation?.condition_id,
              predictionTime
            })
          });
        })
        .filter(Boolean);
    })
    .sort((left, right) => String(left.predictionTime ?? '').localeCompare(String(right.predictionTime ?? '')));
  const limitedRows = Number.isFinite(normalizedLimit) && normalizedLimit > 0
    ? rows.slice(-normalizedLimit)
    : rows;

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo,
      limit: Number.isFinite(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : null
    },
    rowCount: limitedRows.length,
    rows: limitedRows,
    summary: summarizeChicagoModelTrainingRows(limitedRows)
  };
}

async function getChicagoHistoryFromFiles(env, init, { date } = {}) {
  const snapshots = snapshotRows(await readJsonl(env, CHICAGO_SNAPSHOTS_FILE), date).slice(0, 50);
  const marketSnapshots = marketSnapshotRows(snapshots).slice(0, 200);
  const observations = snapshots
    .flatMap((snapshot) => Array.isArray(snapshot?.observations?.observations) ? snapshot.observations.observations : [])
    .slice(0, 500);
  const stationDiagnostics = snapshots
    .flatMap((snapshot) => Array.isArray(snapshot?.stationDiagnostics?.comparisons) ? snapshot.stationDiagnostics.comparisons.map((comparison) => ({
      ...comparison,
      event_date: snapshot.targetDate,
      captured_at: snapshot.generatedAt
    })) : [])
    .slice(0, 200);
  const forecastSnapshots = snapshots
    .flatMap((snapshot) => Array.isArray(snapshot?.forecasts?.forecastRows) ? snapshot.forecasts.forecastRows : [])
    .slice(0, 500);
  const settlements = snapshots
    .map((snapshot) => snapshot?.settlement ? {
      ...snapshot.settlement,
      event_date: snapshot.targetDate,
      captured_at: snapshot.generatedAt
    } : null)
    .filter(Boolean)
    .slice(0, 25);
  const predictions = snapshots
    .map((snapshot) => snapshot?.prediction ? {
      ...snapshot.prediction,
      event_date: snapshot.targetDate,
      captured_at: snapshot.generatedAt
    } : null)
    .filter(Boolean)
    .slice(0, 50);
  const recommendations = snapshots
    .flatMap(recommendationRowsFromSnapshot)
    .slice(0, 100);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    marketSnapshots,
    observations,
    stationDiagnostics,
    forecastSnapshots,
    settlements,
    predictions,
    recommendations
  };
}

async function getChicagoSourceAuditFromFiles(env, init, { date } = {}) {
  const normalizedDate = normalizeDateBound(date);
  const snapshots = snapshotRows(await readJsonl(env, CHICAGO_SNAPSHOTS_FILE), normalizedDate);
  const summary = summarizeChicagoSourceAuditRows(marketSnapshotRows(snapshots));

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    ...summary,
    date: normalizedDate
  };
}

function normalizeDailyArchiveRow(row) {
  const rawJson = parseMaybeJson(row?.raw_json) ?? row?.rawJson ?? null;
  const rawData = row?.rawData ?? rawJson?.rawData ?? rawJson ?? null;

  return {
    stationId: row?.station_id ?? row?.stationId ?? null,
    archiveStationId: row?.archive_station_id ?? row?.archiveStationId ?? null,
    archiveDate: normalizeAuditDate(row?.archive_date ?? row?.archiveDate),
    source: row?.source ?? 'ncei-cdo-ghcnd',
    maxTempF: toNumberOrNull(row?.max_temp_f ?? row?.maxTempF),
    minTempF: toNumberOrNull(row?.min_temp_f ?? row?.minTempF),
    precipitationIn: toNumberOrNull(row?.precipitation_in ?? row?.precipitationIn),
    snowIn: toNumberOrNull(row?.snow_in ?? row?.snowIn),
    fetchedAt: normalizeAuditTimestamp(row?.fetched_at ?? row?.fetchedAt),
    rawData
  };
}

function mergeDailyArchiveRows(rows) {
  const byKey = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const normalized = normalizeDailyArchiveRow(row);

    if (!normalized.archiveDate || !normalized.stationId || typeof normalized.maxTempF !== 'number') {
      continue;
    }

    const key = `${normalized.stationId}:${normalized.archiveDate}:${normalized.source}`;
    const existing = byKey.get(key);
    const existingTime = Date.parse(existing?.fetchedAt ?? '');
    const nextTime = Date.parse(normalized.fetchedAt ?? '');

    if (!existing || !Number.isFinite(existingTime) || (Number.isFinite(nextTime) && nextTime >= existingTime)) {
      byKey.set(key, normalized);
    }
  }

  return [...byKey.values()].sort((left, right) => {
    const dateComparison = left.archiveDate.localeCompare(right.archiveDate);

    if (dateComparison !== 0) {
      return dateComparison;
    }

    return String(left.stationId).localeCompare(String(right.stationId));
  });
}

function archiveSettlementMap(rows) {
  const byDate = new Map();

  for (const row of mergeDailyArchiveRows(rows)) {
    if (row.archiveDate && typeof row.maxTempF === 'number') {
      byDate.set(row.archiveDate, row.maxTempF);
    }
  }

  return byDate;
}

async function persistChicagoDailyArchiveToFiles(env, init, archive) {
  const existingRows = await readJsonl(env, CHICAGO_DAILY_ARCHIVE_FILE);
  const records = mergeDailyArchiveRows([
    ...existingRows,
    ...(Array.isArray(archive?.records) ? archive.records : [])
  ]);

  await writeJsonl(env, CHICAGO_DAILY_ARCHIVE_FILE, records);
  const localAnalytics = await persistLocalChicagoDailyArchive(env, records);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    source: archive?.source ?? 'ncei-cdo-ghcnd',
    stationId: archive?.stationId ?? null,
    recordCount: Array.isArray(archive?.records) ? archive.records.length : 0,
    storedRecordCount: records.length,
    file: path.join(getWeatherDataDir(env), CHICAGO_DAILY_ARCHIVE_FILE),
    localAnalytics
  };
}

async function getChicagoDailyArchiveFromFiles(env, init, { dateFrom = null, dateTo = null } = {}) {
  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const rows = mergeDailyArchiveRows(await readJsonl(env, CHICAGO_DAILY_ARCHIVE_FILE))
    .filter((row) => !normalizedDateFrom || row.archiveDate >= normalizedDateFrom)
    .filter((row) => !normalizedDateTo || row.archiveDate <= normalizedDateTo);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo
    },
    recordCount: rows.length,
    records: rows
  };
}

export async function persistChicagoDailyArchive(env, archive) {
  const init = await initializePersistence(env);
  const records = mergeDailyArchiveRows(Array.isArray(archive?.records) ? archive.records : []);

  if (!init.enabled) {
    return persistChicagoDailyArchiveToFiles(env, init, {
      ...archive,
      records
    });
  }

  for (const record of records) {
    await query(env, `
      insert into chicago_daily_archives (
        id, station_id, archive_station_id, archive_date, source, max_temp_f,
        min_temp_f, precipitation_in, snow_in, fetched_at, raw_json, captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
      on conflict (station_id, archive_date, source) do update set
        archive_station_id = excluded.archive_station_id,
        max_temp_f = excluded.max_temp_f,
        min_temp_f = excluded.min_temp_f,
        precipitation_in = excluded.precipitation_in,
        snow_in = excluded.snow_in,
        fetched_at = excluded.fetched_at,
        raw_json = excluded.raw_json,
        captured_at = now()
    `, [
      randomUUID(),
      record.stationId,
      record.archiveStationId,
      record.archiveDate,
      record.source,
      record.maxTempF,
      record.minTempF,
      record.precipitationIn,
      record.snowIn,
      record.fetchedAt,
      safeJson(record)
    ]);
  }

  const localAnalytics = await persistLocalChicagoDailyArchive(env, records);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    source: archive?.source ?? 'ncei-cdo-ghcnd',
    stationId: archive?.stationId ?? null,
    recordCount: records.length,
    localAnalytics
  };
}

export async function getChicagoDailyArchive(env, { dateFrom = null, dateTo = null } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoDailyArchiveFromFiles(env, init, { dateFrom, dateTo });
  }

  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const result = await query(env, `
    select *
    from chicago_daily_archives
    where ($1::date is null or archive_date >= $1::date)
      and ($2::date is null or archive_date <= $2::date)
    order by archive_date asc, station_id asc
  `, [normalizedDateFrom, normalizedDateTo]);
  const rows = mergeDailyArchiveRows(result?.rows ?? []);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo
    },
    recordCount: rows.length,
    records: rows
  };
}

function normalizeLeadDaysFilter(value) {
  if (value === undefined || value === null || value === true || value === '') {
    return null;
  }

  if (Array.isArray(value)) {
    const values = value
      .flatMap((entry) => typeof entry === 'string' ? entry.split(',') : [entry])
      .map((entry) => Number.parseInt(String(entry).trim(), 10))
      .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 7);

    return values.length > 0 ? [...new Set(values)].sort((left, right) => left - right) : null;
  }

  if (typeof value === 'string') {
    return normalizeLeadDaysFilter(value.split(','));
  }

  const numeric = Number.parseInt(String(value), 10);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 7 ? [numeric] : null;
}

function normalizeForecastVintageRow(row) {
  const rawJson = parseMaybeJson(row?.raw_json) ?? row?.rawJson ?? null;
  const rawData = row?.rawData ?? rawJson?.rawData ?? rawJson ?? null;

  return {
    stationId: row?.station_id ?? row?.stationId ?? null,
    source: row?.source ?? 'open-meteo-previous-runs',
    model: row?.model ?? 'gfs_seamless',
    targetDate: normalizeAuditDate(row?.target_date ?? row?.targetDate),
    validTimeLocal: row?.valid_time_local ?? row?.validTimeLocal ?? null,
    leadDays: Number.parseInt(String(row?.lead_days ?? row?.leadDays), 10),
    forecastTempF: toNumberOrNull(row?.forecast_temp_f ?? row?.forecastTempF),
    fetchedAt: normalizeAuditTimestamp(row?.fetched_at ?? row?.fetchedAt),
    rawData
  };
}

function mergeForecastVintageRows(rows) {
  const byKey = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const normalized = normalizeForecastVintageRow(row);

    if (
      !normalized.stationId
      || !normalized.source
      || !normalized.model
      || !normalized.targetDate
      || !normalized.validTimeLocal
      || !Number.isInteger(normalized.leadDays)
      || typeof normalized.forecastTempF !== 'number'
    ) {
      continue;
    }

    const key = [
      normalized.stationId,
      normalized.source,
      normalized.model,
      normalized.targetDate,
      normalized.validTimeLocal,
      normalized.leadDays
    ].join(':');
    const existing = byKey.get(key);
    const existingTime = Date.parse(existing?.fetchedAt ?? '');
    const nextTime = Date.parse(normalized.fetchedAt ?? '');

    if (!existing || !Number.isFinite(existingTime) || (Number.isFinite(nextTime) && nextTime >= existingTime)) {
      byKey.set(key, normalized);
    }
  }

  return [...byKey.values()].sort((left, right) => {
    const dateComparison = left.targetDate.localeCompare(right.targetDate);

    if (dateComparison !== 0) {
      return dateComparison;
    }

    const modelComparison = String(left.model).localeCompare(String(right.model));

    if (modelComparison !== 0) {
      return modelComparison;
    }

    if (left.leadDays !== right.leadDays) {
      return left.leadDays - right.leadDays;
    }

    return String(left.validTimeLocal).localeCompare(String(right.validTimeLocal));
  });
}

function latestTimestamp(rows) {
  return rows
    .map((row) => normalizeAuditTimestamp(row?.fetchedAt ?? row?.fetched_at))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function forecastVintageDailySummaries(rows, actualRows = []) {
  const actualHighByDate = archiveSettlementMap(actualRows);
  const groups = new Map();

  for (const row of mergeForecastVintageRows(rows)) {
    const key = `${row.targetDate}:${row.model}:${row.leadDays}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(row);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    const forecastHighF = Math.max(...group.map((row) => row.forecastTempF));
    const actualHighF = actualHighByDate.get(first.targetDate) ?? null;
    const errorF = typeof actualHighF === 'number' ? forecastHighF - actualHighF : null;

    return {
      stationId: first.stationId,
      source: first.source,
      model: first.model,
      targetDate: first.targetDate,
      leadDays: first.leadDays,
      forecastHighF: roundMetric(forecastHighF, 2),
      actualHighF,
      errorF: roundMetric(errorF, 2),
      absoluteErrorF: typeof errorF === 'number' ? roundMetric(Math.abs(errorF), 2) : null,
      hourlyRecordCount: group.length,
      fetchedAt: latestTimestamp(group)
    };
  }).sort((left, right) => {
    const dateComparison = left.targetDate.localeCompare(right.targetDate);

    if (dateComparison !== 0) {
      return dateComparison;
    }

    if (left.leadDays !== right.leadDays) {
      return left.leadDays - right.leadDays;
    }

    return String(left.model).localeCompare(String(right.model));
  });
}

function forecastVintageSummary(rows, actualRows = []) {
  const dailySummaries = forecastVintageDailySummaries(rows, actualRows);
  const byLeadDay = new Map();

  for (const summary of dailySummaries) {
    if (typeof summary.absoluteErrorF !== 'number') {
      continue;
    }

    if (!byLeadDay.has(summary.leadDays)) {
      byLeadDay.set(summary.leadDays, []);
    }

    byLeadDay.get(summary.leadDays).push(summary);
  }

  return {
    generatedAt: new Date().toISOString(),
    recordCount: mergeForecastVintageRows(rows).length,
    dailySummaryCount: dailySummaries.length,
    actualMatchedCount: dailySummaries.filter((summary) => typeof summary.actualHighF === 'number').length,
    maeByLeadDay: [...byLeadDay.entries()]
      .sort(([left], [right]) => left - right)
      .map(([leadDays, summaries]) => ({
        leadDays,
        count: summaries.length,
        maeF: roundMetric(averageNumbers(summaries.map((summary) => summary.absoluteErrorF)), 2),
        biasF: roundMetric(averageNumbers(summaries.map((summary) => summary.errorF)), 2)
      }))
  };
}

async function persistChicagoForecastVintageArchiveToFiles(env, init, archive) {
  const incomingRecords = mergeForecastVintageRows(Array.isArray(archive?.records) ? archive.records : []);
  const existingRows = await readJsonl(env, CHICAGO_FORECAST_VINTAGES_FILE);
  const records = mergeForecastVintageRows([
    ...existingRows,
    ...incomingRecords
  ]);

  await writeJsonl(env, CHICAGO_FORECAST_VINTAGES_FILE, records);
  const localAnalytics = await persistLocalChicagoForecastVintages(env, records);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    source: archive?.source ?? 'open-meteo-previous-runs',
    stationId: archive?.stationId ?? null,
    model: archive?.model ?? null,
    leadDays: Array.isArray(archive?.leadDays) ? archive.leadDays : null,
    recordCount: incomingRecords.length,
    storedRecordCount: records.length,
    file: path.join(getWeatherDataDir(env), CHICAGO_FORECAST_VINTAGES_FILE),
    localAnalytics
  };
}

async function getChicagoForecastVintagesFromFiles(
  env,
  init,
  { dateFrom = null, dateTo = null, leadDays = null, model = null } = {}
) {
  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const normalizedLeadDays = normalizeLeadDaysFilter(leadDays);
  const normalizedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
  const records = mergeForecastVintageRows(await readJsonl(env, CHICAGO_FORECAST_VINTAGES_FILE))
    .filter((row) => !normalizedDateFrom || row.targetDate >= normalizedDateFrom)
    .filter((row) => !normalizedDateTo || row.targetDate <= normalizedDateTo)
    .filter((row) => !normalizedLeadDays || normalizedLeadDays.includes(row.leadDays))
    .filter((row) => !normalizedModel || row.model === normalizedModel);
  const actualRows = mergeDailyArchiveRows(await readJsonl(env, CHICAGO_DAILY_ARCHIVE_FILE))
    .filter((row) => !normalizedDateFrom || row.archiveDate >= normalizedDateFrom)
    .filter((row) => !normalizedDateTo || row.archiveDate <= normalizedDateTo);
  const dailySummaries = forecastVintageDailySummaries(records, actualRows);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo,
      leadDays: normalizedLeadDays,
      model: normalizedModel
    },
    recordCount: records.length,
    records,
    dailySummaries,
    summary: forecastVintageSummary(records, actualRows)
  };
}

export async function persistChicagoForecastVintageArchive(env, archive) {
  const init = await initializePersistence(env);
  const records = mergeForecastVintageRows(Array.isArray(archive?.records) ? archive.records : []);

  if (!init.enabled) {
    return persistChicagoForecastVintageArchiveToFiles(env, init, {
      ...archive,
      records
    });
  }

  for (const record of records) {
    await query(env, `
      insert into chicago_forecast_vintages (
        id, station_id, source, model, target_date, valid_time_local, lead_days,
        forecast_temp_f, fetched_at, raw_json, captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      on conflict (station_id, source, model, target_date, valid_time_local, lead_days) do update set
        forecast_temp_f = excluded.forecast_temp_f,
        fetched_at = excluded.fetched_at,
        raw_json = excluded.raw_json,
        captured_at = now()
    `, [
      randomUUID(),
      record.stationId,
      record.source,
      record.model,
      record.targetDate,
      record.validTimeLocal,
      record.leadDays,
      record.forecastTempF,
      record.fetchedAt,
      safeJson(record)
    ]);
  }

  const localAnalytics = await persistLocalChicagoForecastVintages(env, records);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    source: archive?.source ?? 'open-meteo-previous-runs',
    stationId: archive?.stationId ?? null,
    model: archive?.model ?? null,
    leadDays: Array.isArray(archive?.leadDays) ? archive.leadDays : null,
    recordCount: records.length,
    localAnalytics
  };
}

export async function getChicagoForecastVintages(
  env,
  { dateFrom = null, dateTo = null, leadDays = null, model = null } = {}
) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoForecastVintagesFromFiles(env, init, { dateFrom, dateTo, leadDays, model });
  }

  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const normalizedLeadDays = normalizeLeadDaysFilter(leadDays);
  const normalizedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
  const result = await query(env, `
    select *
    from chicago_forecast_vintages
    where ($1::date is null or target_date >= $1::date)
      and ($2::date is null or target_date <= $2::date)
      and ($3::int[] is null or lead_days = any($3::int[]))
      and ($4::text is null or model = $4::text)
    order by target_date asc, model asc, lead_days asc, valid_time_local asc
  `, [normalizedDateFrom, normalizedDateTo, normalizedLeadDays, normalizedModel]);
  const archiveResult = await query(env, `
    select *
    from chicago_daily_archives
    where ($1::date is null or archive_date >= $1::date)
      and ($2::date is null or archive_date <= $2::date)
      and source = 'ncei-cdo-ghcnd'
    order by archive_date asc
  `, [normalizedDateFrom, normalizedDateTo]);
  const records = mergeForecastVintageRows(result?.rows ?? []);
  const actualRows = mergeDailyArchiveRows(archiveResult?.rows ?? []);
  const dailySummaries = forecastVintageDailySummaries(records, actualRows);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo,
      leadDays: normalizedLeadDays,
      model: normalizedModel
    },
    recordCount: records.length,
    records,
    dailySummaries,
    summary: forecastVintageSummary(records, actualRows)
  };
}

function normalizeHistoricalBoardArchiveRow(row) {
  const rawJson = parseMaybeJson(row?.raw_json) ?? row?.rawJson ?? null;
  const archive = row?.archive ?? rawJson ?? row ?? {};
  const summary = archive?.summary ?? {};

  return {
    stationId: row?.station_id ?? archive.stationId ?? 'KMDW',
    source: row?.source ?? archive.source ?? 'polymarket-historical-board-reconstruction',
    dateFrom: normalizeAuditDate(row?.date_from ?? archive.dateFrom),
    dateTo: normalizeAuditDate(row?.date_to ?? archive.dateTo),
    startTs: Number.parseInt(String(row?.start_ts ?? archive.startTs), 10),
    endTs: Number.parseInt(String(row?.end_ts ?? archive.endTs), 10),
    contractCount: Number.parseInt(String(row?.contract_count ?? summary.contractCount ?? archive.contracts?.length ?? 0), 10),
    tokenCount: Number.parseInt(String(row?.token_count ?? summary.tokenCount ?? 0), 10),
    pricePointCount: Number.parseInt(String(row?.price_point_count ?? summary.pricePointCount ?? 0), 10),
    tradeCount: Number.parseInt(String(row?.trade_count ?? summary.tradeCount ?? archive.trades?.length ?? 0), 10),
    boardSnapshotCount: Number.parseInt(String(row?.board_snapshot_count ?? summary.boardSnapshotCount ?? archive.boardSnapshots?.length ?? 0), 10),
    generatedAt: normalizeAuditTimestamp(row?.generated_at ?? archive.generatedAt),
    archive
  };
}

function mergeHistoricalBoardArchiveRows(rows) {
  const byKey = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const normalized = normalizeHistoricalBoardArchiveRow(row);

    if (!normalized.stationId || !normalized.source || !normalized.dateFrom || !normalized.dateTo) {
      continue;
    }

    const key = [
      normalized.stationId,
      normalized.source,
      normalized.dateFrom,
      normalized.dateTo,
      Number.isFinite(normalized.startTs) ? normalized.startTs : '',
      Number.isFinite(normalized.endTs) ? normalized.endTs : ''
    ].join(':');
    const existing = byKey.get(key);
    const existingTime = Date.parse(existing?.generatedAt ?? '');
    const nextTime = Date.parse(normalized.generatedAt ?? '');

    if (!existing || !Number.isFinite(existingTime) || (Number.isFinite(nextTime) && nextTime >= existingTime)) {
      byKey.set(key, normalized);
    }
  }

  return [...byKey.values()].sort((left, right) => {
    const dateComparison = left.dateFrom.localeCompare(right.dateFrom);

    if (dateComparison !== 0) {
      return dateComparison;
    }

    return (left.startTs || 0) - (right.startTs || 0);
  });
}

function summarizeHistoricalBoardArchives(rows) {
  const archives = mergeHistoricalBoardArchiveRows(rows);
  const eventDates = new Set();

  for (const archive of archives) {
    for (const date of (Array.isArray(archive.archive?.summary?.eventDates) ? archive.archive.summary.eventDates : [])) {
      eventDates.add(date);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    archiveCount: archives.length,
    eventDates: [...eventDates].sort(),
    contractCount: archives.reduce((sum, row) => sum + (Number.isFinite(row.contractCount) ? row.contractCount : 0), 0),
    tokenCount: archives.reduce((sum, row) => sum + (Number.isFinite(row.tokenCount) ? row.tokenCount : 0), 0),
    pricePointCount: archives.reduce((sum, row) => sum + (Number.isFinite(row.pricePointCount) ? row.pricePointCount : 0), 0),
    tradeCount: archives.reduce((sum, row) => sum + (Number.isFinite(row.tradeCount) ? row.tradeCount : 0), 0),
    boardSnapshotCount: archives.reduce((sum, row) => sum + (Number.isFinite(row.boardSnapshotCount) ? row.boardSnapshotCount : 0), 0),
    firstReconstructedAt: archives
      .flatMap((row) => row.archive?.summary?.firstReconstructedAt ? [row.archive.summary.firstReconstructedAt] : [])
      .sort()[0] ?? null,
    lastReconstructedAt: archives
      .flatMap((row) => row.archive?.summary?.lastReconstructedAt ? [row.archive.summary.lastReconstructedAt] : [])
      .sort()
      .at(-1) ?? null
  };
}

async function persistChicagoHistoricalMarketBoardsToFiles(env, init, archive) {
  const existingRows = await readJsonl(env, CHICAGO_HISTORICAL_BOARDS_FILE);
  const records = mergeHistoricalBoardArchiveRows([
    ...existingRows,
    { archive }
  ]);

  await writeJsonl(env, CHICAGO_HISTORICAL_BOARDS_FILE, records.map((row) => row.archive));
  const localAnalytics = await persistLocalChicagoHistoricalMarketBoards(env, archive);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    source: archive?.source ?? 'polymarket-historical-board-reconstruction',
    stationId: archive?.stationId ?? 'KMDW',
    dateFrom: archive?.dateFrom ?? null,
    dateTo: archive?.dateTo ?? null,
    contractCount: archive?.summary?.contractCount ?? 0,
    pricePointCount: archive?.summary?.pricePointCount ?? 0,
    tradeCount: archive?.summary?.tradeCount ?? 0,
    boardSnapshotCount: archive?.summary?.boardSnapshotCount ?? 0,
    storedArchiveCount: records.length,
    file: path.join(getWeatherDataDir(env), CHICAGO_HISTORICAL_BOARDS_FILE),
    localAnalytics
  };
}

async function getChicagoHistoricalMarketBoardsFromFiles(env, init, { dateFrom = null, dateTo = null } = {}) {
  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const records = mergeHistoricalBoardArchiveRows(await readJsonl(env, CHICAGO_HISTORICAL_BOARDS_FILE))
    .filter((row) => !normalizedDateFrom || row.dateTo >= normalizedDateFrom)
    .filter((row) => !normalizedDateTo || row.dateFrom <= normalizedDateTo);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo
    },
    archiveCount: records.length,
    records,
    summary: summarizeHistoricalBoardArchives(records)
  };
}

export async function persistChicagoHistoricalMarketBoards(env, archive) {
  const init = await initializePersistence(env);
  const normalized = normalizeHistoricalBoardArchiveRow({ archive });

  if (!init.enabled) {
    return persistChicagoHistoricalMarketBoardsToFiles(env, init, normalized.archive);
  }

  await query(env, `
    insert into chicago_historical_market_boards (
      id, station_id, source, date_from, date_to, start_ts, end_ts,
      contract_count, token_count, price_point_count, trade_count,
      board_snapshot_count, generated_at, raw_json, captured_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
    on conflict (station_id, source, date_from, date_to, start_ts, end_ts) do update set
      contract_count = excluded.contract_count,
      token_count = excluded.token_count,
      price_point_count = excluded.price_point_count,
      trade_count = excluded.trade_count,
      board_snapshot_count = excluded.board_snapshot_count,
      generated_at = excluded.generated_at,
      raw_json = excluded.raw_json,
      captured_at = now()
  `, [
    randomUUID(),
    normalized.stationId,
    normalized.source,
    normalized.dateFrom,
    normalized.dateTo,
    Number.isFinite(normalized.startTs) ? normalized.startTs : null,
    Number.isFinite(normalized.endTs) ? normalized.endTs : null,
    Number.isFinite(normalized.contractCount) ? normalized.contractCount : 0,
    Number.isFinite(normalized.tokenCount) ? normalized.tokenCount : 0,
    Number.isFinite(normalized.pricePointCount) ? normalized.pricePointCount : 0,
    Number.isFinite(normalized.tradeCount) ? normalized.tradeCount : 0,
    Number.isFinite(normalized.boardSnapshotCount) ? normalized.boardSnapshotCount : 0,
    normalized.generatedAt,
    safeJson(normalized.archive)
  ]);

  const localAnalytics = await persistLocalChicagoHistoricalMarketBoards(env, normalized.archive);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    source: normalized.source,
    stationId: normalized.stationId,
    dateFrom: normalized.dateFrom,
    dateTo: normalized.dateTo,
    contractCount: normalized.contractCount,
    pricePointCount: normalized.pricePointCount,
    tradeCount: normalized.tradeCount,
    boardSnapshotCount: normalized.boardSnapshotCount,
    localAnalytics
  };
}

export async function getChicagoHistoricalMarketBoards(env, { dateFrom = null, dateTo = null } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoHistoricalMarketBoardsFromFiles(env, init, { dateFrom, dateTo });
  }

  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const result = await query(env, `
    select *
    from chicago_historical_market_boards
    where ($1::date is null or date_to >= $1::date)
      and ($2::date is null or date_from <= $2::date)
    order by date_from asc, start_ts asc nulls last
  `, [normalizedDateFrom, normalizedDateTo]);
  const records = mergeHistoricalBoardArchiveRows(result?.rows ?? []);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo
    },
    archiveCount: records.length,
    records,
    summary: summarizeHistoricalBoardArchives(records)
  };
}

function bestRecommendationFromSnapshot(snapshot) {
  if (snapshot?.recommendations?.best && typeof snapshot.recommendations.best === 'object') {
    return snapshot.recommendations.best;
  }

  const recommendations = Array.isArray(snapshot?.recommendations?.recommendations)
    ? snapshot.recommendations.recommendations
    : [];

  return [...recommendations].sort((left, right) => {
    const leftPassed = left?.status === 'passed' || left?.action === 'recommend-buy-yes';
    const rightPassed = right?.status === 'passed' || right?.action === 'recommend-buy-yes';

    if (leftPassed !== rightPassed) {
      return rightPassed ? 1 : -1;
    }

    const leftScore = toNumberOrNull(left?.score)
      ?? toNumberOrNull(left?.riskAdjustedEdge)
      ?? toNumberOrNull(left?.edge)
      ?? Number.NEGATIVE_INFINITY;
    const rightScore = toNumberOrNull(right?.score)
      ?? toNumberOrNull(right?.riskAdjustedEdge)
      ?? toNumberOrNull(right?.edge)
      ?? Number.NEGATIVE_INFINITY;

    return rightScore - leftScore;
  })[0] ?? null;
}

function compactBucketForDrift(recommendation) {
  if (!recommendation) {
    return null;
  }

  return {
    conditionId: recommendation.conditionId ?? null,
    marketSlug: recommendation.marketSlug ?? null,
    outcomeLabel: recommendation.outcomeLabel ?? null,
    lowTemp: toNumberOrNull(recommendation.lowTemp),
    highTemp: toNumberOrNull(recommendation.highTemp)
  };
}

function driftBucketKey(bucket) {
  if (!bucket) {
    return null;
  }

  return bucket.conditionId
    ?? bucket.marketSlug
    ?? bucket.outcomeLabel
    ?? `${bucket.lowTemp ?? ''}:${bucket.highTemp ?? ''}`;
}

function compactChicagoSignalSnapshot(snapshot) {
  const prediction = snapshot?.prediction ?? {};
  const threshold = prediction?.thresholdDiagnostics ?? {};
  const sourceFreshness = prediction?.sourceFreshness ?? {};
  const best = bestRecommendationFromSnapshot(snapshot);

  return {
    generatedAt: normalizeAuditTimestamp(snapshot?.generatedAt),
    targetDate: snapshot?.targetDate ?? null,
    predictionTime: normalizeAuditTimestamp(prediction?.predictionTime ?? snapshot?.generatedAt),
    expectedHigh: roundMetric(toNumberOrNull(prediction?.expectedHigh), 2),
    bestBucket: compactBucketForDrift(best),
    action: best?.action ?? null,
    status: best?.status ?? null,
    fairProbability: roundMetric(toNumberOrNull(best?.fairProbability)),
    marketPrice: roundMetric(toNumberOrNull(best?.marketPrice)),
    edge: roundMetric(toNumberOrNull(best?.edge)),
    riskAdjustedEdge: roundMetric(toNumberOrNull(best?.riskAdjustedEdge) ?? toNumberOrNull(best?.edge)),
    thresholdStatus: threshold?.status ?? null,
    thresholdDistanceF: roundMetric(toNumberOrNull(threshold?.nearestBoundary?.distanceF), 2),
    nearestBoundaryF: roundMetric(toNumberOrNull(threshold?.nearestBoundary?.boundaryF), 2),
    topBucketMargin: roundMetric(toNumberOrNull(threshold?.topBucketMargin)),
    sourceStale: sourceFreshness?.isStale === true
  };
}

function addDriftChange(changes, name, from, to, options = {}) {
  const changed = options.compareAsJson
    ? JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)
    : from !== to;

  if (!changed) {
    return;
  }

  changes.push({
    name,
    from,
    to,
    material: options.material === true
  });
}

function addNumericDriftChange(changes, name, previousValue, latestValue, materialThreshold = 0.03) {
  const previousNumber = toNumberOrNull(previousValue);
  const latestNumber = toNumberOrNull(latestValue);

  if (previousNumber === null && latestNumber === null) {
    return;
  }

  const delta = typeof previousNumber === 'number' && typeof latestNumber === 'number'
    ? roundMetric(latestNumber - previousNumber)
    : null;
  const changed = delta !== null
    ? delta !== 0
    : previousNumber !== latestNumber;

  if (!changed) {
    return;
  }

  changes.push({
    name,
    from: previousNumber,
    to: latestNumber,
    delta,
    material: typeof delta === 'number' && Math.abs(delta) >= materialThreshold
  });
}

export function summarizeChicagoSignalDriftSnapshots(snapshots) {
  const orderedSnapshots = (Array.isArray(snapshots) ? snapshots : [])
    .filter(Boolean)
    .sort((left, right) => String(right?.generatedAt ?? '').localeCompare(String(left?.generatedAt ?? '')));
  const compacted = orderedSnapshots.map(compactChicagoSignalSnapshot);
  const latest = compacted[0] ?? null;
  const previous = compacted[1] ?? null;

  if (!latest || !previous) {
    return {
      generatedAt: new Date().toISOString(),
      date: latest?.targetDate ?? null,
      snapshotCount: orderedSnapshots.length,
      latestAt: latest?.generatedAt ?? null,
      previousAt: null,
      status: 'insufficient-history',
      materialChange: false,
      changes: [],
      latest,
      previous: null
    };
  }

  const changes = [];
  addDriftChange(changes, 'best-bucket', previous.bestBucket, latest.bestBucket, {
    compareAsJson: true,
    material: driftBucketKey(previous.bestBucket) !== driftBucketKey(latest.bestBucket)
  });
  addDriftChange(changes, 'action', previous.action, latest.action, {
    material: true
  });
  addNumericDriftChange(changes, 'risk-adjusted-edge', previous.riskAdjustedEdge, latest.riskAdjustedEdge);
  addNumericDriftChange(changes, 'market-price', previous.marketPrice, latest.marketPrice);
  addNumericDriftChange(changes, 'fair-probability', previous.fairProbability, latest.fairProbability);
  addNumericDriftChange(changes, 'expected-high', previous.expectedHigh, latest.expectedHigh, 1);
  addDriftChange(changes, 'threshold-status', previous.thresholdStatus, latest.thresholdStatus, {
    material: true
  });
  addDriftChange(changes, 'source-stale', previous.sourceStale, latest.sourceStale, {
    material: latest.sourceStale === true
  });

  const materialChange = changes.some((change) => change.material);

  return {
    generatedAt: new Date().toISOString(),
    date: latest.targetDate ?? previous.targetDate ?? null,
    snapshotCount: orderedSnapshots.length,
    latestAt: latest.generatedAt,
    previousAt: previous.generatedAt,
    status: materialChange ? 'material-move' : changes.length > 0 ? 'changed' : 'stable',
    materialChange,
    changes,
    latest,
    previous
  };
}

async function getChicagoSignalDriftFromFiles(env, init, { date } = {}) {
  const records = await readJsonl(env, CHICAGO_SNAPSHOTS_FILE);
  const latestDate = snapshotRows(records)[0]?.targetDate ?? null;
  const normalizedDate = normalizeDateBound(date) ?? latestDate;
  const snapshots = normalizedDate
    ? snapshotRows(records, normalizedDate)
    : snapshotRows(records);
  const summary = summarizeChicagoSignalDriftSnapshots(snapshots);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    date: normalizedDate,
    ...summary
  };
}

function recommendationFromPostgresRow(row) {
  const raw = parseMaybeJson(row?.raw_json) ?? {};

  return {
    ...raw,
    marketSlug: raw.marketSlug ?? row?.market_slug ?? null,
    conditionId: raw.conditionId ?? row?.condition_id ?? null,
    outcomeLabel: raw.outcomeLabel ?? row?.outcome_label ?? null,
    action: raw.action ?? row?.action ?? null,
    fairProbability: toNumberOrNull(raw.fairProbability ?? row?.fair_probability),
    marketPrice: toNumberOrNull(raw.marketPrice ?? row?.market_price),
    edge: toNumberOrNull(raw.edge ?? row?.edge),
    status: raw.status ?? row?.status ?? null,
    reason: raw.reason ?? row?.reason ?? null
  };
}

async function getLatestChicagoPredictionDate(env) {
  const result = await query(env, `
    select event_date
    from chicago_predictions
    order by prediction_time desc, captured_at desc
    limit 1
  `);

  return normalizeAuditDate(result?.rows?.[0]?.event_date);
}

export async function getChicagoSignalDrift(env, { date } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoSignalDriftFromFiles(env, init, { date });
  }

  const normalizedDate = normalizeDateBound(date) ?? await getLatestChicagoPredictionDate(env);
  const predictionResult = await query(env, `
    select id, event_date, prediction_time, raw_json, captured_at
    from chicago_predictions
    where ($1::date is null or event_date = $1::date)
    order by prediction_time desc, captured_at desc
    limit 2
  `, [normalizedDate]);
  const predictionRows = predictionResult?.rows ?? [];
  const predictionIds = predictionRows.map((row) => row.id).filter(Boolean);
  let recommendationsByPrediction = new Map();

  if (predictionIds.length > 0) {
    const recommendationResult = await query(env, `
      select *
      from chicago_trade_recommendations
      where prediction_id = any($1::text[])
      order by captured_at desc
    `, [predictionIds]);

    recommendationsByPrediction = (recommendationResult?.rows ?? []).reduce((map, row) => {
      const predictionId = row.prediction_id;

      if (!map.has(predictionId)) {
        map.set(predictionId, []);
      }

      map.get(predictionId).push(recommendationFromPostgresRow(row));
      return map;
    }, new Map());
  }

  const snapshots = predictionRows.map((row) => {
    const prediction = parseMaybeJson(row.raw_json) ?? {};
    const recommendations = recommendationsByPrediction.get(row.id) ?? [];

    return {
      generatedAt: normalizeAuditTimestamp(row.captured_at ?? row.prediction_time),
      targetDate: normalizeAuditDate(row.event_date),
      prediction: {
        ...prediction,
        predictionTime: prediction.predictionTime ?? normalizeAuditTimestamp(row.prediction_time)
      },
      recommendations: {
        best: bestRecommendationFromSnapshot({ recommendations: { recommendations } }),
        recommendations
      }
    };
  });
  const summary = summarizeChicagoSignalDriftSnapshots(snapshots);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    ...summary,
    date: normalizedDate
  };
}

export async function persistChicagoSnapshot(env, snapshot) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return persistChicagoSnapshotToFiles(env, snapshot, init.reason);
  }

  const capturedAt = snapshot?.generatedAt ?? new Date().toISOString();
  const eventDate = snapshot?.targetDate ?? null;

  for (const bucket of (Array.isArray(snapshot?.markets?.buckets) ? snapshot.markets.buckets : [])) {
    await query(env, `
      insert into chicago_market_snapshots (
        id, market_slug, condition_id, event_date, outcome_label, low_temp, high_temp,
        best_bid, best_ask, last_price, spread, bid_depth, ask_depth, liquidity,
        volume, quote_source, rule_text_hash, rule_ambiguity, has_kmdw_source, source_verified,
        source_verification_status, designated_station_id, designated_source_provider,
        source_trade_gate, captured_at, raw_json
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    `, [
      randomUUID(),
      bucket.marketSlug ?? null,
      bucket.conditionId ?? null,
      eventDate,
      bucket.outcomeLabel ?? null,
      toNumberOrNull(bucket.lowTemp),
      toNumberOrNull(bucket.highTemp),
      toNumberOrNull(bucket.bestBid),
      toNumberOrNull(bucket.bestAsk),
      toNumberOrNull(bucket.marketProbability ?? bucket.midpoint),
      toNumberOrNull(bucket.spread),
      toNumberOrNull(bucket.bidDepth),
      toNumberOrNull(bucket.askDepth),
      toNumberOrNull(bucket.liquidity),
      toNumberOrNull(bucket.volume),
      bucket.bookSource ?? bucket.quoteSource ?? null,
      bucket.rulesTextHash ?? bucket.designatedSource?.sourceTextHash ?? null,
      bucket.ruleFlags?.ruleAmbiguity ?? null,
      bucket.ruleFlags?.hasKmdwSource ?? null,
      bucket.designatedSource?.verified ?? null,
      bucket.designatedSource?.verificationStatus ?? null,
      bucket.designatedSource?.stationId ?? null,
      bucket.designatedSource?.provider ?? null,
      bucket.designatedSource?.tradeGate ?? null,
      capturedAt,
      safeJson(bucket)
    ]);
  }

  for (const comparison of (Array.isArray(snapshot?.stationDiagnostics?.comparisons) ? snapshot.stationDiagnostics.comparisons : [])) {
    await query(env, `
      insert into chicago_station_diagnostics (
        id, event_date, primary_station_id, comparison_station_id, current_temp_f,
        observed_high_so_far, current_spread_f, high_spread_f, risk_level,
        latest_observation_at, captured_at, raw_json
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      randomUUID(),
      eventDate,
      snapshot?.stationDiagnostics?.primaryStationId ?? snapshot?.station?.stationId ?? 'KMDW',
      comparison.stationId ?? null,
      toNumberOrNull(comparison.currentObservedTemp),
      toNumberOrNull(comparison.observedHighSoFar),
      toNumberOrNull(comparison.currentSpreadF),
      toNumberOrNull(comparison.highSpreadF),
      comparison.riskLevel ?? null,
      comparison.latestObservationAt ?? null,
      capturedAt,
      safeJson(comparison)
    ]);
  }

  for (const observation of (Array.isArray(snapshot?.observations?.observations) ? snapshot.observations.observations : [])) {
    await query(env, `
      insert into chicago_observations (
        id, station_id, observed_at, temp_f, dewpoint_f, wind_speed,
        wind_direction, raw_metar, raw_json, captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (station_id, observed_at) do update set
        temp_f = excluded.temp_f,
        dewpoint_f = excluded.dewpoint_f,
        wind_speed = excluded.wind_speed,
        wind_direction = excluded.wind_direction,
        raw_metar = excluded.raw_metar,
        raw_json = excluded.raw_json,
        captured_at = excluded.captured_at
    `, [
      randomUUID(),
      observation.stationId ?? snapshot?.station?.stationId ?? 'KMDW',
      observation.observedAt,
      toNumberOrNull(observation.tempF),
      toNumberOrNull(observation.dewpointF),
      toNumberOrNull(observation.windSpeedMph),
      toNumberOrNull(observation.windDirection),
      observation.rawMetar ?? null,
      safeJson(observation),
      capturedAt
    ]);
  }

  for (const forecast of (Array.isArray(snapshot?.forecasts?.forecastRows) ? snapshot.forecasts.forecastRows : [])) {
    if (!forecast.validStart || !forecast.validEnd || !forecast.source) {
      continue;
    }

    await query(env, `
      insert into chicago_forecast_snapshots (
        id, station_id, source, issue_time, valid_start, valid_end, forecast_temp,
        dew_point, wind_speed, wind_direction, cloud_cover, precip_prob,
        pressure, raw_json, captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      on conflict (station_id, source, valid_start, valid_end) do update set
        issue_time = excluded.issue_time,
        forecast_temp = excluded.forecast_temp,
        dew_point = excluded.dew_point,
        wind_speed = excluded.wind_speed,
        wind_direction = excluded.wind_direction,
        cloud_cover = excluded.cloud_cover,
        precip_prob = excluded.precip_prob,
        pressure = excluded.pressure,
        raw_json = excluded.raw_json,
        captured_at = excluded.captured_at
    `, [
      randomUUID(),
      forecast.stationId ?? snapshot?.station?.stationId ?? 'KMDW',
      forecast.source,
      forecast.issueTime ?? null,
      forecast.validStart,
      forecast.validEnd,
      toNumberOrNull(forecast.forecastTempF),
      toNumberOrNull(forecast.dewpointF),
      toNumberOrNull(forecast.windSpeedMph),
      toNumberOrNull(forecast.windDirection),
      toNumberOrNull(forecast.cloudCover),
      toNumberOrNull(forecast.precipProbability),
      toNumberOrNull(forecast.pressureHpa),
      safeJson(forecast),
      capturedAt
    ]);
  }

  if (
    snapshot?.settlement?.status === 'settled'
    && snapshot.settlement.cliDate
    && typeof snapshot.settlement.maxTempF === 'number'
  ) {
    await query(env, `
      insert into chicago_settlements (
        id, station_id, cli_product, cli_date, max_temp_f, source_text_hash,
        source_url, settled_at, raw_text, captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (station_id, cli_product, cli_date) do update set
        max_temp_f = excluded.max_temp_f,
        source_text_hash = excluded.source_text_hash,
        source_url = excluded.source_url,
        settled_at = excluded.settled_at,
        raw_text = excluded.raw_text,
        captured_at = excluded.captured_at
    `, [
      randomUUID(),
      snapshot.settlement.stationId ?? snapshot?.station?.stationId ?? 'KMDW',
      snapshot.settlement.product ?? snapshot?.station?.cliProduct ?? 'CLIMDW',
      snapshot.settlement.cliDate,
      toNumberOrNull(snapshot.settlement.maxTempF),
      snapshot.settlement.sourceTextHash ?? null,
      snapshot.settlement.sourceUrl ?? null,
      snapshot.settlement.fetchedAt ?? capturedAt,
      snapshot.settlement.rawText ?? null,
      capturedAt
    ]);
  }

  let predictionId = null;

  if (snapshot?.prediction) {
    predictionId = randomUUID();
    await query(env, `
      insert into chicago_predictions (
        id, prediction_time, event_date, station_id, model_version, expected_high,
        std_dev, temperature_distribution_json, bucket_probabilities_json,
        confidence_score, source_freshness_json, raw_json, captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      predictionId,
      snapshot.prediction.predictionTime ?? capturedAt,
      eventDate,
      snapshot.prediction.stationId ?? snapshot?.station?.stationId ?? 'KMDW',
      snapshot.prediction.modelVersion ?? null,
      toNumberOrNull(snapshot.prediction.expectedHigh),
      toNumberOrNull(snapshot.prediction.stdDev),
      safeJson(snapshot.prediction.temperatureDistribution),
      safeJson(snapshot.prediction.bucketProbabilities),
      toNumberOrNull(snapshot.prediction.confidence),
      safeJson(snapshot.prediction.sourceFreshness),
      safeJson(snapshot.prediction),
      capturedAt
    ]);
  }

  for (const recommendation of (Array.isArray(snapshot?.recommendations?.recommendations) ? snapshot.recommendations.recommendations : [])) {
    await query(env, `
      insert into chicago_trade_recommendations (
        id, prediction_id, market_slug, condition_id, outcome_label, action,
        fair_probability, market_price, edge, max_entry_price, suggested_size,
        status, reason, raw_json, captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      randomUUID(),
      predictionId,
      recommendation.marketSlug ?? null,
      recommendation.conditionId ?? null,
      recommendation.outcomeLabel ?? null,
      recommendation.action ?? null,
      toNumberOrNull(recommendation.fairProbability),
      toNumberOrNull(recommendation.marketPrice),
      toNumberOrNull(recommendation.edge),
      toNumberOrNull(recommendation.maxEntryPrice),
      toNumberOrNull(recommendation.suggestedSize),
      recommendation.status ?? null,
      recommendation.reason ?? null,
      safeJson(recommendation),
      capturedAt
    ]);
  }

  const localAnalytics = await persistLocalChicagoSnapshot(env, snapshot);

  return {
    enabled: true,
    predictionId,
    localAnalytics
  };
}

export async function getChicagoHistory(env, { date } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoHistoryFromFiles(env, init, { date });
  }

  const [
    marketSnapshots,
    observations,
    stationDiagnostics,
    forecastSnapshots,
    settlements,
    predictions,
    recommendations
  ] = await Promise.all([
    query(env, `
      select *
      from chicago_market_snapshots
      where ($1::date is null or event_date = $1::date)
      order by captured_at desc
      limit 200
    `, [date ?? null]),
    query(env, `
      select *
      from chicago_observations
      where ($1::date is null or observed_at >= (($1::date + interval '6 hours') at time zone 'UTC')
        and observed_at < (($1::date + interval '1 day 6 hours') at time zone 'UTC'))
      order by observed_at desc
      limit 500
    `, [date ?? null]),
    query(env, `
      select *
      from chicago_station_diagnostics
      where ($1::date is null or event_date = $1::date)
      order by captured_at desc
      limit 200
    `, [date ?? null]),
    query(env, `
      select *
      from chicago_forecast_snapshots
      where ($1::date is null or valid_start >= (($1::date + interval '6 hours') at time zone 'UTC')
        and valid_start < (($1::date + interval '1 day 6 hours') at time zone 'UTC'))
      order by captured_at desc, valid_start asc
      limit 500
    `, [date ?? null]),
    query(env, `
      select *
      from chicago_settlements
      where ($1::date is null or cli_date = $1::date)
      order by captured_at desc
      limit 25
    `, [date ?? null]),
    query(env, `
      select *
      from chicago_predictions
      where ($1::date is null or event_date = $1::date)
      order by prediction_time desc
      limit 50
    `, [date ?? null]),
    query(env, `
      select r.*
      from chicago_trade_recommendations r
      left join chicago_predictions p on p.id = r.prediction_id
      where ($1::date is null or p.event_date = $1::date)
      order by r.captured_at desc
      limit 100
    `, [date ?? null])
  ]);

  return {
    enabled: true,
    marketSnapshots: marketSnapshots?.rows ?? [],
    observations: observations?.rows ?? [],
    stationDiagnostics: stationDiagnostics?.rows ?? [],
    forecastSnapshots: forecastSnapshots?.rows ?? [],
    settlements: settlements?.rows ?? [],
    predictions: predictions?.rows ?? [],
    recommendations: recommendations?.rows ?? []
  };
}

export async function getChicagoSourceAudit(env, { date } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoSourceAuditFromFiles(env, init, { date });
  }

  const normalizedDate = normalizeDateBound(date);
  const result = await query(env, `
    select *
    from chicago_market_snapshots
    where ($1::date is null or event_date = $1::date)
    order by captured_at desc
    limit 2000
  `, [normalizedDate]);
  const summary = summarizeChicagoSourceAuditRows(result?.rows ?? []);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    date: normalizedDate,
    ...summary
  };
}

function normalizeAlertSeverity(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['critical', 'warning', 'info'].includes(normalized) ? normalized : 'info';
}

function normalizeAlertStatus(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['active', 'acknowledged', 'resolved'].includes(normalized) ? normalized : 'active';
}

function normalizeChicagoAlertRow(row) {
  const rawJson = parseMaybeJson(row?.raw_json) ?? row?.rawJson ?? null;
  const raw = row?.raw ?? rawJson ?? row ?? {};
  const alertKey = row?.alert_key ?? row?.alertKey ?? raw.alertKey ?? raw.id ?? randomUUID();
  const id = row?.id ?? raw.id ?? alertKey;
  const triggeredAt = normalizeAuditTimestamp(row?.triggered_at ?? row?.triggeredAt ?? raw.triggeredAt) ?? new Date().toISOString();

  return {
    id: String(id),
    stationId: row?.station_id ?? row?.stationId ?? raw.stationId ?? 'KMDW',
    eventDate: normalizeAuditDate(row?.event_date ?? row?.eventDate ?? raw.eventDate),
    alertKey: String(alertKey),
    type: row?.alert_type ?? row?.type ?? raw.type ?? 'kmdw-alert',
    severity: normalizeAlertSeverity(row?.severity ?? raw.severity),
    status: normalizeAlertStatus(row?.status ?? raw.status),
    title: String(row?.title ?? raw.title ?? 'KMDW alert'),
    message: row?.message ?? raw.message ?? null,
    triggeredAt,
    acknowledgedAt: normalizeAuditTimestamp(row?.acknowledged_at ?? row?.acknowledgedAt ?? raw.acknowledgedAt),
    resolvedAt: normalizeAuditTimestamp(row?.resolved_at ?? row?.resolvedAt ?? raw.resolvedAt),
    raw: rawJson ?? raw,
    createdAt: normalizeAuditTimestamp(row?.created_at ?? row?.createdAt ?? raw.createdAt) ?? triggeredAt,
    updatedAt: normalizeAuditTimestamp(row?.updated_at ?? row?.updatedAt ?? raw.updatedAt) ?? triggeredAt
  };
}

function mergeChicagoAlertRows(rows) {
  const byId = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const normalized = normalizeChicagoAlertRow(row);
    const existing = byId.get(normalized.id);
    const existingTime = Date.parse(existing?.updatedAt ?? existing?.triggeredAt ?? '');
    const nextTime = Date.parse(normalized.updatedAt ?? normalized.triggeredAt ?? '');

    if (!existing || !Number.isFinite(existingTime) || (Number.isFinite(nextTime) && nextTime >= existingTime)) {
      byId.set(normalized.id, normalized);
    }
  }

  return [...byId.values()].sort((left, right) => {
    const timeComparison = String(right.triggeredAt ?? '').localeCompare(String(left.triggeredAt ?? ''));

    if (timeComparison !== 0) {
      return timeComparison;
    }

    return String(left.id).localeCompare(String(right.id));
  });
}

function summarizeChicagoAlerts(alerts, { generatedAt = new Date().toISOString(), date = null } = {}) {
  const normalizedAlerts = mergeChicagoAlertRows(alerts);
  const activeAlerts = normalizedAlerts.filter((alert) => alert.status === 'active');
  const severityCounts = activeAlerts.reduce((counts, alert) => {
    counts[alert.severity] = (counts[alert.severity] ?? 0) + 1;
    return counts;
  }, {});
  const typeCounts = activeAlerts.reduce((counts, alert) => {
    counts[alert.type] = (counts[alert.type] ?? 0) + 1;
    return counts;
  }, {});

  return {
    generatedAt,
    date,
    alertCount: normalizedAlerts.length,
    activeCount: activeAlerts.length,
    criticalCount: severityCounts.critical ?? 0,
    warningCount: severityCounts.warning ?? 0,
    severityCounts,
    typeCounts
  };
}

async function persistChicagoAlertsToFiles(env, init, alerts, {
  date = null,
  generatedAt = new Date().toISOString(),
  resolveMissing = true
} = {}) {
  const normalizedDate = normalizeDateBound(date);
  const incomingAlerts = mergeChicagoAlertRows(alerts).map((alert) => ({
    ...alert,
    status: 'active',
    resolvedAt: null,
    updatedAt: generatedAt
  }));
  const incomingIds = new Set(incomingAlerts.map((alert) => alert.id));
  const existingAlerts = mergeChicagoAlertRows(await readJsonl(env, CHICAGO_ALERTS_FILE));
  const retainedAlerts = existingAlerts.map((alert) => {
    if (
      resolveMissing
      && normalizedDate
      && alert.status === 'active'
      && alert.eventDate === normalizedDate
      && !incomingIds.has(alert.id)
    ) {
      return {
        ...alert,
        status: 'resolved',
        resolvedAt: generatedAt,
        updatedAt: generatedAt
      };
    }

    return alert;
  });
  const mergedAlerts = mergeChicagoAlertRows([
    ...retainedAlerts,
    ...incomingAlerts
  ]);

  await writeJsonl(env, CHICAGO_ALERTS_FILE, mergedAlerts);
  const localAnalytics = await persistLocalChicagoAlerts(env, mergedAlerts);

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    file: path.join(getWeatherDataDir(env), CHICAGO_ALERTS_FILE),
    storedAlertCount: mergedAlerts.length,
    localAnalytics,
    ...summarizeChicagoAlerts(incomingAlerts, { generatedAt, date: normalizedDate })
  };
}

async function getChicagoAlertsFromFiles(env, init, { date = null, status = 'active', limit = 50 } = {}) {
  const normalizedDate = normalizeDateBound(date);
  const normalizedStatus = status === null ? null : normalizeAlertStatus(status);
  const normalizedLimit = Number.parseInt(String(limit ?? ''), 10);
  const alerts = mergeChicagoAlertRows(await readJsonl(env, CHICAGO_ALERTS_FILE))
    .filter((alert) => !normalizedDate || alert.eventDate === normalizedDate)
    .filter((alert) => normalizedStatus === null || alert.status === normalizedStatus);
  const limitedAlerts = Number.isFinite(normalizedLimit) && normalizedLimit > 0
    ? alerts.slice(0, normalizedLimit)
    : alerts;

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    filters: {
      date: normalizedDate,
      status: normalizedStatus,
      limit: Number.isFinite(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : null
    },
    alerts: limitedAlerts,
    summary: summarizeChicagoAlerts(limitedAlerts, {
      date: normalizedDate
    })
  };
}

export async function persistChicagoAlerts(env, alerts, {
  date = null,
  generatedAt = new Date().toISOString(),
  resolveMissing = true
} = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return persistChicagoAlertsToFiles(env, init, alerts, { date, generatedAt, resolveMissing });
  }

  const normalizedDate = normalizeDateBound(date);
  const normalizedAlerts = mergeChicagoAlertRows(alerts).map((alert) => ({
    ...alert,
    status: 'active',
    resolvedAt: null,
    updatedAt: generatedAt
  }));

  for (const alert of normalizedAlerts) {
    await query(env, `
      insert into chicago_alerts (
        id, station_id, event_date, alert_key, alert_type, severity, status,
        title, message, triggered_at, acknowledged_at, resolved_at, raw_json,
        created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,$12,now(),now())
      on conflict (id) do update set
        station_id = excluded.station_id,
        event_date = excluded.event_date,
        alert_key = excluded.alert_key,
        alert_type = excluded.alert_type,
        severity = excluded.severity,
        status = 'active',
        title = excluded.title,
        message = excluded.message,
        triggered_at = excluded.triggered_at,
        acknowledged_at = excluded.acknowledged_at,
        resolved_at = null,
        raw_json = excluded.raw_json,
        updated_at = now()
    `, [
      alert.id,
      alert.stationId,
      alert.eventDate,
      alert.alertKey,
      alert.type,
      alert.severity,
      alert.title,
      alert.message,
      alert.triggeredAt,
      alert.acknowledgedAt,
      alert.resolvedAt,
      safeJson(alert.raw ?? alert)
    ]);
  }

  if (resolveMissing && normalizedDate) {
    const activeIds = normalizedAlerts.map((alert) => alert.id);
    await query(env, `
      update chicago_alerts
      set status = 'resolved',
        resolved_at = $3::timestamptz,
        updated_at = now()
      where status = 'active'
        and event_date = $1::date
        and ($2::text[] is null or not (id = any($2::text[])))
    `, [normalizedDate, activeIds.length > 0 ? activeIds : null, generatedAt]);
  }

  const localAnalytics = await persistLocalChicagoAlerts(env, normalizedAlerts);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    localAnalytics,
    ...summarizeChicagoAlerts(normalizedAlerts, { generatedAt, date: normalizedDate })
  };
}

export async function getChicagoAlerts(env, { date = null, status = 'active', limit = 50 } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoAlertsFromFiles(env, init, { date, status, limit });
  }

  const normalizedDate = normalizeDateBound(date);
  const normalizedStatus = status === null ? null : normalizeAlertStatus(status);
  const normalizedLimit = Number.parseInt(String(limit ?? ''), 10);
  const result = await query(env, `
    select *
    from chicago_alerts
    where ($1::date is null or event_date = $1::date)
      and ($2::text is null or status = $2::text)
    order by triggered_at desc, updated_at desc
    limit $3
  `, [
    normalizedDate,
    normalizedStatus,
    Number.isFinite(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : 50
  ]);
  const alerts = mergeChicagoAlertRows(result?.rows ?? []);

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    filters: {
      date: normalizedDate,
      status: normalizedStatus,
      limit: Number.isFinite(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : 50
    },
    alerts,
    summary: summarizeChicagoAlerts(alerts, {
      date: normalizedDate
    })
  };
}

function normalizeDateBound(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseMaybeJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function recommendationRange(row) {
  const raw = recommendationRawJson(row);
  return {
    lowTemp: toNumberOrNull(raw.lowTemp),
    highTemp: toNumberOrNull(raw.highTemp)
  };
}

function recommendationRawJson(row) {
  return parseMaybeJson(row?.raw_json) ?? {};
}

function rangeContainsHigh(actualHigh, range) {
  if (typeof actualHigh !== 'number') {
    return null;
  }

  if (typeof range.lowTemp === 'number' && actualHigh < range.lowTemp) {
    return false;
  }

  if (typeof range.highTemp === 'number' && actualHigh > range.highTemp) {
    return false;
  }

  return true;
}

function averageNumbers(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function roundMetric(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function probabilityLogLoss(probability, actualOutcome) {
  if (typeof probability !== 'number' || typeof actualOutcome !== 'boolean') {
    return null;
  }

  const safeProbability = Math.min(0.999999, Math.max(0.000001, probability));
  return actualOutcome
    ? -Math.log(safeProbability)
    : -Math.log(1 - safeProbability);
}

function recommendationEstimatedCost(row) {
  const raw = recommendationRawJson(row);
  return toNumberOrNull(row?.estimated_cost)
    ?? toNumberOrNull(raw.estimatedCost)
    ?? toNumberOrNull(raw.costBreakdown?.totalCost)
    ?? 0;
}

function predictionRawJson(row) {
  return parseMaybeJson(row?.prediction_raw_json) ?? {};
}

function rowBucketProbability(row, { rowKey, predictionKey, rawKeys = [] }) {
  const raw = recommendationRawJson(row);
  const predictionRaw = predictionRawJson(row);
  const conditionId = row?.condition_id ?? raw.conditionId ?? null;

  for (const rawKey of rawKeys) {
    const rawValue = toNumberOrNull(raw?.[rawKey]);

    if (typeof rawValue === 'number') {
      return rawValue;
    }
  }

  return toNumberOrNull(row?.[rowKey])
    ?? toNumberOrNull(predictionRaw?.[predictionKey]?.[conditionId])
    ?? (predictionKey === 'weatherBucketProbabilities'
      ? probabilityFromTemperatureDistribution(predictionRaw?.temperatureDistribution, recommendationRange(row))
      : null)
    ?? null;
}

function probabilityFromTemperatureDistribution(distribution, range) {
  if (!distribution || typeof distribution !== 'object') {
    return null;
  }

  let probability = 0;
  let found = false;

  for (const [temperature, value] of Object.entries(distribution)) {
    const temp = Number.parseInt(temperature, 10);
    const bucketProbability = toNumberOrNull(value);

    if (!Number.isFinite(temp) || typeof bucketProbability !== 'number') {
      continue;
    }

    if (typeof range.lowTemp === 'number' && temp < range.lowTemp) {
      continue;
    }

    if (typeof range.highTemp === 'number' && temp > range.highTemp) {
      continue;
    }

    probability += bucketProbability;
    found = true;
  }

  return found ? roundMetric(probability, 6) : null;
}

function standardDeviation(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));

  if (valid.length < 2) {
    return null;
  }

  const mean = averageNumbers(valid);
  const variance = valid.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / valid.length;
  return Math.sqrt(variance);
}

function buildPnlMetrics(rows) {
  const orderedRows = [...rows]
    .filter((row) => typeof row.netOneSharePnl === 'number')
    .sort((left, right) => {
      const leftKey = `${left.event_date ?? ''}-${left.prediction_time ?? ''}-${left.condition_id ?? ''}`;
      const rightKey = `${right.event_date ?? ''}-${right.prediction_time ?? ''}-${right.condition_id ?? ''}`;
      return leftKey.localeCompare(rightKey);
    });
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve = orderedRows.map((row) => {
    cumulative += row.netOneSharePnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);

    return {
      eventDate: row.event_date ?? null,
      predictionTime: row.prediction_time ?? null,
      conditionId: row.condition_id ?? null,
      netOneSharePnl: roundMetric(row.netOneSharePnl, 4),
      cumulativeNetPnl: roundMetric(cumulative, 4)
    };
  });
  const netValues = orderedRows.map((row) => row.netOneSharePnl);
  const averageNetPnl = averageNumbers(netValues);
  const stdDev = standardDeviation(netValues);

  return {
    grossOneSharePnl: roundMetric(orderedRows.reduce((sum, row) => sum + (row.oneSharePnl ?? 0), 0), 4),
    netOneSharePnl: roundMetric(cumulative, 4),
    averageNetPnlPerActionable: roundMetric(averageNetPnl, 4),
    maxDrawdown: roundMetric(maxDrawdown, 4),
    sharpeLike: typeof averageNetPnl === 'number' && typeof stdDev === 'number' && stdDev > 0
      ? roundMetric((averageNetPnl / stdDev) * Math.sqrt(netValues.length), 4)
      : null,
    equityCurve
  };
}

function buildFillAdjustedMetrics(rows) {
  const attemptedRows = rows.filter((row) => row.isActionable && row.actualOutcome !== null);
  const filledRows = attemptedRows.filter((row) => row.fillEligible);
  const noFillRows = attemptedRows.filter((row) => row.executionExecutable === false);
  const blockerCounts = new Map();

  for (const row of noFillRows) {
    const blockers = Array.isArray(row.executionPlan?.blockers) && row.executionPlan.blockers.length > 0
      ? row.executionPlan.blockers
      : ['execution blocked'];

    for (const blocker of blockers) {
      blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1);
    }
  }

  return {
    attemptedActionableCount: attemptedRows.length,
    filledActionableCount: filledRows.length,
    noFillCount: noFillRows.length,
    fillRate: attemptedRows.length > 0 ? roundMetric(filledRows.length / attemptedRows.length) : null,
    trading: buildPnlMetrics(filledRows),
    topNoFillReasons: [...blockerCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }))
  };
}

function buildCalibrationBins(rows, probabilityKey) {
  const bins = Array.from({ length: 10 }, (_, index) => ({
    binStart: index / 10,
    binEnd: (index + 1) / 10,
    count: 0,
    probabilitySum: 0,
    outcomeSum: 0
  }));

  for (const row of rows) {
    const probability = toNumberOrNull(row?.[probabilityKey]);

    if (typeof probability !== 'number' || typeof row.actualOutcome !== 'boolean') {
      continue;
    }

    const index = Math.min(9, Math.max(0, Math.floor(probability * 10)));
    bins[index].count += 1;
    bins[index].probabilitySum += probability;
    bins[index].outcomeSum += row.actualOutcome ? 1 : 0;
  }

  const populatedBins = bins
    .filter((bin) => bin.count > 0)
    .map((bin) => {
      const averageProbability = bin.probabilitySum / bin.count;
      const observedRate = bin.outcomeSum / bin.count;

      return {
        bin: `${Math.round(bin.binStart * 100)}-${Math.round(bin.binEnd * 100)}%`,
        count: bin.count,
        averageProbability: roundMetric(averageProbability),
        observedRate: roundMetric(observedRate),
        calibrationError: roundMetric(Math.abs(averageProbability - observedRate))
      };
    });

  return {
    meanAbsoluteCalibrationError: roundMetric(averageNumbers(populatedBins.map((bin) => bin.calibrationError))),
    bins: populatedBins
  };
}

export function summarizeChicagoBacktestRows(rows) {
  const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) => {
    const raw = recommendationRawJson(row);
    const actualHigh = toNumberOrNull(row.actual_high);
    const range = recommendationRange(row);
    const actualOutcome = rangeContainsHigh(actualHigh, range);
    const modelProbability = toNumberOrNull(row.fair_probability);
    const weatherOnlyProbability = rowBucketProbability(row, {
      rowKey: 'weather_probability',
      predictionKey: 'weatherBucketProbabilities',
      rawKeys: ['weatherProbability', 'weatherOnlyProbability']
    });
    const marketImpliedProbability = rowBucketProbability(row, {
      rowKey: 'market_implied_probability',
      predictionKey: 'marketImpliedBucketProbabilities',
      rawKeys: ['marketImpliedProbability']
    });
    const marketPrice = toNumberOrNull(row.market_price);
    const expectedHigh = toNumberOrNull(row.expected_high);
    const isActionable = row.status === 'passed' || row.action === 'recommend-buy-yes';
    const estimatedCost = recommendationEstimatedCost(row);
    const executionPlan = raw.executionPlan && typeof raw.executionPlan === 'object' ? raw.executionPlan : null;
    const executionExecutable = executionPlan ? executionPlan.executable === true : null;
    const fillEligible = isActionable && executionExecutable !== false;
    const oneSharePnl = isActionable && actualOutcome !== null && typeof marketPrice === 'number'
      ? (actualOutcome ? 1 - marketPrice : -marketPrice)
      : null;
    const netOneSharePnl = fillEligible && typeof oneSharePnl === 'number'
      ? oneSharePnl - estimatedCost
      : null;

    return {
      ...row,
      actualHigh,
      range,
      actualOutcome,
      modelProbability,
      weatherOnlyProbability,
      marketImpliedProbability,
      marketPrice,
      expectedHigh,
      isActionable,
      estimatedCost,
      executionPlan,
      executionExecutable,
      fillEligible,
      oneSharePnl,
      netOneSharePnl
    };
  });
  const settled = normalizedRows.filter((row) => row.actualOutcome !== null);
  const actionable = normalizedRows.filter((row) => row.isActionable);
  const settledActionable = actionable.filter((row) => row.actualOutcome !== null);
  const brierValues = settled
    .filter((row) => typeof row.modelProbability === 'number')
    .map((row) => (row.modelProbability - (row.actualOutcome ? 1 : 0)) ** 2);
  const marketBrierValues = settled
    .filter((row) => typeof row.marketPrice === 'number')
    .map((row) => (row.marketPrice - (row.actualOutcome ? 1 : 0)) ** 2);
  const weatherBrierValues = settled
    .filter((row) => typeof row.weatherOnlyProbability === 'number')
    .map((row) => (row.weatherOnlyProbability - (row.actualOutcome ? 1 : 0)) ** 2);
  const modelLogLossValues = settled
    .map((row) => probabilityLogLoss(row.modelProbability, row.actualOutcome))
    .filter((value) => typeof value === 'number');
  const marketLogLossValues = settled
    .map((row) => probabilityLogLoss(row.marketPrice, row.actualOutcome))
    .filter((value) => typeof value === 'number');
  const weatherLogLossValues = settled
    .map((row) => probabilityLogLoss(row.weatherOnlyProbability, row.actualOutcome))
    .filter((value) => typeof value === 'number');
  const modelBiasValues = settled
    .filter((row) => typeof row.modelProbability === 'number')
    .map((row) => row.modelProbability - (row.actualOutcome ? 1 : 0));
  const marketBiasValues = settled
    .filter((row) => typeof row.marketPrice === 'number')
    .map((row) => row.marketPrice - (row.actualOutcome ? 1 : 0));
  const weatherBiasValues = settled
    .filter((row) => typeof row.weatherOnlyProbability === 'number')
    .map((row) => row.weatherOnlyProbability - (row.actualOutcome ? 1 : 0));
  const forecastErrors = settled
    .filter((row) => typeof row.expectedHigh === 'number' && typeof row.actualHigh === 'number')
    .map((row) => Math.abs(row.expectedHigh - row.actualHigh));
  const pnlValues = settledActionable
    .map((row) => row.oneSharePnl)
    .filter((value) => typeof value === 'number');
  const netPnlMetrics = buildPnlMetrics(settledActionable);
  const fillAdjustedMetrics = buildFillAdjustedMetrics(normalizedRows);
  const winners = settledActionable.filter((row) => row.actualOutcome === true).length;
  const modelBrierScore = roundMetric(averageNumbers(brierValues));
  const marketBrierScore = roundMetric(averageNumbers(marketBrierValues));
  const weatherBrierScore = roundMetric(averageNumbers(weatherBrierValues));
  const modelCalibration = buildCalibrationBins(settled, 'modelProbability');
  const marketCalibration = buildCalibrationBins(settled, 'marketPrice');
  const weatherCalibration = buildCalibrationBins(settled, 'weatherOnlyProbability');

  return {
    generatedAt: new Date().toISOString(),
    rowCount: normalizedRows.length,
    recommendationCount: normalizedRows.length,
    actionableCount: actionable.length,
    settledCount: settled.length,
    settledActionableCount: settledActionable.length,
    brierScore: modelBrierScore,
    forecastMae: roundMetric(averageNumbers(forecastErrors), 2),
    hitRate: settledActionable.length > 0 ? roundMetric(winners / settledActionable.length) : null,
    oneSharePnl: roundMetric(pnlValues.reduce((sum, value) => sum + value, 0), 4),
    averagePnlPerActionable: roundMetric(averageNumbers(pnlValues), 4),
    trading: netPnlMetrics,
    fillAdjusted: fillAdjustedMetrics,
    benchmarks: {
      fusedModel: {
        brierScore: modelBrierScore,
        logLoss: roundMetric(averageNumbers(modelLogLossValues)),
        calibrationBias: roundMetric(averageNumbers(modelBiasValues)),
        calibration: modelCalibration
      },
      weatherOnly: {
        brierScore: weatherBrierScore,
        logLoss: roundMetric(averageNumbers(weatherLogLossValues)),
        calibrationBias: roundMetric(averageNumbers(weatherBiasValues)),
        calibration: weatherCalibration
      },
      marketOnly: {
        brierScore: marketBrierScore,
        logLoss: roundMetric(averageNumbers(marketLogLossValues)),
        calibrationBias: roundMetric(averageNumbers(marketBiasValues)),
        calibration: marketCalibration
      },
      edgeVsMarket: {
        brierImprovement: typeof modelBrierScore === 'number' && typeof marketBrierScore === 'number'
          ? roundMetric(marketBrierScore - modelBrierScore)
          : null,
        lowerBrierWinner: typeof modelBrierScore === 'number' && typeof marketBrierScore === 'number'
          ? (modelBrierScore <= marketBrierScore ? 'fused-model' : 'market-only')
          : null
      },
      edgeVsWeatherOnly: {
        brierImprovement: typeof modelBrierScore === 'number' && typeof weatherBrierScore === 'number'
          ? roundMetric(weatherBrierScore - modelBrierScore)
          : null,
        lowerBrierWinner: typeof modelBrierScore === 'number' && typeof weatherBrierScore === 'number'
          ? (modelBrierScore <= weatherBrierScore ? 'fused-model' : 'weather-only')
          : null
      }
    },
    rows: normalizedRows.map((row) => ({
      predictionId: row.prediction_id ?? null,
      eventDate: row.event_date ?? null,
      marketSlug: row.market_slug ?? null,
      conditionId: row.condition_id ?? null,
      outcomeLabel: row.outcome_label ?? null,
      action: row.action ?? null,
      status: row.status ?? null,
      fairProbability: row.modelProbability,
      weatherOnlyProbability: row.weatherOnlyProbability,
      marketImpliedProbability: row.marketImpliedProbability,
      marketPrice: row.marketPrice,
      edge: toNumberOrNull(row.edge),
      estimatedCost: roundMetric(row.estimatedCost, 4),
      expectedHigh: row.expectedHigh,
      actualHigh: row.actualHigh,
      actualHighSource: row.actual_high_source ?? null,
      actualOutcome: row.actualOutcome,
      executionExecutable: row.executionExecutable,
      fillEligible: row.fillEligible,
      oneSharePnl: roundMetric(row.oneSharePnl, 4),
      netOneSharePnl: roundMetric(row.netOneSharePnl, 4)
    }))
  };
}

async function getChicagoBacktestFromFiles(env, init, { dateFrom = null, dateTo = null, minEdge = null } = {}) {
  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const normalizedMinEdge = toNumberOrNull(minEdge);
  const snapshots = snapshotRows(await readJsonl(env, CHICAGO_SNAPSHOTS_FILE));
  const settlementsByDate = settlementMapFromSnapshots(snapshots);
  const archiveRows = mergeDailyArchiveRows(await readJsonl(env, CHICAGO_DAILY_ARCHIVE_FILE));
  const archiveByDate = archiveSettlementMap(archiveRows);
  const forecastVintage = await getChicagoForecastVintagesFromFiles(env, init, {
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo
  });
  const historicalBoards = await getChicagoHistoricalMarketBoardsFromFiles(env, init, {
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo
  });
  const rows = snapshots
    .filter((snapshot) => !normalizedDateFrom || snapshot.targetDate >= normalizedDateFrom)
    .filter((snapshot) => !normalizedDateTo || snapshot.targetDate <= normalizedDateTo)
    .flatMap((snapshot) => recommendationRowsFromSnapshot(snapshot).map((row) => ({
      ...row,
      actual_high: archiveByDate.get(row.event_date) ?? settlementsByDate.get(row.event_date) ?? null,
      actual_high_source: archiveByDate.has(row.event_date)
        ? 'ncei-cdo-ghcnd'
        : settlementsByDate.has(row.event_date)
          ? 'captured-climdw'
          : null
    })))
    .filter((row) => normalizedMinEdge === null || toNumberOrNull(row.edge) >= normalizedMinEdge)
    .sort((left, right) => String(right.prediction_time ?? '').localeCompare(String(left.prediction_time ?? '')));

  return {
    enabled: true,
    storage: 'jsonl',
    databaseEnabled: false,
    reason: init.reason,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo,
      minEdge: normalizedMinEdge
    },
    archive: {
      recordCount: archiveRows.length,
      usedActualHighCount: rows.filter((row) => row.actual_high_source === 'ncei-cdo-ghcnd').length
    },
    forecastVintage: {
      recordCount: forecastVintage.recordCount,
      dailySummaryCount: forecastVintage.summary.dailySummaryCount,
      actualMatchedCount: forecastVintage.summary.actualMatchedCount,
      maeByLeadDay: forecastVintage.summary.maeByLeadDay
    },
    historicalBoards: {
      archiveCount: historicalBoards.summary.archiveCount,
      contractCount: historicalBoards.summary.contractCount,
      pricePointCount: historicalBoards.summary.pricePointCount,
      tradeCount: historicalBoards.summary.tradeCount,
      boardSnapshotCount: historicalBoards.summary.boardSnapshotCount,
      eventDates: historicalBoards.summary.eventDates
    },
    summary: summarizeChicagoBacktestRows(rows)
  };
}

export async function getChicagoModelTrainingRows(env, { dateFrom = null, dateTo = null, limit = null } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoModelTrainingRowsFromFiles(env, init, { dateFrom, dateTo, limit });
  }

  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const normalizedLimit = Number.parseInt(String(limit ?? ''), 10);
  const archiveStationId = env?.noaaCdoKmdwStationId ?? 'GHCND:USW00014819';
  const result = await query(env, `
    select
      p.event_date,
      p.prediction_time,
      p.expected_high,
      p.std_dev,
      p.confidence_score,
      p.raw_json as prediction_raw_json,
      r.market_slug,
      r.condition_id,
      r.outcome_label,
      r.fair_probability,
      r.market_price,
      r.edge,
      r.raw_json as recommendation_raw_json,
      fv.forecast_vintage_high,
      hb.historical_market_probability,
      hb.historical_market_reconstructed_at,
      hb.historical_market_source,
      coalesce(a.max_temp_f, s.max_temp_f) as actual_high,
      case
        when a.max_temp_f is not null then a.source
        when s.max_temp_f is not null then 'captured-climdw'
        else null
      end as actual_high_source
    from chicago_trade_recommendations r
    join chicago_predictions p on p.id = r.prediction_id
    left join chicago_daily_archives a
      on a.archive_date = p.event_date
      and a.station_id = $3::text
      and a.source = 'ncei-cdo-ghcnd'
    left join chicago_settlements s
      on s.station_id = p.station_id
      and s.cli_date = p.event_date
    left join lateral (
      select max(v.forecast_temp_f)::float as forecast_vintage_high
      from chicago_forecast_vintages v
      where v.target_date = p.event_date
        and v.station_id = p.station_id
        and v.lead_days = 1
    ) fv on true
    left join lateral (
      select
        coalesce(contract.value->>'reconstructedPrice', contract.value->>'lastTradePrice')::float as historical_market_probability,
        board.value->>'reconstructedAt' as historical_market_reconstructed_at,
        case
          when contract.value ? 'reconstructedPrice' and contract.value->>'reconstructedPrice' is not null
          then coalesce(contract.value->>'quoteSource', 'polymarket-clob-prices-history')
          else 'polymarket-trades'
        end as historical_market_source
      from chicago_historical_market_boards h
      cross join lateral jsonb_array_elements(coalesce(h.raw_json->'boardSnapshots', '[]'::jsonb)) as board(value)
      cross join lateral jsonb_array_elements(coalesce(board.value->'contracts', '[]'::jsonb)) as contract(value)
      where h.station_id = p.station_id
        and board.value->>'eventDate' = p.event_date::text
        and contract.value->>'conditionId' = r.condition_id
        and coalesce(contract.value->>'reconstructedPrice', contract.value->>'lastTradePrice') ~ '^[0-9]+(\\.[0-9]+)?$'
        and board.value->>'timestamp' ~ '^[0-9]+(\\.[0-9]+)?$'
        and (board.value->>'timestamp')::numeric <= extract(epoch from p.prediction_time)
      order by (board.value->>'timestamp')::numeric desc
      limit 1
    ) hb on true
    where ($1::date is null or p.event_date >= $1::date)
      and ($2::date is null or p.event_date <= $2::date)
      and coalesce(a.max_temp_f, s.max_temp_f) is not null
    order by p.prediction_time asc
  `, [normalizedDateFrom, normalizedDateTo, archiveStationId]);
  const rows = (result?.rows ?? [])
    .map((row) => {
      const prediction = parseMaybeJson(row.prediction_raw_json) ?? {
        expectedHigh: toNumberOrNull(row.expected_high),
        stdDev: toNumberOrNull(row.std_dev),
        confidence: toNumberOrNull(row.confidence_score)
      };
      const recommendation = parseMaybeJson(row.recommendation_raw_json) ?? {
        marketSlug: row.market_slug,
        conditionId: row.condition_id,
        outcomeLabel: row.outcome_label,
        fairProbability: toNumberOrNull(row.fair_probability),
        marketPrice: toNumberOrNull(row.market_price),
        edge: toNumberOrNull(row.edge)
      };

      return buildChicagoModelTrainingRow({
        prediction,
        recommendation: {
          marketSlug: row.market_slug,
          conditionId: row.condition_id,
          outcomeLabel: row.outcome_label,
          fairProbability: toNumberOrNull(row.fair_probability),
          marketPrice: toNumberOrNull(row.market_price),
          edge: toNumberOrNull(row.edge),
          ...recommendation
        },
        eventDate: normalizeAuditDate(row.event_date),
        predictionTime: normalizeAuditTimestamp(row.prediction_time),
        actualHigh: row.actual_high,
        actualHighSource: row.actual_high_source,
        context: {
          forecastVintageHighF: toNumberOrNull(row.forecast_vintage_high),
          historicalMarketProbability: toNumberOrNull(row.historical_market_probability),
          historicalMarketReconstructedAt: normalizeAuditTimestamp(row.historical_market_reconstructed_at),
          historicalMarketSource: row.historical_market_source ?? null
        }
      });
    })
    .filter(Boolean);
  const limitedRows = Number.isFinite(normalizedLimit) && normalizedLimit > 0
    ? rows.slice(-normalizedLimit)
    : rows;

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo,
      limit: Number.isFinite(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : null
    },
    rowCount: limitedRows.length,
    rows: limitedRows,
    summary: summarizeChicagoModelTrainingRows(limitedRows)
  };
}

export async function getChicagoBacktest(env, { dateFrom = null, dateTo = null, minEdge = null } = {}) {
  const init = await initializePersistence(env);

  if (!init.enabled) {
    return getChicagoBacktestFromFiles(env, init, { dateFrom, dateTo, minEdge });
  }

  const normalizedDateFrom = normalizeDateBound(dateFrom);
  const normalizedDateTo = normalizeDateBound(dateTo);
  const normalizedMinEdge = toNumberOrNull(minEdge);
  const archiveStationId = env?.noaaCdoKmdwStationId ?? 'GHCND:USW00014819';
  const result = await query(env, `
    select
      r.prediction_id,
      p.event_date,
      p.prediction_time,
      p.expected_high,
      p.confidence_score,
      p.raw_json as prediction_raw_json,
      r.market_slug,
      r.condition_id,
      r.outcome_label,
      r.action,
      r.fair_probability,
      r.market_price,
      r.edge,
      r.status,
      r.reason,
      r.raw_json,
      coalesce(a.max_temp_f, s.max_temp_f) as actual_high,
      case
        when a.max_temp_f is not null then a.source
        when s.max_temp_f is not null then 'captured-climdw'
        else null
      end as actual_high_source
    from chicago_trade_recommendations r
    join chicago_predictions p on p.id = r.prediction_id
    left join chicago_daily_archives a
      on a.archive_date = p.event_date
      and a.station_id = $4::text
      and a.source = 'ncei-cdo-ghcnd'
    left join chicago_settlements s
      on s.station_id = p.station_id
      and s.cli_date = p.event_date
    where ($1::date is null or p.event_date >= $1::date)
      and ($2::date is null or p.event_date <= $2::date)
      and ($3::numeric is null or r.edge >= $3::numeric)
    order by p.event_date desc, p.prediction_time desc, r.edge desc nulls last
    limit 1000
  `, [normalizedDateFrom, normalizedDateTo, normalizedMinEdge, archiveStationId]);
  const rows = result?.rows ?? [];
  const forecastVintage = await getChicagoForecastVintages(env, {
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo
  });
  const historicalBoards = await getChicagoHistoricalMarketBoards(env, {
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo
  });

  return {
    enabled: true,
    storage: 'postgres',
    databaseEnabled: true,
    filters: {
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo,
      minEdge: normalizedMinEdge
    },
    archive: {
      stationId: archiveStationId,
      usedActualHighCount: rows.filter((row) => row.actual_high_source === 'ncei-cdo-ghcnd').length
    },
    forecastVintage: {
      recordCount: forecastVintage.recordCount,
      dailySummaryCount: forecastVintage.summary.dailySummaryCount,
      actualMatchedCount: forecastVintage.summary.actualMatchedCount,
      maeByLeadDay: forecastVintage.summary.maeByLeadDay
    },
    historicalBoards: {
      archiveCount: historicalBoards.summary.archiveCount,
      contractCount: historicalBoards.summary.contractCount,
      pricePointCount: historicalBoards.summary.pricePointCount,
      tradeCount: historicalBoards.summary.tradeCount,
      boardSnapshotCount: historicalBoards.summary.boardSnapshotCount,
      eventDates: historicalBoards.summary.eventDates
    },
    summary: summarizeChicagoBacktestRows(rows)
  };
}
