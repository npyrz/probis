import axios from 'axios';
import nacl from 'tweetnacl';

const US_MARKETS_CACHE_TTL_MS = 60_000;
const usMarketsCache = new Map();

function getErrorMessage(error) {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.message ?? error.response?.data?.error ?? error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown Polymarket US API error';
}

function decodeSecretSeed(secretKey) {
  try {
    const bytes = Buffer.from(secretKey, 'base64');

    if (bytes.length < 32) {
      return null;
    }

    return new Uint8Array(bytes.subarray(0, 32));
  } catch {
    return null;
  }
}

function createAuthSignature({ timestamp, method, path, secretKey }) {
  const seed = decodeSecretSeed(secretKey);

  if (!seed) {
    throw new Error('POLYMARKET_US_SECRET_KEY is not a valid base64 Ed25519 secret.');
  }

  const signingKey = nacl.sign.keyPair.fromSeed(seed);
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const signature = nacl.sign.detached(Buffer.from(message, 'utf8'), signingKey.secretKey);

  return Buffer.from(signature).toString('base64');
}

function createPolymarketUsClient(env) {
  return axios.create({
    baseURL: env.polymarketUsBaseUrl,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function getSignedHeaders(env, method, path) {
  if (!env.polymarketUsKeyId || !env.polymarketUsSecretKey) {
    throw new Error('Missing POLYMARKET_US_KEY_ID/POLYMARKET_US_SECRET_KEY (or POLYMARKET_API_KEY/POLYMARKET_PRIVATE_KEY fallback).');
  }

  const timestamp = String(Date.now());
  const signature = createAuthSignature({
    timestamp,
    method,
    path,
    secretKey: env.polymarketUsSecretKey
  });

  return {
    'X-PM-Access-Key': env.polymarketUsKeyId,
    'X-PM-Timestamp': timestamp,
    'X-PM-Signature': signature
  };
}

function parseNumber(value) {
  const next = Number.parseFloat(value ?? NaN);
  return Number.isFinite(next) ? next : null;
}

function extractNumericQuantity(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const directKeys = [
    'quantity',
    'qty',
    'size',
    'shares',
    'position',
    'netQuantity',
    'availableQuantity'
  ];

  for (const key of directKeys) {
    const numeric = parseNumber(candidate[key]);
    if (typeof numeric === 'number' && numeric > 0) {
      return numeric;
    }
  }

  const nestedKeys = ['quantity', 'qty', 'size', 'shares', 'position'];

  for (const key of nestedKeys) {
    const numeric = parseNumber(candidate[key]?.value);
    if (typeof numeric === 'number' && numeric > 0) {
      return numeric;
    }
  }

  return null;
}

function getPortfolioPositions(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.positions)) {
    return payload.positions;
  }

  if (Array.isArray(payload?.data?.positions)) {
    return payload.data.positions;
  }

  return [];
}

function getUsMarketsFromPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.markets)) {
    return payload.markets;
  }

  if (Array.isArray(payload?.data?.markets)) {
    return payload.data.markets;
  }

  return [];
}

function getUsMarketsPageCursor(payload) {
  if (typeof payload?.nextCursor === 'string') {
    return payload.nextCursor;
  }

  if (typeof payload?.data?.nextCursor === 'string') {
    return payload.data.nextCursor;
  }

  return '';
}

function getUsMarketsPageEof(payload) {
  if (typeof payload?.eof === 'boolean') {
    return payload.eof;
  }

  if (typeof payload?.data?.eof === 'boolean') {
    return payload.data.eof;
  }

  return true;
}

