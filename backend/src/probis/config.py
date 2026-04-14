from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

from typing import Optional


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", env_file=".env", extra="ignore")

    probis_env: str = "dev"
    log_level: str = "INFO"

    edge_threshold: float = 0.05

    redis_url: str = "redis://localhost:6379/0"
    database_url: Optional[str] = None

    polymarket_key_id: Optional[str] = None
    polymarket_secret_key: Optional[str] = None
    polymarket_market_limit: int = 500
    polymarket_discovery_interval_seconds: int = 180

    news_api_key: Optional[str] = None
    news_api_base_url: str = "https://newsapi.org/v2"
    news_api_everything_endpoint: str = "/everything"
    news_results_limit: int = 5

    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "gemma2:2b"
    llm_interval_seconds: int = 60


settings = Settings()
