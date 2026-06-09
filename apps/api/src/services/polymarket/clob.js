import axios from 'axios';

const CLOB_TIMEOUT_MS = 5000;
const HISTORY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const HISTORY_FIDELITY_MINUTES = 1440;
const BATCH_PRICE_HISTORY_LIMIT = 20;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function createClobClient(env) {
  return axios.create({
    baseURL: env.polymarketClobBaseUrl ?? 'https://clob.polymarket.com',
    timeout: CLOB_TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });
}

function getOutcomeTokenId(outcome) {
  const tokenId = outcome?.tokenId ?? outcome?.token_id ?? outcome?.assetId ?? outcome?.asset_id ?? null;
  const normalized = String(tokenId ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBookSide(levels, direction) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({
      price: toNumberOrNull(level?.price),
      size: toNumberOrNull(level?.size)
    }))
    .filter((level) => typeof level.price === 'number' && typeof level.size === 'number')
    .sort((left, right) => direction === 'desc' ? right.price - left.price : left.price - right.price);
}

function normalizeBook(book) {
  const bids = normalizeBookSide(book?.bids, 'desc');
  const asks = normalizeBookSide(book?.asks, 'asc');
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = typeof bestBid === 'number' && typeof bestAsk === 'number'
    ? Math.max(0, bestAsk - bestBid)
    : null;
  const midpoint = typeof bestBid === 'number' && typeof bestAsk === 'number'
    ? (bestBid + bestAsk) / 2
    : null;

  return {
    tokenId: String(book?.asset_id ?? book?.assetId ?? '').trim() || null,
    market: book?.market ?? null,
    timestamp: book?.timestamp ?? null,
    bestBid,
    bestAsk,
    spread,
    midpoint,
    bidDepth: bids.reduce((sum, level) => sum + level.size, 0),
    askDepth: asks.reduce((sum, level) => sum + level.size, 0),
    bids: bids.slice(0, 5),
    asks: asks.slice(0, 5)
  };
}

function normalizeHistoryPayload(payload) {
  const history = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.history)
      ? payload.history
      : [];

  return history
    .map((point) => ({
      timestamp: toNumberOrNull(point?.t),
      price: toNumberOrNull(point?.p)
    }))
    .filter((point) => typeof point.timestamp === 'number' && typeof point.price === 'number')
    .sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeBatchHistoryPayload(payload) {
  const history = payload?.history && typeof payload.history === 'object' ? payload.history : {};

  return new Map(Object.entries(history).map(([tokenId, points]) => [
    String(tokenId),
    normalizeHistoryPayload(points)
  ]));
}

function summarizeHistory(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return {
      pointCount: 0,
      firstPrice: null,
      latestPrice: null,
      lowPrice: null,
      highPrice: null,
      absoluteChange: null,
      percentChange: null
    };
  }

  const prices = points.map((point) => point.price);
  const firstPrice = points[0].price;
  const latestPrice = points.at(-1).price;
  const absoluteChange = latestPrice - firstPrice;

  return {
    pointCount: points.length,
    firstPrice,
    latestPrice,
    lowPrice: Math.min(...prices),
    highPrice: Math.max(...prices),
    absoluteChange,
    percentChange: firstPrice ? absoluteChange / firstPrice : null
  };
}

async function fetchBatchMap(client, path, body) {
  if (body.length === 0) {
    return {};
  }

  try {
    const response = await client.post(path, body);
    return response.data && typeof response.data === 'object' ? response.data : {};
  } catch {
    return {};
  }
}

async function fetchBatchBooks(client, tokenIds) {
  if (tokenIds.length === 0) {
    return {};
  }

  try {
    const response = await client.post('/books', tokenIds.map((tokenId) => ({ token_id: tokenId })));
    const books = Array.isArray(response.data) ? response.data : [];

    return Object.fromEntries(
      books.map((book) => {
        const normalized = normalizeBook(book);
        const tokenId = normalized.tokenId ?? String(book?.asset_id ?? '').trim();
        return tokenId ? [tokenId, normalized] : null;
      }).filter(Boolean)
    );
  } catch {
    return {};
  }
}

async function fetchTokenHistory(client, tokenId) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - HISTORY_WINDOW_SECONDS;

  try {
    const response = await client.get('/prices-history', {
      params: {
        market: tokenId,
        startTs,
        endTs,
        fidelity: HISTORY_FIDELITY_MINUTES
      }
    });
    const points = normalizeHistoryPayload(response.data);

    return {
      points,
      summary: summarizeHistory(points)
    };
  } catch {
    return {
      points: [],
      summary: summarizeHistory([])
    };
  }
}

function chunkArray(values, size) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

