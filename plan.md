Background market scanner service that scans the full tradable Polymarket US universe on a schedule and ranks candidates.
Scanner API endpoint that runs event analytics + statistical model + ranking and returns Opportunity Board rows.
Opportunity Board features: edge, EV per dollar, confidence, liquidity, spread, time-to-resolution, momentum, signal source, and class labels (strong buy / soft buy / watchlist / avoid).
Auto-generated draft trade intents from top-ranked opportunities (recommendation-first, not auto-execution).
Agent mode for live trades with staged-entry ladder (initial entry, add 1, add 2, no more adds).
Partial take-profit + trailing-stop behavior for active positions.
Blended position accounting for multi-leg entries (blended entry probability, blended cost basis, per-leg attribution).
Portfolio risk engine with hard caps by market, event cluster, league, day, and regime.
PostgreSQL storage for intents, fills, quotes, model versions, and outcome attribution (replace JSON-file persistence).
Optional true terminal workflow (CLI/TUI): scan, inspect, draft, execute, monitor, rebalance.
Update / Fix / Improve (Existing System)

Enforce venue authority model: Polymarket US is authoritative for tradability, shares, fills; discovery feeds are candidate discovery only.
Upgrade active trade loop from stop-loss/take-profit-only to re-decision each poll: hold, add, trim, exit.
Add machine-readable reason logging for every action (add/trim/exit/skip) so behavior is auditable.
Improve sizing logic to be risk-budget aware before any add-on entries.
Improve ranking objective from “winner prediction” to EV after fees, slippage, and fill quality.
Add execution-quality features into scoring: spread, depth, quote staleness, imbalance, fill tempo.
Split models by market family instead of one broad scorer (sports moneyline, props, geopolitics, crypto thresholds, multi-candidate).
For sports, model residual edge (your fair probability minus market probability), not just win probability.
Add uncertainty-aware gating: require edge > uncertainty + execution cost.
Separate playoff vs regular-season modeling (report flags playoff degradation).
Prioritize NBA automation ahead of MLB (NBA signal quality is stronger in report).
Add post-trade learning metrics: closing-line value, realized EV, slippage, fill rate/quality, and exit-reason effectiveness.
Practical Build Order

Scanner + Opportunity Board ranking API.
Draft intent generation + alerting.
Portfolio risk caps + sizing guardrails.
Agent mode (staged adds/trims/exits + explainability logs).
PostgreSQL migration.
Model-family split + uncertainty/execution-cost-aware ranking refinements.