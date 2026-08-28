import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAMILY_INTERFACE_VERSION,
  createFamily,
  getFamily,
  listFamilies,
  registerFamily,
  resolveFamilyForMarket
} from '../src/families/registry.js';
import {
  buildCatalogFromEvents,
  deriveOutcomeKey,
  mergeCatalogMarkets,
  normalizeCatalogMarket,
  summarizeByFamily
} from '../src/core/catalog/index.js';
import { WEATHER_FAMILY } from '../src/families/weather/index.js';

test('createFamily requires a family id', () => {
  assert.throws(() => createFamily({ discoverMarkets() {} }), /family id is required/i);
});

test('createFamily requires discoverMarkets', () => {
  assert.throws(() => createFamily({ id: 'no-discovery' }), /missing discoverMarkets/i);
});

test('createFamily derives capabilities from the methods a family actually implements', () => {
  const family = createFamily({
    id: 'capability-probe',
    discoverMarkets() {},
    priceOutcomes() {}
  });

  assert.equal(family.interfaceVersion, FAMILY_INTERFACE_VERSION);
  assert.equal(family.capabilities.priceOutcomes, true);
  assert.equal(family.capabilities.backtest, false);
  assert.equal(family.capabilities.attachFeeds, false);
});

test('a family without a backtested model stays in the screened tier', () => {
  const priceOnly = createFamily({
    id: 'screened-probe',
    discoverMarkets() {},
    priceOutcomes() {}
  });

  assert.equal(priceOnly.tier, 'screened');
});

test('a family that prices outcomes and backtests them reaches the modeled tier', () => {
  const modeled = createFamily({
    id: 'modeled-probe',
    discoverMarkets() {},
    priceOutcomes() {},
    backtest() {}
  });

  assert.equal(modeled.tier, 'modeled');
});

test('registerFamily makes a family retrievable and listable', () => {
  registerFamily({
    id: 'registry-probe',
    name: 'Registry Probe',
    discoverMarkets() {}
  });

  assert.equal(getFamily('registry-probe').name, 'Registry Probe');
  assert.ok(listFamilies().some((family) => family.id === 'registry-probe'));
  assert.equal(getFamily('does-not-exist'), null);
});

test('resolveFamilyForMarket returns null when no family claims the market', () => {
  assert.equal(resolveFamilyForMarket({ title: 'Alaska Senate Election Winner', markets: [] }), null);
});

test('the weather family conforms to the contract and is modeled', () => {
  const weather = getFamily('weather');

  assert.equal(weather.id, 'weather');
  assert.equal(weather, WEATHER_FAMILY);
  assert.equal(weather.interfaceVersion, FAMILY_INTERFACE_VERSION);
  assert.equal(weather.tier, 'modeled');

  for (const method of [
    'discoverMarkets',
    'attachFeeds',
    'fetchHistory',
    'priceOutcomes',
    'features',
    'settlementSource',
    'backtest'
  ]) {
    assert.equal(typeof weather[method], 'function', `weather family is missing ${method}()`);
  }
});

test('deriveOutcomeKey pulls the sibling discriminator out of a market slug', () => {
  assert.equal(deriveOutcomeKey('mlb-alchamp-2026-09-27', 'tec-mlb-alchamp-2026-09-27-nyy'), 'nyy');
  assert.equal(deriveOutcomeKey('mlb-alchamp-2026-09-27', 'tec-mlb-alchamp-2026-09-27-tb'), 'tb');
  assert.equal(deriveOutcomeKey('chicago-high-may-20', 'chicago-high-may-20'), null);
  assert.equal(deriveOutcomeKey('some-event', 'unrelated-slug'), null);
  assert.equal(deriveOutcomeKey(null, 'anything'), null);
});

test('normalizeCatalogMarket hashes rules text and falls back to the event', () => {
  const event = {
    slug: 'event-slug',
    title: 'Event Title',
    category: 'politics',
    rules: 'Event level rules',
    endDate: '2026-11-06T16:20:09Z'
  };
  const market = {
    conditionId: 'condition-1',
    slug: 'event-slug-a',
    question: '',
    outcomes: [{ label: 'Yes', price: 0.4 }, { label: 'No', price: 0.6 }]
  };
  const row = normalizeCatalogMarket(event, market, null);

  assert.equal(row.title, 'Event Title');
  assert.equal(row.category, 'politics');
  assert.equal(row.closeTime, '2026-11-06T16:20:09Z');
  assert.equal(row.outcomeKey, 'a');
  assert.equal(row.outcomeCount, 2);
  assert.equal(row.familyId, null);
  assert.match(row.rulesTextHash, /^[0-9a-f]{64}$/);
});

