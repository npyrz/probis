from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Optional
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


def _account_trading_ready(state: MarketState) -> bool:
    return bool(state.account.get("trading_ready"))


def _push_system_log(state: MarketState, *, level: str, message: str, session_id: Optional[str] = None) -> None:
    payload = {
        "type": "log",
        "ts": datetime.utcnow().isoformat(),
        "session_id": session_id,
        "level": level,
        "message": message,
    }
    state.push_log(payload)
    state.push_update(payload)


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

        previous_market_prob = get_market_probability(state, tick.market, tick.outcome)
        update_market_price(state, tick.market, tick.outcome, tick.price)
        key = (tick.market, tick.outcome)

        # Cheap deterministic model: market price plus short-term momentum.
        base_prob = tick.price
        if previous_market_prob is not None:
            momentum = tick.price - previous_market_prob
            base_prob = max(0.0, min(1.0, tick.price + (0.8 * momentum)))
        signal = latest_signal_by_event.get(tick.market)  # simplest mapping for now
        your_prob = apply_signal_to_model_prob(base_prob=base_prob, signal=signal)
        set_model_probability(state, tick.market, tick.outcome, your_prob)

        market_prob = get_market_probability(state, tick.market, tick.outcome)
        if market_prob is None:
            continue

        config = state.monitor_configs.get(key)
        threshold = settings.edge_threshold if config is None else float(config["edge_threshold"])

        decision: EdgeDecision = compute_edge_decision(
            market=tick.market,
            outcome=tick.outcome,
            your_probability=your_prob,
            market_probability=market_prob,
            threshold=threshold,
        )

        state.edges[key] = decision.edge

        # Push minimal update for dashboard/websocket.
        state.push_update(
            {
                "type": "market",
                "ts": datetime.utcnow().isoformat(),
                "market": tick.market,
                "outcome": tick.outcome,
                "market_probability": market_prob,
                "your_probability": your_prob,
                "edge": decision.edge,
                "should_trade": decision.should_trade,
                "position": state.positions.get(key, 0.0),
                "session_id": None if config is None else config.get("session_id"),
            }
        )

        if config is None:
            continue

        current_position = state.positions.get(key, 0.0)
        avg_entry = state.entry_prices.get(key)
        order_size = float(config["order_size"])
        max_position = float(config["max_position"])
        exit_threshold = float(config["exit_threshold"])
        take_profit = float(config["take_profit"])
        stop_loss = float(config["stop_loss"])
        entry_price_min = config.get("entry_price_min")
        entry_price_max = config.get("entry_price_max")
        add_price = config.get("add_price")
        add_order_size = config.get("add_order_size")
        trim_price = config.get("trim_price")
        trim_order_size = config.get("trim_order_size")
        take_profit_price = config.get("take_profit_price")
        stop_loss_price = config.get("stop_loss_price")

        order: Optional[OrderRequest] = None
        in_entry_range = True
        if entry_price_min is not None and tick.price < float(entry_price_min):
            in_entry_range = False
        if entry_price_max is not None and tick.price > float(entry_price_max):
            in_entry_range = False

        if (
            add_price is not None
            and add_order_size is not None
            and not config.get("add_executed")
            and current_position > 0
            and current_position < max_position
            and tick.price <= float(add_price)
        ):
            size = min(float(add_order_size), max_position - current_position)
            if size > 0:
                config["add_executed"] = True
                order = OrderRequest(
                    market=tick.market,
                    outcome=tick.outcome,
                    side="buy",
                    size=size,
                    limit_price=tick.price,
                    session_id=config.get("session_id"),
                    reason="price-add",
                )
        elif decision.edge > threshold and current_position < max_position and in_entry_range:
            size = min(order_size, max_position - current_position)
            if size > 0:
                order = OrderRequest(
                    market=tick.market,
                    outcome=tick.outcome,
                    side="buy",
                    size=size,
                    limit_price=tick.price,
                    session_id=config.get("session_id"),
                    reason="edge-entry",
                )
        elif current_position > 0:
            trim_hit = (
                trim_price is not None
                and trim_order_size is not None
                and not config.get("trim_executed")
                and tick.price >= float(trim_price)
            )
            profit_hit = (take_profit_price is not None and tick.price >= float(take_profit_price)) or (
                avg_entry is not None and (tick.price - avg_entry) >= take_profit
            )
            stop_hit = (stop_loss_price is not None and tick.price <= float(stop_loss_price)) or (
                avg_entry is not None and (avg_entry - tick.price) >= stop_loss
            )
            edge_exit = decision.edge <= -exit_threshold
            if trim_hit:
                config["trim_executed"] = True
                order = OrderRequest(
                    market=tick.market,
                    outcome=tick.outcome,
                    side="sell",
                    size=min(float(trim_order_size), current_position),
                    limit_price=tick.price,
                    session_id=config.get("session_id"),
                    reason="price-trim",
                )
            elif profit_hit or stop_hit or edge_exit:
                reason = "take-profit" if profit_hit else "stop-loss" if stop_hit else "edge-exit"
                order = OrderRequest(
                    market=tick.market,
                    outcome=tick.outcome,
                    side="sell",
                    size=current_position,
                    limit_price=tick.price,
                    session_id=config.get("session_id"),
                    reason=reason,
                )

        if order is not None:
            if not _account_trading_ready(state):
                blocked_key = "trading_blocked_logged"
                if not config.get(blocked_key):
                    config[blocked_key] = True
                    reason = state.account.get("error") or "Polymarket account is not trading_ready"
                    _push_system_log(
                        state,
                        level="WARN",
                        session_id=config.get("session_id"),
                        message=f"Execution blocked until account is trading_ready: {reason}",
                    )
                continue

            config.pop("trading_blocked_logged", None)
            await bus.publish(ORDER_CHANNEL, order.model_dump(mode="json"))


