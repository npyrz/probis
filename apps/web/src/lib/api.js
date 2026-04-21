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
  const [polymarketResult, aiResult, accountIdentityResult] = await Promise.allSettled([
    requestJson('/api/polymarket/status'),
    requestJson('/api/ai/status'),
    requestJson('/api/polymarket/account-identity')
  ]);

  if (polymarketResult.status !== 'fulfilled') {
    throw polymarketResult.reason;
  }

  return {
    polymarket: polymarketResult.value.status,
    ai: aiResult.status === 'fulfilled'
      ? aiResult.value.status
      : {
          reachable: false,
          requestedModel: null,
          resolvedModel: null,
          availableModels: [],
          error: aiResult.reason instanceof Error ? aiResult.reason.message : 'Unable to refresh AI status'
        },
    accountIdentity: accountIdentityResult.status === 'fulfilled'
      ? accountIdentityResult.value.identity
      : {
          configured: false,
          endpoint: null,
          keyIdSuffix: null,
          authenticated: false,
          totalAccountBudget: null,
          buyingPower: null,
          assetNotional: null,
          assetAvailable: null,
          pendingCredit: null,
          openOrders: null,
          unsettledFunds: null,
          marginRequirement: null,
          budgetCurrency: 'USD',
          balanceLastUpdatedAt: null,
          openPositionsCount: 0,
          openPositions: [],
          error: accountIdentityResult.reason instanceof Error ? accountIdentityResult.reason.message : 'Unable to refresh Polymarket account identity'
        }
  };
}

export async function fetchActiveEvents(limit = 5) {
  const data = await requestJson(`/api/polymarket/events?limit=${limit}`);
  return data.events;
}

export async function fetchOpportunityScanner(options = {}) {
  const query = new URLSearchParams();

  if (options.refresh) {
    query.set('refresh', 'true');
  }

  if (options.wait) {
    query.set('wait', 'true');
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const data = await requestJson(`/api/polymarket/scanner${suffix}`);
  return data.scanner;
}

export async function refreshOpportunityScanner() {
  return fetchOpportunityScanner({ refresh: true, wait: true });
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
  const tradeAmount = Number.parseFloat(options.tradeAmount);
  const payload = {
    input,
    refresh: options.refresh === true
  };

  if (Number.isFinite(tradeAmount) && tradeAmount > 0) {
    payload.tradeAmount = tradeAmount;
  }

  const data = await requestJson('/api/ai/analyze-event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
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

export async function updateTradeIntent(id, payload) {
  const data = await requestJson(`/api/trades/intents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  return data.intent;
}

export async function deleteTradeIntent(id) {
  const data = await requestJson(`/api/trades/intents/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });

  return data.intent;
}

export async function executeTradeIntent(id) {
  const data = await requestJson(`/api/trades/intents/${encodeURIComponent(id)}/execute`, {
    method: 'POST'
  });

  return data.intent;
}

export async function pollTrackedTradeIntents() {
  const data = await requestJson('/api/trades/intents/poll', {
    method: 'POST'
  });

  return data.intents;
}

export async function pollTradeIntent(id) {
  const data = await requestJson(`/api/trades/intents/${encodeURIComponent(id)}/poll`, {
    method: 'POST'
  });

  return data.intent;
}

export async function sellTradeIntent(id) {
  const data = await requestJson(`/api/trades/intents/${encodeURIComponent(id)}/sell`, {
    method: 'POST'
  });

  return data.intent;
}

export async function stopTradeIntent(id) {
  const data = await requestJson(`/api/trades/intents/${encodeURIComponent(id)}/stop`, {
    method: 'POST'
  });

  return data.intent;
}

export async function closeTradeIntent(id) {
  const data = await requestJson(`/api/trades/intents/${encodeURIComponent(id)}/close`, {
    method: 'POST'
  });

  return data.intent;
}
