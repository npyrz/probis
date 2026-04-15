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
- React dashboard with event URL input and market outcome display
- Local Ollama smoke-test endpoint and event analysis endpoint
- `.env` and `.env.example` templates with Polymarket and Ollama settings

## API Endpoints

- `GET /health`
- `GET /api/polymarket/status`
- `GET /api/polymarket/events?limit=10`
- `GET /api/polymarket/events/resolve?input=https://polymarket.com/event/...`
- `GET /api/ai/status`
- `POST /api/ai/test`
- `POST /api/ai/analyze-event`

## Step 2 and Step 3

Step 2 is implemented through the backend Polymarket routes and health checks.
Step 3 is implemented through the frontend event input flow and market display.

## Next Step

Step 4 and beyond can now build on the resolved event data already flowing through the backend and frontend.