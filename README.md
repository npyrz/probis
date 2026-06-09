![Probis Logo](apps/web/public/logo.png)

# Probis

Probis is a local-first Polymarket US analysis and trade-monitoring system. The current product focus is weather markets, with UFC planned as the next market family.

The recommendation path stays deterministic-first. Event resolution, aggregation, scoring, trade shaping, and tracking are handled in code. The local Ollama layer explains the setup and selects from model-ranked candidates.

## Current Focus

- Resolve Polymarket event URLs or slugs.
- Pull active event and market data with Polymarket US-aware fallback handling.
- Build 7-day price-history and liquidity snapshots.
- Detect weather markets and parse rule text for resolution metadata.
- Surface weather-only ranked opportunities in the Opportunity Board.
- Run a market-microstructure scoring model with weather-rule context attached.
- Save, execute, and monitor trade intents through Polymarket US.

For weather markets, Probis extracts details such as resolution source URL, station code/name, target date, unit, precision, finalization language, and outcome ranges. For example, Wunderground station-history rules are captured so the UI can show the station/source context before a trade is reviewed.

The Chicago tracker is currently scoped to **KMDW / Chicago Midway**. It uses NWS station observations for live Midway temperatures, the CLIMDW climate product for settlement parsing, and rejects Chicago bucket recommendations unless the market rules explicitly point to KMDW, Midway, or CLIMDW rather than an ambiguous Chicago source.

Weather ingestion now runs through a pluggable provider abstraction. The active provider defaults to `kmdw-nws-climdw`, which supplies Midway station metadata, climate-day windowing, CLIMDW settlement, NWS observations, NWS forecasts, optional NBM features, and KMDW Polymarket market boards behind a shared provider interface.

KMDW recommendations include a paper-only execution plan with limit price, recommended notional, quote/depth blockers, source-verification state, and fill-adjusted backtest metrics. Live routing is intentionally disabled inside Probis; KMDW intents are hardened to paper/manual-only even if a payload tries to enable automated order submission.

KMDW backtests report fused-model, weather-only, and market-only calibration so the dashboard can show whether market fusion is improving or degrading the Midway forecast baseline.

Official KMDW archive backfills use NOAA/NCEI Climate Data Online Daily Summaries for Midway station `GHCND:USW00014819`. Backtests prefer those archive `TMAX` highs when present and fall back to captured CLIMDW settlements for dates that have not been backfilled yet.

KMDW forecast-vintage backfills use Open-Meteo Previous Runs over Midway coordinates to reconstruct historical model forecast highs by lead day. This is distinct from live NWS forecast captures and is used to evaluate forecast-vintage error against archived KMDW actual highs.

KMDW historical market-board backfills rebuild full dated contract boards from Polymarket CLOB price history and public trade tape. Backtests report this coverage separately from live app snapshots so quote/trade replay gaps are visible.

KMDW model training is versioned and supervised. The native trainer builds tabular rows from settled KMDW recommendations, official archive actual highs, reconstructed market boards, and forecast vintages; trains a logistic calibration model; evaluates chronological holdout and rolling folds; then writes a canonical artifact plus a model registry/evaluation log.

Executable KMDW paper signals can be saved into the existing trade-intent review list as drafts. Those drafts carry explicit `liveTradingAllowed: false`, `requiresManualSubmission: true`, and `kmdwPaperManualOnly: true` constraints, and the trade-intent service re-applies that policy before entry, sell, and automated-exit routing.

KMDW position lifecycle rules are implemented as manual paper-risk guidance. Late-afternoon signals recommend manual reduction before late prints, evening signals recommend manual flattening before the final print, and completed climate days recommend paper-position reconciliation after CLIMDW. These lifecycle rules also set `liveReduceAllowed: false`, `liveFlattenAllowed: false`, and `automatedExitAllowed: false`.

Streaming market data is intentionally not implemented. Polymarket US market data uses REST polling for the near-term plan; status payloads, KMDW snapshots, and KMDW trade intents expose `transport: polling`, `streamingEnabled: false`, and polling cadence metadata.

KMDW persistence now includes a local analytics store in addition to Postgres and JSONL. Snapshot, archive, forecast-vintage, historical-board, and alert writes mirror into `data/weather/kmdw-analytics.sqlite` plus DuckDB-readable Parquet files under `data/weather/parquet`.

Example DuckDB read:

```bash
duckdb -c "select target_date, count(*) from 'data/weather/parquet/kmdw_market_snapshots.parquet' group by target_date order by target_date desc;"
```

