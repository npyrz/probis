#!/usr/bin/env python3
"""Train a weather-market calibration model from persisted paper predictions.

The API runs the Monte Carlo weather model in Node. This worker trains a heavier
Python model from settled rows in Postgres, then exports a small JSON artifact
that Node can score without importing Python.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]

FEATURE_NAMES = [
    "simulation_probability",
    "market_probability",
    "gross_simulation_edge",
    "estimated_cost",
    "expected_high",
    "std_dev",
    "observed_high_so_far",
    "current_observed_temp",
    "nws_forecast_high",
    "openmeteo_forecast_high",
    "nws_remaining_forecast_high",
    "openmeteo_remaining_forecast_high",
    "historical_high_for_same_day",
    "recent_station_bias",
    "humidity",
    "wind_speed_mph",
    "cloud_cover",
    "dew_point_f",
    "pressure_hpa",
    "precipitation_chance",
    "observation_count",
    "forecast_disagreement",
    "source_risk_buffer",
    "range_min",
    "range_max",
    "range_width",
    "range_center",
    "range_distance_from_expected",
    "day_phase_code",
    "simulation_p10",
    "simulation_p50",
    "simulation_p90",
    "spread",
    "bid_depth",
    "ask_depth",
    "is_yes_outcome",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_path(raw_path: str | None, fallback: str) -> Path:
    value = raw_path or fallback
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path


def load_dotenv_file(path: Path) -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def fail_dependency(error: ImportError) -> None:
    print(
        "Missing Python ML dependencies. Install them with:\n"
        "  python3 -m pip install -r workers/weather_ml/requirements.txt\n\n"
        f"Import error: {error}",
        file=sys.stderr,
    )
    raise SystemExit(2)


def load_dependencies():
    try:
        import joblib
        import numpy as np
        import pandas as pd
        import psycopg
        from sklearn.ensemble import HistGradientBoostingClassifier
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
        from sklearn.model_selection import train_test_split
        from sklearn.preprocessing import StandardScaler
    except ImportError as error:
        fail_dependency(error)

    return {
        "HistGradientBoostingClassifier": HistGradientBoostingClassifier,
        "LogisticRegression": LogisticRegression,
        "StandardScaler": StandardScaler,
        "brier_score_loss": brier_score_loss,
        "joblib": joblib,
        "log_loss": log_loss,
        "np": np,
        "pd": pd,
        "psycopg": psycopg,
        "roc_auc_score": roc_auc_score,
        "train_test_split": train_test_split,
    }


def maybe_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    return numeric


def maybe_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def nested_get(payload: dict[str, Any], *path: str) -> Any:
    cursor: Any = payload
    for key in path:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(key)
    return cursor


def range_width(lower: float | None, upper: float | None) -> float | None:
    if lower is None or upper is None:
        return None
    return max(0.0, upper - lower)


def range_center(lower: float | None, upper: float | None) -> float | None:
    if lower is not None and upper is not None:
        return (lower + upper) / 2.0
    return lower if lower is not None else upper


def day_phase_code(value: Any) -> float:
    phases = {
        "past": -1.0,
        "morning": 1.0,
        "midday": 2.0,
        "late-afternoon": 3.0,
        "evening": 4.0,
        "future": 5.0,
    }
    return phases.get(str(value or "").strip().lower(), 0.0)


def get_prediction_columns(conn: Any) -> set[str]:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            select column_name
            from information_schema.columns
            where table_schema = 'public' and table_name = 'predictions'
            """
        )
        return {row[0] for row in cursor.fetchall()}


