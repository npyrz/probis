import axios from 'axios';

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOutcomes(market) {
  const labels = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices);
  const tokenIds = parseJsonArray(market.clobTokenIds);

  return labels.map((label, index) => ({
    label,
    price: toNumberOrNull(prices[index]),
    probability: toNumberOrNull(prices[index]),
    tokenId: tokenIds[index] ?? null
  }));
}

function normalizeMarket(market) {
  return {
    id: market.id ?? null,
    question: market.question ?? '',
    subtitle: market.subtitle ?? '',
    active: Boolean(market.active),
    closed: Boolean(market.closed),
    conditionId: market.conditionId ?? null,
    liquidity: toNumberOrNull(market.liquidity),
    volume: toNumberOrNull(market.volume),
    endDate: market.endDate ?? null,
    outcomes: normalizeOutcomes(market)
  };
}

function normalizeEvent(event) {
  return {
    id: event.id ?? null,
    slug: event.slug ?? '',
    title: event.title ?? event.question ?? '',
    description: event.description ?? '',
    active: Boolean(event.active),
    closed: Boolean(event.closed),
    endDate: event.endDate ?? null,
    startDate: event.startDate ?? null,
    liquidity: toNumberOrNull(event.liquidity),
    volume: toNumberOrNull(event.volume),
    markets: Array.isArray(event.markets) ? event.markets.map(normalizeMarket) : []
  };
}

function createGammaClient(env) {
  return axios.create({
    baseURL: env.gammaBaseUrl,
    timeout: 15000,
    headers: {
      Accept: 'application/json'
    }
  });
}

export function extractEventSlug(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('A Polymarket event URL or slug is required.');
  }

  const trimmed = input.trim();

  if (!trimmed.includes('://') && !trimmed.startsWith('polymarket.com/') && !trimmed.startsWith('polymarket.us/')) {
    return trimmed.replace(/^\/(event|events)\//, '').replace(/^\/+|\/+$/g, '');
  }

  const normalizedUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  const parsedUrl = new URL(normalizedUrl);
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  const eventIndex = segments.findIndex((segment) => segment === 'event' || segment === 'events');

  if (eventIndex === -1 || !segments[eventIndex + 1]) {
    throw new Error('Could not extract an event slug from the provided URL.');
  }

  return segments[eventIndex + 1];
}

export async function fetchActiveEvents(env, { limit = 10, offset = 0 } = {}) {
  const gammaClient = createGammaClient(env);
  const response = await gammaClient.get('/events', {
    params: {
      active: true,
      closed: false,
      limit,
      offset,
      order: 'volume_24hr',
      ascending: false
    }
  });

  return Array.isArray(response.data) ? response.data.map(normalizeEvent) : [];
}

export async function fetchEventByInput(env, input) {
  const gammaClient = createGammaClient(env);
  const slug = extractEventSlug(input);
  const response = await gammaClient.get(`/events/slug/${encodeURIComponent(slug)}`);
  const event = Array.isArray(response.data) ? response.data[0] : response.data;

  if (!event) {
    throw new Error(`No Polymarket event was found for slug "${slug}".`);
  }

  return normalizeEvent(event);
}