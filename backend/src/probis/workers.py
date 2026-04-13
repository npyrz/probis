from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Union

from .bus import EventBus, InMemoryBus
from .config import settings
from .models import EdgeDecision, OrderRequest, PriceTick, TradeFill
from .processing import (
    apply_signal_to_model_prob,
    compute_edge_decision,
    get_market_probability,
    set_model_probability,
    update_market_price,
)
from .state import MarketState


log = logging.getLogger(__name__)


PRICE_CHANNEL = "prices"
SIGNAL_CHANNEL = "signals"
ORDER_CHANNEL = "orders"
FILL_CHANNEL = "fills"


async def processing_worker(*, bus: Union[EventBus, InMemoryBus], state: MarketState) -> None:
    """Hot path: price -> model update -> decision -> order (if any).

    Constraints:
    - deterministic
    - no DB, no LLM
    """

    latest_signal_by_event: dict[str, dict] = {}

    async def _signal_listener() -> None:
        async for msg in bus.subscribe(SIGNAL_CHANNEL):
            event = str(msg.data.get("event", ""))
            if event:
                latest_signal_by_event[event] = msg.data

    asyncio.create_task(_signal_listener())

    async for msg in bus.subscribe(PRICE_CHANNEL):
        try:
            tick = PriceTick.model_validate(msg.data)
        except Exception:
            log.exception("Invalid price tick")
            continue

        update_market_price(state, tick.market, tick.outcome, tick.price)

        # Base model = last price (placeholder). Signals nudge it.
        base_prob = tick.price
        signal = latest_signal_by_event.get(tick.market)  # simplest mapping for now
        your_prob = apply_signal_to_model_prob(base_prob=base_prob, signal=signal)
        set_model_probability(state, tick.market, tick.outcome, your_prob)

        market_prob = get_market_probability(state, tick.market, tick.outcome)
        if market_prob is None:
            continue

        decision: EdgeDecision = compute_edge_decision(
            market=tick.market,
            outcome=tick.outcome,
            your_probability=your_prob,
            market_probability=market_prob,
            threshold=settings.edge_threshold,
        )

        state.edges[(tick.market, tick.outcome)] = decision.edge

        # Push minimal update for dashboard/websocket.
        state.updates.put_nowait(
            {
                "ts": datetime.utcnow().isoformat(),
                "market": tick.market,
                "outcome": tick.outcome,
                "market_probability": market_prob,
                "your_probability": your_prob,
                "edge": decision.edge,
                "should_trade": decision.should_trade,
            }
        )

        if not decision.should_trade:
            continue

        # Simple deterministic order sizing rule for demo.
        order = OrderRequest(
            market=tick.market,
            outcome=tick.outcome,
            side="buy" if decision.edge > 0 else "sell",
            size=1.0,
            limit_price=tick.price,
        )
        await bus.publish(ORDER_CHANNEL, order.model_dump(mode="json"))


async def execution_worker(*, bus: Union[EventBus, InMemoryBus], state: MarketState) -> None:
    """Exec worker: receives orders, sim-fills them.

    Replace this with Polymarket API calls later; keep retries/slippage here.
    """

    async for msg in bus.subscribe(ORDER_CHANNEL):
        try:
            order = OrderRequest.model_validate(msg.data)
        except Exception:
            log.exception("Invalid order")
            continue

        # Simulated instant fill at limit.
        fill = TradeFill(
            market=order.market,
            outcome=order.outcome,
            side=order.side,
            size=order.size,
            price=order.limit_price,
            venue="sim",
            order_id=str(uuid.uuid4()),
        )

        key = (fill.market, fill.outcome)
        signed = fill.size if fill.side == "buy" else -fill.size
        state.positions[key] = state.positions.get(key, 0.0) + signed

        await bus.publish(FILL_CHANNEL, fill.model_dump(mode="json"))


async def llm_worker(*, bus: Union[EventBus, InMemoryBus]) -> None:
    """Periodically produces structured signals.

    Default implementation emits a stub signal. Swap in Ollama calls in a
    dedicated process/service if desired.
    """

    from .services.ollama_client import OllamaClient

    client = OllamaClient(base_url=settings.ollama_base_url, model=settings.ollama_model)

    while True:
        await asyncio.sleep(settings.llm_interval_seconds)

        # Placeholder text source.
        text = "Breaking news: election looks tight, slight momentum shift."
        try:
            signal = await client.extract_signal(text=text)
        except Exception:
            # Keep LLM work strictly optional.
            log.info("LLM worker: Ollama unavailable or request failed")
            continue
        if not signal:
            continue
        signal.setdefault("source", "news")
        signal.setdefault("ts", datetime.utcnow().isoformat())

        # For now, map event to a market name.
        if "event" not in signal:
            signal["event"] = "election"

        await bus.publish(SIGNAL_CHANNEL, signal)
