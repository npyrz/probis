import { fetchClobPriceHistoryBatch } from '../polymarket/clob.js';
import { fetchPolymarketTradesForMarkets } from '../polymarket/data-api.js';
import { buildChicagoMarketCatalog, CHICAGO_STATION } from './chicago.js';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_FIDELITY_MINUTES = 60;
const DEFAULT_INTERVAL = 'all';
const DAY_SECONDS = 24 * 60 * 60;

function normalizeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeTimestampSeconds(value) {
  const numeric = toNumberOrNull(value);

  if (typeof numeric !== 'number') {
    return null;
  }

  return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function dateToUnixSeconds(date, offsetDays = 0) {
  const parsed = normalizeDate(date);

  if (!parsed) {
    return null;
  }

  return Math.floor(Date.parse(`${parsed}T00:00:00.000Z`) / 1000) + (offsetDays * DAY_SECONDS);
}

function resolveHistoryWindow({ dateFrom, dateTo, startTs = null, endTs = null, lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const normalizedDateFrom = normalizeDate(dateFrom);
  const normalizedDateTo = normalizeDate(dateTo);
  const normalizedStartTs = normalizeTimestampSeconds(startTs);
  const normalizedEndTs = normalizeTimestampSeconds(endTs);
  const safeStartTs = normalizedStartTs ?? (normalizedDateFrom ? dateToUnixSeconds(normalizedDateFrom, -lookbackDays) : null);
  const safeEndTs = normalizedEndTs ?? (normalizedDateTo ? dateToUnixSeconds(normalizedDateTo, 2) : null);

  if (!normalizedDateFrom || !normalizedDateTo) {
    throw new Error('Historical board reconstruction requires valid dateFrom and dateTo values.');
  }

  if (!Number.isFinite(safeStartTs) || !Number.isFinite(safeEndTs)) {
    throw new Error('Historical board reconstruction requires a valid timestamp range.');
  }

  if (safeStartTs > safeEndTs) {
    throw new Error('Historical board startTs must be before endTs.');
  }

  return {
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo,
    startTs: safeStartTs,
    endTs: safeEndTs,
    startTime: new Date(safeStartTs * 1000).toISOString(),
    endTime: new Date(safeEndTs * 1000).toISOString()
  };
}

function normalizeFidelityMinutes(value) {
  const numeric = Number.parseInt(String(value ?? DEFAULT_FIDELITY_MINUTES), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_FIDELITY_MINUTES;
}

function normalizeContract(bucket) {
  if (!bucket?.conditionId) {
    return null;
  }

  return {
    stationId: CHICAGO_STATION.stationId,
    marketSlug: bucket.marketSlug ?? null,
    eventSlug: bucket.eventSlug ?? null,
    conditionId: bucket.conditionId,
    eventDate: normalizeDate(bucket.targetDate),
    outcomeLabel: bucket.outcomeLabel ?? null,
    lowTemp: toNumberOrNull(bucket.lowTemp),
    highTemp: toNumberOrNull(bucket.highTemp),
    yesTokenId: bucket.yesTokenId ? String(bucket.yesTokenId) : null,
    sourceVerified: bucket.designatedSource?.verified === true,
    sourceVerificationStatus: bucket.designatedSource?.verificationStatus ?? null,
    sourceTradeGate: bucket.designatedSource?.tradeGate ?? null,
    ruleTextHash: bucket.rulesTextHash ?? null,
    endDate: bucket.endDate ?? null,
    rawData: bucket
  };
}

function normalizePriceHistoryByTokenId(priceHistoryByTokenId) {
  if (priceHistoryByTokenId instanceof Map) {
    return new Map([...priceHistoryByTokenId.entries()].map(([tokenId, points]) => [
      String(tokenId),
      normalizePricePoints(points)
    ]));
  }

  if (priceHistoryByTokenId && typeof priceHistoryByTokenId === 'object') {
    return new Map(Object.entries(priceHistoryByTokenId).map(([tokenId, points]) => [
      String(tokenId),
      normalizePricePoints(points)
    ]));
  }

  return new Map();
}

function normalizePricePoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const timestamp = normalizeTimestampSeconds(point?.timestamp ?? point?.t);
      const price = toNumberOrNull(point?.price ?? point?.p);

      if (!Number.isFinite(timestamp) || typeof price !== 'number') {
        return null;
      }

      return {
        timestamp,
        time: new Date(timestamp * 1000).toISOString(),
        price
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeTradeRows(trades) {
  return (Array.isArray(trades) ? trades : [])
    .map((trade) => {
      const timestamp = normalizeTimestampSeconds(trade?.timestamp ?? trade?.t);
      const price = toNumberOrNull(trade?.price);

      if (!Number.isFinite(timestamp) || typeof price !== 'number') {
        return null;
      }

      return {
        tradeId: trade?.tradeId ?? trade?.id ?? trade?.transactionHash ?? null,
        conditionId: trade?.conditionId ?? null,
        tokenId: trade?.tokenId ?? trade?.asset ?? trade?.asset_id ?? null,
        timestamp,
        tradedAt: trade?.tradedAt ?? new Date(timestamp * 1000).toISOString(),
        price,
        size: toNumberOrNull(trade?.size),
        side: trade?.side ?? null,
        transactionHash: trade?.transactionHash ?? null,
        rawData: trade?.rawData ?? trade
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function buildBoardTimes(priceHistoryByTokenId, trades, { startTs, endTs }) {
  const times = new Set();

  for (const points of priceHistoryByTokenId.values()) {
    for (const point of points) {
      if (point.timestamp >= startTs && point.timestamp <= endTs) {
        times.add(point.timestamp);
      }
    }
  }

  for (const trade of trades) {
    if (trade.timestamp >= startTs && trade.timestamp <= endTs) {
      times.add(trade.timestamp);
    }
  }

  return [...times].sort((left, right) => left - right);
}

function latestPriceAt(points, timestamp) {
  let latest = null;

  for (const point of points) {
    if (point.timestamp > timestamp) {
      break;
    }

    latest = point;
  }

  return latest;
}

function getContractTradesAt(trades, contract, timestamp) {
  return trades.filter((trade) => {
    const sameToken = contract.yesTokenId && String(trade.tokenId ?? '') === String(contract.yesTokenId);
    const sameCondition = contract.conditionId && String(trade.conditionId ?? '') === String(contract.conditionId);
    return trade.timestamp <= timestamp && (sameToken || sameCondition);
  });
}

function summarizeTrades(trades) {
  const lastTrade = trades.at(-1) ?? null;
  const volume = trades.reduce((sum, trade) => sum + (typeof trade.size === 'number' ? trade.size : 0), 0);

  return {
    tradeCount: trades.length,
    cumulativeTradeSize: round(volume, 4),
    lastTradePrice: lastTrade?.price ?? null,
    lastTradeAt: lastTrade?.tradedAt ?? null,
    lastTradeSide: lastTrade?.side ?? null
  };
}

function buildBoardSnapshot(timestamp, contracts, priceHistoryByTokenId, trades, eventDate) {
  return {
    stationId: CHICAGO_STATION.stationId,
    eventDate,
    timestamp,
    reconstructedAt: new Date(timestamp * 1000).toISOString(),
    contractCount: contracts.length,
    contracts: contracts.map((contract) => {
      const points = contract.yesTokenId ? priceHistoryByTokenId.get(contract.yesTokenId) ?? [] : [];
      const quote = latestPriceAt(points, timestamp);
      const contractTrades = getContractTradesAt(trades, contract, timestamp);
      const tradeSummary = summarizeTrades(contractTrades);

      return {
        ...contract,
        reconstructedPrice: quote?.price ?? null,
        reconstructedPriceAt: quote?.time ?? null,
        quoteSource: quote ? 'polymarket-clob-prices-history' : null,
        ...tradeSummary
      };
    })
  };
}

function summarizeArchive(archive) {
  const contracts = Array.isArray(archive?.contracts) ? archive.contracts : [];
  const snapshots = Array.isArray(archive?.boardSnapshots) ? archive.boardSnapshots : [];
  const pricePointCount = archive?.priceHistoryByTokenId && typeof archive.priceHistoryByTokenId === 'object'
    ? Object.values(archive.priceHistoryByTokenId).reduce((sum, points) => sum + (Array.isArray(points) ? points.length : 0), 0)
    : 0;
  const trades = Array.isArray(archive?.trades) ? archive.trades : [];
  const eventDates = [...new Set(contracts.map((contract) => contract.eventDate).filter(Boolean))].sort();

  return {
    generatedAt: archive?.generatedAt ?? new Date().toISOString(),
    stationId: CHICAGO_STATION.stationId,
    dateFrom: archive?.dateFrom ?? null,
    dateTo: archive?.dateTo ?? null,
    eventDates,
    contractCount: contracts.length,
    tokenCount: contracts.filter((contract) => contract.yesTokenId).length,
    pricePointCount,
    tradeCount: trades.length,
    boardSnapshotCount: snapshots.length,
    firstReconstructedAt: snapshots[0]?.reconstructedAt ?? null,
    lastReconstructedAt: snapshots.at(-1)?.reconstructedAt ?? null,
    sourceVerifiedCount: contracts.filter((contract) => contract.sourceVerified).length,
    blockedCount: contracts.filter((contract) => contract.sourceVerified !== true).length
  };
}

export function buildHistoricalBoardArchiveFromBuckets(bucketMarkets, {
  dateFrom,
  dateTo,
  startTs,
  endTs,
  priceHistoryByTokenId = new Map(),
  trades = [],
  source = 'polymarket-historical-board-reconstruction',
  catalog = null
} = {}) {
  const window = resolveHistoryWindow({ dateFrom, dateTo, startTs, endTs, lookbackDays: 0 });
  const contracts = (Array.isArray(bucketMarkets) ? bucketMarkets : [])
    .map(normalizeContract)
    .filter(Boolean)
    .filter((contract) => contract.eventDate && contract.eventDate >= window.dateFrom && contract.eventDate <= window.dateTo)
    .sort((left, right) => {
      const dateComparison = left.eventDate.localeCompare(right.eventDate);

      if (dateComparison !== 0) {
        return dateComparison;
      }

      if ((left.lowTemp ?? Number.NEGATIVE_INFINITY) !== (right.lowTemp ?? Number.NEGATIVE_INFINITY)) {
        return (left.lowTemp ?? Number.NEGATIVE_INFINITY) - (right.lowTemp ?? Number.NEGATIVE_INFINITY);
      }

      return (left.highTemp ?? Number.POSITIVE_INFINITY) - (right.highTemp ?? Number.POSITIVE_INFINITY);
    });
  const normalizedPriceHistory = normalizePriceHistoryByTokenId(priceHistoryByTokenId);
  const normalizedTrades = normalizeTradeRows(trades);
  const boardTimes = buildBoardTimes(normalizedPriceHistory, normalizedTrades, window);
  const contractsByDate = contracts.reduce((map, contract) => {
    if (!map.has(contract.eventDate)) {
      map.set(contract.eventDate, []);
    }

    map.get(contract.eventDate).push(contract);
    return map;
  }, new Map());
  const boardSnapshots = [];

  for (const timestamp of boardTimes) {
    for (const [eventDate, dateContracts] of contractsByDate.entries()) {
      boardSnapshots.push(buildBoardSnapshot(timestamp, dateContracts, normalizedPriceHistory, normalizedTrades, eventDate));
    }
  }

  const archive = {
    source,
    stationId: CHICAGO_STATION.stationId,
    generatedAt: new Date().toISOString(),
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    startTs: window.startTs,
    endTs: window.endTs,
    startTime: window.startTime,
    endTime: window.endTime,
    contracts,
    priceHistoryByTokenId: Object.fromEntries(normalizedPriceHistory.entries()),
    trades: normalizedTrades,
    boardSnapshots: boardSnapshots.sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }

      return String(left.eventDate ?? '').localeCompare(String(right.eventDate ?? ''));
    }),
    catalog: catalog ? {
      generatedAt: catalog.generatedAt ?? null,
      source: catalog.source ?? null,
      status: catalog.status ?? null,
      bucketCount: catalog.bucketCount ?? null
    } : null
  };

  return {
    ...archive,
    summary: summarizeArchive(archive)
  };
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
    .map(normalizeContract)
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
