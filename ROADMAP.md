# Probis Roadmap — What's Left for a Complete Weather Betting Assistant

Purpose of this document: define the gap between what Probis does today and a "complete" product — one that pulls the best available weather data, produces the best possible bucket predictions, and safely assists trade placement on Polymarket US weather markets. Chicago (KMDW daily high temperature) is the only supported location today; the roadmap ends with what it takes to add more locations.

Status legend: ✅ done · 🟡 partial · ❌ not started

## 1. Where the project stands

| Area | Status | Notes |
|---|---|---|
| Chicago market discovery + bucket parsing | ✅ | Gateway search, bucket normalization, dedupe, catalog ([chicago.js](apps/api/src/services/weather/chicago.js)) |
| Weather ingestion (NWS obs, NWS forecast, CLIMDW settlement) | ✅ | Cached, climate-day-window aware |
| NBM guidance | 🟡 | Only via `NBM_JSON_URL` env; no default fetch path |
| Ensemble / rapid-refresh model data (HRRR, GEFS, ECMWF) | ❌ | Biggest remaining data gap |
| Cross-station context (KORD, lakefront comparators) | ❌ | Only KMDW is observed |
| Official actuals archive (NOAA CDO) | ✅ | Backfill CLI + API |
| Forecast vintages (Open-Meteo previous runs) | ✅ | Backfill CLI + API |
| Historical market boards (CLOB + data API) | ✅ | Backfill CLI + API |
| Local analytics store (SQLite + Parquet + JSONL) | ✅ | `data/weather/` |
| Temperature distribution → bucket probabilities | ✅ | Gaussian, integer-degree grid |
| Market fusion (adaptive blend weight) | ✅ | Day phase / spread / freshness aware |
| ML calibration layer + registry + evaluation log | ✅ | Logistic artifact; Python GBM trainer optional |
| Backtesting + drift + source audit + alerts | ✅ | CLI + API |
| Manual trade lifecycle (draft → submit → poll → sell/stop/close) | ✅ | Hard gates + spread warning + Kelly sizing |
| Automated re-decision on open positions | ❌ | Poll only checks fills, no hold/add/trim/exit logic |
| Portfolio-level risk caps | ❌ | Per-trade sizing only |
| Scheduled background capture (snapshots during market hours) | 🟡 | Monitor service exists; no supervised scheduler/runbook |
| Multi-location support | 🟡 | Provider interface exists; routes/UI/model are Chicago-hardcoded |

## 2. Best weather data — what to add

Goal: every input that measurably improves prediction of the KMDW daily high, in order of expected value.

1. **NBM by default (highest value, lowest effort).** NBM is the calibrated multi-model blend NWS itself uses — it should not depend on a hand-supplied `NBM_JSON_URL`. Ingest NBM hourly/station output for KMDW automatically (api.weather.gov gridpoint or NOMADS text bulletins), store each cycle as a vintage, and expose it as a first-class forecast source alongside the NWS forecast.
2. **Ensemble spread as an uncertainty input.** Pull GEFS and ECMWF ensemble members (Open-Meteo exposes both) for the target date. Ensemble spread should drive the distribution's standard deviation instead of today's heuristic uncertainty model — this is the single biggest modeling-quality lever.
3. **Rapid-refresh guidance for same-day markets.** HRRR/RAP update hourly and dominate the last 6–12 hours before the daily max. Same-day repricing should react to each new HRRR run, not just new observations.
4. **Cross-station observations.** Ingest KORD and a lakefront station (e.g., Northerly Island) each snapshot. The KMDW–KORD and KMDW–lakefront spreads capture lake-breeze regimes — the main Chicago-specific failure mode — and belong in the feature set.
5. **One-minute ASOS / MADIS data.** Standard METARs are hourly-ish; the daily max is set between them. One-minute ASOS data (NCEI) or MADIS mesonet feeds tighten the observed-high-so-far estimate and settlement anticipation late in the day.
6. **Settlement-source hardening.** CLIMDW parsing should tolerate format variants, detect corrections/amended reports, and reconcile against NOAA CDO after the fact; discrepancies should raise an alert. Market rule text should be re-hashed on every catalog refresh so a silent rules change trips the `designatedSource` gate.
7. **Data quality monitoring.** A coverage report (per day: snapshot count, obs gaps, forecast cycles seen, board fidelity) so missing training data is visible before it degrades the model. Extend `weather:source-audit` into a scheduled health check.

