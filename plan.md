Agent mode for live trades with staged-entry ladder (initial entry, add 1, add 2, no more adds).
Partial take-profit plus trailing-stop behavior for active positions.
Blended position accounting for multi-leg entries.
Portfolio risk engine with hard caps by market family, event cluster, day, and regime.
PostgreSQL storage for intents, fills, quotes, model versions, and outcome attribution.
Optional CLI/TUI workflow: scan, inspect, draft, execute, monitor, rebalance.

Enforce venue authority model: Polymarket US is authoritative for tradability, shares, fills; discovery feeds are candidate discovery only.
Upgrade active trade loop from stop-loss/take-profit-only to re-decision each poll: hold, add, trim, exit.
Add machine-readable reason logging for every action so behavior is auditable.
Improve sizing logic to be risk-budget aware before any add-on entries.
Improve ranking objective from winner prediction to EV after fees, slippage, and fill quality.
Add execution-quality features into scoring: spread, depth, quote staleness, imbalance, fill tempo.
Split models by market family, starting with weather and then UFC.
Add uncertainty-aware gating: require edge > uncertainty + execution cost.
Add post-trade learning metrics: closing-line value, realized EV, slippage, fill rate/quality, and exit-reason effectiveness.

Practical build order:

1. Weather-only scanner and Opportunity Board.
2. Weather rule parsing plus resolution-source display.
3. Weather data ingestion for finalized and forecast source data.
4. UFC market-family detection and baseline pricing.
5. Draft intent generation plus alerting.
6. Portfolio risk caps plus sizing guardrails.
7. Agent mode.
8. PostgreSQL migration.
