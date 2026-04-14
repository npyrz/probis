from __future__ import annotations

from datetime import datetime
from typing import Any
from typing import Optional

from ..config import settings
from ..models import PolymarketAccountSnapshot


def _fingerprint(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    trimmed = value.strip()
    if len(trimmed) <= 8:
        return trimmed
    return f"{trimmed[:4]}...{trimmed[-4:]}"


def _safe_str(payload: Any, *keys: str) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        val = payload.get(key)
        if val is not None:
            return str(val)
    return None


def _balances_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        balances = payload.get("balances")
        if isinstance(balances, list):
            return [item for item in balances if isinstance(item, dict)]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _currency_rank(balance: dict[str, Any]) -> tuple[int, str]:
    currency = str(balance.get("currency") or "").upper()
    if currency in {"USD", "USDC"}:
        return (0, currency)
    if currency:
        return (1, currency)
    return (2, "")


def _extract_balance_usd(payload: Any) -> Optional[str]:
    balances = _balances_list(payload)
    if not balances:
        if isinstance(payload, dict):
            return _safe_str(payload, "currentBalance", "buyingPower", "balance", "availableBalance", "available", "usdc")
        return None

    sorted_balances = sorted(balances, key=_currency_rank)
    for balance in sorted_balances:
        value = _safe_str(
            balance,
            "currentBalance",
            "buyingPower",
            "assetAvailable",
            "balance",
            "availableBalance",
            "available",
        )
        if value not in {None, ""}:
            return value
    return None


class PolymarketAccountService:
    def __init__(self) -> None:
        self._snapshot = self._disconnected_snapshot()

    def current(self) -> PolymarketAccountSnapshot:
        return self._snapshot

    def refresh(self) -> PolymarketAccountSnapshot:
        if not settings.polymarket_key_id or not settings.polymarket_secret_key:
            self._snapshot = PolymarketAccountSnapshot(
                status="disconnected",
                configured=False,
                trading_ready=False,
                error="Set POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY in backend/.env to enable trading.",
                updated_at=datetime.utcnow(),
            )
            return self._snapshot

        try:
            from polymarket_us import PolymarketUS
        except ImportError as exc:
            self._snapshot = PolymarketAccountSnapshot(
                status="error",
                configured=True,
                trading_ready=False,
                error=f"polymarket-us package not installed: {exc}",
                updated_at=datetime.utcnow(),
            )
            return self._snapshot

        try:
            client = PolymarketUS(
                key_id=settings.polymarket_key_id,
                secret_key=settings.polymarket_secret_key,
            )
            balances = client.account.balances()
            orders_resp = client.orders.list()
            positions_resp = client.portfolio.positions()
            client.close()

            balance_usd = _extract_balance_usd(balances)
            if balance_usd is None and isinstance(balances, dict):
                # Grab first numeric-looking value as fallback
                balance_usd = next(
                    (str(v) for v in balances.values() if isinstance(v, (int, float, str)) and v != ""),
                    None,
                )

            orders_list = (
                orders_resp
                if isinstance(orders_resp, list)
                else (orders_resp or {}).get("orders", [])
            )
            open_orders = len(orders_list) if isinstance(orders_list, list) else 0

            positions_list = (
                positions_resp
                if isinstance(positions_resp, list)
                else (positions_resp or {}).get("positions", [])
            )
            position_count = len(positions_list) if isinstance(positions_list, list) else 0

            self._snapshot = PolymarketAccountSnapshot(
                status="connected",
                configured=True,
                trading_ready=True,
                key_id_fingerprint=_fingerprint(settings.polymarket_key_id),
                balance_usd=balance_usd,
                open_orders=open_orders,
                position_count=position_count,
                error=None,
                updated_at=datetime.utcnow(),
            )
        except Exception as exc:
            self._snapshot = PolymarketAccountSnapshot(
                status="error",
                configured=True,
                trading_ready=False,
                error=str(exc),
                updated_at=datetime.utcnow(),
            )

        return self._snapshot

    def _disconnected_snapshot(self) -> PolymarketAccountSnapshot:
        configured = bool(settings.polymarket_key_id and settings.polymarket_secret_key)
        return PolymarketAccountSnapshot(
            status="disconnected",
            configured=configured,
            trading_ready=False,
            error=None if configured else "Set POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY in backend/.env.",
            updated_at=datetime.utcnow(),
        )