## 3. Best predictions — model upgrades

1. **Replace the single Gaussian.** Daily-high errors are not symmetric (fronts, lake breeze cause skew). Move to a skew-normal or small mixture, or a quantile model per lead time, fed by ensemble spread (§2.2). Keep the integer-degree grid and bucket integration — only the distribution shape changes.
2. **Per-lead-time calibration.** A same-day 2 PM forecast and a 3-day-out forecast have very different error profiles. Train and store calibration per lead bucket (0d, 1d, 2–3d, 4+d) rather than one global calibrator.
3. **Uncertainty-aware gating.** Require `edge > model uncertainty + execution cost` before recommending, not just `edge > threshold`. The uncertainty term should come from the ensemble/lead-time calibration, so thin edges on high-uncertainty days stop surfacing.
4. **Regime features.** Wind direction/lake-breeze indicator, frontal passage timing, cloud-cover evolution, snow cover (winter highs), and month interaction terms. These are where Chicago-specific edge over the market lives.
5. **Model promotion criteria.** The registry stores artifacts; it should also enforce promotion: a new model goes live only if it beats the incumbent on rolling-fold Brier/log-loss AND backtested net P&L. Add a `champion/challenger` field and wire the recommender to the champion only.
6. **Automated drift response.** `GET /api/weather/chicago/drift` exists; wire it to alerts and to an automatic fallback (drop ML blend weight to 0, revert to simulation-only) when calibration drifts past a threshold.
7. **Continuous evaluation dashboard.** Reliability curves by lead time, Brier vs market-only baseline, and closing-line comparison in the web UI, so model health is visible without running CLIs.

## 4. Better trading assistance

1. **EV-after-friction objective.** Rank by expected value net of fees, expected slippage (from book depth), and fill probability — not gross edge. Execution-cost estimation exists ([chicago.js](apps/api/src/services/weather/chicago.js) `estimateExecutionCost`); make it depth-aware and feed it into ranking, not just gating.
2. **Re-decision loop on open positions.** Each poll should re-run the model against current quotes and emit hold / add / trim / exit with a machine-readable reason log. Today polls only reconcile fills.
3. **Exit automation (still user-armed).** Partial take-profit and trailing-stop rules the user can enable per intent; flatten-before-final-print warning near the late-day settlement window.
4. **Portfolio risk engine.** Hard caps per market family, per event/day cluster, and per regime; blended position accounting for multi-leg (staged) entries; risk-budget-aware sizing before any add-on entry.
5. **Post-trade learning.** Record closing-line value, realized vs modeled edge, slippage, and fill quality per intent, and surface them — this is the feedback loop that proves (or disproves) the edge.
6. **Streaming or fast polling for same-day markets.** REST polling at current cadences is fine for research but slow near settlement. Either adopt CLOB websockets or add a hot-path poller (5–15 s) for markets within N hours of resolution.

## 5. Product and operations

1. **Scheduler/runbook for continuous capture.** Model quality depends on snapshots being captured during market hours. Ship a supervised schedule (launchd/cron/PM2) for `weather:snapshot`, board capture, nightly archive backfill, nightly retrain + evaluate, and drift check — plus a doc describing it.
2. **Postgres migration (optional, when scale demands).** Intents, fills, quotes, model versions, and outcome attribution in Postgres; keep SQLite/Parquet as the local default.
3. **Hosted-mode hardening.** If this is ever exposed beyond localhost: auth, secret handling, and read-only mode for viewers.
4. **Test coverage for the money paths.** Bucket parsing, gate logic, Kelly sizing, and settlement parsing are tested; add fixtures for fusion weighting, execution-cost estimation, and intent state transitions.

