# Probis Refactor Plan — Open-Source Polymarket Terminal with Agent Mode

**What Probis becomes:** an open-source, local-first terminal for Polymarket US, usable from **two surfaces over the same API: a localhost website and a terminal UI (CLI/TUI)**.

1. **Connect your Polymarket API key** → your markets, positions, and balances on localhost. Nothing custodial, keys never leave your machine.
2. **See every open market**, each with live quotes, order book, price history, attached news/RSS feeds, authoritative data sources, and past data (historical prices + settled comparable markets).
3. **Get a recommendation**: a model layer ranks the best trades available *right now* — fair probability, edge after execution cost, confidence, and suggested size.
4. **Turn on agent mode**: an agent that trades and sells for you — entering recommended positions, managing them (hold/add/trim/exit), and exiting — inside hard risk limits you set, with a kill switch.

Weather (Chicago KMDW daily highs) is no longer the product; it is the first **market family** — the proof that the data → model → backtest → execution pipeline works end to end. Its stack gets generalized, not rewritten.

**Scope decisions (2026-08-05):**
- Polymarket US only. The venue layer stays isolated (`core/polymarket/`) so a second venue is possible later, but none is planned now.
- No Twitter/X (paid, low signal per dollar). News comes from RSS/Atom + GDELT + official sources.
- Open source, BYO keys, localhost only. No hosted mode this iteration.
- This file replaces ROADMAP.md. Weather-specific model work that survives lives in §8.

---

## 1. Target architecture

```
apps/api/src/
├── core/
│   ├── polymarket/          # venue layer (moved from services/polymarket/)
│   │   ├── gamma.js, clob.js, data-api.js, us-orders.js, client.js
│   │   └── history.js       # generalized from weather/historical-boards.js
│   ├── catalog/             # ALL open Polymarket US markets, normalized + tagged
│   ├── feeds/               # news + data provider layer (NEW)
│   │   ├── rss.js           # generic RSS/Atom poller, dedupe, persistence
│   │   ├── gdelt.js         # GDELT 2.0 news firehose (free, 15-min updates)
│   │   ├── registry.js      # feed ↔ market matching rules
│   │   └── store.js         # JSONL + SQLite under data/feeds/
│   ├── engine/              # family-agnostic prediction/trading machinery
│   │   ├── fusion.js        # market-implied blend (extracted from chicago.js)
│   │   ├── gating.js        # hard gates + warnings
│   │   ├── sizing.js        # fractional Kelly
│   │   ├── execution-cost.js
│   │   └── recommender.js   # cross-market "best trade right now" ranking
│   ├── intents/             # trade-intents.js, decision-engine.js
│   └── agent/               # agent mode (NEW) — see §5
├── families/
│   ├── registry.js          # family plugin contract
│   ├── weather/             # current weather stack, conforming to the contract
│   └── <next>/              # crypto, econ, … (see §4)
└── routes/                  # markets.js, feeds.js, recommendations.js, agent.js (+ existing)

apps/
├── api/                     # everything above
├── web/                     # localhost website (existing Vite/React app, generalized)
└── tui/                     # terminal UI (NEW) — same API, keyboard-driven
```

### Surfaces: website + terminal

Both surfaces are thin clients over the same `apps/api` HTTP API — no logic lives in a surface.

