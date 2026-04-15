from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from ..config import Settings
from ..models import MarketOutcome, MarketSnapshot


class MarketLookupError(RuntimeError):
    pass


def _safe_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_list(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


class PolymarketService:
    def __init__(self, settings: Settings):
        self._settings = settings

    async def lookup_market(self, url: str) -> MarketSnapshot:
        slug = self._extract_slug(url)
        if not slug:
            raise MarketLookupError("Could not extract a market slug from the provided URL")

        async with httpx.AsyncClient(base_url=self._settings.polymarket_gamma_api_base, timeout=10.0) as client:
            market_records = await self._fetch_records(client, "/markets", {"slug": slug})
            if market_records:
                return self._normalize_market(url=url, market=market_records[0], event=None)

            event_records = await self._fetch_records(client, "/events", {"slug": slug})
            if event_records:
                event = event_records[0]
                event_markets = event.get("markets") or []
                market = self._pick_event_market(event_markets)
                if market is None:
                    raise MarketLookupError("Event found, but it does not expose a tradable market snapshot")
                return self._normalize_market(url=url, market=market, event=event)

        raise MarketLookupError("No Polymarket event or market matched that URL")

    async def _fetch_records(
        self,
        client: httpx.AsyncClient,
        path: str,
        params: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        response = await client.get(path, params=params)
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        if isinstance(payload, dict):
            records = payload.get("data") or payload.get("markets") or payload.get("events") or []
            return [item for item in records if isinstance(item, dict)]
        return []

    @staticmethod
    def _pick_event_market(markets: List[Any]) -> Optional[Dict[str, Any]]:
        normalized = [item for item in markets if isinstance(item, dict)]
        for item in normalized:
            if item.get("active") and not item.get("closed"):
                return item
        return normalized[0] if normalized else None

    @staticmethod
    def _extract_slug(value: str) -> str:
        raw = value.strip()
        if not raw:
            return ""
        parsed = urlparse(raw)
        if parsed.scheme and parsed.netloc:
            segments = [segment for segment in parsed.path.split("/") if segment]
            if not segments:
                return ""
            if segments[0] in {"event", "market", "markets"} and len(segments) >= 2:
                return segments[1]
            return segments[-1]
        return raw

    def _normalize_market(
        self,
        *,
        url: str,
        market: Dict[str, Any],
        event: Optional[Dict[str, Any]],
    ) -> MarketSnapshot:
        outcome_names = _as_list(market.get("outcomes"))
        outcome_prices = _as_list(market.get("outcomePrices"))
        outcomes: List[MarketOutcome] = []
        for index, name in enumerate(outcome_names):
            price = _safe_float(outcome_prices[index] if index < len(outcome_prices) else None)
            if price is None:
                continue
            outcomes.append(MarketOutcome(name=str(name), price=price))

        if not outcomes:
            fallback_price = _safe_float(market.get("lastTradePrice")) or 0.5
            outcomes = [
                MarketOutcome(name="Yes", price=fallback_price),
                MarketOutcome(name="No", price=max(0.0, min(1.0, 1.0 - fallback_price))),
            ]

        return MarketSnapshot(
            url=url,
            title=str((event or {}).get("title") or market.get("question") or market.get("slug") or "Untitled market"),
            question=str(market.get("question") or (event or {}).get("title") or ""),
            slug=str(market.get("slug") or ""),
            event_title=None if event is None else str(event.get("title") or ""),
            event_slug=None if event is None else str(event.get("slug") or ""),
            category=str((event or {}).get("category") or market.get("category") or "General"),
            description=str(market.get("description") or (event or {}).get("description") or ""),
            liquidity=_safe_float(market.get("liquidity")),
            volume=_safe_float(market.get("volume")),
            volume_24hr=_safe_float(market.get("volume24hr")),
            end_date=str(market.get("endDate") or (event or {}).get("endDate") or "") or None,
            resolution_source=str(market.get("resolutionSource") or (event or {}).get("resolutionSource") or "") or None,
            outcomes=outcomes,
            source_status="live",
            raw_market=market,
            raw_event=event,
        )

    async def fetch_active_markets(self, *, limit: int) -> list[MarketDescriptor]:
        from polymarket_us import PolymarketUS

        client = PolymarketUS()
        try:
            discovery_limit = max(limit, 500)
            market_response, sports_resp, series_resp = await asyncio.gather(
                asyncio.to_thread(
                    client.markets.list,
                    {
                        "limit": discovery_limit,
                        "closed": False,
                        "includeHidden": False,
                    },
                ),
                asyncio.to_thread(client.sports.list),
                asyncio.to_thread(client.series.list, {"limit": 250}),
            )
        finally:
            client.close()

        if isinstance(market_response, list):
            raw_markets = [item for item in market_response if isinstance(item, dict)]
        elif isinstance(market_response, dict):
            items = market_response.get("markets") or market_response.get("data") or []
            raw_markets = [item for item in items if isinstance(item, dict)]
        else:
            raw_markets = []

        sport_labels = _build_sport_labels(sports_resp, series_resp)

        sports_markets = [item for item in raw_markets if str(item.get("category") or "").lower() == "sports"]
        non_sports_markets = [item for item in raw_markets if str(item.get("category") or "").lower() != "sports"]
        diversified_sports = _diversify_sports_markets(sports_markets, sport_labels=sport_labels, limit=limit)

        non_sports_by_category: dict[str, list[dict[str, Any]]] = {}
        for item in non_sports_markets:
            category_key = str(item.get("category") or "other").lower()
            non_sports_by_category.setdefault(category_key, []).append(item)

        preferred_non_sports = [
            non_sports_by_category.pop("politics", []),
            non_sports_by_category.pop("macro", []),
        ]
        remaining_non_sports = [non_sports_by_category[key] for key in sorted(non_sports_by_category)]
        selected_raw_markets = _interleave_market_groups(
            [group for group in [*preferred_non_sports, diversified_sports, *remaining_non_sports] if group],
            limit=limit,
        )

        deduped_markets: list[dict[str, Any]] = []
        seen_slugs: set[str] = set()
        for item in selected_raw_markets:
            slug = str(item.get("slug") or item.get("marketSlug") or "")
            if not slug or slug in seen_slugs:
                continue
            seen_slugs.add(slug)
            deduped_markets.append(item)
            if len(deduped_markets) >= limit:
                break

        markets: list[MarketDescriptor] = []
        for item in deduped_markets:
            if isinstance(item, dict):
                descriptor = self._market_descriptor_from_payload(item, sport_labels=sport_labels)
                if descriptor is not None:
                    markets.append(descriptor)
        return markets

    async def fetch_market_snapshot(self, *, slug: str) -> tuple[dict[str, Any], MarketDescriptor, dict[str, Any], dict[str, Any]]:
        from polymarket_us import PolymarketUS

        client = PolymarketUS()
        try:
            market_response, bbo_response, book_response, sports_resp, series_resp = await asyncio.gather(
                asyncio.to_thread(client.markets.retrieve_by_slug, slug),
                asyncio.to_thread(client.markets.bbo, slug),
                asyncio.to_thread(client.markets.book, slug),
                asyncio.to_thread(client.sports.list),
                asyncio.to_thread(client.series.list, {"limit": 250}),
            )
        finally:
            client.close()

        payload = market_response.get("market") if isinstance(market_response, dict) else None
        if not isinstance(payload, dict):
            raise RuntimeError(f"market slug not found: {slug}")

        sport_labels = _build_sport_labels(sports_resp, series_resp)
        descriptor = self._market_descriptor_from_payload(payload, sport_labels=sport_labels)
        if descriptor is None:
            raise RuntimeError(f"could not normalize market slug: {slug}")

        bbo_market = bbo_response.get("marketData") if isinstance(bbo_response, dict) else {}
        descriptor.best_bid = _safe_float(((bbo_market.get("bestBid") or {}).get("value") if isinstance(bbo_market.get("bestBid"), dict) else bbo_market.get("bestBid")))
        descriptor.best_ask = _safe_float(((bbo_market.get("bestAsk") or {}).get("value") if isinstance(bbo_market.get("bestAsk"), dict) else bbo_market.get("bestAsk")))
        descriptor.last_trade_price = _safe_float(((bbo_market.get("lastTradePx") or {}).get("value") if isinstance(bbo_market.get("lastTradePx"), dict) else bbo_market.get("lastTradePx")))
        descriptor.reference_price = _mid_price(descriptor.best_bid, descriptor.best_ask, descriptor.last_trade_price) or descriptor.reference_price

        return market_response, descriptor, book_response if isinstance(book_response, dict) else {}, bbo_response if isinstance(bbo_response, dict) else {}

    def _search_results_to_markets(self, payload: Any, *, limit: int) -> list[MarketDescriptor]:
        if not isinstance(payload, dict):
            return []

        events = payload.get("events") or []
        if not isinstance(events, list):
            return []

        markets: list[MarketDescriptor] = []
        seen_slugs: set[str] = set()
        sport_labels: dict[str, str] = {}
        for event in events:
            if not isinstance(event, dict):
                continue
            event_markets = event.get("markets") or []
            if not isinstance(event_markets, list):
                continue
            for item in event_markets:
                if not isinstance(item, dict):
                    continue
                slug = str(item.get("slug") or item.get("marketSlug") or "").strip()
                if not slug or slug in seen_slugs:
                    continue
                descriptor = self._market_descriptor_from_payload(item, sport_labels=sport_labels)
                if descriptor is None:
                    continue
                if not descriptor.active or descriptor.closed:
                    continue
                seen_slugs.add(slug)
                markets.append(descriptor)
                if len(markets) >= limit:
                    return markets
        return markets

    def _market_descriptor_from_payload(self, item: dict[str, Any], *, sport_labels: dict[str, str]) -> Optional[MarketDescriptor]:
        slug = item.get("slug") or item.get("marketSlug")
        if not slug:
            return None

        title = item.get("title") or item.get("question") or str(slug)
        category = item.get("category") or item.get("eventTitle") or "Polymarket US"
        outcomes = _parse_outcome_strings(item.get("outcomes"))
        outcome_prices = _parse_outcome_prices(item.get("outcomePrices"))

        best_bid = _safe_float(item.get("bestBid") or item.get("best_bid"))
        best_ask = _safe_float(item.get("bestAsk") or item.get("best_ask"))
        last_trade_price = _safe_float(item.get("lastTradePrice") or item.get("last_trade_price"))
        reference_price = _mid_price(best_bid, best_ask, last_trade_price) or 0.5

        return MarketDescriptor(
            market=str(slug),
            title=str(title),
            category=str(category),
            subtitle=item.get("subtitle"),
            description=item.get("description"),
            market_type=_infer_market_type(str(slug), sport_labels),
            outcome="Yes",
            outcomes=outcomes,
            outcome_prices=outcome_prices,
            venue="polymarket",
            reference_price=reference_price,
            active=bool(item.get("active", True)),
            closed=bool(item.get("closed", False)),
            best_bid=best_bid,
            best_ask=best_ask,
            last_trade_price=last_trade_price,
            min_tick_size=_safe_float(item.get("orderPriceMinTickSize") or item.get("order_price_min_tick_size")),
            start_date=item.get("startDate") or item.get("gameStartTime"),
            end_date=item.get("endDate") or item.get("closeDate"),
            created_at=item.get("createdAt"),
            updated_at=item.get("updatedAt"),
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

        if not settings.polymarket_key_id or not settings.polymarket_secret_key:
            raise RuntimeError("Polymarket US websocket requires POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY")

        queue: asyncio.Queue = asyncio.Queue()
        client = PolymarketUS(
            key_id=settings.polymarket_key_id,
            secret_key=settings.polymarket_secret_key,
        )
        markets_ws = client.ws.markets()
        markets_ws.on("trade", lambda d: queue.put_nowait(("trade", d)))
        markets_ws.on("market_data", lambda d: queue.put_nowait(("market_data", d)))
        markets_ws.on("error", lambda e: log.error("Polymarket US WS error: %s", e))
        markets_ws.on("close", lambda _: queue.put_nowait(("close", {})))

        await markets_ws.connect()
        log.info("Polymarket websocket connected, subscribing to %d markets", len(market_slugs))
        await markets_ws.subscribe("market-trades", "SUBSCRIPTION_TYPE_TRADE", market_slugs)
        log.info("Subscribed to market trades")

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
        log.info("Trade event: slug=%s price=%s", slug, price)
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
        log.info("Market data: slug=%s bid=%s ask=%s mid=%s", slug, best_bid, best_ask, price)
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



