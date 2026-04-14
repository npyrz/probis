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
    controller = MonitorController(state=state, bus=bus)

    app = create_app(state=state, controller=controller)

    # Workers
    tasks = [
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
