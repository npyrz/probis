from __future__ import annotations

from datetime import datetime
from typing import Literal

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


class TradeFill(BaseModel):
    ts: datetime = Field(default_factory=datetime.utcnow)
    market: str
    outcome: str
    side: Literal["buy", "sell"]
    size: float
    price: float
    venue: Literal["polymarket", "sim"]
    order_id: str