The KMDW tracker also reports threshold sensitivity for the active posterior, marking bucket calls as `stable`, `contested`, or `knife-edge` based on bucket probability separation and distance to the nearest temperature-band boundary.

It also compares the latest captured KMDW signal with the previous capture for the same date, flagging material drift when the best bucket, action, risk-adjusted edge, price, threshold status, or source freshness changes.

KMDW alerts are persisted as in-app notification records for material signal moves, source text hash changes, and threshold danger. The scheduled tracker evaluates alerts after each capture, and manual runs can force a fresh evaluation.

## Research Plan Status

The KMDW / Chicago Midway / Polymarket US research plan is implemented for the intended paper/manual-only scope. There are no remaining code gaps from the plan; remaining work is operational data population and any future decision to expand beyond KMDW.

| Feature | Status | Implementation notes | Command / API entrypoint |
|---|---|---|---|
| KMDW weather tracker | Implemented | Builds Midway snapshots from CLIMDW, NWS observations, NWS forecasts, optional NBM features, KMDW market buckets, and posterior probabilities. | `GET /api/weather/chicago/snapshot`, `npm run weather:snapshot` |
| Source verification | Implemented | Blocks ambiguous Chicago bucket recommendations unless rule text explicitly verifies KMDW, Midway, or CLIMDW. | `GET /api/weather/chicago/source-audit`, `npm run weather:source-audit` |
| Paper-only KMDW signals | Implemented | KMDW draft intents carry manual-only constraints and are hardened before entry, sell, and automated-exit paths. | `POST /api/weather/chicago/intents`, `GET /api/trades/intents` |
| Backtests | Implemented | Reports calibration, market/weather/fused comparisons, execution gates, fill-adjusted P&L, archive coverage, forecast vintage coverage, and reconstructed board coverage. | `GET /api/weather/chicago/backtest`, `npm run weather:backtest` |
| Official archive backfill | Implemented | Imports NOAA/NCEI CDO daily summaries for Midway station `GHCND:USW00014819`; backtests prefer official archive highs when available. | `POST /api/weather/chicago/archive/backfill`, `npm run weather:archive-backfill` |
| Forecast-vintage archive | Implemented | Reconstructs historical Midway forecast vintages from Open-Meteo Previous Runs by lead day and evaluates against archive actuals. | `POST /api/weather/chicago/forecast-vintages/backfill`, `npm run weather:forecast-vintage-backfill` |
| Historical market-board reconstruction | Implemented | Rebuilds dated KMDW contract boards from CLOB price history and public trade tape. | `POST /api/weather/chicago/historical-boards/backfill`, `npm run weather:market-board-backfill` |
| Model training and calibration | Implemented | Trains and evaluates a versioned tabular KMDW calibrator with chronological holdout and rolling folds. | `POST /api/weather/chicago/model/train`, `npm run weather:model-train` |
| Alerts and notifications | Implemented | Persists alert records for material signal drift, source hash changes, and threshold danger. | `GET /api/weather/chicago/alerts`, `npm run weather:alerts` |
| Position lifecycle rules | Implemented | Provides manual reduce, flatten, and paper-close guidance while keeping all live reduce/flatten/exit flags disabled. | KMDW snapshot `executionPlan.positionLifecycle` |
| Polling market data | Implemented | Market data is explicitly REST polling-only; streaming is not implemented for the near-term plan. | `GET /api/polymarket/status`, KMDW snapshot `marketDataPolicy` |
| SQLite / Parquet local analytics store | Implemented | Mirrors KMDW writes into `data/weather/kmdw-analytics.sqlite` and DuckDB-readable Parquet files under `data/weather/parquet`. | `WEATHER_LOCAL_*` env settings |
| Provider abstraction layer | Implemented | Weather ingestion runs through the registered `kmdw-nws-climdw` provider behind a shared provider interface. | `GET /api/weather/providers`, `WEATHER_PROVIDER_ID` |
| Live KMDW trading / routing | Intentionally not implemented | KMDW remains paper/manual-only inside Probis. Live routing must stay disabled unless a separate future plan explicitly enables it. | Trade-intent hardening policy |

What is left:

- Run archive, forecast-vintage, market-board, alert, and model-training jobs for the historical ranges you want populated.
- Re-run model training/evaluation after enough official archive, market-board, and forecast-vintage data exists.
- Keep live KMDW trading disabled unless a separate future plan explicitly changes that safety posture.
- Optionally add more weather providers behind the existing provider abstraction; do not reintroduce non-Midway Chicago station scope for the KMDW product.

