from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from typing import Optional
from typing import Union

import httpx
import websockets
from websockets.client import WebSocketClientProtocol

from ..bus import EventBus, InMemoryBus
from ..config import settings
from ..models import MarketDescriptor


log = logging.getLogger(__name__)

USER_AGENT = "Probis/0.1 (+https://github.com/noah/probis)"
PRICE_CHANNEL = "prices"


def _parse_jsonish_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _safe_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _mid_price(best_bid: Optional[float], best_ask: Optional[float], last_trade: Optional[float]) -> Optional[float]:
    if best_bid is not None and best_ask is not None and best_bid > 0 and best_ask > 0:
        return (best_bid + best_ask) / 2.0
    if best_bid is not None and best_bid > 0:
        return best_bid
    if best_ask is not None and best_ask > 0:
        return best_ask
    return last_trade


class PolymarketClient:
    def __init__(self) -> None:
        self._headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        }

    async def fetch_active_markets(self, *, limit: int) -> list[MarketDescriptor]:
        params = {
            "active": "true",
            "closed": "false",
            "limit": str(limit),
            "order": "volume24hr",
            "ascending": "false",
        }
        async with httpx.AsyncClient(headers=self._headers, timeout=20.0) as client:
            response = await client.get(f"{settings.polymarket_api_url}/markets", params=params)
            response.raise_for_status()
            payload = response.json()

        markets: list[MarketDescriptor] = []
        for item in payload:
            descriptor = self._market_descriptor_from_payload(item)
            if descriptor is not None:
                markets.append(descriptor)
        return markets

    def _market_descriptor_from_payload(self, item: dict[str, Any]) -> Optional[MarketDescriptor]:
        outcomes = _parse_jsonish_list(item.get("outcomes"))
        prices = _parse_jsonish_list(item.get("outcomePrices"))
        token_ids = _parse_jsonish_list(item.get("clobTokenIds"))
        if not outcomes or not token_ids:
            return None

        normalized_outcomes = [str(outcome) for outcome in outcomes]
        yes_index = 0
        for index, outcome in enumerate(normalized_outcomes):
            if outcome.lower() == "yes":
                yes_index = index
                break

        event = (item.get("events") or [{}])[0]
        reference_price = _safe_float(prices[yes_index] if yes_index < len(prices) else None)
        best_bid = _safe_float(item.get("bestBid"))
        best_ask = _safe_float(item.get("bestAsk"))
        last_trade_price = _safe_float(item.get("lastTradePrice"))
        reference_price = _mid_price(best_bid, best_ask, last_trade_price) or reference_price or 0.5

        return MarketDescriptor(
            market=str(item.get("slug") or item.get("conditionId") or item.get("id")),
            title=str(item.get("question") or event.get("title") or "Polymarket Market"),
            category=str(event.get("title") or "Polymarket"),
            outcome=str(normalized_outcomes[yes_index]),
            venue="polymarket",
            reference_price=reference_price,
            condition_id=item.get("conditionId"),
            asset_id=str(token_ids[yes_index]) if yes_index < len(token_ids) else None,
            no_asset_id=str(token_ids[1 - yes_index]) if len(token_ids) > 1 else None,
            best_bid=best_bid,
            best_ask=best_ask,
            last_trade_price=last_trade_price,
            end_date=item.get("endDate"),
            image=item.get("image") or event.get("image"),
        )


