import axios from 'axios';
import nacl from 'tweetnacl';

const US_MARKETS_CACHE_TTL_MS = 60_000;
const QUOTE_REQUEST_TIMEOUT_MS = 2_500;
const usMarketsCache = new Map();
const MARKET_MATCH_STOP_WORDS = new Set([
  'the',
  'and',
  'vs',
  'will',
  'there',
  'be',
  'a',
  'an',
  'in',
  'on',
  'of',
  'for',
  'to'
]);

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

function createPolymarketUsClient(env, timeout = 30000) {
  return axios.create({
    baseURL: env.polymarketUsBaseUrl,
    timeout,
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

function extractSignedQuantity(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const directKeys = [
    'netPosition',
    'qtyAvailable',
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
    if (typeof numeric === 'number' && numeric !== 0) {
      return numeric;
    }
  }

  const nestedKeys = ['quantity', 'qty', 'size', 'shares', 'position', 'netPosition'];

  for (const key of nestedKeys) {
    const numeric = parseNumber(candidate[key]?.value);
    if (typeof numeric === 'number' && numeric !== 0) {
      return numeric;
    }
  }

  return null;
}

function extractPositionCashValue(position) {
  if (!position || typeof position !== 'object') {
    return null;
  }

  return parseNumber(
    position.cashValue?.value
    ?? position.cashValue
    ?? position.marketValue?.value
    ?? position.marketValue
    ?? position.notionalValue?.value
    ?? position.notionalValue
  );
}

function summarizePortfolioPositions(positions) {
  const summarizedPositions = (Array.isArray(positions) ? positions : [])
    .map((position) => {
      const signedQuantity = extractSignedQuantity(position);

      if (!Number.isFinite(signedQuantity) || signedQuantity === 0) {
        return null;
      }

      return {
        marketSlug: getPositionMarketSlug(position),
        outcome: getPositionOutcome(position),
        quantity: Math.abs(signedQuantity),
        signedQuantity,
        side: signedQuantity > 0 ? 'long' : 'short',
        cashValue: extractPositionCashValue(position),
        avgPrice: parseNumber(position.avgPx?.value ?? position.avgPx),
        updatedAt: typeof position.updateTime === 'string' ? position.updateTime : null
      };
    })
    .filter(Boolean);

  const totalCashValue = summarizedPositions.reduce((sum, position) => {
    return typeof position.cashValue === 'number' ? sum + position.cashValue : sum;
  }, 0);

  return {
    positions: summarizedPositions,
    totalCashValue
  };
}

function getPortfolioPositions(payload) {
  const positions = [];

  const pushPositionCollection = (value) => {
    if (Array.isArray(value)) {
      positions.push(...value);
      return;
    }

    if (value && typeof value === 'object') {
      positions.push(...Object.values(value));
    }
  };

  pushPositionCollection(payload);
  pushPositionCollection(payload?.positions);
  pushPositionCollection(payload?.availablePositions);
  pushPositionCollection(payload?.data?.positions);
  pushPositionCollection(payload?.data?.availablePositions);

  return positions;
}

function getOrdersFromPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.orders)) {
    return payload.orders;
  }

  if (Array.isArray(payload?.data?.orders)) {
    return payload.data.orders;
  }

  return [];
}

function getAccountBalances(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.balances)) {
    return payload.balances;
  }

  if (Array.isArray(payload?.data?.balances)) {
    return payload.data.balances;
  }

  return [];
}

function pickUsdBalance(balances) {
  if (!Array.isArray(balances) || balances.length === 0) {
    return null;
  }

  return balances.find((balance) => String(balance?.currency ?? '').toUpperCase() === 'USD')
    ?? balances[0]
    ?? null;
}

function extractUsdAccountSnapshot(usdBalance) {
  if (!usdBalance || typeof usdBalance !== 'object') {
    return null;
  }

  return {
    totalAccountBudget: parseNumber(
      usdBalance.currentBalance
      ?? usdBalance.balance
      ?? usdBalance.balance?.value
    ),
    buyingPower: parseNumber(
      usdBalance.buyingPower
      ?? usdBalance.availableBalance
      ?? usdBalance.available
      ?? usdBalance.available?.value
    ),
    assetNotional: parseNumber(
      usdBalance.assetNotional
      ?? usdBalance.assetValue
      ?? usdBalance.assetValue?.value
    ),
    assetAvailable: parseNumber(
      usdBalance.assetAvailable
      ?? usdBalance.availableAsset
      ?? usdBalance.availableAsset?.value
    ),
    pendingCredit: parseNumber(
      usdBalance.pendingCredit
      ?? usdBalance.pendingCredits
      ?? usdBalance.pendingCredits?.value
    ),
    openOrders: parseNumber(
      usdBalance.openOrders
      ?? usdBalance.openOrderNotional
      ?? usdBalance.openOrderNotional?.value
    ),
    unsettledFunds: parseNumber(
      usdBalance.unsettledFunds
      ?? usdBalance.unsettled
      ?? usdBalance.unsettled?.value
    ),
    marginRequirement: parseNumber(
      usdBalance.marginRequirement
      ?? usdBalance.marginUsed
      ?? usdBalance.marginUsed?.value
    ),
    budgetCurrency: String(usdBalance.currency ?? 'USD').toUpperCase(),
    balanceLastUpdatedAt: typeof usdBalance.lastUpdated === 'string' && usdBalance.lastUpdated.trim().length > 0
      ? usdBalance.lastUpdated
      : null
  };
}

async function fetchUsdAccountSnapshot(env) {
  const path = '/v1/account/balances';
  const client = createPolymarketUsClient(env);
  const response = await client.get(path, {
    headers: getSignedHeaders(env, 'GET', path)
  });
  const balances = getAccountBalances(response.data);
  const usdBalance = pickUsdBalance(balances);

  return extractUsdAccountSnapshot(usdBalance);
}

function getPositionOutcome(position) {
  return String(
    position?.outcome
    ?? position?.outcomeLabel
    ?? position?.marketMetadata?.outcome
    ?? position?.side
    ?? ''
  ).trim() || null;
}

