from __future__ import annotations

import asyncio
import math
from typing import Any
from typing import Optional

from ..config import settings
from ..models import (
    AITradeAnalysis,
    DeterministicAnalysis,
    EventContext,
    MarketAnalysisResponse,
    MarketDescriptor,
    MonitorSettings,
)
from .news import NewsService
from .ollama_client import OllamaClient
from .polymarket import PolymarketClient, _build_sport_labels, _mid_price, _safe_float


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _price_value(payload: Any, *keys: str) -> Optional[float]:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        value = payload.get(key)
        if isinstance(value, dict):
            price = _safe_float(value.get("value"))
        else:
            price = _safe_float(value)
        if price is not None:
            return price
    return None


def _float_value(payload: Any, key: str) -> Optional[float]:
    if not isinstance(payload, dict):
        return None
    return _safe_float(payload.get(key))


def _extract_event_context(market_payload: dict[str, Any]) -> list[EventContext]:
    contexts: list[EventContext] = []
    market = market_payload.get("market") if "market" in market_payload else market_payload
    if not isinstance(market, dict):
        return contexts

    market_sides = market.get("marketSides") or []
    for side in market_sides:
        if not isinstance(side, dict):
            continue
        team = side.get("team") or {}
        label = str(side.get("description") or team.get("name") or "").strip()
        if not label:
            continue
        record = str(team.get("record") or "").strip()
        league = str(team.get("league") or "").upper()
        value_parts = [part for part in [league, record] if part]
        contexts.append(EventContext(label=label, value=" / ".join(value_parts) or "participant"))

    tags = market.get("tags") or []
    if tags:
        contexts.append(EventContext(label="Tags", value=", ".join(str(tag) for tag in tags[:5])))
    return contexts


