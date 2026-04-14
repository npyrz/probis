# Probis Backend

Thin-slice backend to prove the core hot path:

`price tick → processing/decision → order → execution` (LLM + DB are off the hot path).

## Quickstart

### 1) Install

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e .
```

### 2) (Optional) Start Redis + Ollama

From repo root:

```bash
docker compose up -d redis ollama
```

If you skip Redis, Probis falls back to an in-memory bus (single process).

### 3) Run

```bash
python -m probis.main
```

### 4) See state

- HTTP: http://localhost:8000/state
- WS: ws://localhost:8000/ws/state

### 5) Terminal APIs

- `GET /markets` — list monitorable markets
- `GET /terminal` — terminal snapshot (markets, sessions, fills, logs)
- `POST /monitor-sessions` — start monitoring a market
- `POST /monitor-sessions/{session_id}/abort` — abort a running session
- `WS /ws/terminal` — live terminal event stream