def fetch_training_rows(conn: Any, limit: int | None) -> list[dict[str, Any]]:
    columns = get_prediction_columns(conn)
    feature_select = "p.feature_json" if "feature_json" in columns else "'{}'::jsonb as feature_json"
    model_version_select = "p.model_version" if "model_version" in columns else "null::text as model_version"
    limit_clause = "limit %s" if limit else ""
    params = [limit] if limit else []

    query = f"""
      select
        p.id,
        p.market_id,
        p.outcome_id,
        p.timestamp,
        p.station_id,
        p.expected_high,
        p.distribution_json,
        p.model_probability,
        p.market_probability,
        p.edge,
        p.confidence,
        p.actual_high,
        p.actual_outcome,
        p.created_at,
        {feature_select},
        {model_version_select},
        o.label as outcome_label,
        o.lower_temp,
        o.upper_temp,
        o.spread,
        o.liquidity,
        m.slug,
        m.question,
        m.location_name,
        m.market_date,
        ws.raw_json as weather_raw_json,
        ws.observed_temp,
        ws.observed_high_so_far,
        ws.nws_forecast_high,
        ws.openmeteo_forecast_high,
        ws.historical_high as historical_high_for_same_day,
        ws.recent_station_bias,
        ws.humidity,
        ws.wind_speed,
        ws.cloud_cover
      from predictions p
      join outcomes o on o.id = p.outcome_id
      join markets m on m.id = p.market_id
      left join lateral (
        select *
        from weather_snapshots ws
        where ws.market_id = p.market_id
          and ws.created_at <= p.created_at
        order by ws.created_at desc
        limit 1
      ) ws on true
      where p.actual_outcome is not null
        and p.model_probability is not null
        and p.market_probability is not null
      order by p.created_at desc
      {limit_clause}
    """

    with conn.cursor(row_factory=dict_row_factory(conn)) as cursor:
        cursor.execute(query, params)
        return list(cursor.fetchall())


def dict_row_factory(conn: Any):
    try:
        from psycopg.rows import dict_row
    except ImportError:
        return None
    return dict_row


