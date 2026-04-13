from __future__ import annotations

import asyncio
import math
import time
from collections.abc import AsyncIterator


async def sim_price_ticks(*, market: str, outcome: str) -> AsyncIterator[dict]:
    """Deterministic-ish simulated price ticks for smoke testing."""
    t0 = time.time()
    i = 0
    while True:
        # 1Hz by default; tune higher when profiling.
        await asyncio.sleep(1.0)
        dt = time.time() - t0
        # simple bounded oscillation between ~0.35 and ~0.65
        price = 0.5 + 0.15 * math.sin(dt / 10.0) + 0.02 * math.sin(dt)
        i += 1
        yield {
            "source": "sim",
            "market": market,
            "outcome": outcome,
            "price": max(0.0, min(1.0, float(price))),
            "seq": i,
        }
