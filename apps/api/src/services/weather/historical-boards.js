// Weather-family adapter over the venue-generic board history in core/polymarket/history.js.
// Binds the KMDW station and the Chicago market catalog; the reconstruction math lives in core.
import {
  DEFAULT_FIDELITY_MINUTES,
  DEFAULT_INTERVAL,
  DEFAULT_LOOKBACK_DAYS,
  buildHistoricalBoardArchiveFromBuckets as buildBoardArchiveFromBuckets,
  normalizeContract,
  normalizeFidelityMinutes,
  normalizePricePoints,
  normalizeTradeRows,
  resolveHistoryWindow,
  summarizeArchive
} from '../../core/polymarket/history.js';
import { fetchClobPriceHistoryBatch } from '../../core/polymarket/clob.js';
import { fetchPolymarketTradesForMarkets } from '../../core/polymarket/data-api.js';
import { buildChicagoMarketCatalog, CHICAGO_STATION } from './chicago.js';

export function buildHistoricalBoardArchiveFromBuckets(bucketMarkets, options = {}) {
  return buildBoardArchiveFromBuckets(bucketMarkets, {
    stationId: CHICAGO_STATION.stationId,
    ...options
  });
}

export async function fetchKmdwHistoricalBoardArchive(env, {
  dateFrom,
  dateTo,
  startTs = null,
  endTs = null,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  fidelityMinutes = DEFAULT_FIDELITY_MINUTES,
  interval = DEFAULT_INTERVAL,
  includeTrades = true
} = {}) {
  const window = resolveHistoryWindow({ dateFrom, dateTo, startTs, endTs, lookbackDays });
  const catalog = await buildChicagoMarketCatalog(env, {
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    includeUndated: false
  });
  const buckets = Array.isArray(catalog?.buckets) ? catalog.buckets : [];
  const contracts = buckets
    .map((bucket) => normalizeContract(bucket, CHICAGO_STATION.stationId))
    .filter(Boolean);
  const tokenIds = contracts
    .map((contract) => contract.yesTokenId)
    .filter(Boolean);
  const conditionIds = contracts
    .map((contract) => contract.conditionId)
    .filter(Boolean);
  const priceHistory = await fetchClobPriceHistoryBatch(env, tokenIds, {
    startTs: window.startTs,
    endTs: window.endTs,
    interval,
    fidelityMinutes: normalizeFidelityMinutes(fidelityMinutes)
  });
  const trades = includeTrades && conditionIds.length > 0
    ? await fetchPolymarketTradesForMarkets(env, conditionIds, {
        limit: 10000,
        maxPages: 5
      })
    : { trades: [] };

  return buildHistoricalBoardArchiveFromBuckets(buckets, {
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    startTs: window.startTs,
    endTs: window.endTs,
    priceHistoryByTokenId: priceHistory.byTokenId,
    trades: (trades.trades ?? []).filter((trade) => trade.timestamp >= window.startTs && trade.timestamp <= window.endTs),
    catalog,
    source: 'polymarket-historical-board-reconstruction'
  });
}

export {
  normalizePricePoints,
  normalizeTradeRows,
  resolveHistoryWindow,
  summarizeArchive
};
