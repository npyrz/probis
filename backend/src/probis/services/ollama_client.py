from __future__ import annotations

import json

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

        return await self._generate_json(prompt)

    async def analyze_trade(self, *, payload: dict) -> dict:
        prompt = (
            "You are analyzing a prediction-market trade. Return ONLY valid JSON with keys: "
            "verdict, confidence, estimated_probability, summary, thesis, catalysts, risks. "
            "Rules: verdict must be one of buy/watch/avoid. confidence and estimated_probability must be in [0,1]. "
            "thesis, catalysts, risks must be arrays of short strings.\n\n"
            f"Payload: {json.dumps(payload, ensure_ascii=True)}"
        )
        return await self._generate_json(prompt)

    async def _generate_json(self, prompt: str) -> dict:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self._base_url}/api/generate",
                json={"model": self._model, "prompt": prompt, "stream": False},
            )
            resp.raise_for_status()
            data = resp.json()

        raw = data.get("response", "{}").strip()
        try:
            return json.loads(raw)
        except Exception:
            return {}