def feature_from_row(row: dict[str, Any]) -> dict[str, float | None]:
    feature_json = maybe_json(row.get("feature_json"))
    weather_raw = maybe_json(row.get("weather_raw_json"))
    distribution = maybe_json(row.get("distribution_json"))
    model = maybe_json(weather_raw.get("model"))
    outcome_label = str(row.get("outcome_label") or "").strip()
    lower = maybe_float(row.get("lower_temp"))
    upper = maybe_float(row.get("upper_temp"))
    center = range_center(lower, upper)
    expected_high = maybe_float(row.get("expected_high"))
    if expected_high is None:
        expected_high = maybe_float(feature_json.get("expected_high"))
    simulation_probability = maybe_float(feature_json.get("simulation_probability"))

    if simulation_probability is None:
        simulation_probability = maybe_float(distribution.get(outcome_label))
    if simulation_probability is None:
        simulation_probability = maybe_float(row.get("model_probability"))

    market_probability = maybe_float(feature_json.get("market_probability"))
    if market_probability is None:
        market_probability = maybe_float(row.get("market_probability"))
    model_probability = maybe_float(row.get("model_probability"))
    edge = maybe_float(row.get("edge"))
    estimated_cost = None
    if model_probability is not None and market_probability is not None and edge is not None:
        estimated_cost = model_probability - market_probability - edge

    def first(*values: Any) -> float | None:
        for value in values:
            numeric = maybe_float(value)
            if numeric is not None:
                return numeric
        return None

    features: dict[str, float | None] = {
        "simulation_probability": simulation_probability,
        "market_probability": market_probability,
        "gross_simulation_edge": first(
            feature_json.get("gross_simulation_edge"),
            None if simulation_probability is None or market_probability is None else simulation_probability - market_probability,
        ),
        "estimated_cost": first(feature_json.get("estimated_cost"), estimated_cost),
        "expected_high": expected_high,
        "std_dev": first(feature_json.get("std_dev"), model.get("stdDev")),
        "observed_high_so_far": first(feature_json.get("observed_high_so_far"), row.get("observed_high_so_far"), nested_get(weather_raw, "observedHighSoFar")),
        "current_observed_temp": first(feature_json.get("current_observed_temp"), row.get("observed_temp"), nested_get(weather_raw, "currentObservedTemp")),
        "nws_forecast_high": first(feature_json.get("nws_forecast_high"), row.get("nws_forecast_high"), nested_get(weather_raw, "nwsForecastHigh")),
        "openmeteo_forecast_high": first(feature_json.get("openmeteo_forecast_high"), row.get("openmeteo_forecast_high"), nested_get(weather_raw, "openMeteoForecastHigh")),
        "nws_remaining_forecast_high": first(feature_json.get("nws_remaining_forecast_high"), nested_get(weather_raw, "nwsRemainingForecastHigh")),
        "openmeteo_remaining_forecast_high": first(feature_json.get("openmeteo_remaining_forecast_high"), nested_get(weather_raw, "openMeteoRemainingForecastHigh")),
        "historical_high_for_same_day": first(feature_json.get("historical_high_for_same_day"), row.get("historical_high_for_same_day"), nested_get(weather_raw, "historicalHighForSameDay")),
        "recent_station_bias": first(feature_json.get("recent_station_bias"), row.get("recent_station_bias"), nested_get(weather_raw, "recentStationBias")),
        "humidity": first(feature_json.get("humidity"), row.get("humidity"), nested_get(weather_raw, "humidity")),
        "wind_speed_mph": first(feature_json.get("wind_speed_mph"), row.get("wind_speed"), nested_get(weather_raw, "windSpeedMph")),
        "cloud_cover": first(feature_json.get("cloud_cover"), row.get("cloud_cover"), nested_get(weather_raw, "cloudCover")),
        "dew_point_f": first(feature_json.get("dew_point_f"), nested_get(weather_raw, "dewPointF")),
        "pressure_hpa": first(feature_json.get("pressure_hpa"), nested_get(weather_raw, "pressureHpa")),
        "precipitation_chance": first(feature_json.get("precipitation_chance"), nested_get(weather_raw, "precipitationChance")),
        "observation_count": first(feature_json.get("observation_count"), nested_get(weather_raw, "observationCount")),
        "forecast_disagreement": first(feature_json.get("forecast_disagreement"), model.get("forecastDisagreement")),
        "source_risk_buffer": first(feature_json.get("source_risk_buffer"), model.get("sourceRiskBuffer")),
        "range_min": first(feature_json.get("range_min"), lower),
        "range_max": first(feature_json.get("range_max"), upper),
        "range_width": first(feature_json.get("range_width"), range_width(lower, upper)),
        "range_center": first(feature_json.get("range_center"), center),
        "range_distance_from_expected": first(
            feature_json.get("range_distance_from_expected"),
            None if center is None or expected_high is None else abs(center - expected_high),
        ),
        "day_phase_code": first(feature_json.get("day_phase_code"), day_phase_code(model.get("dayPhase"))),
        "simulation_p10": first(feature_json.get("simulation_p10"), nested_get(weather_raw, "weatherPercentiles", "p10")),
        "simulation_p50": first(feature_json.get("simulation_p50"), nested_get(weather_raw, "weatherPercentiles", "p50")),
        "simulation_p90": first(feature_json.get("simulation_p90"), nested_get(weather_raw, "weatherPercentiles", "p90")),
        "spread": first(feature_json.get("spread"), row.get("spread")),
        "bid_depth": first(feature_json.get("bid_depth")),
        "ask_depth": first(feature_json.get("ask_depth")),
        "is_yes_outcome": first(feature_json.get("is_yes_outcome"), 1.0 if outcome_label.lower() == "yes" else 0.0),
    }

    return features


def build_dataframe(rows: list[dict[str, Any]], deps: dict[str, Any]):
    pd = deps["pd"]
    records: list[dict[str, Any]] = []

    for row in rows:
        record = feature_from_row(row)
        record["target"] = 1 if row.get("actual_outcome") else 0
        records.append(record)

    return pd.DataFrame.from_records(records)


def insufficient_artifact(reason: str, sample_count: int, min_samples: int) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "status": "insufficient_data",
        "reason": reason,
        "trainedAt": utc_now(),
        "featureNames": FEATURE_NAMES,
        "training": {
            "sampleCount": sample_count,
            "minSamples": min_samples,
        },
    }


def compute_blend_weight(sample_count: int, brier_score: float | None) -> float:
    base = min(0.65, max(0.15, sample_count / 600.0))
    if brier_score is None:
        return round(base, 4)
    if brier_score <= 0.18:
        base += 0.1
    elif brier_score >= 0.28:
        base -= 0.1
    return round(max(0.1, min(0.65, base)), 4)