class PolymarketMarketStream:
    def __init__(self, *, controller: Any, bus: Union[EventBus, InMemoryBus]):
        self.controller = controller
        self.bus = bus

    async def run(self) -> None:
        backoff_seconds = 2.0
        while True:
            asset_ids = self.controller.stream_asset_ids()
            version = self.controller.catalog_version()
            if not asset_ids:
                await asyncio.sleep(5.0)
                continue

            try:
                await self.controller.emit_log(level="INFO", message=f"Connecting to Polymarket market stream for {len(asset_ids)} assets")
                await self._stream(asset_ids=asset_ids, version=version)
                backoff_seconds = 2.0
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Polymarket websocket stream failed")
                await self.controller.emit_log(level="WARN", message="Polymarket stream disconnected; retrying")
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2.0, 30.0)

    async def _stream(self, *, asset_ids: list[str], version: int) -> None:
        async with websockets.connect(
            settings.polymarket_market_ws_url,
            ping_interval=None,
            open_timeout=20,
            close_timeout=5,
            user_agent_header=USER_AGENT,
        ) as socket:
            await self._subscribe(socket=socket, asset_ids=asset_ids)
            heartbeat = asyncio.create_task(self._heartbeat(socket))
            try:
                while True:
                    if self.controller.catalog_version() != version:
                        return
                    try:
                        raw = await asyncio.wait_for(socket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw == "PONG":
                        continue
                    await self._handle_message(raw)
            finally:
                heartbeat.cancel()

    async def _subscribe(self, *, socket: WebSocketClientProtocol, asset_ids: list[str]) -> None:
        await socket.send(
            json.dumps(
                {
                    "assets_ids": asset_ids,
                    "type": "market",
                    "custom_feature_enabled": True,
                }
            )
        )

    async def _heartbeat(self, socket: WebSocketClientProtocol) -> None:
        try:
            while True:
                await asyncio.sleep(10.0)
                await socket.send("PING")
        except asyncio.CancelledError:
            return

    async def _handle_message(self, raw: str) -> None:
        payload = json.loads(raw)
        events = payload if isinstance(payload, list) else [payload]
        for event in events:
            if not isinstance(event, dict):
                continue
            await self._handle_event(event)

    async def _handle_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("event_type")
        if event_type == "best_bid_ask":
            asset_id = str(event.get("asset_id") or "")
            best_bid = _safe_float(event.get("best_bid"))
            best_ask = _safe_float(event.get("best_ask"))
            price = _mid_price(best_bid, best_ask, None)
            if price is None:
                return
            descriptor = self.controller.market_for_asset(asset_id)
            if descriptor is None:
                return
            self.controller.update_market_quote(
                market=descriptor.market,
                best_bid=best_bid,
                best_ask=best_ask,
                last_trade_price=descriptor.last_trade_price,
            )
            await self.bus.publish(
                PRICE_CHANNEL,
                {
                    "source": "polymarket",
                    "market": descriptor.market,
                    "outcome": descriptor.outcome,
                    "price": price,
                },
            )
            return

        if event_type == "last_trade_price":
            asset_id = str(event.get("asset_id") or "")
            price = _safe_float(event.get("price"))
            if price is None:
                return
            descriptor = self.controller.market_for_asset(asset_id)
            if descriptor is None:
                return
            self.controller.update_market_quote(
                market=descriptor.market,
                best_bid=descriptor.best_bid,
                best_ask=descriptor.best_ask,
                last_trade_price=price,
            )
            await self.bus.publish(
                PRICE_CHANNEL,
                {
                    "source": "polymarket",
                    "market": descriptor.market,
                    "outcome": descriptor.outcome,
                    "price": price,
                },
            )
            return

        if event_type == "market_resolved":
            market_slug = event.get("slug")
            if market_slug:
                self.controller.mark_market_resolved(str(market_slug), str(event.get("winning_outcome") or "resolved"))


async def catalog_refresh_worker(*, client: PolymarketClient, controller: Any) -> None:
    while True:
        try:
            markets = await client.fetch_active_markets(limit=settings.polymarket_market_limit)
            controller.replace_catalog(markets)
            await controller.emit_log(
                level="INFO",
                message=f"Polymarket catalog synced: {len(markets)} active markets",
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Failed to refresh Polymarket catalog")
            await controller.emit_log(level="WARN", message="Polymarket catalog refresh failed")

        await asyncio.sleep(settings.polymarket_discovery_interval_seconds)
