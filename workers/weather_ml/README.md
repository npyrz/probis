# Weather ML Worker

This worker trains the optional heavier calibration layer for Polymarket US high-temperature markets.

The default KMDW rolling calibration workflow is implemented in Node and does not require Python dependencies:

```bash
npm run weather:model-train -- --date-from=2026-05-01 --date-to=2026-05-31 --rolling-folds=4
npm run weather:model-evaluate -- --date-from=2026-05-01 --date-to=2026-05-31
```

That native trainer builds supervised rows from settled KMDW recommendations, writes a canonical model artifact, appends an evaluation log, and updates the model registry.

It reads settled rows from `predictions`, joins the persisted market/outcome/weather data, trains a LightGBM or XGBoost model when those packages are available, and exports a portable logistic calibration artifact that the Node API can score directly.

```bash
python3 -m pip install -r workers/weather_ml/requirements.txt
npm run train:weather-ml
```

The API loads `WEATHER_ML_MODEL_PATH` on each analytics/scanner refresh and blends the model probability with the Monte Carlo probability. If there are not enough settled paper predictions yet, the worker writes an `insufficient_data` artifact and the API keeps using the simulation-only path.
