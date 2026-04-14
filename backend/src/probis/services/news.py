from __future__ import annotations

from typing import Optional

import httpx

from ..config import settings
from ..models import NewsArticle


class NewsService:
    async def fetch_related_news(self, *, query: str, limit: Optional[int] = None) -> list[NewsArticle]:
        if not settings.news_api_key:
            return []

        params = {
            "q": query,
            "pageSize": limit or settings.news_results_limit,
            "sortBy": "publishedAt",
            "language": "en",
            "apiKey": settings.news_api_key,
        }

        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                f"{settings.news_api_base_url.rstrip('/')}{settings.news_api_everything_endpoint}",
                params=params,
            )
            response.raise_for_status()
            payload = response.json()

        articles: list[NewsArticle] = []
        for item in payload.get("articles", [])[: params["pageSize"]]:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            url = str(item.get("url") or "").strip()
            if not title or not url:
                continue
            articles.append(
                NewsArticle(
                    title=title,
                    source=str((item.get("source") or {}).get("name") or "News"),
                    url=url,
                    published_at=item.get("publishedAt"),
                    summary=item.get("description"),
                )
            )
        return articles
