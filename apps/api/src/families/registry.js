// Market-family plugin contract.
//
// A family owns everything market-type-specific: how to find its markets, what
// authoritative data attaches to them, how to price their outcomes, and how to prove
// edge on past data. Everything family-agnostic lives in core/.
//
// This sits ABOVE the intra-family provider contract (weather-provider-v1 in
// services/weather/providers.js, which abstracts *locations within* the weather
// family). A family is a market type; a provider is one instance inside it.
//
// A market whose family has no model is still first-class in the terminal — quotes,
// book, history, and rules all render. `capabilities.pricing === false` is how a
// family declares it screens but does not price.
export const FAMILY_INTERFACE_VERSION = 'market-family-v1';

const families = new Map();

// Every family must be able to find its own markets. Everything else is optional and
// advertised through `capabilities`, so a family can ship discovery-only and add
// pricing later without breaking the contract.
const REQUIRED_FAMILY_METHODS = ['discoverMarkets'];

const OPTIONAL_FAMILY_METHODS = [
  'attachFeeds',
  // Contribute markets the venue's own listing does not surface, so they appear in
  // the venue-wide catalog. See core/catalog/index.js.
  'catalogMarkets',
  'fetchHistory',
  'priceOutcomes',
  'features',
  'settlementSource',
  'backtest'
];

export function describeFamily(family) {
  return {
    id: family.id,
    name: family.name,
    interfaceVersion: family.interfaceVersion ?? FAMILY_INTERFACE_VERSION,
    description: family.description ?? null,
    tier: family.tier ?? 'screened',
    capabilities: family.capabilities ?? {},
    dataSources: family.dataSources ?? []
  };
}

export function createFamily(family) {
  const id = String(family?.id ?? '').trim();

  if (!id) {
    throw new Error('Market family id is required.');
  }

  for (const methodName of REQUIRED_FAMILY_METHODS) {
    if (typeof family?.[methodName] !== 'function') {
      throw new Error(`Market family "${id}" is missing ${methodName}().`);
    }
  }

  const capabilities = Object.fromEntries(
    OPTIONAL_FAMILY_METHODS.map((methodName) => [methodName, typeof family[methodName] === 'function'])
  );

  return Object.freeze({
    ...family,
    id,
    interfaceVersion: FAMILY_INTERFACE_VERSION,
    // A family is only in the "modeled" tier if it can both price outcomes and
    // prove that pricing on past data.
    tier: capabilities.priceOutcomes && capabilities.backtest ? (family.tier ?? 'modeled') : 'screened',
    capabilities: {
      ...capabilities,
      ...(family.capabilities ?? {})
    },
    describe() {
      return describeFamily(this);
    }
  });
}

export function registerFamily(family) {
  const normalizedFamily = family?.interfaceVersion === FAMILY_INTERFACE_VERSION
    ? family
    : createFamily(family);

  families.set(normalizedFamily.id, normalizedFamily);
  return normalizedFamily;
}

export function getFamily(id) {
  return families.get(String(id ?? '').trim()) ?? null;
}

// The registered family objects themselves (with their methods), as opposed to
// listFamilies() which returns serializable descriptors for API responses.
export function listFamilyPlugins() {
  return [...families.values()];
}

export function listFamilies() {
  return [...families.values()].map((family) => describeFamily(family));
}

// Resolve the family that claims a catalog market, or null when nothing does.
// Null is a normal outcome: unmodeled markets still render in the terminal.
export function resolveFamilyForMarket(market) {
  for (const family of families.values()) {
    if (typeof family.claimsMarket === 'function' && family.claimsMarket(market)) {
      return family;
    }
  }

  return null;
}
