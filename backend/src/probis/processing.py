from __future__ import annotations

from typing import Any
from typing import Optional

import numpy as np

from .models import EdgeDecision
from .state import MarketState


def normalize_price(price: float) -> float:
    # Guardrails: keep deterministic and cheap.
    return float(np.clip(price, 0.0, 1.0))


def update_market_price(state: MarketState, market: str, outcome: str, price: float) -> None:
    state.prices[(market, outcome)] = normalize_price(price)


def get_market_probability(state: MarketState, market: str, outcome: str) -> Optional[float]:
    return state.prices.get((market, outcome))


def set_model_probability(state: MarketState, market: str, outcome: str, prob: float) -> None:
    state.model_probs[(market, outcome)] = float(np.clip(prob, 0.0, 1.0))


def compute_edge_decision(
    *,
    market: str,
    outcome: str,
    your_probability: float,
    market_probability: float,
    threshold: float,
) -> EdgeDecision:
    edge = your_probability - market_probability
    return EdgeDecision(
        market=market,
        outcome=outcome,
        your_probability=your_probability,
        market_probability=market_probability,
        edge=edge,
        should_trade=edge > threshold,
    )


def apply_signal_to_model_prob(
    *, base_prob: float, signal: Optional[dict[str, Any]]
) -> float:
    """Cheap deterministic update.

    Current rule: sentiment nudges the base probability.
    - This is intentionally simple; you can swap in Bayesian updates later.
    """

    if not signal:
        return base_prob
    sentiment = float(signal.get("sentiment", 0.0))
    confidence = float(signal.get("confidence", 0.0))

    # Map [-1,1] sentiment into a +/- adjustment. Keep it bounded.
    adjustment = 0.10 * sentiment * confidence
    return float(np.clip(base_prob + adjustment, 0.0, 1.0))
