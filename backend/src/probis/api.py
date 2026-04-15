from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .models import AnalyzeRequest, AnalyzeResponse, HealthResponse
from .services import AnalysisService, MarketLookupError, PolymarketService, build_account_summary


def create_app() -> FastAPI:
    settings = get_settings()
    market_service = PolymarketService(settings)
    analysis_service = AnalysisService(settings)

    app = FastAPI(title=settings.app_name, version="0.2.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin, "http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(
            ok=True,
            app=settings.app_name,
            environment=settings.environment,
            version="0.2.0",
            timestamp=datetime.now(timezone.utc),
        )

    @app.get("/api/account")
    async def account() -> dict:
        return {"account": build_account_summary(settings)}

    @app.post("/api/analyze", response_model=AnalyzeResponse)
    async def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
        try:
            market = await market_service.lookup_market(request.url)
        except MarketLookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Failed to reach Polymarket market data") from exc

        account_summary = build_account_summary(settings)
        return analysis_service.build_report(
            url=request.url,
            market=market,
            account=account_summary,
        )

    @app.get("/")
    async def root() -> dict:
        return {
            "name": settings.app_name,
            "mode": settings.trading_mode,
            "routes": ["/api/health", "/api/account", "/api/analyze"],
        }

    return app


app = create_app()
