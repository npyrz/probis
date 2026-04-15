const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

async function readJson(response) {
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error ?? 'Request failed');
  }

  return data;
}

async function requestJson(path, options) {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, options);
    return await readJson(response);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Backend API is not reachable at ${API_BASE_URL}. Start it with "npm run dev:api" or "npm run dev".`
      );
    }

    throw error;
  }
}

export async function fetchStatus() {
  const [polymarket, ai] = await Promise.all([
    requestJson('/api/polymarket/status'),
    requestJson('/api/ai/status')
  ]);

  return {
    polymarket: polymarket.status,
    ai: ai.status
  };
}

export async function fetchActiveEvents(limit = 5) {
  const data = await requestJson(`/api/polymarket/events?limit=${limit}`);
  return data.events;
}

export async function resolveEvent(input) {
  const data = await requestJson(
    `/api/polymarket/events/resolve?input=${encodeURIComponent(input)}`
  );
  return data.event;
}

export async function resolveEventAggregation(input, options = {}) {
  const refreshQuery = options.refresh ? '&refresh=true' : '';
  return requestJson(`/api/polymarket/events/aggregation?input=${encodeURIComponent(input)}${refreshQuery}`);
}

export async function analyzeEvent(input, options = {}) {
  const data = await requestJson('/api/ai/analyze-event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input, refresh: options.refresh === true })
  });

  return data;
}

export async function invalidateEventAggregationCache(input) {
  return requestJson('/api/polymarket/events/aggregation/invalidate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(input ? { input } : {})
  });
}

export async function fetchTradeIntents(limit = 6) {
  const data = await requestJson(`/api/trades/intents?limit=${limit}`);
  return data.intents;
}

export async function createTradeIntent(payload) {
  const data = await requestJson('/api/trades/intents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  return data.intent;
}