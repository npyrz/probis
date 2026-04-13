from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MarketState:
    # Latest market probabilities by (market, outcome)
    prices: dict[tuple[str, str], float] = field(default_factory=dict)

    # Your internal probabilities by (market, outcome)
    model_probs: dict[tuple[str, str], float] = field(default_factory=dict)

    # Latest computed edges
    edges: dict[tuple[str, str], float] = field(default_factory=dict)

    # Simple position tracking (signed size): (market,outcome)->size
    positions: dict[tuple[str, str], float] = field(default_factory=dict)

    # Broadcast queue for API websocket updates
    updates: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=10_000))
