const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

async function readJson(response) {
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error ?? 'Request failed');
  }

  return data;
}

export async function fetchStatus() {
  const [polymarketResponse, aiResponse] = await Promise.all([
    fetch(`${API_BASE_URL}/api/polymarket/status`),
    fetch(`${API_BASE_URL}/api/ai/status`)
  ]);

  const polymarket = await readJson(polymarketResponse);
  const ai = await readJson(aiResponse);

  return {
    polymarket: polymarket.status,
    ai: ai.status
  };
}

export async function fetchActiveEvents(limit = 5) {
  const response = await fetch(`${API_BASE_URL}/api/polymarket/events?limit=${limit}`);
  const data = await readJson(response);
  return data.events;
}

export async function resolveEvent(input) {
  const response = await fetch(
    `${API_BASE_URL}/api/polymarket/events/resolve?input=${encodeURIComponent(input)}`
  );
  const data = await readJson(response);
  return data.event;
}

export async function analyzeEvent(input) {
  const response = await fetch(`${API_BASE_URL}/api/ai/analyze-event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input })
  });

  const data = await readJson(response);
  return data;
}