## Quick Start

Requirements:

- Node.js 20+
- Ollama for AI routes
- Polymarket US credentials for live trading and account-level reads

Install dependencies:

```bash
npm install
```

Copy environment settings:

```bash
cp .env.example .env
```

Start the API and web app:

```bash
npm run dev
```

Useful URLs:

- Web UI: `http://localhost:5173`
- API: `http://localhost:4000`
- Health check: `http://localhost:4000/health`

KMDW weather commands:

```bash
npm run weather:snapshot -- --force
npm run weather:archive-backfill -- --date-from=2026-05-01 --date-to=2026-05-31
npm run weather:forecast-vintage-backfill -- --date-from=2026-05-01 --date-to=2026-05-31 --lead-days=1,2,3
npm run weather:market-board-backfill -- --date-from=2026-05-01 --date-to=2026-05-31 --fidelity-minutes=60
npm run weather:model-train -- --date-from=2026-05-01 --date-to=2026-05-31 --rolling-folds=4
npm run weather:model-evaluate -- --date-from=2026-05-01 --date-to=2026-05-31
npm run weather:source-audit -- --date=2026-05-19
npm run weather:alerts -- --date=2026-05-19 --evaluate=true
npm run weather:backtest -- --date-from=2026-05-01 --date-to=2026-05-19 --min-edge=0.06
```

`weather:archive-backfill` requires `NOAA_CDO_TOKEN` from NOAA Climate Data Online.
`weather:forecast-vintage-backfill` uses the Open-Meteo Previous Runs API and defaults to `gfs_seamless` lead days 1 through 7.
`weather:market-board-backfill` uses CLOB price history plus public Data API trades for markets discovered from the KMDW Chicago catalog.
`weather:model-train` writes `WEATHER_ML_MODEL_PATH`, a versioned model JSON, `WEATHER_ML_REGISTRY_PATH`, and `WEATHER_ML_EVALUATION_PATH`.

## Environment

Core values:

```env
POLYMARKET_US_BASE_URL=https://api.polymarket.us
POLYMARKET_US_GATEWAY_URL=https://gateway.polymarket.us
POLYMARKET_CLOB_BASE_URL=https://clob.polymarket.com
POLYMARKET_DATA_API_BASE_URL=https://data-api.polymarket.com
POLYMARKET_MARKET_DATA_POLL_INTERVAL_MS=5000
POLYMARKET_MARKET_DATA_STATUS_POLL_INTERVAL_MS=5000
POLYMARKET_MARKET_DATA_BOARD_POLL_INTERVAL_MS=120000
PORT=4000
VITE_API_BASE_URL=http://localhost:4000
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:latest
ANALYTICS_CACHE_TTL_MS=300000
OPPORTUNITY_SCANNER_INTERVAL_MS=600000
OPPORTUNITY_SCANNER_BATCH_SIZE=200
OPPORTUNITY_SCANNER_CONCURRENCY=8
NWS_API_BASE_URL=https://api.weather.gov
NOAA_CDO_API_BASE_URL=https://www.ncei.noaa.gov/cdo-web/api/v2
NOAA_CDO_TOKEN=
NOAA_CDO_KMDW_STATION_ID=GHCND:USW00014819
OPEN_METEO_PREVIOUS_RUNS_BASE_URL=https://previous-runs-api.open-meteo.com
OPEN_METEO_FORECAST_VINTAGE_MODEL=gfs_seamless
OPEN_METEO_FORECAST_VINTAGE_LEAD_DAYS=1,2,3,4,5,6,7
CLIMDW_URL=https://forecast.weather.gov/product.php?format=CI&glossary=1&highlight=off&issuedby=MDW&product=CLI&site=NWS&version=1
WEATHER_PROVIDER_ID=kmdw-nws-climdw
CHICAGO_MARKET_SEARCH_QUERY=highest temperature chicago
CHICAGO_MARKET_SEARCH_LIMIT=60
CHICAGO_WEATHER_REFRESH_INTERVAL_MS=180000
CHICAGO_WEATHER_HOT_REFRESH_INTERVAL_MS=60000
CHICAGO_WEATHER_UPCOMING_REFRESH_INTERVAL_MS=900000
CHICAGO_WEATHER_SETTLED_REFRESH_INTERVAL_MS=900000
CHICAGO_FORECAST_REFRESH_INTERVAL_MS=600000
WEATHER_DATA_DIR=data/weather
WEATHER_LOCAL_STORE_ENABLED=true
WEATHER_LOCAL_SQLITE_PATH=data/weather/kmdw-analytics.sqlite
WEATHER_LOCAL_PARQUET_DIR=data/weather/parquet
WEATHER_LOCAL_PARQUET_ENABLED=true
WEATHER_ML_MODEL_PATH=data/models/weather-high-temp-calibrator.json
WEATHER_ML_REGISTRY_PATH=data/models/weather-model-registry.json
WEATHER_ML_EVALUATION_PATH=data/models/weather-model-evaluations.jsonl
WEATHER_ML_MIN_SAMPLES=40
WEATHER_ML_MIN_CLASS_SAMPLES=5
WEATHER_ML_TRAINING_LIMIT=5000
WEATHER_ML_ROLLING_FOLDS=4
WEATHER_ML_HOLDOUT_FRACTION=0.25
```