async function fetchTokenHistoryRange(client, tokenId, {
  startTs,
  endTs,
  interval = null,
  fidelityMinutes = HISTORY_FIDELITY_MINUTES
} = {}) {
  const params = {
    market: tokenId,
    startTs,
    endTs,
    fidelity: fidelityMinutes
  };

  if (interval) {
    params.interval = interval;
  }

  try {
    const response = await client.get('/prices-history', { params });
    return normalizeHistoryPayload(response.data);
  } catch {
    return [];
  }
}

export async function fetchClobPriceHistoryBatch(env, tokenIds, {
  startTs,
  endTs,
  interval = null,
  fidelityMinutes = HISTORY_FIDELITY_MINUTES
} = {}) {
  const client = createClobClient(env);
  const uniqueTokenIds = [...new Set((Array.isArray(tokenIds) ? tokenIds : [])
    .map((tokenId) => String(tokenId ?? '').trim())
    .filter(Boolean))];
  const byTokenId = new Map(uniqueTokenIds.map((tokenId) => [tokenId, []]));

  if (uniqueTokenIds.length === 0 || !Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    return {
      byTokenId,
      generatedAt: new Date().toISOString(),
      source: 'polymarket-clob-prices-history'
    };
  }

  for (const chunk of chunkArray(uniqueTokenIds, BATCH_PRICE_HISTORY_LIMIT)) {
    const body = {
      markets: chunk,
      start_ts: startTs,
      end_ts: endTs,
      fidelity: fidelityMinutes
    };

    if (interval) {
      body.interval = interval;
    }

    try {
      const response = await client.post('/batch-prices-history', body);
      const batchHistory = normalizeBatchHistoryPayload(response.data);

      for (const tokenId of chunk) {
        byTokenId.set(tokenId, batchHistory.get(tokenId) ?? []);
      }
    } catch {
      const fallbackEntries = await Promise.all(chunk.map(async (tokenId) => [
        tokenId,
        await fetchTokenHistoryRange(client, tokenId, {
          startTs,
          endTs,
          interval,
          fidelityMinutes
        })
      ]));

      for (const [tokenId, points] of fallbackEntries) {
        byTokenId.set(tokenId, points);
      }
    }
  }

  return {
    byTokenId,
    generatedAt: new Date().toISOString(),
    source: 'polymarket-clob-prices-history'
  };
}

export async function fetchClobMarketSnapshots(env, markets, { includeHistory = false } = {}) {
  const client = createClobClient(env);
  const tokenIds = [...new Set(
    (Array.isArray(markets) ? markets : [])
      .flatMap((market) => Array.isArray(market?.outcomes) ? market.outcomes : [])
      .map(getOutcomeTokenId)
      .filter(Boolean)
  )];

  if (tokenIds.length === 0) {
    return {
      byTokenId: new Map(),
      generatedAt: new Date().toISOString(),
      source: 'clob-unavailable-no-token-ids'
    };
  }

  const requestBody = tokenIds.map((tokenId) => ({ token_id: tokenId }));
  const [midpoints, spreads, books] = await Promise.all([
    fetchBatchMap(client, '/midpoints', requestBody),
    fetchBatchMap(client, '/spreads', requestBody),
    fetchBatchBooks(client, tokenIds)
  ]);
  const historyByTokenId = new Map();

  if (includeHistory) {
    const historyEntries = await Promise.all(tokenIds.map(async (tokenId) => [tokenId, await fetchTokenHistory(client, tokenId)]));

    for (const [tokenId, history] of historyEntries) {
      historyByTokenId.set(tokenId, history);
    }
  }

  const byTokenId = new Map(tokenIds.map((tokenId) => {
    const book = books[tokenId] ?? {};
    const midpoint = toNumberOrNull(midpoints[tokenId]) ?? book.midpoint ?? null;
    const spread = toNumberOrNull(spreads[tokenId]) ?? book.spread ?? null;
    const history = historyByTokenId.get(tokenId) ?? {
      points: [],
      summary: summarizeHistory([])
    };

    return [
      tokenId,
      {
        tokenId,
        midpoint,
        spread,
        bestBid: book.bestBid ?? null,
        bestAsk: book.bestAsk ?? null,
        bidDepth: book.bidDepth ?? null,
        askDepth: book.askDepth ?? null,
        book,
        history: history.points,
        historySummary: history.summary,
        generatedAt: new Date().toISOString(),
        source: 'polymarket-clob'
      }
    ];
  }));

  return {
    byTokenId,
    generatedAt: new Date().toISOString(),
    source: 'polymarket-clob'
  };
}

export {
  normalizeHistoryPayload,
  summarizeHistory
};
