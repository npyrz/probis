from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from ..config import Settings
from ..models import AISynthesis, AccountSummary, AnalyzeResponse, ExternalSignal, MarketSnapshot, TradePlan


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


class AnalysisService:
    def __init__(self, settings: Settings):
        self._settings = settings

    def build_report(
        self,
        *,
        url: str,
        market: MarketSnapshot,
        account: AccountSummary,
    ) -> AnalyzeResponse:
        signals = self._build_signals(market)
        trade_plan = self._build_trade_plan(market, signals, account)
        synthesis = self._build_synthesis(market, trade_plan, signals)

        return AnalyzeResponse(
            generated_at=datetime.now(timezone.utc),
            account=account,
            market=market.model_copy(update={"url": url}),
            external_signals=signals,
            ai_synthesis=synthesis,
            trade_plan=trade_plan,
            source_notes=[
                "Market metadata comes from the public Polymarket Gamma API.",
                "Trade output is deterministic and designed as a starting framework, not live execution advice.",
                "AI synthesis is isolated from the pricing path and currently uses a local template engine.",
            ],
        )

    def _build_signals(self, market: MarketSnapshot) -> List[ExternalSignal]:
        yes_price = self._yes_price(market)
        turnover_ratio = self._turnover_ratio(market)
        days_to_close = self._days_to_close(market.end_date)
        signals: List[ExternalSignal] = []

        if yes_price is not None:
            balance_score = 1.0 - min(abs(yes_price - 0.5) * 2.0, 1.0)
            direction = "neutral" if 0.35 <= yes_price <= 0.65 else "positive"
            detail = (
                f"YES is trading at {yes_price:.1%}. Near-even pricing means the market is unresolved; "
                if direction == "neutral"
                else f"YES is trading at {yes_price:.1%}, which shows a clear market favorite. "
            )
            detail += "That changes whether momentum or mean-reversion rules should dominate."
            signals.append(
                ExternalSignal(
                    label="Consensus price",
                    direction=direction,
                    score=round(balance_score, 2),
                    detail=detail,
                )
            )

        if turnover_ratio is not None:
            if turnover_ratio >= 1.0:
                direction = "positive"
                detail = "24h volume is strong relative to posted liquidity, so the tape likely reflects current information."
            elif turnover_ratio >= 0.25:
                direction = "neutral"
                detail = "Volume is respectable but not dominant relative to liquidity. Price discovery is usable but not complete."
            else:
                direction = "risk"
                detail = "The market is thin relative to liquidity, which increases slippage and stale-price risk."
            signals.append(
                ExternalSignal(
                    label="Flow quality",
                    direction=direction,
                    score=round(_clamp(turnover_ratio / 1.5, 0.0, 1.0), 2),
                    detail=detail,
                )
            )

        if days_to_close is not None:
            if days_to_close <= 3:
                direction = "positive"
                detail = "The market resolves soon, so prevailing consensus should carry more weight than far-dated optionality."
                score = 0.85
            elif days_to_close <= 30:
                direction = "neutral"
                detail = "The event horizon is mid-range, which supports measured sizing but not aggressive conviction."
                score = 0.55
            else:
                direction = "risk"
                detail = "The event is far from resolution, so headline drift can overwhelm current pricing signals."
                score = 0.35
            signals.append(
                ExternalSignal(
                    label="Time to resolution",
                    direction=direction,
                    score=score,
                    detail=detail,
                )
            )

        category = (market.category or "Unknown").strip()
        signals.append(
            ExternalSignal(
                label="External event lens",
                direction="neutral",
                score=0.5,
                detail=(
                    f"{category} events should be paired with outside context before automation. "
                    "Use this panel as the handoff point for news, models, or LLM evidence."
                ),
            )
        )
        return signals

    def _build_trade_plan(
        self,
        market: MarketSnapshot,
        signals: List[ExternalSignal],
        account: AccountSummary,
    ) -> TradePlan:
        yes_price = self._yes_price(market)
        no_price = self._no_price(market)
        if yes_price is None:
            yes_price = market.outcomes[0].price if market.outcomes else 0.5
        if no_price is None:
            no_price = 1.0 - yes_price

        days_to_close = self._days_to_close(market.end_date)
        turnover_ratio = self._turnover_ratio(market)
        favored_side = 1.0 if yes_price >= 0.5 else -1.0

        if days_to_close is None:
            time_bias = -0.025
        elif days_to_close <= 3:
            time_bias = 0.06
        elif days_to_close <= 14:
            time_bias = 0.03
        elif days_to_close <= 45:
            time_bias = 0.01
        else:
            time_bias = -0.025

        flow_bias = 0.015 if turnover_ratio is not None and turnover_ratio >= 1.0 else 0.0
        thin_market_penalty = -0.015 if turnover_ratio is not None and turnover_ratio < 0.2 else 0.0

        fair_yes = _clamp(yes_price + (favored_side * (time_bias + flow_bias + thin_market_penalty)), 0.03, 0.97)
        yes_edge = fair_yes - yes_price
        no_edge = (1.0 - fair_yes) - no_price

        if yes_edge >= no_edge and yes_edge > self._settings.edge_threshold:
            action = "buy_yes"
            target_outcome = "YES"
            edge = yes_edge
            market_probability = yes_price
            model_probability = fair_yes
        elif no_edge > yes_edge and no_edge > self._settings.edge_threshold:
            action = "buy_no"
            target_outcome = "NO"
            edge = no_edge
            market_probability = no_price
            model_probability = 1.0 - fair_yes
        else:
            action = "wait"
            target_outcome = "WATCH"
            edge = max(yes_edge, no_edge)
            market_probability = yes_price
            model_probability = fair_yes

        conviction = _clamp((abs(edge) / max(self._settings.edge_threshold, 0.01)) * 0.45 + 0.35, 0.0, 0.98)
        risk_flags = [signal.label for signal in signals if signal.direction == "risk"]
        stake_pct = min(account.max_trade_risk_pct * max(conviction, 0.4), account.max_trade_risk_pct)

        rationale = [
            f"Market probability is {market_probability:.1%}; the deterministic model marks {model_probability:.1%} for the target side.",
            "Sizing assumes small clips and explicit invalidation rather than all-in directional exposure.",
        ]
        if days_to_close is not None:
            rationale.append(f"The event resolves in roughly {days_to_close:.1f} days, which directly affects persistence versus mean-reversion assumptions.")
        if turnover_ratio is not None:
            rationale.append(f"Turnover-to-liquidity ratio is {turnover_ratio:.2f}, which informs how much trust to place in the tape.")

        return TradePlan(
            action=action,
            target_outcome=target_outcome,
            market_probability=round(market_probability, 4),
            model_probability=round(model_probability, 4),
            edge_pct=round(edge, 4),
            conviction=round(conviction, 2),
            entry_window=(
                "Scale in over 2-3 clips near the current quote and avoid chasing through rapid repricing."
                if action != "wait"
                else "No entry. Wait for fresh information or a wider dislocation."
            ),
            sizing=f"Risk up to {stake_pct:.1%} of available book on the initial probe.",
            invalidation=(
                "Exit if the tape moves 4-6 points against the thesis without confirming external data."
                if action != "wait"
                else "Invalidate the setup if external evidence never improves beyond current market consensus."
            ),
            rationale=rationale,
            risk_flags=risk_flags or ["No structural red flags detected from the current public snapshot."],
        )

    def _build_synthesis(
        self,
        market: MarketSnapshot,
        trade_plan: TradePlan,
        signals: List[ExternalSignal],
    ) -> AISynthesis:
        direction_map = {
            "buy_yes": "The current framework leans into the YES side because short-horizon persistence and current tape quality support it.",
            "buy_no": "The current framework leans into the NO side because the quoted favorite looks rich relative to the time and liquidity regime.",
            "wait": "The current framework does not see a clean enough dislocation to justify a trade yet.",
        }

        drivers = [signal.detail for signal in signals if signal.direction != "risk"]
        caveats = [signal.detail for signal in signals if signal.direction == "risk"]
        if not caveats:
            caveats.append("The next layer to add is real external event evidence or an LLM synthesis feed connected to this same output contract.")

        return AISynthesis(
            mode=self._settings.ai_mode,
            summary=(
                f"{direction_map[trade_plan.action]} "
                f"{market.title} currently screens as a {trade_plan.action.replace('_', ' ')} setup with {trade_plan.conviction:.0%} conviction."
            ),
            drivers=drivers[:4],
            caveats=caveats[:4],
        )

    @staticmethod
    def _yes_price(market: MarketSnapshot) -> Optional[float]:
        for outcome in market.outcomes:
            if outcome.name.strip().lower() == "yes":
                return outcome.price
        return market.outcomes[0].price if market.outcomes else None

    @staticmethod
    def _no_price(market: MarketSnapshot) -> Optional[float]:
        for outcome in market.outcomes:
            if outcome.name.strip().lower() == "no":
                return outcome.price
        return market.outcomes[1].price if len(market.outcomes) > 1 else None

    @staticmethod
    def _turnover_ratio(market: MarketSnapshot) -> Optional[float]:
        if market.volume_24hr is None or market.liquidity in (None, 0):
            return None
        return market.volume_24hr / market.liquidity

    @staticmethod
    def _days_to_close(end_date: Optional[str]) -> Optional[float]:
        if not end_date:
            return None
        try:
            parsed = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        except ValueError:
            return None
        delta = parsed - datetime.now(timezone.utc)
        return max(delta.total_seconds() / 86400.0, 0.0)