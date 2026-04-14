from __future__ import annotations

from datetime import datetime
from typing import Any
from typing import Optional

from ..config import settings
from ..models import PolymarketAccountSnapshot


try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import ApiCreds
    from py_clob_client.clob_types import AssetType
    from py_clob_client.clob_types import BalanceAllowanceParams
except Exception as exc:  # pragma: no cover - depends on local Python/runtime
    ClobClient = None
    ApiCreds = None
    AssetType = None
    BalanceAllowanceParams = None
    _IMPORT_ERROR: Optional[Exception] = exc
else:  # pragma: no cover - trivial branch
    _IMPORT_ERROR = None


SIGNATURE_TYPE_LABELS = {
    0: "EOA",
    1: "POLY_PROXY",
    2: "GNOSIS_SAFE",
}


def _fingerprint(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    trimmed = value.strip()
    if len(trimmed) <= 8:
        return trimmed
    return f"{trimmed[:4]}...{trimmed[-4:]}"


def _extract_value(payload: Any, *keys: str) -> Optional[str]:
    if not isinstance(payload, dict):
        return None

    lowered = {str(key).lower(): value for key, value in payload.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is not None:
            return str(value)

    data = payload.get("data")
    if isinstance(data, dict):
        return _extract_value(data, *keys)
    return None


def _extract_bool(payload: Any, *keys: str) -> Optional[bool]:
    raw = _extract_value(payload, *keys)
    if raw is None:
        return None
    normalized = raw.strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    return None


def _is_positive_number(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    try:
        return float(value) > 0.0
    except (TypeError, ValueError):
        return None


class PolymarketAccountService:
    def __init__(self) -> None:
        self._snapshot = self._build_unchecked_snapshot()

    def current(self) -> PolymarketAccountSnapshot:
        return self._snapshot

    def refresh(self) -> PolymarketAccountSnapshot:
        if not settings.polymarket_private_key:
            self._snapshot = self._build_snapshot(
                status="disconnected",
                configured=False,
                trading_ready=False,
                error="Set POLYMARKET_PRIVATE_KEY in backend/.env to enable authenticated CLOB access.",
            )
            return self._snapshot

        if ClobClient is None or ApiCreds is None or AssetType is None or BalanceAllowanceParams is None:
            detail = str(_IMPORT_ERROR) if _IMPORT_ERROR is not None else "py-clob-client is unavailable"
            self._snapshot = self._build_snapshot(
                status="unsupported",
                configured=True,
                trading_ready=False,
                error=(
                    "The official Polymarket Python client is unavailable in this runtime. "
                    f"{detail}. Upgrade the backend interpreter to Python 3.9.10+ and reinstall dependencies."
                ),
            )
            return self._snapshot

        try:
            client = self._build_client()
            collateral = client.get_balance_allowance(
                params=BalanceAllowanceParams(asset_type=AssetType.COLLATERAL)
            )
            open_orders = client.get_orders()
            closed_only = client.get_closed_only_mode()

            collateral_balance = _extract_value(collateral, "balance", "available", "available_balance")
            collateral_allowance = _extract_value(collateral, "allowance", "approved", "approved_amount")
            closed_only_mode = _extract_bool(closed_only, "closedonly", "closed_only", "isclosedonly")

            positive_allowance = _is_positive_number(collateral_allowance)
            trading_ready = closed_only_mode is not True and positive_allowance is not False

            self._snapshot = self._build_snapshot(
                status="connected",
                configured=True,
                trading_ready=trading_ready,
                address=client.get_address(),
                funder_address=settings.polymarket_funder_address or client.get_address(),
                api_key_present=client.creds is not None,
                api_key_fingerprint=_fingerprint(getattr(client.creds, "api_key", None)),
                collateral_balance=collateral_balance,
                collateral_allowance=collateral_allowance,
                open_orders=len(open_orders) if isinstance(open_orders, list) else 0,
                closed_only_mode=closed_only_mode,
                error=None,
            )
        except Exception as exc:
            self._snapshot = self._build_snapshot(
                status="error",
                configured=True,
                trading_ready=False,
                error=str(exc),
            )
        return self._snapshot

    def _build_client(self) -> Any:
        client = ClobClient(
            settings.polymarket_clob_url,
            chain_id=settings.polymarket_chain_id,
            key=settings.polymarket_private_key,
            signature_type=settings.polymarket_signature_type,
            funder=settings.polymarket_funder_address,
            creds=self._env_api_creds(),
        )
        if client.creds is None:
            client.set_api_creds(client.create_or_derive_api_creds())
        return client

    def _env_api_creds(self) -> Optional[Any]:
        values = (
            settings.polymarket_clob_api_key,
            settings.polymarket_clob_secret,
            settings.polymarket_clob_passphrase,
        )
        if not all(values):
            return None
        return ApiCreds(
            api_key=settings.polymarket_clob_api_key,
            api_secret=settings.polymarket_clob_secret,
            api_passphrase=settings.polymarket_clob_passphrase,
        )

    def _build_unchecked_snapshot(self) -> PolymarketAccountSnapshot:
        configured = bool(settings.polymarket_private_key)
        status = "disconnected" if not configured else "unsupported" if ClobClient is None else "disconnected"
        error: Optional[str] = None
        if not configured:
            error = "Polymarket account credentials are not configured yet."
        elif ClobClient is None:
            error = "The Polymarket account client is unavailable until Python 3.9.10+ is used."
        return self._build_snapshot(
            status=status,
            configured=configured,
            trading_ready=False,
            error=error,
        )

    def _build_snapshot(
        self,
        *,
        status: str,
        configured: bool,
        trading_ready: bool,
        error: Optional[str],
        address: Optional[str] = None,
        funder_address: Optional[str] = None,
        api_key_present: bool = False,
        api_key_fingerprint: Optional[str] = None,
        collateral_balance: Optional[str] = None,
        collateral_allowance: Optional[str] = None,
        open_orders: int = 0,
        closed_only_mode: Optional[bool] = None,
    ) -> PolymarketAccountSnapshot:
        return PolymarketAccountSnapshot(
            status=status,
            configured=configured,
            trading_ready=trading_ready,
            address=address,
            funder_address=funder_address,
            signature_type=settings.polymarket_signature_type,
            signature_type_label=SIGNATURE_TYPE_LABELS.get(settings.polymarket_signature_type, "UNKNOWN"),
            chain_id=settings.polymarket_chain_id,
            host=settings.polymarket_clob_url,
            api_key_present=api_key_present,
            api_key_fingerprint=api_key_fingerprint,
            collateral_balance=collateral_balance,
            collateral_allowance=collateral_allowance,
            open_orders=open_orders,
            closed_only_mode=closed_only_mode,
            error=error,
            updated_at=datetime.utcnow(),
        )