async def execution_worker(*, bus: Union[EventBus, InMemoryBus], state: MarketState) -> None:
    """Exec worker: receives orders, places them via the Polymarket US API."""

    async for msg in bus.subscribe(ORDER_CHANNEL):
        try:
            order = OrderRequest.model_validate(msg.data)
        except Exception:
            log.exception("Invalid order")
            continue

        try:
            from polymarket_us import AsyncPolymarketUS

            intent = "ORDER_INTENT_BUY_LONG" if order.side == "buy" else "ORDER_INTENT_SELL_LONG"
            async with AsyncPolymarketUS(
                key_id=settings.polymarket_key_id,
                secret_key=settings.polymarket_secret_key,
            ) as client:
                result = await client.orders.create({
                    "marketSlug": order.market,
                    "intent": intent,
                    "type": "ORDER_TYPE_LIMIT",
                    "price": {"value": str(round(order.limit_price, 4)), "currency": "USD"},
                    "quantity": order.size,
                    "tif": "TIME_IN_FORCE_GOOD_TILL_CANCEL",
                })

            order_id = result.get("id") if isinstance(result, dict) else None
            price_field = (result.get("price") or {}) if isinstance(result, dict) else {}
            fill_price = float(price_field.get("value", order.limit_price)) if price_field else order.limit_price
            fill_size = float(result.get("quantity", order.size)) if isinstance(result, dict) else order.size
        except Exception:
            log.exception("Order placement failed for %s %s", order.market, order.side)
            continue

        fill = TradeFill(
            market=order.market,
            outcome=order.outcome,
            side=order.side,
            size=fill_size,
            price=fill_price,
            venue="polymarket",
            order_id=order_id or str(uuid.uuid4()),
            session_id=order.session_id,
            reason=order.reason,
        )

        key = (fill.market, fill.outcome)
        current_position = state.positions.get(key, 0.0)
        signed = fill.size if fill.side == "buy" else -fill.size
        new_position = current_position + signed
        state.positions[key] = new_position

        if fill.side == "buy":
            avg_entry = state.entry_prices.get(key, 0.0)
            total_cost = (avg_entry * current_position) + (fill.price * fill.size)
            state.entry_prices[key] = total_cost / max(new_position, 1e-9)
        elif new_position <= 0:
            state.entry_prices.pop(key, None)

        fill_payload = fill.model_dump(mode="json")
        state.push_fill(fill_payload)
        state.push_update({"type": "fill", **fill_payload, "position": state.positions.get(key, 0.0)})

        session_id = order.session_id
        if session_id and session_id in state.sessions:
            session = state.sessions[session_id]
            session["last_action"] = f"{fill.side.upper()} {fill.size:.2f} @ {fill.price:.3f}"
            session["last_price"] = fill.price
            state.push_update({"type": "session", "action": "started", "session": session})

        await bus.publish(FILL_CHANNEL, fill_payload)


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