Polymarket US reads and live orders require:

- `POLYMARKET_US_KEY_ID`
- `POLYMARKET_US_SECRET_KEY`

## Workspace Layout

```text
.
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── config/
│   │       ├── routes/
│   │       └── services/
│   │           ├── polymarket/
│   │           ├── weather/
│   │           ├── decision-engine.js
│   │           ├── ollama.js
│   │           └── trade-intents.js
│   └── web/
│       └── src/
├── data/
│   └── trade-intents.json
├── scripts/
│   └── check-orders-and-positions.js
└── package.json
```

## API Surface

- `GET /`
- `GET /health`
- `GET /api/polymarket/status`
- `GET /api/polymarket/account-identity`
- `GET /api/polymarket/events?limit=10&offset=0`
- `GET /api/polymarket/scanner`
- `GET /api/polymarket/events/resolve?input=<url-or-slug>`
- `GET /api/polymarket/events/aggregation?input=<url-or-slug>`
- `POST /api/polymarket/events/aggregation/invalidate`
- `GET /api/weather/providers`
- `GET /api/weather/chicago/status`
- `GET /api/weather/chicago/markets?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`
- `GET /api/weather/chicago/markets/:slug?date=YYYY-MM-DD`
- `GET /api/weather/chicago/settlement?date=YYYY-MM-DD`
- `GET /api/weather/chicago/snapshot?date=YYYY-MM-DD`
- `POST /api/weather/chicago/reprice`
- `POST /api/weather/chicago/intents`
- `GET /api/weather/chicago/history?date=YYYY-MM-DD`
- `GET /api/weather/chicago/source-audit?date=YYYY-MM-DD`
- `GET /api/weather/chicago/alerts?date=YYYY-MM-DD&status=active`
- `POST /api/weather/chicago/alerts/evaluate`
- `GET /api/weather/chicago/model`
- `POST /api/weather/chicago/model/train`
- `POST /api/weather/chicago/model/evaluate`
- `GET /api/weather/chicago/archive?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`
- `POST /api/weather/chicago/archive/backfill`
- `GET /api/weather/chicago/historical-boards?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`
- `POST /api/weather/chicago/historical-boards/backfill`
- `GET /api/weather/chicago/forecast-vintages?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&leadDays=1,2&model=gfs_seamless`
- `POST /api/weather/chicago/forecast-vintages/backfill`
- `GET /api/weather/chicago/drift?date=YYYY-MM-DD`
- `GET /api/weather/chicago/signals?date=YYYY-MM-DD`
- `GET /api/weather/chicago/backtest?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&minEdge=0.06`
- `POST /api/weather/backtest`
- `GET /api/recommendations/chicago?date=YYYY-MM-DD`
- `GET /api/polymarket/chicago/snapshots?date=YYYY-MM-DD`
- `GET /api/ai/status`
- `POST /api/ai/test`
- `POST /api/ai/analyze-event`
- `GET /api/trades/intents?limit=6`
- `POST /api/trades/intents`
- `PATCH /api/trades/intents/:id`
- `DELETE /api/trades/intents/:id`
- `POST /api/trades/intents/:id/execute`
- `POST /api/trades/intents/poll`
- `POST /api/trades/intents/:id/poll`
- `POST /api/trades/intents/:id/sell`
- `POST /api/trades/intents/:id/stop`
- `POST /api/trades/intents/:id/close`

## Development

```bash
npm run dev:api
npm run dev:web
npm run build
npm run start
```