class MarketAnalysisService:
    def __init__(self, *, polymarket_client: PolymarketClient, news_service: Optional[NewsService] = None):
        self._polymarket_client = polymarket_client
        self._news_service = news_service or NewsService()
        self._ollama = OllamaClient(base_url=settings.ollama_base_url, model=settings.ollama_model)

    async def search_markets(self, *, query: str, limit: int | None = None) -> list[MarketDescriptor]:
        return await self._polymarket_client.search_markets(
            query=query,
            limit=limit or settings.polymarket_search_limit,
        )

    async def analyze_slug(self, *, slug: str, notes: Optional[str] = None) -> MarketAnalysisResponse:
        market_payload, descriptor, book_payload, bbo_payload = await self._polymarket_client.fetch_market_snapshot(slug=slug)

        news_query = self._build_news_query(descriptor)
        news_articles = await self._safe_news_query(news_query)

        deterministic = self._build_deterministic_analysis(
            descriptor=descriptor,
            book_payload=book_payload,
            bbo_payload=bbo_payload,
            news_articles=news_articles,
        )
        ai_analysis = await self._build_ai_analysis(
            descriptor=descriptor,
            deterministic=deterministic,
            event_context=_extract_event_context(market_payload),
            news_articles=news_articles,
            notes=notes,
        )
        recommended_settings = self._recommend_settings(deterministic=deterministic, ai_analysis=ai_analysis)

        return MarketAnalysisResponse(
            market=descriptor,
            event_context=_extract_event_context(market_payload),
            news=news_articles,
            deterministic=deterministic,
            ai=ai_analysis,
            recommended_settings=recommended_settings,
            trading_ready=bool(settings.polymarket_key_id and settings.polymarket_secret_key),
        )

    def _build_news_query(self, descriptor: MarketDescriptor) -> str:
        parts = [descriptor.title]
        if descriptor.market_type:
            parts.append(descriptor.market_type)
        if descriptor.category:
            parts.append(descriptor.category)
        return " ".join(part for part in parts if part)

    async def _safe_news_query(self, query: str) -> list:
        try:
            return await self._news_service.fetch_related_news(query=query)
        except Exception:
            return []

    def _build_deterministic_analysis(
        self,
        *,
        descriptor: MarketDescriptor,
        book_payload: dict[str, Any],
        bbo_payload: dict[str, Any],
        news_articles: list,
    ) -> DeterministicAnalysis:
        bbo = bbo_payload.get("marketData") if isinstance(bbo_payload, dict) else {}
        book = book_payload.get("marketData") if isinstance(book_payload, dict) else {}
        stats = book.get("stats") if isinstance(book, dict) else {}

        best_bid = _price_value(bbo, "bestBid") or descriptor.best_bid
        best_ask = _price_value(bbo, "bestAsk") or descriptor.best_ask
        last_trade_price = _price_value(bbo, "lastTradePx") or descriptor.last_trade_price
        current_price = _price_value(bbo, "currentPx") or _mid_price(best_bid, best_ask, last_trade_price) or descriptor.reference_price
        spread = None if best_bid is None or best_ask is None else max(best_ask - best_bid, 0.0)

        bid_depth = _float_value(bbo, "bidDepth")
        ask_depth = _float_value(bbo, "askDepth")
        open_interest = _float_value(stats, "openInterest") or _float_value(bbo, "openInterest")
        shares_traded = _float_value(stats, "sharesTraded") or _float_value(bbo, "sharesTraded")
        low_price = _price_value(stats, "lowPx")
        high_price = _price_value(stats, "highPx")
        volatility_range = 0.0 if low_price is None or high_price is None else max(high_price - low_price, 0.0)

        liquidity_depth = (bid_depth or 0.0) + (ask_depth or 0.0)
        liquidity_score = _clamp(((liquidity_depth / 40.0) + ((open_interest or 0.0) / 15000.0)) / 2.0, 0.0, 1.0)
        spread_penalty = 0.0 if spread is None else _clamp(spread / 0.10, 0.0, 1.0)
        volatility_penalty = _clamp(volatility_range / 0.20, 0.0, 1.0)
        news_bonus = min(len(news_articles), 5) * 0.02
        fair_probability = _clamp(current_price + (0.04 * liquidity_score) - (0.03 * spread_penalty) + news_bonus, 0.0, 1.0)
        edge = fair_probability - current_price
        risk_score = _clamp(0.45 + (0.35 * spread_penalty) + (0.20 * volatility_penalty) - (0.15 * liquidity_score), 0.0, 1.0)

        risk_flags: list[str] = []
        if spread is not None and spread >= 0.03:
            risk_flags.append("Wide spread")
        if liquidity_depth < 8:
            risk_flags.append("Thin top-of-book depth")
        if open_interest is not None and open_interest < 2500:
            risk_flags.append("Low open interest")
        if not news_articles:
            risk_flags.append("No live news context configured")

        return DeterministicAnalysis(
            market_probability=current_price,
            fair_probability=fair_probability,
            edge=edge,
            best_bid=best_bid,
            best_ask=best_ask,
            spread=spread,
            spread_bps=None if spread is None else spread * 10000.0,
            last_trade_price=last_trade_price,
            open_interest=open_interest,
            shares_traded=shares_traded,
            bid_depth=bid_depth,
            ask_depth=ask_depth,
            liquidity_score=liquidity_score,
            risk_score=risk_score,
            risk_flags=risk_flags,
        )

    async def _build_ai_analysis(
        self,
        *,
        descriptor: MarketDescriptor,
        deterministic: DeterministicAnalysis,
        event_context: list[EventContext],
        news_articles: list,
        notes: Optional[str],
    ) -> AITradeAnalysis:
        news_payload = [article.model_dump(mode="json") for article in news_articles[:5]]
        event_payload = [context.model_dump(mode="json") for context in event_context]
        payload = {
            "market": descriptor.model_dump(mode="json"),
            "deterministic": deterministic.model_dump(mode="json"),
            "event_context": event_payload,
            "news": news_payload,
            "notes": notes,
        }

        try:
            ai_payload = await self._ollama.analyze_trade(payload=payload)
        except Exception:
            ai_payload = {}

        if not ai_payload:
            return AITradeAnalysis(
                status="fallback",
                verdict="buy" if deterministic.edge > 0.03 and deterministic.risk_score < 0.55 else "watch" if deterministic.edge > 0 else "avoid",
                confidence=_clamp(0.45 + (deterministic.liquidity_score * 0.25) - (deterministic.risk_score * 0.20), 0.0, 1.0),
                estimated_probability=deterministic.fair_probability,
                summary="AI synthesis unavailable. Using deterministic market structure, liquidity, and optional news coverage as the trade memo basis.",
                thesis=[
                    f"Market implies {deterministic.market_probability:.1%} and the deterministic fair estimate is {deterministic.fair_probability:.1%}.",
                    f"Liquidity score is {deterministic.liquidity_score:.2f} with risk score {deterministic.risk_score:.2f}.",
                ],
                catalysts=[article.title for article in news_articles[:3]],
                risks=deterministic.risk_flags or ["AI synthesis unavailable"],
            )

        return AITradeAnalysis(
            status="available",
            verdict=str(ai_payload.get("verdict") or "watch") if str(ai_payload.get("verdict") or "watch") in {"buy", "watch", "avoid"} else "watch",
            confidence=_clamp(float(ai_payload.get("confidence", 0.5)), 0.0, 1.0),
            estimated_probability=None if ai_payload.get("estimated_probability") is None else _clamp(float(ai_payload.get("estimated_probability")), 0.0, 1.0),
            summary=str(ai_payload.get("summary") or ""),
            thesis=[str(item) for item in ai_payload.get("thesis", []) if str(item).strip()],
            catalysts=[str(item) for item in ai_payload.get("catalysts", []) if str(item).strip()],
            risks=[str(item) for item in ai_payload.get("risks", []) if str(item).strip()],
        )

    def _recommend_settings(self, *, deterministic: DeterministicAnalysis, ai_analysis: AITradeAnalysis) -> MonitorSettings:
        estimated_probability = ai_analysis.estimated_probability if ai_analysis.estimated_probability is not None else deterministic.fair_probability
        expected_edge = estimated_probability - deterministic.market_probability
        order_size = 1.0 if ai_analysis.confidence < 0.6 else 1.5 if ai_analysis.confidence < 0.8 else 2.0
        max_position = 2.0 if deterministic.risk_score > 0.65 else 3.0 if expected_edge < 0.08 else 4.0
        entry_min = max(deterministic.market_probability - 0.02, 0.01)
        entry_max = min(deterministic.market_probability + 0.01, 0.99)
        add_price = max(deterministic.market_probability - 0.04, 0.01)
        trim_price = min(deterministic.market_probability + 0.05, 0.99)
        take_profit_price = min(max(estimated_probability, deterministic.market_probability + 0.06), 0.99)
        stop_loss_price = max(deterministic.market_probability - max(0.04, deterministic.risk_score * 0.05), 0.01)

        return MonitorSettings(
            edge_threshold=max(0.02, min(abs(expected_edge) * 0.5, 0.12)),
            exit_threshold=0.01,
            order_size=order_size,
            max_position=max_position,
            take_profit=max(0.05, take_profit_price - deterministic.market_probability),
            stop_loss=max(0.03, deterministic.market_probability - stop_loss_price),
            entry_price_min=entry_min,
            entry_price_max=entry_max,
            add_price=add_price,
            add_order_size=max(order_size * 0.75, 0.5),
            trim_price=trim_price,
            trim_order_size=max(order_size * 0.5, 0.5),
            take_profit_price=take_profit_price,
            stop_loss_price=stop_loss_price,
            author_notes=f"AI verdict={ai_analysis.verdict}; confidence={ai_analysis.confidence:.2f}; risk={deterministic.risk_score:.2f}",
        )