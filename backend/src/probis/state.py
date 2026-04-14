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

    # Weighted average entry price for open positions.
    entry_prices: dict[tuple[str, str], float] = field(default_factory=dict)

    # Active monitor config keyed by (market, outcome).
    monitor_configs: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)

    # Session snapshot data for the terminal.
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    fills: list[dict[str, Any]] = field(default_factory=list)
    logs: list[dict[str, Any]] = field(default_factory=list)
    market_catalog: list[dict[str, Any]] = field(default_factory=list)

    # Broadcast queue for API websocket updates
    updates: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=10_000))

    def push_update(self, payload: dict[str, Any]) -> None:
        try:
            self.updates.put_nowait(payload)
        except asyncio.QueueFull:
            # Terminal updates are best-effort.
            return

    def push_fill(self, payload: dict[str, Any]) -> None:
        self.fills.insert(0, payload)
        del self.fills[100:]

    def push_log(self, payload: dict[str, Any]) -> None:
        self.logs.insert(0, payload)
        del self.logs[200:]
