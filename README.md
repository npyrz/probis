# Probis

Probis is a low-latency, AI-assisted trading system for Polymarket US. This repository is now scaffolded through Step 1 of the plan with a backend API workspace, a frontend React workspace, shared environment configuration, and initial package management.

## Project Structure

```text
.
├── apps
│   ├── api
│   │   └── src
│   │       ├── config
│   │       ├── lib
│   │       ├── routes
│   │       └── services
│   └── web
│       └── src
│           ├── components
│           ├── features
│           └── lib
├── .env
├── .env.example
├── .nvmrc
├── package.json
└── plan.md
```

## Step 1 Setup

1. Use Node.js 20 or newer.
2. Populate `.env` with your Polymarket credentials.
3. Install dependencies:

	```bash
	npm install
	```

4. Start both apps in development:

	```bash
	npm run dev
	```

5. Verify the API is alive:

	```bash
	curl http://localhost:4000/health
	```

## Included Dependencies

- Backend: Express, Axios, Dotenv, `@polymarket/clob-client`, `ws`
- Frontend: React, Vite
- Root tooling: Concurrently

## What Is Ready

- Root npm workspace for multi-app development
- Express API bootstrapped with environment loading
- Live Gamma-backed Polymarket event fetching for active events and direct event URL resolution
- CLOB auth status check that validates whether the configured private key can initialize the SDK
- React dashboard with event resolution, live market filtering, ranking controls, decision highlights, and market drilldown
- Historical aggregation layer for 7-day price series, liquidity snapshots, and event-level derived metrics
- First-pass statistical model for model probability, edge, confidence, and best-opportunity ranking
- Local Ollama smoke-test endpoint, analytics-aware event analysis endpoint, and combined decision-engine recommendation
- Step 7 trade suggestion flow with draft persistence, review modal, and amount-based trade preview
- Step 8 starter defaults for stop-loss and take-profit levels derived from current probability and model edge
- In-memory analytics caching with TTL and manual invalidation support
- `.env` and `.env.example` templates with Polymarket and Ollama settings

## API Endpoints

- `GET /health`
- `GET /api/polymarket/status`
- `GET /api/polymarket/events?limit=10`
- `GET /api/polymarket/events/resolve?input=https://polymarket.com/event/...`
- `GET /api/polymarket/events/aggregation?input=...`
- `GET /api/polymarket/events/aggregation?input=...&refresh=true`
- `POST /api/polymarket/events/aggregation/invalidate`
- `GET /api/ai/status`
- `POST /api/ai/test`
- `POST /api/ai/analyze-event`

## Analytics Cache

- Set `ANALYTICS_CACHE_TTL_MS` in `.env` to control the analytics cache TTL. The default is 300000 milliseconds.
- Use `refresh=true` on the aggregation endpoint to bypass the cache for a single request.
- Use `POST /api/polymarket/events/aggregation/invalidate` with `{ "input": "..." }` to evict one cached event, or omit `input` to clear the entire analytics cache.

## Progress

Steps 2 through 8 are started through the backend analytics pipeline and the frontend market analysis workflow.

## Next Step

The next plan items can build on the existing event resolution, aggregation, model scoring, decision-engine layers, and persisted trade drafts for execution wiring.