function getOrderMarketSlug(order) {
  if (!order || typeof order !== 'object') {
    return null;
  }

  return order.marketSlug
    ?? order.market?.slug
    ?? order.marketMetadata?.slug
    ?? null;
}

function getOrderOutcome(order) {
  return String(
    order?.outcome
    ?? order?.outcomeLabel
    ?? order?.marketMetadata?.outcome
    ?? ''
  ).trim() || null;
}

function getOrderTimestampMs(order) {
  const timestamp = Date.parse(String(order?.createTime ?? order?.insertTime ?? ''));
  return Number.isFinite(timestamp) ? timestamp : null;
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

export async function fetchUsMarketsBySlug(env, slug, { includeClosed = true, timeoutMs = 30000 } = {}) {
  const normalizedSlug = String(slug ?? '').trim().toLowerCase();

  if (!normalizedSlug) {
    return [];
  }

  if (!env.polymarketUsKeyId || !env.polymarketUsSecretKey) {
    return [];
  }

  const path = '/v1/markets';
  const client = createPolymarketUsClient(env, timeoutMs);
  const candidateSlugs = [
    normalizedSlug,
    normalizedSlug.startsWith('aec-') ? normalizedSlug.slice(4) : `aec-${normalizedSlug}`
  ];
  const dedupedCandidates = [...new Set(candidateSlugs.filter(Boolean))];

  for (const candidateSlug of dedupedCandidates) {
    const params = new URLSearchParams();
    params.set('slug', candidateSlug);

    if (!includeClosed) {
      params.set('active', 'true');
      params.set('closed', 'false');
    }

    const requestPath = `${path}?${params.toString()}`;

    try {
      const response = await client.get(requestPath, {
        headers: getSignedHeaders(env, 'GET', path)
      });
      const markets = getUsMarketsFromPayload(response.data)
        .filter((market) => market && typeof market === 'object');

      if (markets.length > 0) {
        return markets;
      }
    } catch {
      // Continue trying slug variants.
    }
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

  return null;
}

function normalizeMatchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeMatchText(value) {
  return normalizeMatchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !MARKET_MATCH_STOP_WORDS.has(token));
}

function tokenOverlapCount(leftTokens, rightTokens) {
  const rightSet = new Set(rightTokens);
  let matches = 0;

  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      matches += 1;
    }
  }

  return matches;
}

function hasStrongQuestionMatch(question, targetQuestions, titleTokens) {
  const questionTokens = tokenizeMatchText(question);

  if (questionTokens.length === 0) {
    return false;
  }

  for (const target of targetQuestions) {
    const targetTokens = tokenizeMatchText(target);

    if (targetTokens.length === 0) {
      continue;
    }

    const overlap = tokenOverlapCount(questionTokens, targetTokens);
    const needed = Math.max(2, Math.ceil(Math.min(questionTokens.length, targetTokens.length) * 0.6));

    if (overlap >= needed) {
      return true;
    }
  }

  if (titleTokens.length > 0) {
    const overlapWithTitle = tokenOverlapCount(questionTokens, titleTokens);
    const neededFromTitle = Math.max(2, Math.ceil(titleTokens.length * 0.6));

    if (overlapWithTitle >= neededFromTitle) {
      return true;
    }
  }

  return false;
}

async function listUsMarkets(env, { limit = 200, maxPages = 20 } = {}) {
  const path = '/v1/markets';
  const cacheKey = `${env.polymarketUsBaseUrl}:${limit}:${maxPages}:active-open`;
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
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('active', 'true');
    params.set('closed', 'false');

    if (cursor) {
      params.set('cursor', cursor);
    } else if (offset > 0) {
      params.set('offset', String(offset));
    }

    const requestPath = `${path}?${params.toString()}`;
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

    const eof = getUsMarketsPageEof(payload);

    if (eof === true) {
      break;
    }

    const nextCursor = getUsMarketsPageCursor(payload);

    if (nextCursor) {
      cursor = nextCursor;
      continue;
    }

    // Some API responses omit cursor/eof fields but still support offset paging.
    if (markets.length < limit) {
      break;
    }

    offset += limit;
  }

  usMarketsCache.set(cacheKey, {
    markets: collected,
    expiresAt: Date.now() + US_MARKETS_CACHE_TTL_MS
  });

  return collected;
}

