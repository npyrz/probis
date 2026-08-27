# Repository Guidelines

## Project Structure & Module Organization

Probis is a local-first, open-source terminal for Polymarket US. It is mid-pivot: the built and working surface today is the weather market family (Chicago/KMDW daily high-temperature markets), which is being generalized into a full-market terminal with news/data feeds, a cross-market recommendation layer, and agent mode. `REFACTOR-PLAN.md` is the authoritative plan and its phase numbering is the shared vocabulary for this work — check it before starting a task. Phase 0 is complete: `apps/api/src/core/` (venue layer, engine, catalog) and `apps/api/src/families/` (the `market-family-v1` contract plus the weather family) now exist. `apps/tui/` does not. The layering rule is strict: `core/` must never import from `families/` or `services/` — inject what it needs (see the event filter in `core/polymarket/gamma.js` and the `stationId` parameter in `core/polymarket/history.js`). It is a Node.js workspace with two main apps under `apps/`. `apps/api` contains the Express API, routes in `src/routes`, family-agnostic machinery in `src/core`, market families in `src/families`, the weather/ML/persistence stack in `src/services`, CLI weather scripts in `src/scripts`, and API tests in `test/`. `apps/web` contains the Vite/React UI in `src`, static assets in `public`, and built output in `dist` (gitignored, regenerate with the build). The optional Python weather worker lives in `workers/weather_ml`, and archived background research in `docs/research/`. Local data and model artifacts are written under `data/` — this directory is gitignored, holds the entire backtest/training corpus plus live trade intents, and must never be cleaned up casually. Do not commit secrets or machine-specific generated data.

## Build, Test, and Development Commands

- `npm install`: install root and workspace dependencies.
- `npm run dev`: run API and web together.
- `npm run dev:api`: run the API with Node watch mode.
- `npm run dev:web`: run the Vite web app.
- `npm run start`: start the API without watch mode.
- `npm test`: run Node API tests from `apps/api/test/*.test.js`.
- `npm run build`: build all workspaces.
- `npm run build --workspace @probis/web`: build only the web app.
- `npm run weather:snapshot`, `weather:archive-backfill`, `weather:forecast-vintage-backfill`, `weather:market-board-backfill`, `weather:model-train`, and `weather:model-evaluate`: run KMDW data and model workflows.

## Coding Style & Naming Conventions

Use modern ESM JavaScript, two-space indentation, semicolons, and single quotes. Prefer small pure helpers near their callers unless a service-level abstraction already exists. Keep API route handlers thin and place business logic in `apps/api/src/services`. Use descriptive camelCase for functions and variables, PascalCase for React components, and lowercase hyphenated names for CLI script files. Do not edit `apps/web/dist` directly; change source files and rebuild.

## Testing Guidelines

Tests use Node’s built-in `node:test` runner. Add or update tests in `apps/api/test/chicago.test.js` when changing weather math, persistence, trade gates, training rows, alerts, or service contracts. Prefer deterministic fixtures over network-dependent tests. Run `npm test` before API handoff; run the web build for UI changes.

## Commit & Pull Request Guidelines

Recent commits use conventional prefixes such as `feat:` followed by concise imperative text, for example `feat: implement training data portal`. Keep commits scoped and avoid mixing generated data with source changes. Pull requests should describe the behavior change, list verification commands, mention any `.env` or data migration impact, and include screenshots for visible UI changes.

## Security & Configuration Tips

Copy `.env.example` to `.env` for local setup. Keep Polymarket keys, NOAA tokens, database URLs, and local account details out of commits. Prefer documented environment variables over hardcoded paths or credentials.
