# Probis
Probis is a low-latency, AI-assisted trading system for real-time prediction markets. It combines live market data, probabilistic modeling, and LLM-based signal extraction to identify mispriced events and execute trades automatically.

## Repo layout

- backend/ — FastAPI + asyncio workers (hot path: price → decision → trade)
- frontend/ — React operator terminal for selecting markets and controlling monitor sessions
- docker-compose.yml — local Redis/Postgres/Ollama

## Quickstart (backend)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e .
python -m probis.main
```

Then open:

- http://localhost:8000/state
- ws://localhost:8000/ws/state

## Quickstart (frontend terminal)

```bash
cd frontend
npm install
npm run dev
```

Then open:

- http://localhost:5173

The operator flow is:

1. Browse markets in the terminal.
2. Select one market.
3. Set author-controlled monitoring thresholds.
4. Engage monitoring.
5. Let the deterministic model buy/sell based on those settings.
6. Abort the session at any time.

### Optional: Redis + Ollama

```bash
docker compose up -d redis ollama
```

If Redis is not running, the backend falls back to an in-memory bus (single process).
