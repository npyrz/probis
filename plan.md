Your base is stronger than it looks. The repo already has single-event analytics, a live trading loop, venue-aware buy/sell execution, sports auto-sync, and backtesting: event-data.js:57, trade-intents.js:875, trade-intents.js:1185, us-orders.js:1596, sports.js:132. What it does not have yet is the layer that turns those pieces into a real trade assistant: a scanner, a portfolio/risk brain, and a re-decision engine while a trade is live.

On Polymarket research, the useful takeaway is structural: Polymarket US is a separate regulated venue, while the broader Polymarket docs split discovery across Gamma, Data, and CLOB APIs. That matches your code already: event discovery through active-event fetches and event resolution, then venue-specific US order execution. Moving forward, treat the US venue as authoritative for tradability, shares, and fills, and use discovery feeds only to find candidates. Your code is already close to that model in gamma.js:295, gamma.js:333, and us-orders.js:601.

What To Build Next

Add a scanner service, not just single-event analysis. Right now the app loads only a handful of active events in the UI and analyzes one event at a time: App.jsx:1406, api.js:91. Build a background scanner that pulls a larger tradable universe, runs analytics on candidates, and ranks opportunities by expected value, confidence, liquidity, spread, and time-to-resolution.
Add agent mode for active trades. The current live loop mainly polls, checks stop-loss/take-profit, and exits: trade-intents.js:875, trade-intents.js:1297. Extend that state machine so an active trade can scale in, scale out, tighten stops, or pause further adds when edge decays.
Add blended-position accounting. If the engine buys more during an active trade, you need blended entry probability, blended cost basis, incremental max position sizing, and per-leg attribution. That belongs in the trade-intent state and position model in trade-intents.js:1185.
Add portfolio risk controls before adding more automation. You need max exposure per market, per event cluster, per league, per day, and per regime. Otherwise a scanner plus agent mode just increases turnover and correlation risk.
Replace JSON persistence with a real database. You are still storing trade state in a JSON file: trade-intents.js:23. The plan already points at PostgreSQL: plan.md:32-33. Do that before serious automation, because you need durable fills, quotes, model versions, and outcome attribution.
Agent Mode
For the feature you asked about specifically, I would implement it as staged-entry policy rather than “always buy more.”

Create an add-on policy per trade:
Add only if edge improved since entry, market liquidity is still acceptable, the updated model still agrees with the thesis, and total position remains under a hard cap.
Add a scale ladder:
Example states are initial entry, first add, second add, no more adds. Each rung should require a stronger threshold than the last.
Recompute fair value every poll:
You already poll tracked intents every 5 seconds in the UI: App.jsx:1483. The backend should recompute edge on each active position and decide hold, add, trim, or exit.
Support partial profit-taking and trailing stops:
You already have sell execution and aggressive ladders: us-orders.js:977, us-orders.js:1023, us-orders.js:1708. Reuse that for partial exits.
Make it explain itself:
Every add or trim should write a machine-readable reason: edge widened, model confidence rose, liquidity stayed stable, risk budget available.
Auto-Find Good Trades
This is the highest-value product addition.

Build an Opportunity Board in the Trade Center: App.jsx:2495.
Show per candidate:
Outcome, current market probability, model probability, edge, EV per dollar, confidence, liquidity, spread, recent momentum, time to event, and whether the signal is sports-model-driven or market-microstructure-driven.
Add decision classes:
Strong buy, soft buy, watchlist, avoid.
Generate draft intents automatically, not auto-execution first.
Add alerts:
Tell you which side to take, max suggested size, and what invalidates the trade.
The missing backend piece is a scanner endpoint that loops through the active tradable universe, runs event-data.js:57, applies statistical-model.js:118, then ranks with decision-engine.js:212.

Model Priorities
The backtests make the priorities clearer.

NBA looks decent after calibration:
Raw accuracy was about 63.1%, calibrated about 64.1%, walk-forward about 64.1%. Brier improved from about 0.250 raw to about 0.224 walk-forward.

MLB is weaker:
Raw accuracy was about 56.2%, calibrated unchanged, walk-forward about 56.1%. Brier improved from about 0.259 raw to about 0.245 walk-forward, but the edge is modest.

That means:

NBA is closer to automation-ready than MLB.
Calibration is helping materially, which validates the work in elo-model.js:204 and elo-model.js:811.
Playoff performance is materially worse than regular season, so you should model playoffs separately.
Accuracy is not enough. You need closing-line value, realized EV, slippage, and fill quality.
The biggest model upgrades I’d make are:

Add time-to-resolution features and market regime features to the Polymarket model. Right now the generic market model is mostly short-horizon price history, momentum, volatility, liquidity share, and sports fair probability blending: statistical-model.js:118.
Add market microstructure features:
Spread, depth, quote staleness, order-book imbalance, and last fill tempo.
Split models by market family:
Sports moneyline-style markets, player props, geopolitical deadline markets, crypto threshold markets, and multi-candidate winner markets should not share one scoring rule.
Train on residuals:
For sports, model the difference between your fair probability and market probability, not just the win probability itself.
Add uncertainty:
A trade should require not just positive edge, but edge greater than uncertainty plus execution cost.
How To Make It a Real Money-Focused Assistant
Do not optimize for “predicting winners.” Optimize for expected value after costs.

Rank trades by edge net of slippage, fees, and likely fill quality.
Size positions by confidence, uncertainty, liquidity, and portfolio correlation.
Log every recommendation, every rejected recommendation, every fill attempt, and every exit reason.
Compare forecast to market close and to actual resolution.
Learn which signal families actually pay:
Sports fair-value drift, news shock, late liquidity dislocations, overreaction reversals, and stale prices.
If by “terminal” you mean a real CLI, you do not really have one yet. You have a web operator console plus a couple of scripts: package.json:18, package.json:23, package.json:24. If you want a true terminal workflow, build a scanner TUI or CLI with commands like scan, inspect, draft, execute, monitor, and rebalance. If you mean the current operator console, then the biggest UX upgrade is an opportunity board, a live position ladder, and a portfolio-risk panel.

Natural next steps are:

Build the market scanner and Opportunity Board first.
Add staged-entry agent mode with blended cost basis and hard risk caps.
Move trade storage and analytics to PostgreSQL so the system can actually learn from fills and outcomes.
If you want, I can turn this into a concrete implementation plan for the repo and start with the scanner endpoint plus an Opportunity Board in the current app.