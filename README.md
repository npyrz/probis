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
- Placeholder Polymarket client wiring for Step 2
- React dashboard shell bootstrapped for Step 4
- `.env` and `.env.example` templates with Polymarket and Ollama settings

## Next Step

Step 2 is now the next meaningful implementation target: authenticate against Polymarket and validate market-fetching endpoints.