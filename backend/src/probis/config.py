from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Probis"
    environment: str = Field(default="dev", validation_alias="PROBIS_ENV")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")
    host: str = Field(default="127.0.0.1", validation_alias="PROBIS_HOST")
    port: int = Field(default=8000, validation_alias="PROBIS_PORT")
    frontend_origin: str = Field(default="http://127.0.0.1:5173", validation_alias="FRONTEND_ORIGIN")

    edge_threshold: float = Field(default=0.04, validation_alias="EDGE_THRESHOLD")
    account_label: str = Field(default="Primary", validation_alias="PROBIS_ACCOUNT_LABEL")
    paper_cash: float = Field(default=25000.0, validation_alias="PROBIS_PAPER_CASH")
    max_trade_risk_pct: float = Field(default=0.02, validation_alias="PROBIS_MAX_TRADE_RISK_PCT")
    max_daily_loss: float = Field(default=1500.0, validation_alias="PROBIS_MAX_DAILY_LOSS")
    ai_mode: str = Field(default="template", validation_alias="PROBIS_AI_MODE")

    polymarket_gamma_api_base: str = Field(
        default="https://gamma-api.polymarket.com",
        validation_alias="POLYMARKET_GAMMA_API_BASE",
    )
    polymarket_key_id: str = Field(default="", validation_alias="POLYMARKET_KEY_ID")
    polymarket_secret_key: str = Field(default="", validation_alias="POLYMARKET_SECRET_KEY")

    @property
    def trading_ready(self) -> bool:
        return bool(self.polymarket_key_id and self.polymarket_secret_key)

    @property
    def trading_mode(self) -> str:
        return "live-ready" if self.trading_ready else "paper"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
