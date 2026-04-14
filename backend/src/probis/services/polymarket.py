from __future__ import annotations

import asyncio
import logging
from typing import Any
from typing import Optional
from typing import Union

from ..bus import EventBus, InMemoryBus
from ..config import settings
from ..models import MarketDescriptor


log = logging.getLogger(__name__)

PRICE_CHANNEL = "prices"


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
    async def fetch_active_markets(self, *, limit: int) -> list[MarketDescriptor]:
        from polymarket_us import PolymarketUS

        client = PolymarketUS()
        try:
            resp = await asyncio.to_thread(
                client.markets.list,
                {"limit": limit, "active": True, "closed": False},
            )
        finally:
            client.close()

        raw_markets: list[Any] = []
        if isinstance(resp, list):
            raw_markets = resp
        elif isinstance(resp, dict):
            raw_markets = resp.get("markets") or resp.get("data") or []

        markets: list[MarketDescriptor] = []
        for item in raw_markets:
            if isinstance(item, dict):
                descriptor = self._market_descriptor_from_payload(item)
                if descriptor is not None:
                    markets.append(descriptor)
        return markets

    def _market_descriptor_from_payload(self, item: dict[str, Any]) -> Optional[MarketDescriptor]:
        slug = item.get("slug") or item.get("marketSlug")
        if not slug:
            return None

        title = item.get("title") or item.get("question") or str(slug)
        category = item.get("category") or item.get("eventTitle") or "Polymarket US"

        best_bid = _safe_float(item.get("bestBid") or item.get("best_bid"))
        best_ask = _safe_float(item.get("bestAsk") or item.get("best_ask"))
        last_trade_price = _safe_float(item.get("lastTradePrice") or item.get("last_trade_price"))
        reference_price = _mid_price(best_bid, best_ask, last_trade_price) or 0.5

        return MarketDescriptor(
            market=str(slug),
            title=str(title),
            category=str(category),
            outcome="Yes",
            venue="polymarket",
            reference_price=reference_price,
            best_bid=best_bid,
            best_ask=best_ask,
            last_trade_price=last_trade_price,
            end_date=item.get("endDate") or item.get("closeDate"),
            image=item.get("imageUrl") or item.get("image"),
        )


class PolymarketMarketStream:
    def __init__(self, *, controller: Any, bus: Union[EventBus, InMemoryBus]):
        self.controller = controller
        self.bus = bus

    async def run(self) -> None:
        backoff_seconds = 2.0
        while True:
            market_slugs = self.controller.stream_market_slugs()
            version = self.controller.catalog_version()
            if not market_slugs:
                await asyncio.sleep(5.0)
                continue

            try:
                await self.controller.emit_log(
                    level="INFO",
                    message=f"Connecting to Polymarket US market stream for {len(market_slugs)} markets",
                )
                await self._stream(market_slugs=market_slugs, version=version)
                backoff_seconds = 2.0
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Polymarket US websocket stream failed")
                await self.controller.emit_log(level="WARN", message="Polymarket US stream disconnected; retrying")
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2.0, 30.0)

    async def _stream(self, *, market_slugs: list[str], version: int) -> None:
        from polymarket_us import PolymarketUS

        queue: asyncio.Queue = asyncio.Queue()
        client = PolymarketUS()
        markets_ws = client.ws.markets()
        markets_ws.on("trade", lambda d: queue.put_nowait(("trade", d)))
        markets_ws.on("market_data", lambda d: queue.put_nowait(("market_data", d)))
        markets_ws.on("error", lambda e: log.error("Polymarket US WS error: %s", e))
        markets_ws.on("close", lambda _: queue.put_nowait(("close", {})))

        await markets_ws.connect()
        for i, slug in enumerate(market_slugs):
            await markets_ws.subscribe(f"trade-{i}", "SUBSCRIPTION_TYPE_TRADE", [slug])

        try:
            while True:
                if self.controller.catalog_version() != version:
                    return
                try:
                    event_type, data = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                if event_type == "close":
                    raise ConnectionError("WebSocket closed by server")
                elif event_type == "trade":
                    await self._handle_trade(data)
                elif event_type == "market_data":
                    await self._handle_market_data(data)
        finally:
            try:
                await markets_ws.close()
            except Exception:
                pass
            client.close()

    async def _handle_trade(self, data: Any) -> None:
        trade = data.get("trade") if isinstance(data, dict) else data
        if not isinstance(trade, dict):
            return
        slug = trade.get("marketSlug") or trade.get("slug") or trade.get("market")
        price = _safe_float(trade.get("price") or trade.get("lastPrice"))
        if not slug or price is None:
            return
        descriptor = self.controller.market_for_slug(str(slug))
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

    async def _handle_market_data(self, data: Any) -> None:
        book = data.get("marketData") if isinstance(data, dict) else data
        if not isinstance(book, dict):
            return
        slug = book.get("marketSlug") or book.get("slug") or book.get("market")
        if not slug:
            return
        bids = book.get("bids") or []
        asks = book.get("asks") or []
        best_bid = _safe_float(bids[0].get("price") if bids else None)
        best_ask = _safe_float(asks[0].get("price") if asks else None)
        price = _mid_price(best_bid, best_ask, None)
        descriptor = self.controller.market_for_slug(str(slug))
        if descriptor is None:
            return
        self.controller.update_market_quote(
            market=descriptor.market,
            best_bid=best_bid,
            best_ask=best_ask,
            last_trade_price=descriptor.last_trade_price,
        )
        if price is not None:
            await self.bus.publish(
                PRICE_CHANNEL,
                {
                    "source": "polymarket",
                    "market": descriptor.market,
                    "outcome": descriptor.outcome,
                    "price": price,
                },
            )


async def catalog_refresh_worker(*, client: PolymarketClient, controller: Any) -> None:
    while True:
        try:
            markets = await client.fetch_active_markets(limit=settings.polymarket_market_limit)
            controller.replace_catalog(markets)
            await controller.emit_log(
                level="INFO",
                message=f"Polymarket US catalog synced: {len(markets)} active markets",
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Failed to refresh Polymarket US catalog")
            await controller.emit_log(level="WARN", message="Polymarket US catalog refresh failed")

        await asyncio.sleep(settings.polymarket_discovery_interval_seconds)



