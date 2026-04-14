from __future__ import annotations

import asyncio
import logging
import re
from typing import Any
from typing import Optional
from typing import Union

from ..bus import EventBus, InMemoryBus
from ..config import settings
from ..models import MarketDescriptor


log = logging.getLogger(__name__)

PRICE_CHANNEL = "prices"
DEFAULT_MARKET_CATEGORIES = ("sports", "politics")
SPORT_CODE_LABELS = {
    "nba": "NBA",
    "nfl": "NFL",
    "mlb": "MLB",
    "nhl": "NHL",
    "ufc": "UFC",
    "epl": "EPL",
    "mls": "MLS",
    "ucl": "UCL",
    "wta": "WTA",
    "atp": "ATP",
    "cbb": "CBB",
    "cfb": "CFB",
    "wcbb": "WCBB",
    "cs2": "CS2",
    "lol": "LoL",
    "cod": "COD",
    "ipl": "IPL",
    "lal": "LaLiga",
    "bun": "Bundesliga",
    "sea": "Serie A",
    "masters": "Masters",
    "rbcheri": "RBC Heritage",
}
PREFERRED_DESK_VIEWS = (
    "NBA",
    "MLB",
    "NHL",
    "UFC",
    "ATP",
    "WTA",
    "EPL",
    "MLS",
    "UCL",
    "NFL",
    "Politics",
)


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


def _titleize_code(value: str) -> str:
    parts = re.split(r"[^a-z0-9]+", value.lower())
    if not parts:
        return value.upper()
    acronyms = {"nba", "nfl", "mlb", "nhl", "ufc", "epl", "mls", "ucl", "wta", "atp", "ipl", "cs2", "lol", "cod", "cfb", "cbb", "wcbb"}
    formatted: list[str] = []
    for part in parts:
        if not part:
            continue
        formatted.append(part.upper() if part in acronyms else part.capitalize())
    return " ".join(formatted) if formatted else value.upper()


def _build_sport_labels(sports_payload: Any, series_payload: Any) -> dict[str, str]:
    sports = []
    if isinstance(sports_payload, dict):
        sports = sports_payload.get("sports") or []

    series = []
    if isinstance(series_payload, dict):
        series = series_payload.get("series") or []

    series_by_id = {
        str(item.get("id")): str(item.get("title"))
        for item in series
        if isinstance(item, dict) and item.get("id") and item.get("title")
    }
    series_by_slug = {
        str(item.get("slug")): str(item.get("title"))
        for item in series
        if isinstance(item, dict) and item.get("slug") and item.get("title")
    }

    labels: dict[str, str] = {}
    for item in sports:
        if not isinstance(item, dict):
            continue
        code = str(item.get("sport") or "").strip().lower()
        if not code:
            continue
        series_id = str(item.get("series") or "").strip()
        label = SPORT_CODE_LABELS.get(code) or series_by_id.get(series_id) or series_by_slug.get(code) or _titleize_code(code)
        labels[code] = label
    return labels


def _infer_market_type(slug: str, sport_labels: dict[str, str]) -> Optional[str]:
    slug_lower = slug.lower()
    parts = [part for part in re.split(r"[^a-z0-9]+", slug_lower) if part]
    part_set = set(parts)
    for code in sorted(sport_labels, key=len, reverse=True):
        if code in part_set or f"-{code}-" in f"-{slug_lower}-":
            return sport_labels[code]
    return None


def _merge_category_results(category_results: list[list[dict[str, Any]]], *, limit: int) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    index = 0
    while len(merged) < limit:
        added = False
        for results in category_results:
            if index >= len(results):
                continue
            item = results[index]
            slug = str(item.get("slug") or item.get("marketSlug") or "")
            if slug and slug not in seen:
                seen.add(slug)
                merged.append(item)
                added = True
                if len(merged) >= limit:
                    break
        if not added:
            break
        index += 1
    return merged


def _diversify_sports_markets(markets: list[dict[str, Any]], *, sport_labels: dict[str, str], limit: int) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in markets:
        slug = str(item.get("slug") or item.get("marketSlug") or "")
        label = _infer_market_type(slug, sport_labels) or "Sports"
        grouped.setdefault(label, []).append(item)

    ordered_labels = [label for label in PREFERRED_DESK_VIEWS if label in grouped]
    ordered_labels.extend(sorted(label for label in grouped if label not in set(ordered_labels)))

    diversified: list[dict[str, Any]] = []
    index = 0
    while len(diversified) < limit:
        added = False
        for label in ordered_labels:
            items = grouped[label]
            if index < len(items):
                diversified.append(items[index])
                added = True
                if len(diversified) >= limit:
                    break
        if not added:
            break
        index += 1
    return diversified


class PolymarketClient:
    async def fetch_active_markets(self, *, limit: int) -> list[MarketDescriptor]:
        from polymarket_us import PolymarketUS

        client = PolymarketUS()
        try:
            politics_limit = max(limit, 12)
            sports_limit = max(limit * 20, 500)
            category_responses = await asyncio.gather(
                asyncio.to_thread(
                    client.markets.list,
                    {
                        "limit": sports_limit,
                        "closed": False,
                        "categories": ["sports"],
                        "includeHidden": False,
                    },
                ),
                asyncio.to_thread(
                    client.markets.list,
                    {
                        "limit": politics_limit,
                        "closed": False,
                        "categories": ["politics"],
                        "includeHidden": False,
                    },
                ),
                asyncio.to_thread(client.sports.list),
                asyncio.to_thread(client.series.list, {"limit": 250}),
            )
        finally:
            client.close()

        *market_responses, sports_resp, series_resp = category_responses

        raw_category_results: dict[str, list[dict[str, Any]]] = {}
        for category, response in zip(DEFAULT_MARKET_CATEGORIES, market_responses):
            if isinstance(response, list):
                raw_category_results[category] = [item for item in response if isinstance(item, dict)]
            elif isinstance(response, dict):
                items = response.get("markets") or response.get("data") or []
                raw_category_results[category] = [item for item in items if isinstance(item, dict)]
            else:
                raw_category_results[category] = []

        sport_labels = _build_sport_labels(sports_resp, series_resp)
        diversified_sports = _diversify_sports_markets(
            raw_category_results.get("sports", []),
            sport_labels=sport_labels,
            limit=sports_limit,
        )
        raw_markets = _merge_category_results(
            [diversified_sports, raw_category_results.get("politics", [])],
            limit=limit,
        )

        markets: list[MarketDescriptor] = []
        for item in raw_markets:
            if isinstance(item, dict):
                descriptor = self._market_descriptor_from_payload(item, sport_labels=sport_labels)
                if descriptor is not None:
                    markets.append(descriptor)
        return markets

    def _market_descriptor_from_payload(self, item: dict[str, Any], *, sport_labels: dict[str, str]) -> Optional[MarketDescriptor]:
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
            market_type=_infer_market_type(str(slug), sport_labels),
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
        await markets_ws.subscribe("market-trades", "SUBSCRIPTION_TYPE_TRADE", market_slugs)

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



