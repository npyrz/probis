from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Optional
from typing import Union

from .bus import EventBus, InMemoryBus
from .models import MarketDescriptor, MonitorSession, PolymarketAccountSnapshot, StartMonitorRequest
from .state import MarketState


class MonitorController:
    def __init__(self, *, state: MarketState, bus: Union[EventBus, InMemoryBus], account_service: Optional[object] = None):
        self.state = state
        self.bus = bus
        self.account_service = account_service
        self._catalog: list[MarketDescriptor] = []
        self._fetched_catalog: list[MarketDescriptor] = []
        self._manual_markets: dict[str, MarketDescriptor] = {}
        self._markets_by_name: dict[str, MarketDescriptor] = {}
        self._catalog_version = 0

        if self.account_service is not None and hasattr(self.account_service, "current"):
            snapshot = self.account_service.current()
            self.state.account = snapshot.model_dump(mode="json") if isinstance(snapshot, PolymarketAccountSnapshot) else {}

    def list_markets(self) -> list[dict]:
        markets: list[dict] = []
        for market in self._catalog:
            key = (market.market, market.outcome)
            config = self.state.monitor_configs.get(key)
            markets.append(
                {
                    **market.model_dump(mode="json"),
                    "last_price": self.state.prices.get(key, market.reference_price),
                    "model_probability": self.state.model_probs.get(key, market.reference_price),
                    "edge": self.state.edges.get(key, 0.0),
                    "position": self.state.positions.get(key, 0.0),
                    "monitored": config is not None,
                    "session_id": None if config is None else config.get("session_id"),
                }
            )
        return markets

    def snapshot_terminal(self) -> dict:
        return {
            "markets": self.list_markets(),
            "sessions": list(self.state.sessions.values()),
            "fills": self.state.fills,
            "logs": self.state.logs,
            "positions": {f"{m}:{o}": s for (m, o), s in self.state.positions.items()},
            "account": self.account_snapshot(),
        }

    def account_snapshot(self) -> dict:
        return self.state.account

    async def refresh_polymarket_account(self) -> dict:
        if self.account_service is None or not hasattr(self.account_service, "refresh"):
            return self.state.account

        snapshot = await asyncio.to_thread(self.account_service.refresh)
        payload = snapshot.model_dump(mode="json") if isinstance(snapshot, PolymarketAccountSnapshot) else {}
        self.state.account = payload
        self.state.push_update({"type": "account", "account": payload})

        status = payload.get("status")
        if status == "connected":
            await self.emit_log(level="INFO", message="Polymarket account connection refreshed")
        elif payload.get("error"):
            await self.emit_log(level="WARN", message=f"Polymarket account connection failed: {payload['error']}")

        return payload

    async def emit_log(self, *, level: str, message: str, session_id: Optional[str] = None) -> None:
        payload = {
            "type": "log",
            "ts": datetime.utcnow().isoformat(),
            "session_id": session_id,
            "level": level,
            "message": message,
        }
        self.state.push_log(payload)
        self.state.push_update(payload)

    def catalog_version(self) -> int:
        return self._catalog_version

    def stream_market_slugs(self) -> list[str]:
        return [market.market for market in self._catalog]

    def market_for_slug(self, slug: str) -> Optional[MarketDescriptor]:
        return self._markets_by_name.get(slug)

    def replace_catalog(self, markets: list[MarketDescriptor]) -> None:
        self._fetched_catalog = markets
        self._rebuild_catalog()

    def add_manual_market(self, market: MarketDescriptor) -> None:
        self._manual_markets[market.market] = market
        self._rebuild_catalog()

    def _rebuild_catalog(self) -> None:
        combined: dict[str, MarketDescriptor] = {market.market: market for market in self._fetched_catalog}
        for slug, market in self._manual_markets.items():
            combined[slug] = market
        self._catalog = list(combined.values())
        self._markets_by_name = combined
        self._catalog_version += 1
        self.state.market_catalog = [market.model_dump(mode="json") for market in self._catalog]
        for market in self._catalog:
            key = (market.market, market.outcome)
            self.state.prices.setdefault(key, market.reference_price)
            self.state.model_probs.setdefault(key, market.reference_price)
            self.state.edges.setdefault(key, 0.0)
        self.state.push_update({"type": "snapshot", **self.snapshot_terminal()})

    def update_market_quote(
        self,
        *,
        market: str,
        best_bid: Optional[float],
        best_ask: Optional[float],
        last_trade_price: Optional[float],
    ) -> None:
        descriptor = self._markets_by_name.get(market)
        if descriptor is None:
            return
        descriptor.best_bid = best_bid
        descriptor.best_ask = best_ask
        descriptor.last_trade_price = last_trade_price

    def mark_market_resolved(self, market: str, winning_outcome: str) -> None:
        session_ids = [
            session_id
            for session_id, session in self.state.sessions.items()
            if session["market"] == market and session["status"] == "running"
        ]
        for session_id in session_ids:
            session = self.state.sessions[session_id]
            session["status"] = "completed"
            session["stopped_at"] = datetime.utcnow().isoformat()
            session["reason"] = f"resolved: {winning_outcome}"
            session["last_action"] = f"Resolved {winning_outcome}"
            key = (session["market"], session["outcome"])
            self.state.monitor_configs.pop(key, None)
            self.state.push_update({"type": "session", "action": "aborted", "session": session})

    def _market_title(self, market_name: str) -> str:
        descriptor = self._markets_by_name.get(market_name)
        return market_name if descriptor is None else descriptor.title

    async def start_session(self, request: StartMonitorRequest) -> dict:
        key = (request.market, request.outcome)
        if key in self.state.monitor_configs:
            raise RuntimeError("market is already being monitored")
        if request.market not in self._markets_by_name:
            raise RuntimeError("market is not available in the live Polymarket catalog")

        session_id = str(uuid.uuid4())
        session = MonitorSession(
            session_id=session_id,
            market=request.market,
            outcome=request.outcome,
            title=self._market_title(request.market),
            settings=request.settings,
        )
        session_payload = session.model_dump(mode="json")
        self.state.sessions[session_id] = session_payload
        self.state.monitor_configs[key] = {
            **request.settings.model_dump(mode="json"),
            "session_id": session_id,
        }

        self.state.push_update({"type": "session", "action": "started", "session": session_payload})
        await self.emit_log(session_id=session_id, level="INFO", message="Monitoring started")
        return session_payload

    async def abort_session(self, session_id: str, *, reason: str = "aborted by operator") -> dict:
        session = self.state.sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)

        if session.get("status") != "running":
            return session

        key = (session["market"], session["outcome"])
        self.state.monitor_configs.pop(key, None)

        session["status"] = "aborted"
        session["stopped_at"] = datetime.utcnow().isoformat()
        session["reason"] = reason
        session["last_action"] = "Aborted"

        self.state.push_update({"type": "session", "action": "aborted", "session": session})
        await self.emit_log(session_id=session_id, level="WARN", message=reason)
        return session

    async def shutdown(self) -> None:
        session_ids = list(self.state.sessions.keys())
        for session_id in session_ids:
            session = self.state.sessions.get(session_id)
            if session and session.get("status") == "running":
                await self.abort_session(session_id, reason="system shutdown")
