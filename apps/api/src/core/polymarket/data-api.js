import axios from 'axios';

const DATA_API_TIMEOUT_MS = 8000;
const DEFAULT_TRADES_LIMIT = 1000;
const MAX_TRADES_LIMIT = 10000;
const DEFAULT_MAX_PAGES = 5;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function createDataApiClient(env) {
  return axios.create({
    baseURL: env?.polymarketDataApiBaseUrl ?? 'https://data-api.polymarket.com',
    timeout: DATA_API_TIMEOUT_MS,
    headers: {
      Accept: 'application/json'
    }
  });
}

function normalizeTimestampSeconds(value) {
  const numeric = toNumberOrNull(value);

  if (typeof numeric !== 'number') {
    return null;
  }

  return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function getTradesPayloadRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.trades)) {
    return payload.trades;
  }

  return [];
}

function normalizeTradeRow(row) {
  const timestamp = normalizeTimestampSeconds(row?.timestamp ?? row?.time ?? row?.match_time ?? row?.createdAt);
  const price = toNumberOrNull(row?.price);
  const size = toNumberOrNull(row?.size ?? row?.amount ?? row?.quantity);

  if (!Number.isFinite(timestamp) || typeof price !== 'number') {
    return null;
  }

  return {
    tradeId: row?.id ?? row?.transactionHash ?? row?.transaction_hash ?? null,
    conditionId: row?.conditionId ?? row?.condition_id ?? row?.market ?? null,
    tokenId: row?.asset ?? row?.asset_id ?? row?.assetId ?? null,
    marketSlug: row?.slug ?? row?.marketSlug ?? null,
    eventSlug: row?.eventSlug ?? row?.event_slug ?? null,
    outcome: row?.outcome ?? null,
    side: typeof row?.side === 'string' ? row.side.toUpperCase() : null,
    price,
    size,
    timestamp,
    tradedAt: new Date(timestamp * 1000).toISOString(),
    transactionHash: row?.transactionHash ?? row?.transaction_hash ?? null,
    rawData: row
  };
}

function normalizeTrades(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeTradeRow)
    .filter(Boolean)
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }

      return String(left.tradeId ?? '').localeCompare(String(right.tradeId ?? ''));
    });
}

function normalizeConditionIds(conditionIds) {
  return [...new Set((Array.isArray(conditionIds) ? conditionIds : [])
    .map((conditionId) => String(conditionId ?? '').trim())
    .filter(Boolean))];
}

export async function fetchPolymarketTradesForMarkets(env, conditionIds, {
  limit = DEFAULT_TRADES_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
  offset = 0,
  side = null
} = {}) {
  const marketIds = normalizeConditionIds(conditionIds);

  if (marketIds.length === 0) {
    return {
      source: 'polymarket-data-api-trades',
      generatedAt: new Date().toISOString(),
      trades: []
    };
  }

  const client = createDataApiClient(env);
  const normalizedLimit = Math.max(1, Math.min(MAX_TRADES_LIMIT, Number.parseInt(String(limit), 10) || DEFAULT_TRADES_LIMIT));
  const trades = [];

  for (let page = 0; page < maxPages; page += 1) {
    const params = {
      market: marketIds.join(','),
      limit: normalizedLimit,
      offset: offset + (page * normalizedLimit),
      takerOnly: false
    };

    if (side) {
      params.side = side;
    }

    const response = await client.get('/trades', { params });
    const rows = getTradesPayloadRows(response.data);
    trades.push(...normalizeTrades(rows));

    if (rows.length < normalizedLimit) {
      break;
    }
  }

  return {
    source: 'polymarket-data-api-trades',
    generatedAt: new Date().toISOString(),
    conditionIds: marketIds,
    trades: normalizeTrades(trades)
  };
}

export {
  normalizeTradeRow,
  normalizeTrades
};
