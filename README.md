# Probis
Probis is a low-latency, AI-assisted trading system for real-time prediction markets. It combines live market data, probabilistic modeling, and LLM-based signal extraction to identify mispriced events and execute trades automatically.

## Repo layout

- backend/ — FastAPI + asyncio workers (hot path: price → decision → trade)
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

### Optional: Redis + Ollama

```bash
docker compose up -d redis ollama
```

If Redis is not running, the backend falls back to an in-memory bus (single process).