def evaluate_probabilities(y_true: Any, y_prob: Any, deps: dict[str, Any]) -> dict[str, float | None]:
    np = deps["np"]
    brier_score_loss = deps["brier_score_loss"]
    log_loss = deps["log_loss"]
    roc_auc_score = deps["roc_auc_score"]

    metrics: dict[str, float | None] = {
        "brierScore": float(brier_score_loss(y_true, y_prob)),
        "logLoss": float(log_loss(y_true, y_prob, labels=[0, 1])),
        "auc": None,
    }
    if len(set(np.asarray(y_true).tolist())) > 1:
        metrics["auc"] = float(roc_auc_score(y_true, y_prob))
    return metrics


def train_optional_gbm(x_train: Any, y_train: Any, x_eval: Any, y_eval: Any, native_output: Path, deps: dict[str, Any]) -> dict[str, Any] | None:
    candidates: list[tuple[str, Any]] = []

    try:
        from lightgbm import LGBMClassifier

        candidates.append((
            "lightgbm",
            LGBMClassifier(
                n_estimators=250,
                learning_rate=0.04,
                num_leaves=15,
                subsample=0.9,
                colsample_bytree=0.9,
                random_state=42,
                verbose=-1,
            ),
        ))
    except ImportError:
        pass

    try:
        from xgboost import XGBClassifier

        candidates.append((
            "xgboost",
            XGBClassifier(
                n_estimators=250,
                max_depth=3,
                learning_rate=0.04,
                subsample=0.9,
                colsample_bytree=0.9,
                eval_metric="logloss",
                random_state=42,
            ),
        ))
    except ImportError:
        pass

    candidates.append((
        "sklearn-hist-gradient-boosting",
        deps["HistGradientBoostingClassifier"](
            max_iter=200,
            learning_rate=0.04,
            max_leaf_nodes=15,
            random_state=42,
        ),
    ))

    for model_type, model in candidates:
        try:
            model.fit(x_train, y_train)
            y_prob = model.predict_proba(x_eval)[:, 1]
            native_output.parent.mkdir(parents=True, exist_ok=True)
            deps["joblib"].dump(model, native_output)
            importance = getattr(model, "feature_importances_", None)
            return {
                "modelType": model_type,
                "nativeModelPath": str(native_output),
                "metrics": evaluate_probabilities(y_eval, y_prob, deps),
                "featureImportances": None if importance is None else {
                    name: float(value)
                    for name, value in zip(FEATURE_NAMES, importance)
                },
            }
        except Exception as error:  # pragma: no cover - training robustness
            print(f"Skipping {model_type}: {error}", file=sys.stderr)

    return None