## 6. Explicit non-goals (for now)

- Fully autonomous trading with no user click. The manual submit gate stays until the post-trade learning loop (§4.5) proves sustained positive realized edge.
- Non-weather market families (sports, UFC, politics). Legacy generic routes remain but are not the product.
- Trading markets whose settlement source is unverified — `designatedSource.verified` remains a hard block.

## 7. Multi-location support

The provider interface ([providers.js](apps/api/src/services/weather/providers.js)) already defines the contract: `getTargetDate`, `getClimateDayWindow`, `fetchSettlement`, `fetchObservations`, `fetchForecasts`, `fetchModelForecast`, `fetchMarkets`. What remains:

**Per new city (e.g., New York / KLGA, Miami / KMIA, Austin / KAUS):**

1. Station config: ICAO id, lat/lon, timezone, climate-day UTC offset, NOAA CDO GHCND station id.
2. Settlement product: the city's NWS CLI product (e.g., `CLINYC`) URL + parser check — CLI format is mostly shared, so `parseClimdwProduct` should generalize to `parseCliProduct(stationConfig)`.
3. Market discovery: search queries + bucket-label parsing verification against real market titles for that city.
4. Designated-source verification: confirm from the market rules which station settles that city's markets before enabling trading.
5. Data backfill: run archive, forecast-vintage, and market-board backfills for the new station.
6. Model artifact: train a per-station calibrator; the registry already keys artifacts by name, but the recommender needs a per-provider model path.

**One-time generalization work in the codebase:**

7. Routes: `/api/weather/chicago/*` → `/api/weather/:location/*` (keep the Chicago paths as aliases).
8. Storage: per-station SQLite/Parquet naming is already `kmdw_*` — parametrize by station id.
9. Config: replace `CHICAGO_*` env vars with per-provider config (JSON or `WEATHER_LOCATIONS=` list).
10. UI: location selector; board, trade panel, and training portal driven by the selected provider.
11. Cross-location risk: portfolio caps (§4.4) must treat "same weather system, multiple cities" as one correlated cluster.

## 8. Suggested order of work

| Phase | Contents | Why first |
|---|---|---|
| 1. Data floor | NBM default ingest, ensemble spread, scheduler/runbook, data-quality report (§2.1–2.2, §2.7, §5.1) | Everything downstream is capped by data quality and capture consistency |
| 2. Model | Skewed/ensemble-driven distribution, per-lead calibration, uncertainty gating, promotion criteria (§3.1–3.3, §3.5) | Converts better data into better probabilities |
| 3. Same-day edge | HRRR ingest, cross-station features, hot-path polling, 1-min ASOS (§2.3–2.5, §4.6) | Same-day markets are where edges are largest and decay fastest |
| 4. Trading loop | EV-after-friction ranking, re-decision loop, exit automation, post-trade learning (§4.1–4.3, §4.5) | Turns predictions into realized P&L safely |
| 5. Portfolio + scale | Risk engine, Postgres, evaluation dashboard (§4.4, §5.2, §3.7) | Needed once multiple concurrent positions exist |
| 6. Second city | Generalization work + one new provider end-to-end (§7) | Proves the multi-location design with real markets |

## 9. Definition of done

Probis is "complete" as a weather betting assistant when:

1. Snapshots, forecasts (NWS + NBM + ensemble + HRRR), boards, and settlements are captured automatically every market day with gap monitoring.
2. Bucket probabilities are calibrated per lead time and demonstrably beat the market-only baseline on Brier/log-loss over a rolling 60-day window.
3. Every recommendation is uncertainty-gated, EV-after-friction ranked, and every executed intent records realized edge and closing-line value.
4. Open positions are re-evaluated on every poll with auditable reasons for hold/add/trim/exit.
5. Adding a new city requires only a provider config + verification checklist, no core code changes.