test('normalizeCatalogMarket leaves the rules hash null when there is no rules text', () => {
  const row = normalizeCatalogMarket({ slug: 'e', title: 'T' }, { conditionId: 'c', slug: 'e-x' }, null);

  assert.equal(row.rulesTextHash, null);
  assert.equal(row.outcomeCount, 0);
});

test('buildCatalogFromEvents flattens events, drops closed markets, and counts by family', () => {
  const catalog = buildCatalogFromEvents([{
    slug: 'event-a',
    title: 'Event A',
    markets: [
      { conditionId: 'open-1', slug: 'event-a-1', closed: false, volume: 10 },
      { conditionId: 'closed-1', slug: 'event-a-2', closed: true, volume: 999 }
    ]
  }, {
    slug: 'event-b',
    title: 'Event B',
    markets: [{ conditionId: 'open-2', slug: 'event-b-1', closed: false, volume: 50 }]
  }]);

  assert.equal(catalog.eventCount, 2);
  assert.equal(catalog.marketCount, 2);
  assert.equal(catalog.venue, 'polymarket-us');
  assert.equal(catalog.byFamily.unmodeled, 2);
  assert.ok(!catalog.markets.some((market) => market.conditionId === 'closed-1'));
  // highest volume first
  assert.equal(catalog.markets[0].conditionId, 'open-2');
});

test('buildCatalogFromEvents tags markets using an injected family resolver', () => {
  const events = [
    { slug: 'weatherish', title: 'Chicago High Temp', markets: [{ conditionId: 'w-1', slug: 'weatherish-a' }] },
    { slug: 'other', title: 'Senate Race', markets: [{ conditionId: 'o-1', slug: 'other-a' }] }
  ];
  const catalog = buildCatalogFromEvents(events, {
    resolveFamily: (event) => (event.slug === 'weatherish' ? { id: 'weather' } : null)
  });

  assert.equal(catalog.byFamily.weather, 1);
  assert.equal(catalog.byFamily.unmodeled, 1);
  assert.equal(catalog.markets.find((m) => m.conditionId === 'w-1').familyId, 'weather');
  assert.equal(catalog.markets.find((m) => m.conditionId === 'o-1').familyId, null);
});

test('buildCatalogFromEvents leaves markets untagged when no resolver is injected', () => {
  const catalog = buildCatalogFromEvents([
    { slug: 'e', title: 'T', markets: [{ conditionId: 'c-1', slug: 'e-a' }] }
  ]);

  assert.equal(catalog.markets[0].familyId, null);
  assert.equal(catalog.byFamily.unmodeled, 1);
});

test('mergeCatalogMarkets dedupes by identity and lets the earlier source win', () => {
  const familyRow = { conditionId: 'shared', title: 'Rich family row', familyId: 'weather', volume: 5 };
  const listingRow = { conditionId: 'shared', title: 'Thin listing row', familyId: null, volume: 5 };
  const otherRow = { conditionId: 'other', title: 'Other', familyId: null, volume: 9 };

  const merged = mergeCatalogMarkets([familyRow], [listingRow, otherRow]);

  assert.equal(merged.length, 2);
  const shared = merged.find((row) => row.conditionId === 'shared');
  assert.equal(shared.title, 'Rich family row');
  assert.equal(shared.familyId, 'weather');
});

test('mergeCatalogMarkets tolerates empty and non-array sources', () => {
  assert.deepEqual(mergeCatalogMarkets(), []);
  assert.deepEqual(mergeCatalogMarkets(null, undefined, []), []);
  assert.equal(mergeCatalogMarkets([{ conditionId: 'a' }], null).length, 1);
});

test('mergeCatalogMarkets skips rows with no usable identity', () => {
  const merged = mergeCatalogMarkets([{ title: 'no id' }, { conditionId: 'a', title: 'has id' }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].conditionId, 'a');
});

test('summarizeByFamily counts unmodeled markets under their own key', () => {
  assert.deepEqual(
    summarizeByFamily([{ familyId: 'weather' }, { familyId: 'weather' }, { familyId: null }]),
    { weather: 2, unmodeled: 1 }
  );
  assert.deepEqual(summarizeByFamily([]), {});
});

test('the weather family can contribute markets the venue listing does not surface', () => {
  const weather = getFamily('weather');

  assert.equal(typeof weather.catalogMarkets, 'function');
  // The contract must advertise it, or a family author has no way to discover it.
  assert.equal(weather.capabilities.catalogMarkets, true);
});

test('catalogMarkets is part of the advertised contract but does not affect tier', () => {
  const contributor = createFamily({
    id: 'contributor-probe',
    discoverMarkets() {},
    catalogMarkets() {}
  });

  assert.equal(contributor.capabilities.catalogMarkets, true);
  // tier still keys only off priceOutcomes && backtest
  assert.equal(contributor.tier, 'screened');
});
