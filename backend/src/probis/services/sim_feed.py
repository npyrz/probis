from __future__ import annotations

import asyncio
import math
import time
from collections.abc import AsyncIterator


async def sim_price_ticks(*, market: str, outcome: str) -> AsyncIterator[dict]:
    """Deterministic-ish simulated price ticks for smoke testing."""
    t0 = time.time()
    i = 0
    phase = (sum(ord(ch) for ch in market) % 13) / 10.0
    center = 0.45 + ((sum(ord(ch) for ch in outcome) % 10) / 100.0)
    while True:
        # 1Hz by default; tune higher when profiling.
        await asyncio.sleep(1.0)
        dt = time.time() - t0
        # simple bounded oscillation between ~0.35 and ~0.65
        price = center + 0.15 * math.sin((dt / 10.0) + phase) + 0.02 * math.sin(dt + phase)
        i += 1
        yield {
            "source": "sim",
            "market": market,
            "outcome": outcome,
            "price": max(0.0, min(1.0, float(price))),
            "seq": i,
        }
