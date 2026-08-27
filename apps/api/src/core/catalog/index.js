// Venue-wide market catalog: every open Polymarket US market, normalized and tagged
// with the family that claims it (or null).
//
// Phase 0 scope: a read-through over the gateway. Persistence, rules-hash change
// detection, and scheduled refresh are Phase 1 — this deliberately holds no state.
import { createHash } from 'node:crypto';

import { fetchActiveEvents } from '../polymarket/gamma.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function hashText(value) {
  const text = String(value ?? '').trim();
  return text ? createHash('sha256').update(text).digest('hex') : null;
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, MAX_LIMIT);
}

// One catalog entry per tradable market, flattened out of its parent event.
export function normalizeCatalogMarket(event, market, familyId = null) {
  const rulesText = market.rules ?? event.rules ?? null;

  return {
    id: market.conditionId ?? market.slug ?? market.id ?? null,
    conditionId: market.conditionId ?? null,
    marketSlug: market.slug ?? null,
    eventSlug: event.slug ?? null,
    title: market.question || market.title || event.title || '',
    eventTitle: event.title ?? '',
    // Distinguishes sibling markets that share an event title (see deriveOutcomeKey).
    outcomeKey: deriveOutcomeKey(event.slug, market.slug),
    category: market.category ?? event.category ?? null,
    familyId,
    outcomes: Array.isArray(market.outcomes) ? market.outcomes : [],
    outcomeCount: Array.isArray(market.outcomes) ? market.outcomes.length : 0,
    liquidity: market.liquidity ?? null,
    volume: market.volume ?? null,
    closeTime: market.endDate ?? event.endDate ?? null,
    startTime: event.startDate ?? null,
    active: market.active !== false,
    closed: market.closed === true,
    resolutionSource: market.resolutionSource ?? event.resolutionSource ?? null,
    rulesText,
    // Hashing the rules text now means Phase 1 can detect a mid-market rules change
    // by comparing hashes across snapshots.
    rulesTextHash: hashText(rulesText)
  };
}

// The US gateway returns one market per outcome, all sharing the parent event's
// title; the only discriminator is the slug suffix (…-nyy, …-tb). Surface it rather
// than inventing a label. Returns null when nothing can be derived honestly.
export function deriveOutcomeKey(eventSlug, marketSlug) {
  const event = String(eventSlug ?? '').trim();
  const market = String(marketSlug ?? '').trim();

  if (!event || !market || !market.includes(event)) {
    return null;
  }

  const suffix = market.slice(market.indexOf(event) + event.length).replace(/^[-_]+/, '').trim();

  return suffix || null;
}

function sortCatalogMarkets(markets) {
  return [...markets].sort((left, right) => {
    const volumeDelta = (right.volume ?? 0) - (left.volume ?? 0);

    if (volumeDelta !== 0) {
      return volumeDelta;
    }

    const closeDelta = String(left.closeTime ?? '').localeCompare(String(right.closeTime ?? ''));

    if (closeDelta !== 0) {
      return closeDelta;
    }

    const titleDelta = String(left.title).localeCompare(String(right.title));

    return titleDelta !== 0
      ? titleDelta
      : String(left.marketSlug ?? '').localeCompare(String(right.marketSlug ?? ''));
  });
}

// `resolveFamily` is injected by the caller so core/ never imports families/.
// Omit it and every market is simply untagged — which is a valid catalog.
export function buildCatalogFromEvents(events, { resolveFamily = null } = {}) {
  const rows = Array.isArray(events) ? events : [];
  const markets = [];

  for (const event of rows) {
    const family = typeof resolveFamily === 'function' ? resolveFamily(event) : null;
    const familyId = family?.id ?? null;

    for (const market of Array.isArray(event.markets) ? event.markets : []) {
      if (market.closed === true) {
        continue;
      }

      markets.push(normalizeCatalogMarket(event, market, familyId));
    }
  }

  const sorted = sortCatalogMarkets(markets);
  const byFamily = {};

  for (const market of sorted) {
    const key = market.familyId ?? 'unmodeled';
    byFamily[key] = (byFamily[key] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    venue: 'polymarket-us',
    eventCount: rows.length,
    marketCount: sorted.length,
    byFamily,
    markets: sorted
  };
}

// Markets from different discovery sources (the /events listing and family-specific
// search) are merged by identity. Earlier rows win, so a family's richer row is kept
// over a thinner listing row when both describe the same market.
export function mergeCatalogMarkets(...rowGroups) {
  const seen = new Map();

  for (const rows of rowGroups) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = row?.conditionId ?? row?.id ?? row?.marketSlug;

      if (key && !seen.has(key)) {
        seen.set(key, row);
      }
    }
  }

  return sortCatalogMarkets([...seen.values()]);
}

export function summarizeByFamily(markets) {
  const byFamily = {};

  for (const market of Array.isArray(markets) ? markets : []) {
    const key = market.familyId ?? 'unmodeled';
    byFamily[key] = (byFamily[key] ?? 0) + 1;
  }

  return byFamily;
}

// Read-through fetch of the open market catalog. No family filter is applied at the
// gateway, so unmodeled markets are included — that is the point.
export async function fetchMarketCatalog(env, {
  limit = DEFAULT_LIMIT,
  offset = 0,
  family = null,
  search = null,
  resolveFamily = null,
  extraMarkets = []
} = {}) {
  const events = await fetchActiveEvents(env, {
    limit: normalizeLimit(limit),
    offset: Number.parseInt(String(offset ?? 0), 10) || 0
  });
  const baseCatalog = buildCatalogFromEvents(events, { resolveFamily });
  // Family-supplied rows first: the /events listing does not surface every market
  // (weather markets, for one, are only reachable through gateway search).
  const merged = mergeCatalogMarkets(extraMarkets, baseCatalog.markets);
  const catalog = {
    ...baseCatalog,
    marketCount: merged.length,
    byFamily: summarizeByFamily(merged),
    markets: merged
  };
  let markets = catalog.markets;

  if (family) {
    const wanted = String(family).trim().toLowerCase();
    markets = markets.filter((market) => (
      wanted === 'unmodeled' ? market.familyId === null : market.familyId === wanted
    ));
  }

  if (search) {
    const needle = String(search).trim().toLowerCase();
    markets = markets.filter((market) => (
      market.title.toLowerCase().includes(needle)
      || String(market.eventTitle).toLowerCase().includes(needle)
      || String(market.marketSlug ?? '').toLowerCase().includes(needle)
      || String(market.outcomeKey ?? '').toLowerCase().includes(needle)
    ));
  }

  return {
    ...catalog,
    // Counts describe what is actually returned; totalMarketCount is the unfiltered size.
    totalMarketCount: catalog.marketCount,
    marketCount: markets.length,
    byFamily: summarizeByFamily(markets),
    filtered: markets.length !== catalog.markets.length,
    markets
  };
}

export async function getCatalogMarket(env, id, options = {}) {
  const catalog = await fetchMarketCatalog(env, { ...options, limit: MAX_LIMIT });
  const needle = String(id ?? '').trim();

  return catalog.markets.find((market) => (
    market.id === needle || market.conditionId === needle || market.marketSlug === needle
  )) ?? null;
}
