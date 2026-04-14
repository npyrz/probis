from __future__ import annotations

import asyncio
import logging

from typing import Union

import uvicorn

from .api import create_app
from .bus import EventBus, InMemoryBus
from .config import settings
from .controller import MonitorController
from .logging import configure_logging
from .services.analysis import MarketAnalysisService
from .services.news import NewsService
from .services.polymarket_account import PolymarketAccountService
from .services.polymarket import PolymarketClient, PolymarketMarketStream, catalog_refresh_worker
from .state import MarketState
from .workers import execution_worker, processing_worker, llm_worker


log = logging.getLogger(__name__)


async def _connect_bus() -> Union[EventBus, InMemoryBus]:
    bus = EventBus(settings.redis_url)
    try:
        await bus.connect()
        return bus
    except Exception:
        log.warning("Redis unavailable; falling back to in-memory bus")
        mem = InMemoryBus()
        await mem.connect()
        return mem


async def _run() -> None:
    configure_logging(settings.log_level)

    state = MarketState()
    bus = await _connect_bus()
    account_service = PolymarketAccountService()
    controller = MonitorController(state=state, bus=bus, account_service=account_service)
    polymarket_client = PolymarketClient()
    analysis_service = MarketAnalysisService(polymarket_client=polymarket_client, news_service=NewsService())

    try:
        markets = await polymarket_client.fetch_active_markets(limit=settings.polymarket_market_limit)
        controller.replace_catalog(markets)
        await controller.emit_log(level="INFO", message=f"Loaded {len(markets)} Polymarket markets")
    except Exception:
        log.exception("Failed to load initial Polymarket catalog")
        await controller.emit_log(level="WARN", message="Failed to load initial Polymarket catalog")

    if settings.polymarket_key_id:
        await controller.refresh_polymarket_account()

    app = create_app(state=state, controller=controller, analysis_service=analysis_service)

    # Workers
    tasks = [
        asyncio.create_task(catalog_refresh_worker(client=polymarket_client, controller=controller)),
        asyncio.create_task(PolymarketMarketStream(controller=controller, bus=bus).run()),
        asyncio.create_task(processing_worker(bus=bus, state=state)),
        asyncio.create_task(execution_worker(bus=bus, state=state)),
        asyncio.create_task(llm_worker(bus=bus)),
    ]

    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="warning")
    server = uvicorn.Server(config)
    tasks.append(asyncio.create_task(server.serve()))

    try:
        await asyncio.gather(*tasks)
    finally:
        for t in tasks:
            t.cancel()
        await controller.shutdown()
        await bus.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
