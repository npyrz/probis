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

## Environment

Core values:

```env
POLYMARKET_US_BASE_URL=https://api.polymarket.us
POLYMARKET_US_GATEWAY_URL=https://gateway.polymarket.us
PORT=4000
VITE_API_BASE_URL=http://localhost:4000
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:latest
ANALYTICS_CACHE_TTL_MS=300000
OPPORTUNITY_SCANNER_INTERVAL_MS=600000
OPPORTUNITY_SCANNER_BATCH_SIZE=200
OPPORTUNITY_SCANNER_CONCURRENCY=8
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
