from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from .controller import MonitorController
from .models import StartMonitorRequest
from .state import MarketState


log = logging.getLogger(__name__)


def create_app(*, state: MarketState, controller: MonitorController) -> FastAPI:
    app = FastAPI(default_response_class=ORJSONResponse, title="Probis")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True}

    @app.get("/state")
    async def get_state() -> dict:
        # Snapshot for dashboard
        return {
            "prices": {f"{m}:{o}": p for (m, o), p in state.prices.items()},
            "model_probs": {f"{m}:{o}": p for (m, o), p in state.model_probs.items()},
            "edges": {f"{m}:{o}": e for (m, o), e in state.edges.items()},
            "positions": {f"{m}:{o}": s for (m, o), s in state.positions.items()},
        }

    @app.get("/markets")
    async def get_markets() -> dict:
        return {"markets": controller.list_markets()}

    @app.get("/terminal")
    async def get_terminal() -> dict:
        return controller.snapshot_terminal()

    @app.get("/polymarket/account")
    async def get_polymarket_account() -> dict:
        return {"account": controller.account_snapshot()}

    @app.post("/polymarket/account/refresh")
    async def refresh_polymarket_account() -> dict:
        return {"account": await controller.refresh_polymarket_account()}

    @app.get("/monitor-sessions")
    async def get_sessions() -> dict:
        return {"sessions": list(state.sessions.values())}

    @app.post("/monitor-sessions")
    async def start_session(request: StartMonitorRequest) -> dict:
        try:
            session = await controller.start_session(request)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"session": session}

    @app.post("/monitor-sessions/{session_id}/abort")
    async def abort_session(session_id: str) -> dict:
        try:
            session = await controller.abort_session(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="session not found") from exc
        return {"session": session}

    async def _iter_updates() -> AsyncIterator[dict]:
        while True:
            try:
                yield await state.updates.get()
            except asyncio.CancelledError:
                return

    @app.websocket("/ws/state")
    async def ws_state(ws: WebSocket) -> None:
        await ws.accept()
        try:
            async for update in _iter_updates():
                await ws.send_json(update)
        except Exception:
            log.info("WebSocket closed")

    @app.websocket("/ws/terminal")
    async def ws_terminal(ws: WebSocket) -> None:
        await ws.accept()
        await ws.send_json({"type": "snapshot", **controller.snapshot_terminal()})
        try:
            async for update in _iter_updates():
                await ws.send_json(update)
        except Exception:
            log.info("Terminal websocket closed")

    return app
