import axios from 'axios';
import { getUsMarketSlugsForEvent } from './us-orders.js';

const TOKEN_ALIASES = {
  usho: ['house'],
  ushouse: ['house'],
  ussen: ['senate'],
  ussenate: ['senate'],
  uspres: ['president', 'presidential'],
  dem: ['democratic', 'democrats'],
  rep: ['republican', 'republicans'],
  gop: ['republican', 'republicans']
};

const STOP_WORDS = new Set(['the', 'and', 'for', 'will', 'with', 'after', 'before', 'party']);

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
    slug: market.slug ?? null,
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

async function filterEventMarketsToUs(env, event) {
  const slugs = await getUsMarketSlugsForEvent(env, event.slug);

  if (slugs.size === 0) {
    return {
      ...event,
      markets: [],
      usFiltered: true,
      usAvailableMarketCount: 0
    };
  }

  const markets = event.markets.filter((market) => {
    const slug = String(market.slug ?? '').toLowerCase();
    return slug.length > 0 && slugs.has(slug);
  });

  return {
    ...event,
    markets,
    usFiltered: true,
    usAvailableMarketCount: markets.length
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

function normalizeSearchText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function expandTokens(tokens) {
  const expanded = new Set(tokens);

  for (const token of tokens) {
    const aliases = TOKEN_ALIASES[token];
    if (aliases) {
      for (const alias of aliases) {
        expanded.add(alias);
      }
    }
  }

  return [...expanded];
}

function scoreEventCandidate(slug, event) {
  const baseTokens = tokenize(slug);
  const tokens = expandTokens(baseTokens);
  const candidateText = normalizeSearchText(`${event.slug} ${event.title}`);
  let score = 0;

  for (const token of tokens) {
    if (candidateText.includes(token)) {
      score += token.length >= 5 ? 3 : 2;
    }
  }

  if (tokens.includes('house') && candidateText.includes('house')) {
    score += 4;
  }

  if (tokens.includes('senate') && candidateText.includes('senate')) {
    score += 4;
  }

  if (tokens.includes('midterms') && candidateText.includes('midterms')) {
    score += 3;
  }

  if (tokens.includes('2026') && candidateText.includes('2026')) {
    score += 2;
  }

  return score;
}

async function findFallbackEvent(env, slug) {
  const candidates = await fetchActiveEvents(env, { limit: 100, offset: 0 });
  const ranked = candidates
    .map((event) => ({
      event,
      score: scoreEventCandidate(slug, event)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  if (ranked.length === 0 || ranked[0].score < 6) {
    return null;
  }

  return ranked[0].event;
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

  try {
    const response = await gammaClient.get(`/events/slug/${encodeURIComponent(slug)}`);
    const event = Array.isArray(response.data) ? response.data[0] : response.data;

    if (!event) {
      throw new Error(`No Polymarket event was found for slug "${slug}".`);
    }

    return filterEventMarketsToUs(env, normalizeEvent(event));
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;

    if (status && status !== 404) {
      throw error;
    }

    const fallbackEvent = await findFallbackEvent(env, slug);

    if (!fallbackEvent) {
      throw new Error(`No Polymarket event was found for slug "${slug}".`);
    }

    return filterEventMarketsToUs(env, {
      ...fallbackEvent,
      requestedSlug: slug,
      resolvedFromFallback: true
    });
  }
}