def train_model(rows: list[dict[str, Any]], args: argparse.Namespace, deps: dict[str, Any]) -> dict[str, Any]:
    np = deps["np"]
    train_test_split = deps["train_test_split"]
    LogisticRegression = deps["LogisticRegression"]
    StandardScaler = deps["StandardScaler"]
    dataframe = build_dataframe(rows, deps)
    sample_count = len(dataframe)

    if sample_count < args.min_samples:
        return insufficient_artifact("not enough settled predictions", sample_count, args.min_samples)

    positives = int(dataframe["target"].sum())
    negatives = sample_count - positives

    if positives < args.min_class_samples or negatives < args.min_class_samples:
        return insufficient_artifact("not enough positive and negative settled outcomes", sample_count, args.min_samples)

    x = dataframe[FEATURE_NAMES].apply(lambda column: deps["pd"].to_numeric(column, errors="coerce"))
    y = dataframe["target"].astype(int)
    imputation_values = {
        name: float(0.0 if np.isnan(x[name].median()) else x[name].median())
        for name in FEATURE_NAMES
    }
    x = x.fillna(imputation_values)
    stratify = y if positives >= 2 and negatives >= 2 and sample_count >= 40 else None

    if sample_count >= 40:
        x_train, x_eval, y_train, y_eval = train_test_split(
            x,
            y,
            test_size=min(0.3, max(0.2, 20 / sample_count)),
            random_state=42,
            stratify=stratify,
        )
        evaluation_scope = "holdout"
    else:
        x_train, x_eval, y_train, y_eval = x, x, y, y
        evaluation_scope = "training"

    scaler = StandardScaler()
    x_train_scaled = scaler.fit_transform(x_train)
    x_eval_scaled = scaler.transform(x_eval)
    logistic = LogisticRegression(
        class_weight="balanced",
        max_iter=4000,
        random_state=42,
    )
    logistic.fit(x_train_scaled, y_train)
    logistic_prob = logistic.predict_proba(x_eval_scaled)[:, 1]
    logistic_metrics = evaluate_probabilities(y_eval, logistic_prob, deps)
    native_output = resolve_path(args.native_output, "data/models/weather-high-temp-gbm.joblib")
    gbm_result = train_optional_gbm(x_train, y_train, x_eval, y_eval, native_output, deps)
    model_type = "logistic-calibrator"
    if gbm_result:
        model_type = f"{gbm_result['modelType']}-with-logistic-production-calibrator"

    coefficients = {
        name: float(value)
        for name, value in zip(FEATURE_NAMES, logistic.coef_[0])
    }
    feature_transforms = {
        name: {
            "mean": float(mean),
            "scale": float(scale if scale > 0 else 1.0),
        }
        for name, mean, scale in zip(FEATURE_NAMES, scaler.mean_, scaler.scale_)
    }

    return {
        "schemaVersion": 1,
        "status": "ready",
        "modelId": f"weather-high-temp-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "modelType": model_type,
        "target": "settled_outcome_probability",
        "trainedAt": utc_now(),
        "featureNames": FEATURE_NAMES,
        "imputationValues": imputation_values,
        "featureTransforms": feature_transforms,
        "probabilityModel": {
            "modelType": "scaled-logistic-regression",
            "intercept": float(logistic.intercept_[0]),
            "coefficients": coefficients,
        },
        "blendWeight": compute_blend_weight(sample_count, logistic_metrics.get("brierScore")),
        "training": {
            "source": "postgres.predictions",
            "sampleCount": sample_count,
            "positiveCount": positives,
            "negativeCount": negatives,
            "minSamples": args.min_samples,
            "evaluationScope": evaluation_scope,
            "nativeModelType": None if gbm_result is None else gbm_result["modelType"],
            "nativeModelPath": None if gbm_result is None else gbm_result["nativeModelPath"],
        },
        "metrics": {
            "productionLogistic": logistic_metrics,
            "gbm": None if gbm_result is None else gbm_result["metrics"],
        },
        "featureImportances": None if gbm_result is None else gbm_result["featureImportances"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train the weather high-temp ML calibration artifact.")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"))
    parser.add_argument("--output", default=os.getenv("WEATHER_ML_MODEL_PATH", "data/models/weather-high-temp-calibrator.json"))
    parser.add_argument("--native-output", default=os.getenv("WEATHER_ML_NATIVE_MODEL_PATH", "data/models/weather-high-temp-gbm.joblib"))
    parser.add_argument("--min-samples", type=int, default=int(os.getenv("WEATHER_ML_MIN_SAMPLES", "40")))
    parser.add_argument("--min-class-samples", type=int, default=int(os.getenv("WEATHER_ML_MIN_CLASS_SAMPLES", "5")))
    parser.add_argument("--limit", type=int, default=int(os.getenv("WEATHER_ML_TRAINING_LIMIT", "5000")))
    return parser.parse_args()


def main() -> None:
    load_dotenv_file(REPO_ROOT / ".env")
    args = parse_args()
    output = resolve_path(args.output, "data/models/weather-high-temp-calibrator.json")

    if not args.database_url:
        write_json(output, insufficient_artifact("DATABASE_URL is not configured", 0, args.min_samples))
        print(f"Wrote insufficient-data artifact to {output}")
        return

    deps = load_dependencies()
    psycopg = deps["psycopg"]

    with psycopg.connect(args.database_url) as conn:
        rows = fetch_training_rows(conn, args.limit if args.limit > 0 else None)

    artifact = train_model(rows, args, deps)
    write_json(output, artifact)
    print(f"Wrote weather ML artifact to {output} ({artifact['status']}, samples={artifact['training']['sampleCount']})")


if __name__ == "__main__":
    main()
