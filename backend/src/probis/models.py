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
    outcome: str = "YES"
    venue: Literal["polymarket", "sim"] = "sim"
    reference_price: float = 0.5


class MonitorSettings(BaseModel):
    edge_threshold: float = Field(default=0.05, ge=0.0, le=1.0)
    exit_threshold: float = Field(default=0.01, ge=0.0, le=1.0)
    order_size: float = Field(default=1.0, gt=0.0)
    max_position: float = Field(default=3.0, gt=0.0)
    take_profit: float = Field(default=0.08, ge=0.0, le=1.0)
    stop_loss: float = Field(default=0.04, ge=0.0, le=1.0)
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