- **Website** (`apps/web`, exists today): market list, market detail, trade panel, dashboards, chat pane. The richer surface — charts, order-book depth, feed reading.
- **Terminal UI** (`apps/tui`, new): a keyboard-driven TUI (Ink or blessed — Node, matching the stack) with: markets list (filter/sort by family, edge, close time), market detail pane (quotes, book summary, latest feed headlines, model view), positions/intents pane, recommendations pane, and an agent/chat prompt line. Every TUI view is also available as a one-shot CLI command with `--json` output (e.g., `probis markets`, `probis recs`, `probis positions`) so it composes with scripts.
- Feature parity rule: trading actions (draft/submit/sell/stop) and the risk envelope behave identically on both surfaces; the human-click gate applies equally (in the TUI it's an explicit confirm keypress).

### Family plugin contract

Generalized from `weather/providers.js` (`weather-provider-v1`). A family owns:

| Method | What it does | Weather implementation today |
|---|---|---|
| `discoverMarkets()` | find + parse the family's markets | gateway search + bucket parsing (chicago.js) |
| `attachFeeds(market)` | authoritative data sources | NWS obs/forecast/CLIMDW |
| `fetchHistory(market)` | past data backfill | NOAA CDO, forecast vintages, boards |
| `priceOutcomes(market)` | fair probability per outcome | temp distribution → bucket integration |
| `features(market)` | calibration feature vector | ~35 features |
| `settlementSource(market)` | designated source + verification | CLIMDW + `designatedSource.verified` gate |
| `backtest(range)` | prove edge on past data | chicago-backtest.js |

**Key rule:** a market with no family model is still first-class in the terminal — quotes, book, history, feeds, rules all render. It just shows no fair-value/edge panel. This is what lets the terminal cover *all* markets on day one while models arrive family by family.

---

## 2. Phase 0 — Extraction refactor (no behavior change)

Weather keeps working exactly as it does; it just runs through the new structure.

1. Move `services/polymarket/` → `core/polymarket/` (already family-agnostic).
2. Generalize `weather/historical-boards.js` → `core/polymarket/history.js` — price/board capture is venue logic, not weather logic.
3. Extract family-agnostic parts of `chicago.js` (fusion weighting, gating, Kelly, execution cost) → `core/engine/`. Chicago keeps only weather logic.
4. Create `families/registry.js`; wrap the existing weather provider to conform; register as family `weather`.
5. New routes `/api/markets`, `/api/markets/:id` (catalog + family detail); keep `/api/weather/*` working.
6. Generalize `apps/web/src/features/market-explorer`: market list driven by the catalog; the weather card becomes the family-specific detail panel.
7. Tests: existing money-path tests pass unmoved; add a family-contract test.

**Exit criteria:** same Chicago workflow works; CLIs unchanged; new "All markets" view lists every open Polymarket US market read-only.

## 3. Phase 1 — The terminal: API key, all markets, feeds, past data

This phase delivers the product's first headline: *connect your key, see everything with data on it.*

1. **Onboarding/connection flow.** First-run screen: paste Polymarket US API credentials → stored locally (env/local config, never committed) → terminal shows balances, positions, open orders alongside the catalog. Read-only mode if no key.
2. **Full catalog ingestion.** Poll Gamma/gateway for all open US markets; normalize title, outcomes, category, volume, liquidity, close time, resolution-rules text + hash. Snapshot to disk like weather boards today.
3. **Market detail view** — the terminal core. Every market shows:
   - live quotes, spread, order-book depth, trade tape
   - price history chart (backfilled on demand via `core/polymarket/history.js`)
   - attached news: RSS items + GDELT hits matched to this market
   - family data if available (weather: NWS panel; crypto: candles; econ: FRED series)
   - resolution rules + designated settlement source, with rules-hash change detection
   - past comparable markets and how they settled (from Gamma resolved-market data)
4. **RSS/Atom poller** with a curated default source list per category (AP, Reuters, BBC, NPR, Politico, The Hill; FRED/BLS/Fed releases; CoinDesk, The Block; ESPN/league feeds) — user-editable in `data/feeds/sources.json`. Etag caching, GUID dedupe, JSONL + SQLite index.
5. **GDELT connector** — the Twitter replacement: free global news events every 15 minutes, queried by market keywords.
6. **Feed ↔ market matching**: family rules first, keyword/category matching as fallback, manual pin/unpin in the UI.
7. **Scheduler**: one supervised background process (extends chicago-monitor) ticking catalog refresh, feed polls, board capture, with per-source coverage/health reporting.

8. **Terminal UI v1** (`apps/tui`): markets list + market detail + positions views over the new catalog/feeds routes, plus one-shot CLI commands with `--json`. Read-only in this phase; trading and recommendations reach the TUI in Phases 2–3.

**Exit criteria:** connect a key, open any Polymarket US market — in the web app *or* the TUI — and see book + history + news + rules + comparables in one screen.

## 4. Phase 2 — The recommendation layer: best trade right now

The second headline: *the terminal tells you the best trade available at this moment.*

1. **Cross-market recommender** (`core/engine/recommender.js`): one ranked list across *all* modeled markets — net edge after estimated execution cost, confidence, liquidity/spread checks, Kelly-sized suggestion. Generalizes today's weather ranking + `opportunity-scanner.js`.
2. **Two tiers of signal, clearly labeled:**
   - **Modeled** (family has a backtested model): fair probability vs price, true edge. Trustworthy tier.
   - **Screened** (no family model yet): statistical screens generalized from `statistical-model.js`/opportunity-scanner — mispricing vs comparables, momentum/flow anomalies, cross-market consistency (e.g., mutually exclusive outcomes summing > 1). Research signals, ranked separately, never presented as modeled edge.
3. **Model families, added one at a time**, each through the same playbook weather used (discover → verify settlement source → attach data → backfill → model → **backtest must pass** → enable recommendations):
   - **Family #2: crypto price buckets** (BTC/ETH price-at-date, up/down). Structurally identical to weather — numeric settlement from a designated source, distribution → bucket integration, uncertainty from realized volatility, free exchange candles, hundreds of settled comparables to backtest on. Maximum machinery reuse.
   - **Family #3: economic prints** (CPI, jobs, Fed decisions). Official-release settlement (BLS/BEA/Fed) mirrors the CLIMDW pattern; data from FRED (free); lower frequency, lean harder on market fusion.
   - **Later: editorial/news markets** (politics, awards). No numeric distribution; stay in the screened tier until there's a real modeling approach.
4. **Recommendation quality loop**: every recommendation logged with model version, price, and eventual outcome → closing-line value and realized-vs-modeled edge per family. This is what proves the recommender is worth following — and what later justifies agent mode.

5. **Surfaces**: "Best trades now" ships on both — a web view and a TUI recommendations pane / `probis recs` command. Trading from the TUI (draft → confirm keypress → submit) lands here too, reusing the intent routes.

**Exit criteria:** a "Best trades now" view ranking modeled edges across ≥2 families, with the screened tier below it, on both surfaces, and a logged track record accumulating.

## 5. Phase 3 — Agent mode: it trades and sells for you

The third headline. Built on the intent pipeline that already exists (draft → submit → poll → sell/stop/close), not a parallel system.

1. **Three operating levels, per-user setting:**
   - **Advise** (default): agent researches and prepares intents; you click submit. Today's behavior.
   - **Semi-auto**: agent auto-submits entries from the *modeled* tier that pass all hard gates; exits still confirmed by you.
   - **Full agent**: agent enters, manages, and exits positions autonomously within the risk envelope.
2. **Risk envelope (hard, enforced in `core/intents/`, not in the agent):** max per-trade stake, max daily outlay, max open positions, max exposure per market family and per event/day cluster, modeled-tier-only flag, drawdown circuit breaker, and a **kill switch** that flattens or freezes everything. Agent code cannot exceed these — they are enforced below it.
3. **Position management loop** (the "sell for you" half): on every poll, re-run the model against current quotes and emit hold / add / trim / exit with a machine-readable reason log. Take-profit, trailing-stop, and flatten-before-settlement rules configurable per intent. In advise mode these are suggestions; in agent mode they execute.
4. **Chat interface**: a chat pane in the web UI and a prompt line in the TUI, both over the same internals — ask about markets, feeds, positions; instruct the agent ("scan econ markets", "trim anything with edge below cost"). Backends: local Ollama (existing `ollama.js`, offline default) or the user's own Claude/API key.
5. **MCP server** exposing the terminal as tools (`list_markets`, `get_market_detail`, `get_feeds`, `get_history`, `get_recommendations`, `prepare_intent`, `submit_intent`, `manage_position`, `positions`, `set_risk_limits`) — so any MCP client, including Claude Code, can drive the terminal. The project ships no LLM and pays for no inference.
6. **Full audit trail**: every agent decision logged with inputs (model view, quotes, feeds cited), action, and reason — reviewable in the UI. Non-negotiable for an open-source project asking for trading keys.

**Exit criteria:** semi-auto mode running on the modeled tier with the risk envelope enforced and the audit trail visible; full-agent mode behind an explicit opt-in.

## 6. Phase 4 — Open-source release

1. README rewrite around the three headlines (terminal → recommendations → agent mode); weather becomes a section, not the identity.
2. Quickstart: clone → `npm install` → `npm run dev` → paste API key → browsing markets in under 5 minutes (read-only works with no key).
3. Family-authoring guide: the plugin contract + the playbook, using weather and crypto as worked examples.
4. Default feed lists shipped and documented; config reference; secrets handling (`.env`, never committed).
5. License check, contribution guide, issue templates. Point releases per phase — visible momentum for contributors.

## 7. Sequencing

| Phase | Deliverable | Depends on |
|---|---|---|
| 0 | Extraction refactor; weather unchanged; read-only all-markets catalog | — |
| 1 | API-key connection, market detail w/ feeds + past data, scheduler, TUI v1 (read-only) | 0 |
| 2 | Recommender ("best trade now"), crypto family, screened tier, TUI trading + recs | 0, 1 |
| 3 | Agent mode (advise → semi-auto → full), chat (web + TUI), MCP server | 1, 2 |
| 4 | OSS release polish | all |

Phases 2 and 3 can overlap: the agent's advise level and the MCP server only need Phase 1.

## 8. Weather family — surviving roadmap items

ROADMAP.md is deleted; these are the items still worth doing, now scoped to the weather family (and where noted, built in `core/` so every family inherits them):

- **NBM by default** — auto-ingest NBM for KMDW instead of requiring `NBM_JSON_URL`.
- **Ensemble spread as uncertainty input** (GEFS/ECMWF via Open-Meteo) — biggest weather-model lever; the pattern (data-driven σ) carries to crypto via realized vol.
- **HRRR/RAP for same-day repricing**; cross-station obs (KORD, lakefront) for lake-breeze regimes.
- **Settlement hardening** — CLIMDW format variants, correction detection, CDO reconciliation, rules re-hash on refresh (rules-hashing goes in `core/catalog/` for all families).
- **Per-lead-time calibration** and skewed/mixture distributions instead of the single Gaussian.
- **Model promotion criteria** (champion/challenger: new model must beat incumbent on Brier *and* backtested net P&L) — build in `core/engine/`, all families inherit.
- **Portfolio-level risk caps** — now part of the Phase 3 risk envelope (`core/`), not weather-specific.
- **Re-decision loop on open positions** — now Phase 3 §5.3 (`core/`), not weather-specific.
- **Multi-location expansion** (NYC/KLGA, Miami/KMIA, …): per-city station config, settlement product, discovery queries, model artifact — unchanged, just internal to the weather family now.

## 9. Non-goals (this iteration)

- Twitter/X ingestion.
- Second venue (Kalshi etc.) — isolated venue layer keeps it cheap later; PMXT is the candidate adapter.
- Hosted/multi-user mode — localhost only.
- Market creation — this is a trading terminal, not a market-making platform.
