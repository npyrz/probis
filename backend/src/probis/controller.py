from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Optional
from typing import Union

from .bus import EventBus, InMemoryBus
from .models import MarketDescriptor, MonitorSession, StartMonitorRequest
from .services.sim_feed import sim_price_ticks
from .state import MarketState


PRICE_CHANNEL = "prices"


class MonitorController:
    def __init__(self, *, state: MarketState, bus: Union[EventBus, InMemoryBus]):
        self.state = state
        self.bus = bus
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._catalog = [
            MarketDescriptor(
                market="election-2028",
                title="US Election 2028 - Democrat Wins",
                category="Politics",
                reference_price=0.53,
            ),
            MarketDescriptor(
                market="fed-cut-sep",
                title="Fed Cuts Rates By September",
                category="Macro",
                reference_price=0.41,
            ),
            MarketDescriptor(
                market="eth-5k-2026",
                title="ETH Above 5,000 Before 2026 End",
                category="Crypto",
                reference_price=0.38,
            ),
            MarketDescriptor(
                market="ai-act-2026",
                title="US AI Safety Act Signed In 2026",
                category="Policy",
                reference_price=0.46,
            ),
        ]
        self.state.market_catalog = [market.model_dump(mode="json") for market in self._catalog]
        for market in self._catalog:
            key = (market.market, market.outcome)
            self.state.prices.setdefault(key, market.reference_price)
            self.state.model_probs.setdefault(key, market.reference_price)
            self.state.edges.setdefault(key, 0.0)

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
        }

    async def _log(self, *, session_id: Optional[str], level: str, message: str) -> None:
        payload = {
            "type": "log",
            "ts": datetime.utcnow().isoformat(),
            "session_id": session_id,
            "level": level,
            "message": message,
        }
        self.state.push_log(payload)
        self.state.push_update(payload)

    def _market_title(self, market_name: str) -> str:
        for market in self._catalog:
            if market.market == market_name:
                return market.title
        return market_name

    async def start_session(self, request: StartMonitorRequest) -> dict:
        key = (request.market, request.outcome)
        if key in self.state.monitor_configs:
            raise RuntimeError("market is already being monitored")

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

        self._tasks[session_id] = asyncio.create_task(
            self._run_session_feed(session_id=session_id, market=request.market, outcome=request.outcome)
        )

        self.state.push_update({"type": "session", "action": "started", "session": session_payload})
        await self._log(session_id=session_id, level="INFO", message="Monitoring started")
        return session_payload

    async def abort_session(self, session_id: str, *, reason: str = "aborted by operator") -> dict:
        session = self.state.sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)

        if session.get("status") != "running":
            return session

        task = self._tasks.pop(session_id, None)
        if task is not None:
            task.cancel()

        key = (session["market"], session["outcome"])
        self.state.monitor_configs.pop(key, None)

        session["status"] = "aborted"
        session["stopped_at"] = datetime.utcnow().isoformat()
        session["reason"] = reason
        session["last_action"] = "Aborted"

        self.state.push_update({"type": "session", "action": "aborted", "session": session})
        await self._log(session_id=session_id, level="WARN", message=reason)
        return session

    async def shutdown(self) -> None:
        session_ids = list(self._tasks.keys())
        for session_id in session_ids:
            await self.abort_session(session_id, reason="system shutdown")

    async def _run_session_feed(self, *, session_id: str, market: str, outcome: str) -> None:
        try:
            async for tick in sim_price_ticks(market=market, outcome=outcome):
                await self.bus.publish(PRICE_CHANNEL, tick)
        except asyncio.CancelledError:
            return
