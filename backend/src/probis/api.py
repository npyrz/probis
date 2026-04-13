from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, WebSocket
from fastapi.responses import ORJSONResponse

from .state import MarketState


log = logging.getLogger(__name__)


def create_app(*, state: MarketState) -> FastAPI:
    app = FastAPI(default_response_class=ORJSONResponse, title="Probis")

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

    return app
