from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from typing import Optional

import orjson
import redis.asyncio as redis


log = logging.getLogger(__name__)


def _dumps(obj: Any) -> bytes:
    return orjson.dumps(obj)


def _loads(data: bytes) -> Any:
    return orjson.loads(data)


@dataclass(frozen=True)
class BusMessage:
    channel: str
    data: dict[str, Any]


class EventBus:
    """Redis pub/sub bus.

    Notes:
    - This is used for decoupling ingestion/processing/execution workers.
    - Hot path should keep messages small and avoid expensive transforms.
    """

    def __init__(self, redis_url: str):
        self._redis_url = redis_url
        self._redis: Optional[redis.Redis] = None

    async def connect(self) -> None:
        if self._redis is not None:
            return
        self._redis = redis.from_url(self._redis_url, decode_responses=False)
        await self._redis.ping()

    async def close(self) -> None:
        if self._redis is None:
            return
        await self._redis.aclose()
        self._redis = None

    async def publish(self, channel: str, data: dict[str, Any]) -> None:
        if self._redis is None:
            raise RuntimeError("EventBus not connected")
        await self._redis.publish(channel, _dumps(data))

    async def subscribe(self, channel: str) -> AsyncIterator[BusMessage]:
        if self._redis is None:
            raise RuntimeError("EventBus not connected")

        pubsub = self._redis.pubsub()
        await pubsub.subscribe(channel)
        try:
            while True:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg is None:
                    await asyncio.sleep(0)
                    continue
                if msg.get("type") != "message":
                    continue
                raw: bytes = msg["data"]
                try:
                    payload = _loads(raw)
                except Exception:
                    log.exception("Failed to decode message on %s", channel)
                    continue
                if not isinstance(payload, dict):
                    continue
                yield BusMessage(channel=channel, data=payload)
        finally:
            try:
                await pubsub.unsubscribe(channel)
            finally:
                await pubsub.aclose()


class InMemoryBus:
    """Fallback bus when Redis isn't available (single-process only)."""

    def __init__(self):
        self._channels: dict[str, list[asyncio.Queue[dict[str, Any]]]] = {}

    async def connect(self) -> None:  # noqa: D401
        return

    async def close(self) -> None:
        self._channels.clear()

    async def publish(self, channel: str, data: dict[str, Any]) -> None:
        for q in list(self._channels.get(channel, [])):
            q.put_nowait(data)

    async def subscribe(self, channel: str) -> AsyncIterator[BusMessage]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10_000)
        self._channels.setdefault(channel, []).append(q)
        try:
            while True:
                payload = await q.get()
                yield BusMessage(channel=channel, data=payload)
        finally:
            self._channels.get(channel, []).remove(q)
