from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    ok: bool
    app: str
    environment: str
    version: str
    timestamp: datetime


class AnalyzeRequest(BaseModel):
    url: str = Field(min_length=8)


class AccountSummary(BaseModel):
    label: str
    mode: Literal["paper", "live-ready"]
    trading_ready: bool
    api_key_configured: bool
    paper_balance: float
    buying_power: float
    max_trade_risk_pct: float
    max_daily_loss: float
    notes: List[str] = Field(default_factory=list)


class MarketOutcome(BaseModel):
    name: str
    price: float = Field(ge=0.0, le=1.0)


class MarketSnapshot(BaseModel):
    url: str
    title: str
    question: str
    slug: str
    event_title: Optional[str] = None
    event_slug: Optional[str] = None
    category: Optional[str] = None
    description: str = ""
    liquidity: Optional[float] = None
    volume: Optional[float] = None
    volume_24hr: Optional[float] = None
    end_date: Optional[str] = None
    resolution_source: Optional[str] = None
    outcomes: List[MarketOutcome] = Field(default_factory=list)
    source_status: Literal["live"] = "live"
    raw_market: Dict[str, Any] = Field(default_factory=dict)
    raw_event: Optional[Dict[str, Any]] = None


class ExternalSignal(BaseModel):
    label: str
    direction: Literal["positive", "neutral", "risk"]
    score: float = Field(ge=0.0, le=1.0)
    detail: str


class AISynthesis(BaseModel):
    mode: str
    summary: str
    drivers: List[str] = Field(default_factory=list)
    caveats: List[str] = Field(default_factory=list)


class TradePlan(BaseModel):
    action: Literal["buy_yes", "buy_no", "wait"]
    target_outcome: str
    market_probability: float = Field(ge=0.0, le=1.0)
    model_probability: float = Field(ge=0.0, le=1.0)
    edge_pct: float
    conviction: float = Field(ge=0.0, le=1.0)
    entry_window: str
    sizing: str
    invalidation: str
    rationale: List[str] = Field(default_factory=list)
    risk_flags: List[str] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    generated_at: datetime
    account: AccountSummary
    market: MarketSnapshot
    external_signals: List[ExternalSignal] = Field(default_factory=list)
    ai_synthesis: AISynthesis
    trade_plan: TradePlan
    source_notes: List[str] = Field(default_factory=list)
    trading_ready: bool = False
    key_id_fingerprint: Optional[str] = None
    balance_usd: Optional[str] = None
    open_orders: int = 0
    position_count: int = 0
    error: Optional[str] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class AnalyzeMarketRequest(BaseModel):
    slug: str = Field(min_length=1)
    notes: Optional[str] = None


class NewsArticle(BaseModel):
    title: str
    source: str
    url: str
    published_at: Optional[str] = None
    summary: Optional[str] = None


class EventContext(BaseModel):
    label: str
    value: str


class DeterministicAnalysis(BaseModel):
    market_probability: float = Field(ge=0.0, le=1.0)
    fair_probability: float = Field(ge=0.0, le=1.0)
    edge: float
    best_bid: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    best_ask: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    spread: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    spread_bps: Optional[float] = None
    last_trade_price: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    open_interest: Optional[float] = None
    shares_traded: Optional[float] = None
    bid_depth: Optional[float] = None
    ask_depth: Optional[float] = None
    liquidity_score: float = Field(ge=0.0, le=1.0)
    risk_score: float = Field(ge=0.0, le=1.0)
    risk_flags: list[str] = Field(default_factory=list)


class AITradeAnalysis(BaseModel):
    status: Literal["available", "fallback", "unavailable"] = "fallback"
    verdict: Literal["buy", "watch", "avoid"] = "watch"
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    estimated_probability: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    summary: str = ""
    thesis: list[str] = Field(default_factory=list)
    catalysts: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)


class MarketAnalysisResponse(BaseModel):
    market: MarketDescriptor
    event_context: list[EventContext] = Field(default_factory=list)
    news: list[NewsArticle] = Field(default_factory=list)
    deterministic: DeterministicAnalysis
    ai: AITradeAnalysis
    recommended_settings: MonitorSettings
    trading_ready: bool = False