async function listUsMarkets(env, { limit = 200, maxPages = 20 } = {}) {
  const path = '/v1/markets';
  const cacheKey = `${env.polymarketUsBaseUrl}:${limit}:${maxPages}`;
  const cached = usMarketsCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.markets;
  }

  if (!env.polymarketUsKeyId || !env.polymarketUsSecretKey) {
    return [];
  }

  const client = createPolymarketUsClient(env);
  const collected = [];
  let cursor = '';

  for (let page = 0; page < maxPages; page += 1) {
    const requestPath = cursor
      ? `${path}?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `${path}?limit=${limit}`;
    const response = await client.get(requestPath, {
      headers: getSignedHeaders(env, 'GET', path)
    });
    const payload = response.data;
    const markets = getUsMarketsFromPayload(payload);

    for (const market of markets) {
      if (market && typeof market === 'object') {
        collected.push(market);
      }
    }

    if (getUsMarketsPageEof(payload)) {
      break;
    }

    const nextCursor = getUsMarketsPageCursor(payload);

    if (!nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  usMarketsCache.set(cacheKey, {
    markets: collected,
    expiresAt: Date.now() + US_MARKETS_CACHE_TTL_MS
  });

  return collected;
}

export async function getUsMarketSlugsForEvent(env, eventSlug) {
  const normalizedEventSlug = String(eventSlug ?? '').trim().toLowerCase();

  if (!normalizedEventSlug) {
    return new Set();
  }

  const markets = await listUsMarkets(env);
  const slugs = new Set();

  for (const market of markets) {
    const slug = typeof market?.slug === 'string' ? market.slug.toLowerCase() : '';

    if (!slug) {
      continue;
    }

    if (slug === normalizedEventSlug || slug.startsWith(`${normalizedEventSlug}-`)) {
      slugs.add(slug);
    }
  }

  return slugs;
}

function getPositionMarketSlug(position) {
  if (!position || typeof position !== 'object') {
    return null;
  }

  return position.marketSlug
    ?? position.market?.slug
    ?? position.marketMetadata?.slug
    ?? null;
}

async function fetchPortfolioPositions(env) {
  const path = '/v1/portfolio/positions';
  const client = createPolymarketUsClient(env);
  const response = await client.get(path, {
    headers: getSignedHeaders(env, 'GET', path)
  });

  return getPortfolioPositions(response.data);
}

async function resolveLivePositionShares(env, intent) {
  const marketSlug = intent.marketSlug;

  if (!marketSlug) {
    return null;
  }

  try {
    const positions = await fetchPortfolioPositions(env);
    const matches = positions.filter((position) => getPositionMarketSlug(position) === marketSlug);

    if (matches.length === 0) {
      return null;
    }

    const byOutcome = matches.find((position) => {
      const outcome = String(
        position.outcome ?? position.marketMetadata?.outcome ?? position.side ?? ''
      ).trim().toLowerCase();
      const desired = normalizeOutcomeLabel(intent.outcomeLabel);
      return outcome === desired;
    }) ?? matches[0];

    return extractNumericQuantity(byOutcome);
  } catch {
    return null;
  }
}

function normalizeOutcomeLabel(label) {
  return String(label ?? '').trim().toLowerCase();
}

function buyIntentForOutcome(outcomeLabel) {
  const normalized = normalizeOutcomeLabel(outcomeLabel);

  if (normalized === 'yes') {
    return 'ORDER_INTENT_BUY_LONG';
  }

  if (normalized === 'no') {
    return 'ORDER_INTENT_BUY_SHORT';
  }

  throw new Error(`Unsupported outcomeLabel "${outcomeLabel}" for Polymarket US order intent. Expected YES/NO.`);
}

function sellIntentForEntryIntent(entryIntent, outcomeLabel) {
  if (entryIntent === 'ORDER_INTENT_BUY_LONG') {
    return 'ORDER_INTENT_SELL_LONG';
  }

  if (entryIntent === 'ORDER_INTENT_BUY_SHORT') {
    return 'ORDER_INTENT_SELL_SHORT';
  }

  const normalized = normalizeOutcomeLabel(outcomeLabel);

  if (normalized === 'yes') {
    return 'ORDER_INTENT_SELL_LONG';
  }

  if (normalized === 'no') {
    return 'ORDER_INTENT_SELL_SHORT';
  }

  throw new Error('Unable to determine sell order intent from existing position metadata.');
}

function getOrderId(orderResponse) {
  return orderResponse?.id ?? null;
}

function getSharesFromOrder(orderResponse) {
  const executions = Array.isArray(orderResponse?.executions) ? orderResponse.executions : [];
  const fromExecutions = executions.reduce((sum, execution) => {
    const filled = parseNumber(execution?.lastShares);
    return filled ? sum + filled : sum;
  }, 0);

  if (fromExecutions > 0) {
    return fromExecutions;
  }

  const firstOrder = executions[0]?.order;
  const fromCumQuantity = parseNumber(firstOrder?.cumQuantity);

  if (typeof fromCumQuantity === 'number' && fromCumQuantity > 0) {
    return fromCumQuantity;
  }

  return null;
}

function getSpentFromOrder(orderResponse) {
  const executions = Array.isArray(orderResponse?.executions) ? orderResponse.executions : [];

  const spent = executions.reduce((sum, execution) => {
    const qty = parseNumber(execution?.lastShares);
    const px = parseNumber(execution?.lastPx?.value);

    if (typeof qty === 'number' && typeof px === 'number') {
      return sum + (qty * px);
    }

    return sum;
  }, 0);

  return spent > 0 ? spent : null;
}

export async function createPolymarketUsOrder(env, body) {
  const path = '/v1/orders';
  const client = createPolymarketUsClient(env);

  try {
    const response = await client.post(path, body, {
      headers: getSignedHeaders(env, 'POST', path)
    });

    return response.data;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function getPolymarketUsTradingStatus(env) {
  const status = {
    configured: Boolean(env.polymarketUsKeyId && env.polymarketUsSecretKey),
    endpoint: env.polymarketUsBaseUrl,
    keyIdPresent: Boolean(env.polymarketUsKeyId),
    secretKeyValid: Boolean(decodeSecretSeed(env.polymarketUsSecretKey)),
    authenticated: false,
    error: null
  };

  if (!status.configured || !status.secretKeyValid) {
    if (status.configured && !status.secretKeyValid) {
      status.error = 'Secret key is not a valid base64 Ed25519 seed.';
    }

    return status;
  }

  const path = '/v1/portfolio/positions';
  const client = createPolymarketUsClient(env);

  try {
    await client.get(path, {
      headers: getSignedHeaders(env, 'GET', path)
    });
    status.authenticated = true;
  } catch (error) {
    status.error = getErrorMessage(error);
  }

  return status;
}

export async function placeBuyOrderForIntent(env, intent) {
  const marketSlug = intent.marketSlug;

  if (!marketSlug) {
    throw new Error('Trade intent is missing marketSlug. Re-resolve the event and save a new intent before executing.');
  }

  const amount = parseNumber(intent.tradeAmount ?? intent.tradeSuggestion?.amount);

  if (!amount || amount <= 0) {
    throw new Error('Trade intent has invalid tradeAmount for market buy.');
  }

  const orderIntent = buyIntentForOutcome(intent.outcomeLabel);
  const maxSlippageBps = Number.parseInt(intent.executionRequest?.maxSlippageBps ?? '100', 10);

  const orderBody = {
    marketSlug,
    intent: orderIntent,
    type: 'ORDER_TYPE_MARKET',
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    cashOrderQty: {
      value: amount.toFixed(2),
      currency: 'USD'
    },
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
    maxBlockTime: '10',
    slippageTolerance: {
      bips: Number.isFinite(maxSlippageBps) ? maxSlippageBps : 100
    }
  };

  const orderResponse = await createPolymarketUsOrder(env, orderBody);

  return {
    request: orderBody,
    response: orderResponse,
    orderId: getOrderId(orderResponse),
    sharesFilled: getSharesFromOrder(orderResponse),
    notionalSpent: getSpentFromOrder(orderResponse),
    entryIntent: orderIntent
  };
}

export async function placeSellOrderForIntent(env, intent) {
  const marketSlug = intent.marketSlug;

  if (!marketSlug) {
    throw new Error('Trade intent is missing marketSlug and cannot be sold automatically.');
  }

  const localShares = parseNumber(intent.position?.sharesFilled ?? intent.executionRequest?.sharesEstimate);
  const liveShares = localShares && localShares > 0 ? null : await resolveLivePositionShares(env, intent);
  const shares = localShares && localShares > 0 ? localShares : liveShares;

  if (!shares || shares <= 0) {
    throw new Error('Trade intent does not have a valid filled share quantity for sell.');
  }

  const orderIntent = sellIntentForEntryIntent(intent.position?.entryIntent, intent.outcomeLabel);

  const orderBody = {
    marketSlug,
    intent: orderIntent,
    type: 'ORDER_TYPE_MARKET',
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    quantity: shares,
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
    maxBlockTime: '10'
  };

  const orderResponse = await createPolymarketUsOrder(env, orderBody);

  return {
    request: orderBody,
    response: orderResponse,
    orderId: getOrderId(orderResponse),
    sharesFilled: getSharesFromOrder(orderResponse),
    entryIntent: orderIntent
  };
}
