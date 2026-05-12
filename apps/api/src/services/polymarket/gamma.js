import axios from 'axios';
import { fetchUsMarketsBySlug, getUsMarketAvailabilityForEvent } from './us-orders.js';
import { isWeatherEvent } from '../weather/event-intelligence.js';

const STOP_WORDS = new Set(['the', 'and', 'for', 'will', 'with', 'after', 'before']);

export class UnsupportedMarketError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedMarketError';
    this.statusCode = 400;
  }
}

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
  const fallbackConditionId = market.conditionId ?? market.slug ?? market.id ?? null;

  return {
    id: market.id ?? null,
    slug: market.slug ?? null,
    question: market.question ?? '',
    title: market.title ?? null,
    subtitle: market.subtitle ?? '',
    description: market.description ?? '',
    category: typeof market?.category === 'string' ? market.category.toLowerCase() : null,
    rules: market.rules ?? market.marketRules ?? null,
    resolutionSource: market.resolutionSource ?? market.resolution_source ?? null,
    active: Boolean(market.active),
    closed: Boolean(market.closed),
    conditionId: fallbackConditionId,
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
    category: typeof event?.category === 'string' ? event.category.toLowerCase() : null,
    rules: event.rules ?? event.marketRules ?? null,
    resolutionSource: event.resolutionSource ?? event.resolution_source ?? null,
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
  const availability = await getUsMarketAvailabilityForEvent(env, event);
  const slugs = availability.slugs;
  const questions = availability.questions;

  if (slugs.size === 0 && questions.size === 0) {
    if (Array.isArray(event.markets) && event.markets.length > 0) {
      return {
        ...event,
        usFiltered: false,
        usAvailableMarketCount: event.markets.length,
        usFilterFallbackRetainedOriginalMarkets: true
      };
    }

    return {
      ...event,
      markets: [],
      usFiltered: true,
      usAvailableMarketCount: 0
    };
  }

  const normalizeQuestion = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const markets = event.markets.filter((market) => {
    const slug = String(market.slug ?? '').toLowerCase();
    const question = normalizeQuestion(market.question);

    if (slug.length > 0 && slugs.has(slug)) {
      return true;
    }

    if (question.length > 0 && questions.has(question)) {
      return true;
    }

    return false;
  });

  if (markets.length === 0 && Array.isArray(event.markets) && event.markets.length > 0) {
    return {
      ...event,
      usFiltered: false,
      usAvailableMarketCount: event.markets.length,
      usFilterFallbackRetainedOriginalMarkets: true
    };
  }

  return {
    ...event,
    markets,
    usFiltered: true,
    usAvailableMarketCount: markets.length
  };
}

function createUsGatewayClient(env) {
  return axios.create({
    baseURL: env.polymarketUsGatewayUrl ?? 'https://gateway.polymarket.us',
    timeout: 15000,
    headers: {
      Accept: 'application/json'
    }
  });
}

