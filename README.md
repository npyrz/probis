# Probis

Probis has been reset to a clean terminal-first foundation.

The current app focuses on a tighter operator loop:

- Show account and risk posture in a Bloomberg-style terminal.
- Accept a Polymarket bet URL.
- Pull the public Polymarket Gamma API payload for that market.
- Run deterministic pricing and risk heuristics.
- Surface external-event hooks and AI synthesis text without putting them on the execution path.
- Output a trade plan such as `buy_yes`, `buy_no`, or `wait`.

## Start

```bash
./dev.sh
```

That starts:

- FastAPI backend at `http://127.0.0.1:8000`
- Vite frontend at `http://127.0.0.1:5173`

## Current Product Surface

### Frontend

The React UI is now a single operator terminal with:

- Account mode, book size, and risk caps
- URL-driven bet lookup
- Market summary and outcome tape
- Deterministic trade plan panel
- AI synthesis panel
- Raw Polymarket market and event JSON

### Backend

The FastAPI service now exposes a smaller contract:

- `GET /api/health`
- `GET /api/account`
- `POST /api/analyze`

`/api/analyze` accepts a Polymarket URL, resolves it against the public Gamma API, normalizes the response, and returns:

- account summary
- market snapshot
- external-signal placeholders
- AI synthesis text
- deterministic trade plan

## Design Direction

- Deterministic pricing and risk logic stay on the hot path.
- AI remains advisory.
- Operator visibility comes before automation.
- Raw source payloads stay exposed in the terminal.
- The codebase is intentionally small so the next iteration can be built deliberately.

## Environment

Your real backend environment file is preserved at `backend/.env`.

The example contract lives in `backend/.env.example`. Trading credentials remain optional. Without them, the UI runs in paper mode.

## Next Build Targets

- Real account hydration from Polymarket authenticated APIs
- External news or event feeds
- Richer probability modeling
- Optional local or hosted LLM synthesis plugged into the existing API shape
- Execution workflows with explicit risk gates
- Local Infra: Redis and PostgreSQL ready for expansion
- Signal Layer: Ollama / Gemma, isolated from the execution path

## Notes

- Redis is optional for local startup; the backend falls back to an in-process bus if Redis is unavailable.
- The terminal is intended to be the single operator surface for monitoring, intervention, and later real account control.
- This repository is structured so real account execution can be added without changing the frontend workflow.

## Vision

Build a low-latency, AI-assisted trading system that combines real-time market data, quantitative decision-making, and intelligent signal extraction to identify and act on inefficiencies in prediction markets.