export async function listUsActiveMarkets(env, options = {}) {
  return listUsMarkets(env, options);
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

export async function getUsMarketAvailabilityForEvent(env, event) {
  const normalizedEventSlug = String(event?.slug ?? '').trim().toLowerCase();
  const titleTokens = tokenizeMatchText(event?.title ?? '');
  const targetQuestions = Array.isArray(event?.markets)
    ? event.markets.map((market) => String(market?.question ?? '')).filter(Boolean)
    : [];

  if (!normalizedEventSlug) {
    return {
      slugs: new Set(),
      questions: new Set()
    };
  }

  const markets = await listUsMarkets(env);
  const slugs = new Set();
  const questions = new Set();

  for (const market of markets) {
    const slug = typeof market?.slug === 'string' ? market.slug.toLowerCase() : '';
    const question = String(market?.question ?? '');

    if (!slug && !question) {
      continue;
    }

    const slugMatch = slug && (slug === normalizedEventSlug || slug.startsWith(`${normalizedEventSlug}-`));
    const questionMatch = hasStrongQuestionMatch(question, targetQuestions, titleTokens);

    if (slugMatch || questionMatch) {
      if (slug) {
        slugs.add(slug);
      }

      if (question) {
        questions.add(normalizeMatchText(question));
      }
    }
  }

  return {
    slugs,
    questions
  };
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

function normalizeMarketSlugValue(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^aec-/, '');
}

function marketSlugsMatch(left, right) {
  const normalizedLeft = normalizeMarketSlugValue(left);
  const normalizedRight = normalizeMarketSlugValue(right);

  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

async function fetchUsOrders(env) {
  const path = '/v1/orders';
  const client = createPolymarketUsClient(env);
  const response = await client.get(path, {
    headers: getSignedHeaders(env, 'GET', path)
  });

  return getOrdersFromPayload(response.data);
}

function isFilledOrder(order) {
  const orderState = String(getOrderState(order) ?? '').trim().toUpperCase();
  const sharesFilled = Number.parseFloat(getSharesFromOrder(order) ?? NaN);

  return orderState === 'ORDER_STATE_FILLED' || (Number.isFinite(sharesFilled) && sharesFilled > 0);
}

function getMatchingFilledSellOrdersForIntent(orders, intent, { entryOrderId, entryCreatedAtMs, expectedSellIntent }) {
  const normalizedRequestedSlug = normalizeMarketSlugValue(intent?.marketSlug);
  const normalizedOutcome = normalizeOutcomeLabel(intent?.outcomeLabel);

  return orders
    .filter((candidate) => {
      const candidateId = String(candidate?.id ?? '').trim();

      if (!candidateId || candidateId === entryOrderId) {
        return false;
      }

      const candidateIntent = String(candidate?.intent ?? '').trim().toUpperCase();
      const candidateAction = String(candidate?.action ?? '').trim().toUpperCase();
      const candidateSlug = getOrderMarketSlug(candidate);
      const candidateOutcome = normalizeOutcomeLabel(getOrderOutcome(candidate));
      const candidateCreatedAtMs = getOrderTimestampMs(candidate);
      const isSellIntentMatch = expectedSellIntent
        ? candidateIntent === expectedSellIntent
        : candidateIntent.startsWith('ORDER_INTENT_SELL_');
      const isSellAction = candidateAction === 'ORDER_ACTION_SELL';
      const isSameMarket = marketSlugsMatch(candidateSlug, normalizedRequestedSlug);
      const isSameOutcome = normalizedOutcome.length === 0
        || candidateOutcome.length === 0
        || candidateOutcome === normalizedOutcome;
      const isAfterEntry = !Number.isFinite(entryCreatedAtMs)
        || !Number.isFinite(candidateCreatedAtMs)
        || candidateCreatedAtMs >= entryCreatedAtMs;

      return isSameMarket
        && isSameOutcome
        && isAfterEntry
        && isFilledOrder(candidate)
        && (isSellIntentMatch || isSellAction);
    })
    .sort((left, right) => {
      const leftTs = getOrderTimestampMs(left) ?? 0;
      const rightTs = getOrderTimestampMs(right) ?? 0;
      return rightTs - leftTs;
    });
}

async function fetchPortfolioPositions(env) {
  const path = '/v1/portfolio/positions';
  const client = createPolymarketUsClient(env);
  const response = await client.get(path, {
    headers: getSignedHeaders(env, 'GET', path)
  });

  return getPortfolioPositions(response.data);
}

export async function resolveIntentOrderFillState(env, intent) {
  const marketSlug = String(intent?.marketSlug ?? '').trim();
  const entryOrderId = String(intent?.executionRequest?.venueOrderId ?? intent?.position?.entryOrderId ?? '').trim();

  if (!marketSlug) {
    return {
      entryOrder: null,
      entryShares: null,
      soldShares: 0,
      remainingShares: null,
      latestSellOrder: null
    };
  }

  let entryOrder = intent?.executionRequest?.venueOrder ?? null;

  if (entryOrderId && String(entryOrder?.id ?? '').trim() !== entryOrderId) {
    entryOrder = await getPolymarketUsOrderById(env, entryOrderId);
  }

  const expectedSellIntent = sellIntentForEntryIntent(intent?.position?.entryIntent, intent?.outcomeLabel);
  const entryCreatedAtMs = getOrderTimestampMs(entryOrder)
    ?? Date.parse(String(intent?.confirmedAt ?? intent?.createdAt ?? ''));
  const entryShares = Number.parseFloat(
    getSharesFromOrder(entryOrder) ?? intent?.position?.sharesFilled ?? intent?.executionRequest?.sharesEstimate ?? NaN
  );
  let matchingSellOrders = [];

  try {
    const orders = await fetchUsOrders(env);
    matchingSellOrders = getMatchingFilledSellOrdersForIntent(orders, intent, {
      entryOrderId,
      entryCreatedAtMs,
      expectedSellIntent
    });
  } catch {
    matchingSellOrders = [];
  }

  const soldShares = matchingSellOrders.reduce((sum, order) => {
    const shares = Number.parseFloat(getSharesFromOrder(order) ?? NaN);
    return Number.isFinite(shares) && shares > 0 ? sum + shares : sum;
  }, 0);
  const remainingShares = Number.isFinite(entryShares) && entryShares > 0
    ? Math.max(0, entryShares - soldShares)
    : null;

  return {
    entryOrder,
    entryShares: Number.isFinite(entryShares) && entryShares > 0 ? entryShares : null,
    soldShares,
    remainingShares,
    latestSellOrder: matchingSellOrders[0] ?? null
  };
}

export async function resolveLivePositionShares(env, intent) {
  const fillState = await resolveIntentOrderFillState(env, intent);
  return Number.isFinite(fillState.remainingShares) && fillState.remainingShares > 0
    ? fillState.remainingShares
    : null;
}

function normalizeOutcomeLabel(label) {
  return String(label ?? '').trim().toLowerCase();
}

function parseOutcomeLabels(value) {
  if (Array.isArray(value)) {
    return value.map((label) => String(label ?? '').trim()).filter(Boolean);
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((label) => String(label ?? '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function parseOutcomePrices(value) {
  if (Array.isArray(value)) {
    return value.map((price) => parseNumber(price));
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((price) => parseNumber(price))
      : [];
  } catch {
    return [];
  }
}

function normalizeOutcomeForComparison(label) {
  return String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isLimitPriceRequiredError(error) {
  const message = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return message.includes('price is required for limit order');
}

function normalizeLimitPrice(price) {
  const numeric = parseNumber(price);

  if (typeof numeric !== 'number' || numeric <= 0) {
    return null;
  }

  return Number(numeric.toFixed(3));
}

function hasPositiveFill(orderResponse) {
  const sharesFilled = parseNumber(getSharesFromOrder(orderResponse));
  return typeof sharesFilled === 'number' && sharesFilled > 0;
}

function clampLimitPrice(value) {
  const numeric = parseNumber(value);

  if (typeof numeric !== 'number') {
    return null;
  }

  // Binary outcome prices must remain within (0, 1).
  const clamped = Math.min(0.999, Math.max(0.001, numeric));
  return normalizeLimitPrice(clamped);
}

function computeAggressiveBuyLimitPrice(basePrice, maxSlippageBps, minimumStep = 0.01) {
  const normalizedBasePrice = normalizeLimitPrice(basePrice);

  if (!normalizedBasePrice) {
    return null;
  }

  const slippageFactor = Number.isFinite(maxSlippageBps)
    ? (1 + Math.max(0, maxSlippageBps) / 10000)
    : 1.01;
  const slippageAdjustedPrice = normalizedBasePrice * slippageFactor;
  // Ensure a small minimum step-up to improve immediate fill probability on thin books.
  const withMinimumBump = Math.max(slippageAdjustedPrice, normalizedBasePrice + minimumStep);

  return clampLimitPrice(withMinimumBump);
}

function isShortBuyOrderIntent(orderIntent) {
  return orderIntent === 'ORDER_INTENT_BUY_SHORT';
}

function resolveBuyLongPriceCap(intent, basePrice) {
  const normalizedBasePrice = normalizeLimitPrice(basePrice);

  if (!normalizedBasePrice) {
    return null;
  }

  const takeProfitProbability = parseNumber(intent?.tradeSuggestion?.takeProfitProbability);

  if (typeof takeProfitProbability === 'number' && takeProfitProbability > 0) {
    const cappedByTakeProfit = clampLimitPrice(takeProfitProbability - 0.005);

    if (typeof cappedByTakeProfit === 'number' && cappedByTakeProfit > normalizedBasePrice) {
      return cappedByTakeProfit;
    }
  }

  // Fallback cap when take-profit is unavailable: allow a wider sweep but avoid near-1.0 bids.
  const widenedCap = clampLimitPrice(normalizedBasePrice + 0.20);

  if (typeof widenedCap === 'number' && widenedCap > normalizedBasePrice) {
    return Math.min(widenedCap, 0.95);
  }

  return clampLimitPrice(Math.min(normalizedBasePrice + 0.05, 0.95));
}

function resolveBuyShortPriceFloor(basePrice) {
  const normalizedBasePrice = normalizeLimitPrice(basePrice);

  if (!normalizedBasePrice) {
    return null;
  }

  // BUY_SHORT routes through SELL-side behavior, so lower prices are more marketable.
  const widenedFloor = clampLimitPrice(normalizedBasePrice - 0.20);

  if (typeof widenedFloor === 'number' && widenedFloor < normalizedBasePrice) {
    return Math.max(widenedFloor, 0.05);
  }

  return clampLimitPrice(Math.max(normalizedBasePrice - 0.05, 0.05));
}

function buildAggressiveBuyLimitLadder(basePrice, maxSlippageBps, { direction = 'up', boundary = null } = {}) {
  const normalizedBasePrice = normalizeLimitPrice(basePrice);

  if (!normalizedBasePrice) {
    return [];
  }

  if (direction === 'down') {
    const primary = clampLimitPrice(normalizedBasePrice - 0.01);
    const secondary = clampLimitPrice(normalizedBasePrice - 0.02);
    const tertiary = clampLimitPrice(normalizedBasePrice - 0.05);
    const quaternary = clampLimitPrice(normalizedBasePrice - 0.08);
    const quinary = clampLimitPrice(normalizedBasePrice - 0.15);
    const values = [primary, secondary, tertiary, quaternary, quinary, boundary]
      .filter((price) => typeof price === 'number');

    return [...new Set(values)]
      .filter((price) => {
        if (typeof boundary !== 'number') {
          return true;
        }

        return price >= boundary;
      })
      .sort((left, right) => right - left);
  }

  const primary = computeAggressiveBuyLimitPrice(normalizedBasePrice, maxSlippageBps, 0.01);
  const secondary = computeAggressiveBuyLimitPrice(normalizedBasePrice, Math.max(maxSlippageBps * 2, 300), 0.02);
  const tertiary = computeAggressiveBuyLimitPrice(normalizedBasePrice, Math.max(maxSlippageBps * 4, 800), 0.05);
  const quaternary = clampLimitPrice(normalizedBasePrice + 0.08);
  const quinary = clampLimitPrice(normalizedBasePrice + 0.15);
  const values = [primary, secondary, tertiary, quaternary, quinary, boundary]
    .filter((price) => typeof price === 'number');

  return [...new Set(values)]
    .filter((price) => {
      if (typeof boundary !== 'number') {
        return true;
      }

      return price <= boundary;
    })
    .sort((left, right) => left - right);
}

function buildAggressiveSellLimitLadder(basePrice, floor = 0.001) {
  return buildAggressiveBuyLimitLadder(basePrice, 0, {
    direction: 'down',
    boundary: clampLimitPrice(floor)
  });
}

function resolveFallbackSellQuotePrice(orderIntent, outcomePrice) {
  const normalizedOutcomePrice = normalizeLimitPrice(outcomePrice);

  if (!normalizedOutcomePrice) {
    return null;
  }

  if (orderIntent === 'ORDER_INTENT_SELL_SHORT') {
    return clampLimitPrice(1 - normalizedOutcomePrice);
  }

  return normalizedOutcomePrice;
}

async function submitLimitBuyOrder(env, { marketSlug, orderIntent, amount, limitPrice }) {
  const limitQuantity = Number((amount / limitPrice).toFixed(4));

  if (!Number.isFinite(limitQuantity) || limitQuantity <= 0) {
    throw new Error('Unable to derive a valid quantity for limit order fallback.');
  }

  const limitOrderBody = {
    marketSlug,
    intent: orderIntent,
    type: 'ORDER_TYPE_LIMIT',
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    price: {
      value: limitPrice.toFixed(3),
      currency: 'USD'
    },
    quantity: limitQuantity,
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
    maxBlockTime: '10'
  };

  const orderResponse = await createPolymarketUsOrder(env, limitOrderBody);

  return {
    request: limitOrderBody,
    response: orderResponse,
    orderId: getOrderId(orderResponse),
    sharesFilled: getSharesFromOrder(orderResponse),
    notionalSpent: getSpentFromOrder(orderResponse),
    entryIntent: orderIntent
  };
}

async function submitLimitSellOrder(env, { marketSlug, orderIntent, shares, limitPrice }) {
  const limitOrderBody = {
    marketSlug,
    intent: orderIntent,
    type: 'ORDER_TYPE_LIMIT',
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    price: {
      value: limitPrice.toFixed(3),
      currency: 'USD'
    },
    quantity: shares,
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
    maxBlockTime: '10'
  };

  const orderResponse = await createPolymarketUsOrder(env, limitOrderBody);

  return {
    request: limitOrderBody,
    response: orderResponse,
    orderId: getOrderId(orderResponse),
    sharesFilled: getSharesFromOrder(orderResponse),
    sharesRequested: shares,
    entryIntent: orderIntent
  };
}

async function resolveOutcomeMarketQuote(env, marketSlug, outcomeLabel) {
  const markets = await fetchUsMarketsBySlug(env, marketSlug, {
    includeClosed: true,
    timeoutMs: QUOTE_REQUEST_TIMEOUT_MS
  });
  const market = markets.find((candidate) => String(candidate?.slug ?? '').toLowerCase() === String(marketSlug).toLowerCase())
    ?? markets[0]
    ?? null;

  if (!market) {
    throw new Error(`Unable to resolve Polymarket US market metadata for slug "${marketSlug}".`);
  }

  const outcomes = parseOutcomeLabels(market.outcomes);
  const outcomePrices = parseOutcomePrices(market.outcomePrices);

  if (outcomes.length < 2 || outcomePrices.length < 2) {
    throw new Error(`Polymarket US market "${marketSlug}" does not expose enough outcome pricing metadata.`);
  }

  const normalizedOutcome = normalizeOutcomeForComparison(outcomeLabel);
  const matchingIndex = outcomes.findIndex((candidate) => normalizeOutcomeForComparison(candidate) === normalizedOutcome);

  if (matchingIndex < 0 || matchingIndex >= outcomePrices.length) {
    throw new Error(
      `Outcome "${outcomeLabel}" does not match market outcomes for "${marketSlug}": ${outcomes.join(' / ')}.`
    );
  }

  const outcomePrice = normalizeLimitPrice(outcomePrices[matchingIndex]);

  if (!outcomePrice) {
    throw new Error(`Unable to derive a valid limit price for outcome "${outcomeLabel}" in "${marketSlug}".`);
  }

  return {
    resolvedMarketSlug: market.slug ?? marketSlug,
    matchingIndex,
    outcomePrice
  };
}

export async function getLiveOutcomeProbabilityFromUsMarket(env, marketSlug, outcomeLabel) {
  if (!marketSlug) {
    return null;
  }

  const [bboResult, quoteResult] = await Promise.allSettled([
    fetchBboForMarket(env, marketSlug),
    resolveOutcomeMarketQuote(env, marketSlug, outcomeLabel)
  ]);

  const bboPrice = bboResult.status === 'fulfilled' && quoteResult.status === 'fulfilled'
    ? getBboExecutablePriceForOutcome(bboResult.value, quoteResult.value.matchingIndex)
    : null;

  if (typeof bboPrice === 'number') {
    return bboPrice;
  }

  if (quoteResult.status === 'fulfilled') {
    return typeof quoteResult.value?.outcomePrice === 'number' ? quoteResult.value.outcomePrice : null;
  }

  return null;
}

async function fetchBboForMarket(env, marketSlug) {
  const normalizedSlug = String(marketSlug ?? '').trim();

  if (!normalizedSlug) {
    return null;
  }

  const candidateSlugs = [
    normalizedSlug,
    normalizedSlug.startsWith('aec-') ? normalizedSlug.slice(4) : `aec-${normalizedSlug}`
  ];
  const dedupedCandidates = [...new Set(candidateSlugs.filter(Boolean))];
  const client = createPolymarketUsClient(env, QUOTE_REQUEST_TIMEOUT_MS);

  for (const candidateSlug of dedupedCandidates) {
    const encodedSlug = encodeURIComponent(candidateSlug);
    const path = `/v1/markets/${encodedSlug}/bbo`;

    try {
      const response = await client.get(path, {
        headers: getSignedHeaders(env, 'GET', path)
      });

      return response.data ?? null;
    } catch {
      // Try the next candidate slug.
    }
  }

  return null;
}

function getBboExecutablePriceForOutcome(bbo, outcomeIndex) {
  const marketData = bbo?.marketData ?? bbo;

  if (!marketData || typeof marketData !== 'object') {
    return null;
  }

  const bestBid = parseNumber(marketData.bestBid?.price?.value ?? marketData.bestBid?.price ?? marketData.bestBid?.value ?? marketData.bestBid ?? marketData.bid?.price?.value ?? marketData.bid?.price ?? marketData.bid);
  const bestAsk = parseNumber(marketData.bestAsk?.price?.value ?? marketData.bestAsk?.price ?? marketData.bestAsk?.value ?? marketData.bestAsk ?? marketData.ask?.price?.value ?? marketData.ask?.price ?? marketData.ask);

  if (outcomeIndex === 1) {
    if (typeof bestAsk === 'number' && bestAsk > 0) {
      return normalizeLimitPrice(1 - bestAsk);
    }

    if (typeof bestBid === 'number' && bestBid > 0) {
      return normalizeLimitPrice(1 - bestBid);
    }

    return null;
  }

  if (typeof bestBid === 'number' && bestBid > 0) {
    return normalizeLimitPrice(bestBid);
  }

  if (typeof bestAsk === 'number' && bestAsk > 0) {
    return normalizeLimitPrice(bestAsk);
  }

  return null;
}

async function resolveOrderIntentsForOutcome(env, marketSlug, outcomeLabel) {
  const normalized = normalizeOutcomeLabel(outcomeLabel);

  if (normalized === 'yes') {
    return {
      buy: 'ORDER_INTENT_BUY_LONG',
      sell: 'ORDER_INTENT_SELL_LONG'
    };
  }

  if (normalized === 'no') {
    return {
      buy: 'ORDER_INTENT_BUY_SHORT',
      sell: 'ORDER_INTENT_SELL_SHORT'
    };
  }

  if (!marketSlug) {
    throw new Error(`Unsupported outcomeLabel "${outcomeLabel}" for Polymarket US order intent.`);
  }

  const markets = await fetchUsMarketsBySlug(env, marketSlug, { includeClosed: true });
  const market = markets.find((candidate) => String(candidate?.slug ?? '').toLowerCase() === String(marketSlug).toLowerCase())
    ?? markets[0]
    ?? null;

  if (!market) {
    throw new Error(`Unable to resolve Polymarket US market metadata for slug "${marketSlug}".`);
  }

  const outcomes = parseOutcomeLabels(market.outcomes);

  if (outcomes.length < 2) {
    throw new Error(`Polymarket US market "${marketSlug}" does not expose at least two outcomes.`);
  }

  const normalizedOutcome = normalizeOutcomeForComparison(outcomeLabel);
  const matchingIndex = outcomes.findIndex((candidate) => normalizeOutcomeForComparison(candidate) === normalizedOutcome);

  if (matchingIndex === 0) {
    return {
      resolvedMarketSlug: market.slug ?? marketSlug,
      buy: 'ORDER_INTENT_BUY_LONG',
      sell: 'ORDER_INTENT_SELL_LONG'
    };
  }

  if (matchingIndex === 1) {
    return {
      resolvedMarketSlug: market.slug ?? marketSlug,
      buy: 'ORDER_INTENT_BUY_SHORT',
      sell: 'ORDER_INTENT_SELL_SHORT'
    };
  }

  throw new Error(
    `Outcome "${outcomeLabel}" does not match market outcomes for "${marketSlug}": ${outcomes.join(' / ')}.`
  );
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

  return null;
}

function getOrderId(orderResponse) {
  const order = orderResponse?.order ?? orderResponse;
  return order?.id ?? orderResponse?.id ?? null;
}

export function getOrderState(orderResponse) {
  const order = orderResponse?.order ?? orderResponse;
  const directState = String(order?.state ?? '').trim();

  if (directState.length > 0) {
    return directState;
  }

  const executions = Array.isArray(orderResponse?.executions) ? orderResponse.executions : [];
  const latestExecution = executions[executions.length - 1] ?? executions[0] ?? null;
  const executionState = String(latestExecution?.order?.state ?? '').trim();

  return executionState.length > 0 ? executionState : null;
}

export function getSharesFromOrder(orderResponse) {
  const order = orderResponse?.order ?? orderResponse;
  const executions = Array.isArray(orderResponse?.executions)
    ? orderResponse.executions
    : (Array.isArray(order?.executions) ? order.executions : []);
  const fromExecutions = executions.reduce((sum, execution) => {
    const filled = parseNumber(execution?.lastShares);
    return filled ? sum + filled : sum;
  }, 0);

  if (fromExecutions > 0) {
    return fromExecutions;
  }

  const firstOrder = executions[0]?.order ?? order;
  const fromCumQuantity = parseNumber(firstOrder?.cumQuantity ?? order?.cumQuantity);

  if (typeof fromCumQuantity === 'number' && fromCumQuantity > 0) {
    return fromCumQuantity;
  }

  return null;
}

export function getSpentFromOrder(orderResponse) {
  const order = orderResponse?.order ?? orderResponse;
  const executions = Array.isArray(orderResponse?.executions)
    ? orderResponse.executions
    : (Array.isArray(order?.executions) ? order.executions : []);

  const spent = executions.reduce((sum, execution) => {
    const qty = parseNumber(execution?.lastShares);
    const px = parseNumber(execution?.lastPx?.value);

    if (typeof qty === 'number' && typeof px === 'number') {
      return sum + (qty * px);
    }

    return sum;
  }, 0);

  if (spent > 0) {
    return spent;
  }

  const cumQuantity = parseNumber(order?.cumQuantity);
  const avgPx = parseNumber(order?.avgPx?.value);

  if (typeof cumQuantity === 'number' && cumQuantity > 0 && typeof avgPx === 'number' && avgPx > 0) {
    return cumQuantity * avgPx;
  }

  return null;
}

export async function getPolymarketUsOrderById(env, orderId) {
  const normalizedOrderId = String(orderId ?? '').trim();

  if (!normalizedOrderId) {
    throw new Error('Order ID is required to fetch order status.');
  }

  const encodedOrderId = encodeURIComponent(normalizedOrderId);
  const path = `/v1/order/${encodedOrderId}`;
  const client = createPolymarketUsClient(env);

  try {
    const response = await client.get(path, {
      headers: getSignedHeaders(env, 'GET', path)
    });

    return response.data?.order ?? response.data;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function findRecentFilledSellOrderForIntent(env, intent) {
  const fillState = await resolveIntentOrderFillState(env, intent);
  return fillState.latestSellOrder ?? null;
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

export async function createPolymarketUsClosePositionOrder(env, body) {
  const path = '/v1/order/close-position';
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
    totalAccountBudget: null,
    reportedCurrentBalance: null,
    buyingPower: null,
    positionsCashValue: null,
    assetNotional: null,
    assetAvailable: null,
    pendingCredit: null,
    openOrders: null,
    unsettledFunds: null,
    marginRequirement: null,
    budgetCurrency: 'USD',
    balanceLastUpdatedAt: null,
    error: null
  };

  if (!status.configured || !status.secretKeyValid) {
    if (status.configured && !status.secretKeyValid) {
      status.error = 'Secret key is not a valid base64 Ed25519 seed.';
    }

    return status;
  }

  try {
    const [snapshotResult, positionsResult] = await Promise.allSettled([
      fetchUsdAccountSnapshot(env),
      fetchPortfolioPositions(env)
    ]);
    status.authenticated = snapshotResult.status === 'fulfilled' || positionsResult.status === 'fulfilled';

    if (snapshotResult.status === 'fulfilled' && snapshotResult.value) {
      const snapshot = snapshotResult.value;
      status.reportedCurrentBalance = snapshot.totalAccountBudget;
      status.buyingPower = snapshot.buyingPower;
      status.assetNotional = snapshot.assetNotional;
      status.assetAvailable = snapshot.assetAvailable;
      status.pendingCredit = snapshot.pendingCredit;
      status.openOrders = snapshot.openOrders;
      status.unsettledFunds = snapshot.unsettledFunds;
      status.marginRequirement = snapshot.marginRequirement;
      status.budgetCurrency = snapshot.budgetCurrency;
      status.balanceLastUpdatedAt = snapshot.balanceLastUpdatedAt;
      status.totalAccountBudget = snapshot.totalAccountBudget;
    }

    if (positionsResult.status === 'fulfilled') {
      const portfolio = summarizePortfolioPositions(positionsResult.value);
      status.positionsCashValue = portfolio.totalCashValue;

      if (typeof status.buyingPower === 'number') {
        status.totalAccountBudget = status.buyingPower + portfolio.totalCashValue;
      }
    }

    if (snapshotResult.status === 'rejected' && positionsResult.status === 'rejected') {
      status.error = getErrorMessage(snapshotResult.reason);
    }
  } catch (error) {
    status.error = getErrorMessage(error);
  }

  return status;
}

export async function getPolymarketUsAccountIdentity(env) {
  const identity = {
    configured: Boolean(env.polymarketUsKeyId && env.polymarketUsSecretKey),
    endpoint: env.polymarketUsBaseUrl,
    keyIdSuffix: env.polymarketUsKeyId ? String(env.polymarketUsKeyId).slice(-8) : null,
    authenticated: false,
    totalAccountBudget: null,
    reportedCurrentBalance: null,
    buyingPower: null,
    positionsCashValue: null,
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
    error: null
  };

  if (!identity.configured) {
    return identity;
  }

  try {
    const [positionsResult, snapshotResult] = await Promise.allSettled([
      fetchPortfolioPositions(env),
      fetchUsdAccountSnapshot(env)
    ]);

    identity.authenticated = positionsResult.status === 'fulfilled' || snapshotResult.status === 'fulfilled';

    if (snapshotResult.status === 'fulfilled' && snapshotResult.value) {
      identity.reportedCurrentBalance = snapshotResult.value.totalAccountBudget;
      identity.totalAccountBudget = snapshotResult.value.totalAccountBudget;
      identity.buyingPower = snapshotResult.value.buyingPower;
      identity.assetNotional = snapshotResult.value.assetNotional;
      identity.assetAvailable = snapshotResult.value.assetAvailable;
      identity.pendingCredit = snapshotResult.value.pendingCredit;
      identity.openOrders = snapshotResult.value.openOrders;
      identity.unsettledFunds = snapshotResult.value.unsettledFunds;
      identity.marginRequirement = snapshotResult.value.marginRequirement;
      identity.budgetCurrency = snapshotResult.value.budgetCurrency;
      identity.balanceLastUpdatedAt = snapshotResult.value.balanceLastUpdatedAt;
    }

    if (positionsResult.status !== 'fulfilled') {
      if (snapshotResult.status === 'rejected') {
        identity.error = getErrorMessage(positionsResult.reason);
      }

      return identity;
    }

    const positions = positionsResult.value;
    const portfolio = summarizePortfolioPositions(positions);

    identity.positionsCashValue = portfolio.totalCashValue;
    if (typeof identity.buyingPower === 'number') {
      identity.totalAccountBudget = identity.buyingPower + portfolio.totalCashValue;
    }
    identity.openPositionsCount = portfolio.positions.length;
    identity.openPositions = portfolio.positions.slice(0, 10);
  } catch (error) {
    identity.error = getErrorMessage(error);
  }

  return identity;
}

export async function placeBuyOrderForIntent(env, intent) {
  const requestedMarketSlug = intent.marketSlug;

  if (!requestedMarketSlug) {
    throw new Error('Trade intent is missing marketSlug. Re-resolve the event and save a new intent before executing.');
  }

  const amount = parseNumber(intent.tradeAmount ?? intent.tradeSuggestion?.amount);

  if (!amount || amount <= 0) {
    throw new Error('Trade intent has invalid tradeAmount for market buy.');
  }

  const orderIntents = await resolveOrderIntentsForOutcome(env, requestedMarketSlug, intent.outcomeLabel);
  const marketSlug = orderIntents.resolvedMarketSlug ?? requestedMarketSlug;
  const orderIntent = orderIntents.buy;
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

  let orderResponse;
  let marketAttempt;

  try {
    orderResponse = await createPolymarketUsOrder(env, orderBody);
    marketAttempt = {
      request: orderBody,
      response: orderResponse,
      orderId: getOrderId(orderResponse),
      sharesFilled: getSharesFromOrder(orderResponse),
      notionalSpent: getSpentFromOrder(orderResponse),
      entryIntent: orderIntent
    };

    if (hasPositiveFill(orderResponse)) {
      return marketAttempt;
    }
  } catch (error) {
    if (!isLimitPriceRequiredError(error)) {
      throw error;
    }
  }

  const quote = await resolveOutcomeMarketQuote(env, marketSlug, intent.outcomeLabel);
  const maxSlippageBpsForRetry = Number.isFinite(maxSlippageBps) ? maxSlippageBps : 100;
  const isShortBuy = isShortBuyOrderIntent(orderIntent);
  const boundary = isShortBuy
    ? resolveBuyShortPriceFloor(quote.outcomePrice)
    : resolveBuyLongPriceCap(intent, quote.outcomePrice);
  const aggressiveLimitPrices = buildAggressiveBuyLimitLadder(
    quote.outcomePrice,
    maxSlippageBpsForRetry,
    { direction: isShortBuy ? 'down' : 'up', boundary }
  );

  if (aggressiveLimitPrices.length === 0) {
    throw new Error('Unable to derive a valid limit price for buy retry.');
  }

  const limitAttempts = [];

  for (const limitPrice of aggressiveLimitPrices) {
    const limitAttempt = await submitLimitBuyOrder(env, {
      marketSlug: quote.resolvedMarketSlug,
      orderIntent,
      amount,
      limitPrice
    });

    limitAttempts.push(limitAttempt);

    if (hasPositiveFill(limitAttempt.response)) {
      return {
        ...limitAttempt,
        attempts: {
          market: marketAttempt ?? null,
          aggressiveLimit: limitAttempts
        }
      };
    }
  }

  const lastLimitAttempt = limitAttempts[limitAttempts.length - 1] ?? null;

  if (!lastLimitAttempt) {
    throw new Error('Unable to submit aggressive limit buy retry attempts.');
  }

  return {
    ...lastLimitAttempt,
    attempts: {
      market: marketAttempt ?? null,
      aggressiveLimit: limitAttempts
    }
  };
}

export async function placeSellOrderForIntent(env, intent) {
  const requestedMarketSlug = intent.marketSlug;

  if (!requestedMarketSlug) {
    throw new Error('Trade intent is missing marketSlug and cannot be sold automatically.');
  }

  const orderIntents = await resolveOrderIntentsForOutcome(env, requestedMarketSlug, intent.outcomeLabel);
  const marketSlug = orderIntents.resolvedMarketSlug ?? requestedMarketSlug;

  const localShares = parseNumber(intent.position?.sharesFilled ?? intent.executionRequest?.sharesEstimate);
  let resolvedShares;

  try {
    const fillState = await resolveIntentOrderFillState(env, intent);
    resolvedShares = Number.isFinite(fillState.remainingShares)
      ? fillState.remainingShares
      : null;
  } catch {
    resolvedShares = null;
  }

  const shares = Number.isFinite(resolvedShares)
    ? resolvedShares
    : localShares;

  if (!shares || shares <= 0) {
    throw new Error('Trade intent does not have a valid filled share quantity for sell.');
  }

  let orderIntent = sellIntentForEntryIntent(intent.position?.entryIntent, intent.outcomeLabel);

  if (!orderIntent) {
    orderIntent = orderIntents.sell;
  }

  const maxSlippageBps = Number.parseInt(intent.executionRequest?.maxSlippageBps ?? '100', 10);
  const closePositionOrderBody = {
    marketSlug,
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
    maxBlockTime: '10',
    slippageTolerance: {
      bips: Number.isFinite(maxSlippageBps) ? maxSlippageBps : 100
    }
  };

  try {
    const orderResponse = await createPolymarketUsClosePositionOrder(env, closePositionOrderBody);
    const orderState = String(getOrderState(orderResponse) ?? '').trim().toUpperCase();

    return {
      request: closePositionOrderBody,
      response: orderResponse,
      orderId: getOrderId(orderResponse),
      sharesFilled: getSharesFromOrder(orderResponse),
      sharesRequested: shares,
      fullyClosed: orderState === 'ORDER_STATE_FILLED',
      orderState,
      entryIntent: orderIntent,
      exitMethod: 'close-position'
    };
  } catch (error) {
    if (!isLimitPriceRequiredError(error)) {
      throw error;
    }
  }

  const quote = await resolveOutcomeMarketQuote(env, marketSlug, intent.outcomeLabel);
  const fallbackQuotePrice = resolveFallbackSellQuotePrice(orderIntent, quote.outcomePrice);

  if (!fallbackQuotePrice) {
    throw new Error('Unable to derive a valid executable limit price for sell retry.');
  }

  const aggressiveLimitPrices = buildAggressiveSellLimitLadder(fallbackQuotePrice);

  if (aggressiveLimitPrices.length === 0) {
    throw new Error('Unable to derive a valid limit price for sell retry.');
  }

  const limitAttempts = [];

  for (const limitPrice of aggressiveLimitPrices) {
    const limitAttempt = await submitLimitSellOrder(env, {
      marketSlug: quote.resolvedMarketSlug ?? marketSlug,
      orderIntent,
      shares,
      limitPrice
    });

    limitAttempts.push(limitAttempt);

    if (hasPositiveFill(limitAttempt.response)) {
      const limitAttemptState = String(getOrderState(limitAttempt.response) ?? '').trim().toUpperCase();
      const limitAttemptSharesFilled = Number.parseFloat(getSharesFromOrder(limitAttempt.response) ?? NaN);

      return {
        ...limitAttempt,
        fullyClosed: limitAttemptState === 'ORDER_STATE_FILLED'
          && Number.isFinite(limitAttemptSharesFilled)
          && limitAttemptSharesFilled >= shares,
        orderState: limitAttemptState,
        exitMethod: 'limit-fallback',
        attempts: {
          aggressiveLimit: limitAttempts
        }
      };
    }
  }

  const lastLimitAttempt = limitAttempts[limitAttempts.length - 1] ?? null;

  if (!lastLimitAttempt) {
    throw new Error('Unable to submit aggressive limit sell retry attempts.');
  }

  const fallbackState = String(getOrderState(lastLimitAttempt.response) ?? '').trim().toUpperCase();
  const fallbackSharesFilled = Number.parseFloat(getSharesFromOrder(lastLimitAttempt.response) ?? NaN);

  return {
    ...lastLimitAttempt,
    sharesRequested: shares,
    fullyClosed: fallbackState === 'ORDER_STATE_FILLED'
      && Number.isFinite(fallbackSharesFilled)
      && fallbackSharesFilled >= shares,
    orderState: fallbackState,
    entryIntent: orderIntent,
    exitMethod: 'limit-fallback',
    attempts: {
      aggressiveLimit: limitAttempts
    }
  };
}
