from __future__ import annotations

from datetime import datetime
from typing import Literal
from typing import Optional

from pydantic import BaseModel, Field


class PriceTick(BaseModel):
    ts: datetime = Field(default_factory=datetime.utcnow)
    source: Literal["polymarket", "sim"]
    market: str
    outcome: str
    price: float = Field(ge=0.0, le=1.0)


class Signal(BaseModel):
    ts: datetime = Field(default_factory=datetime.utcnow)
    source: Literal["news", "twitter", "manual"]
    event: str
    sentiment: float = Field(ge=-1.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)


class EdgeDecision(BaseModel):
    ts: datetime = Field(default_factory=datetime.utcnow)
    market: str
    outcome: str
    your_probability: float = Field(ge=0.0, le=1.0)
    market_probability: float = Field(ge=0.0, le=1.0)
    edge: float
    should_trade: bool


class OrderRequest(BaseModel):
    ts: datetime = Field(default_factory=datetime.utcnow)
    market: str
    outcome: str
    side: Literal["buy", "sell"]
    size: float = Field(gt=0.0)
    limit_price: float = Field(ge=0.0, le=1.0)
    session_id: Optional[str] = None
    reason: str = "edge"


class TradeFill(BaseModel):
    ts: datetime = Field(default_factory=datetime.utcnow)
    market: str
    outcome: str
    side: Literal["buy", "sell"]
    size: float
    price: float
    venue: Literal["polymarket", "sim"]
    order_id: str
    session_id: Optional[str] = None
    reason: str = "edge"


class MarketDescriptor(BaseModel):
    market: str
    title: str
    category: str
    subtitle: Optional[str] = None
    description: Optional[str] = None
    market_type: Optional[str] = None
    outcome: str = "YES"
    outcomes: list[str] = Field(default_factory=list)
    outcome_prices: list[float] = Field(default_factory=list)
    venue: Literal["polymarket", "sim"] = "sim"
    reference_price: float = 0.5
    condition_id: Optional[str] = None
    asset_id: Optional[str] = None
    no_asset_id: Optional[str] = None
    active: bool = True
    closed: bool = False
    best_bid: Optional[float] = None
    best_ask: Optional[float] = None
    last_trade_price: Optional[float] = None
    min_tick_size: Optional[float] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    image: Optional[str] = None


class MonitorSettings(BaseModel):
    edge_threshold: float = Field(default=0.05, ge=0.0, le=1.0)
    exit_threshold: float = Field(default=0.01, ge=0.0, le=1.0)
    order_size: float = Field(default=1.0, gt=0.0)
    max_position: float = Field(default=3.0, gt=0.0)
    take_profit: float = Field(default=0.08, ge=0.0, le=1.0)
    stop_loss: float = Field(default=0.04, ge=0.0, le=1.0)
    entry_price_min: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    entry_price_max: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    add_price: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    add_order_size: Optional[float] = Field(default=None, gt=0.0)
    trim_price: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    trim_order_size: Optional[float] = Field(default=None, gt=0.0)
    take_profit_price: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    stop_loss_price: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    author_notes: str = "Deterministic edge-based monitoring."


class StartMonitorRequest(BaseModel):
    market: str
    outcome: str = "YES"
    settings: MonitorSettings = Field(default_factory=MonitorSettings)


class MonitorSession(BaseModel):
    session_id: str
    market: str
    outcome: str
    title: str
    status: Literal["running", "aborted", "completed"] = "running"
    settings: MonitorSettings
    started_at: datetime = Field(default_factory=datetime.utcnow)
    stopped_at: Optional[datetime] = None
    reason: Optional[str] = None
    last_action: str = "Monitoring"
    last_price: Optional[float] = None


class PolymarketAccountSnapshot(BaseModel):
    status: Literal["disconnected", "connected", "error"] = "disconnected"
    configured: bool = False
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
