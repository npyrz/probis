from __future__ import annotations

from ..config import Settings
from ..models import AccountSummary


def build_account_summary(settings: Settings) -> AccountSummary:
    notes = [
        "Execution defaults to paper mode until Polymarket API credentials are present.",
        "Deterministic pricing and risk rules remain on the critical path.",
    ]
    if settings.trading_ready:
        notes = [
            "Polymarket API credentials detected.",
            "Keep order execution behind explicit risk approvals.",
        ]

    return AccountSummary(
        label=settings.account_label,
        mode=settings.trading_mode,
        trading_ready=settings.trading_ready,
        api_key_configured=bool(settings.polymarket_key_id),
        paper_balance=settings.paper_cash,
        buying_power=settings.paper_cash,
        max_trade_risk_pct=settings.max_trade_risk_pct,
        max_daily_loss=settings.max_daily_loss,
        notes=notes,
    )