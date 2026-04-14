from __future__ import annotations

import httpx


class OllamaClient:
    def __init__(self, base_url: str, model: str):
        self._base_url = base_url.rstrip("/")
        self._model = model

    async def extract_signal(self, *, text: str) -> dict:
        """Return a structured signal.

        This stays out of the hot path; called by the separate LLM worker.
        """

        prompt = (
            "Extract a JSON object with keys: event, sentiment, confidence. "
            "sentiment in [-1,1], confidence in [0,1]. Return ONLY JSON.\n\n"
            f"Text: {text}"
        )

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self._base_url}/api/generate",
                json={"model": self._model, "prompt": prompt, "stream": False},
            )
            resp.raise_for_status()
            data = resp.json()

        # Ollama returns { response: "..." }
        raw = data.get("response", "{}").strip()
        # Best-effort JSON parse; if it fails, return empty signal.
        try:
            import json

            return json.loads(raw)
        except Exception:
            return {}