async function getUsGatewayEventsPage(env, { limit, offset }) {
  const usClient = createUsGatewayClient(env);
  const pathCandidates = ['/events', '/v1/events'];
  let lastError = null;

  for (const path of pathCandidates) {
    try {
      const response = await usClient.get(path, {
        params: {
          active: true,
          closed: false,
          limit,
          offset
        }
      });

      const events = Array.isArray(response.data)
        ? response.data
        : (Array.isArray(response.data?.events) ? response.data.events : []);

      return events.map(normalizeEvent);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

async function getUsGatewayEventBySlug(env, slug) {
  const usClient = createUsGatewayClient(env);
  const encodedSlug = encodeURIComponent(slug);
  const pathCandidates = [`/events/${encodedSlug}`, `/v1/events/${encodedSlug}`];
  let lastError = null;

  for (const path of pathCandidates) {
    try {
      const response = await usClient.get(path);
      const event = Array.isArray(response.data) ? response.data[0] : (response.data?.event ?? response.data);

      if (event && (event.title || event.slug || event.markets)) {
        return normalizeEvent(event);
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function normalizeSearchText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function scoreEventCandidate(slug, event) {
  const tokens = tokenize(slug);
  const candidateText = normalizeSearchText(`${event.slug} ${event.title}`);
  let score = 0;

  for (const token of tokens) {
    if (candidateText.includes(token)) {
      score += token.length >= 5 ? 3 : 2;
    }
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

async function findUsEventByMarketSlug(env, slug) {
  const usMarkets = await fetchUsMarketsBySlug(env, slug, { includeClosed: true });

  if (usMarkets.length === 0) {
    return null;
  }

  const primaryMarket = usMarkets[0];
  const normalizedMarkets = usMarkets.map(normalizeMarket);
  const firstMarket = normalizedMarkets[0];

  return {
    id: primaryMarket.id ?? `us:${slug}`,
    slug,
    title: primaryMarket.question ?? slug,
    description: primaryMarket.description ?? '',
    active: Boolean(primaryMarket.active),
    closed: Boolean(primaryMarket.closed),
    endDate: primaryMarket.endDate ?? null,
    startDate: primaryMarket.startDate ?? null,
    liquidity: toNumberOrNull(primaryMarket.liquidity),
    volume: toNumberOrNull(primaryMarket.volume),
    markets: normalizedMarkets,
    usFiltered: true,
    usAvailableMarketCount: normalizedMarkets.length,
    resolvedFromFallback: true,
    resolvedFromUsMarketSlug: true,
    requestedSlug: slug,
    sourceMarketSlug: firstMarket?.slug ?? slug
  };
}

function assertWeatherOnlyEvent(event, slug) {
  if (isWeatherEvent(event, event?.markets ?? [])) {
    return event;
  }

  throw new UnsupportedMarketError(
    `Only Polymarket US weather markets are supported. The slug "${slug}" does not look like a weather market.`
  );
}

export function extractEventSlug(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('A Polymarket event URL or slug is required.');
  }

  const trimmed = input.trim();

  if (/^(www\.)?polymarket\./i.test(trimmed) && !/^((www\.)?polymarket\.us)\//i.test(trimmed)) {
    throw new Error('Use a polymarket.us event URL or a market slug. Non-US URLs are not supported in this build.');
  }

  if (!trimmed.includes('://') && !trimmed.startsWith('polymarket.us/') && !trimmed.startsWith('www.polymarket.us/')) {
    return trimmed.replace(/^\/(event|events)\//, '').replace(/^\/+|\/+$/g, '');
  }

  const normalizedUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  const parsedUrl = new URL(normalizedUrl);

  if (parsedUrl.hostname !== 'polymarket.us' && parsedUrl.hostname !== 'www.polymarket.us') {
    throw new Error('Use a polymarket.us event URL or a market slug. Non-US Polymarket URLs are not supported.');
  }

  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  const eventIndex = segments.findIndex((segment) => segment === 'event' || segment === 'events');

  if (eventIndex === -1 || !segments[eventIndex + 1]) {
    throw new Error('Could not extract an event slug from the provided URL.');
  }

  return segments[eventIndex + 1];
}

export async function fetchActiveEvents(env, { limit = 10, offset = 0 } = {}) {
  const events = [];
  let pageOffset = offset;
  const pageLimit = Math.max(limit, 25);
  const maxPages = 8;

  for (let pageIndex = 0; events.length < limit && pageIndex < maxPages; pageIndex += 1) {
    const page = await getUsGatewayEventsPage(env, { limit: pageLimit, offset: pageOffset });

    if (page.length === 0) {
      break;
    }

    events.push(...page.filter((event) => isWeatherEvent(event, event.markets)));

    if (page.length < pageLimit) {
      break;
    }

    pageOffset += page.length;
  }

  return events.slice(0, limit);
}

export async function fetchEventByInput(env, input) {
  const slug = extractEventSlug(input);

  try {
    const event = await getUsGatewayEventBySlug(env, slug);

    if (event && (event.title || event.slug || event.markets)) {
      return assertWeatherOnlyEvent(await filterEventMarketsToUs(env, event), slug);
    }
  } catch (error) {
    if (error instanceof UnsupportedMarketError) {
      throw error;
    }

    const status = axios.isAxiosError(error) ? error.response?.status : undefined;

    const usEvent = await findUsEventByMarketSlug(env, slug);

    if (usEvent) {
      return assertWeatherOnlyEvent(usEvent, slug);
    }

    if (status && status >= 500) {
      throw error;
    }

    const fallbackEvent = await findFallbackEvent(env, slug);

    if (!fallbackEvent) {
      throw new Error(`No Polymarket US event was found for slug "${slug}".`);
    }

    return assertWeatherOnlyEvent(await filterEventMarketsToUs(env, {
      ...fallbackEvent,
      requestedSlug: slug,
      resolvedFromFallback: true
    }), slug);
  }
}
