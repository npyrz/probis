import { Router } from 'express';

import { getEnv } from '../config/env.js';
import { fetchMarketCatalog, getCatalogMarket } from '../core/catalog/index.js';
import { getFamily, listFamilies, listFamilyPlugins, resolveFamilyForMarket } from '../families/registry.js';

const router = Router();

// Ask every family that can contribute markets the venue listing does not surface.
// A family failing discovery must not take down the whole catalog.
async function collectFamilyMarkets(env) {
  const results = await Promise.allSettled(
    listFamilyPlugins()
      .filter((family) => typeof family.catalogMarkets === 'function')
      .map((family) => family.catalogMarkets(env))
  );

  return results.flatMap((result) => (result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []));
}

function normalizeTextQuery(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

router.get('/api/families', (_request, response) => {
  response.json({
    ok: true,
    families: listFamilies()
  });
});

router.get('/api/markets', async (request, response) => {
  try {
    const env = getEnv();
    const extraMarkets = await collectFamilyMarkets(env);
    const catalog = await fetchMarketCatalog(env, {
      extraMarkets,
      limit: request.query.limit,
      offset: request.query.offset,
      family: normalizeTextQuery(request.query.family),
      search: normalizeTextQuery(request.query.search),
      resolveFamily: resolveFamilyForMarket
    });

    response.json({
      ok: true,
      ...catalog
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

router.get('/api/markets/:id', async (request, response) => {
  try {
    const env = getEnv();
    const market = await getCatalogMarket(env, request.params.id, {
      resolveFamily: resolveFamilyForMarket,
      extraMarkets: await collectFamilyMarkets(env)
    });

    if (!market) {
      response.status(404).json({
        ok: false,
        error: `No open Polymarket US market found for "${request.params.id}".`
      });
      return;
    }

    // A market with no family model is still first-class: it returns quotes, rules,
    // and metadata, just with no fair-value panel. `family: null` is how the client
    // knows to hide that panel rather than treat this as an error.
    const family = market.familyId ? getFamily(market.familyId) : null;

    response.json({
      ok: true,
      market,
      family: family ? family.describe() : null,
      modeled: family?.tier === 'modeled'
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

export default router;
