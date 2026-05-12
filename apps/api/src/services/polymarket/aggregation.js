import { buildWeatherContext } from '../weather/event-intelligence.js';
import { buildWeatherSnapshots } from '../weather/data-ingestion.js';

const HISTORY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const HISTORY_FIDELITY_MINUTES = 1440;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHistoryPayload(payload) {
  const history = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.history)
      ? payload.history
      : [];

  return history
    .map((point) => ({
      timestamp: point.t,
      price: toNumberOrNull(point.p)
    }))
    .filter((point) => typeof point.price === 'number' && typeof point.timestamp === 'number')
    .sort((left, right) => left.timestamp - right.timestamp);
}

function summarizeHistory(points) {
  if (points.length === 0) {
    return {
      pointCount: 0,
      firstPrice: null,
      latestPrice: null,
      lowPrice: null,
      highPrice: null,
      absoluteChange: null,
      percentChange: null
    };
  }

  const prices = points.map((point) => point.price);
  const firstPrice = points[0].price;
  const latestPrice = points.at(-1).price;
  const absoluteChange = latestPrice - firstPrice;

  return {
    pointCount: points.length,
    firstPrice,
    latestPrice,
    lowPrice: Math.min(...prices),
    highPrice: Math.max(...prices),
    absoluteChange,
    percentChange: firstPrice ? absoluteChange / firstPrice : null
  };
}

function sortOutcomes(outcomes) {
  return [...outcomes].sort((left, right) => {
    const leftValue = typeof left.probability === 'number' ? left.probability : -1;
    const rightValue = typeof right.probability === 'number' ? right.probability : -1;

    return rightValue - leftValue;
  });
}

function getMostCompetitiveMarket(markets) {
  const ranked = markets
    .map((market) => {
      const outcomes = sortOutcomes(market.outcomes).filter((outcome) => typeof outcome.probability === 'number');

      if (outcomes.length < 2) {
        return null;
      }

      return {
        conditionId: market.conditionId,
        question: market.question,
        probabilityGap: outcomes[0].probability - outcomes[1].probability,
        leadingOutcome: outcomes[0].label
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.probabilityGap - right.probabilityGap);

  return ranked[0] ?? null;
}

function getTopOutcome(markets) {
  const candidates = markets
    .flatMap((market) =>
      market.outcomes.map((outcome) => ({
        conditionId: market.conditionId,
        question: market.question,
        label: outcome.label,
        probability: outcome.probability
      }))
    )
    .filter((candidate) => typeof candidate.probability === 'number')
    .sort((left, right) => right.probability - left.probability);

  return candidates[0] ?? null;
}

function getHighestValueMarket(markets, field) {
  const ranked = markets
    .filter((market) => typeof market[field] === 'number')
    .sort((left, right) => right[field] - left[field]);

  if (ranked.length === 0) {
    return null;
  }

  return {
    conditionId: ranked[0].conditionId,
    question: ranked[0].question,
    value: ranked[0][field]
  };
}

function getImpliedSpreadFromOutcomes(outcomes) {
  const probabilities = (Array.isArray(outcomes) ? outcomes : [])
    .map((outcome) => toNumberOrNull(outcome?.probability ?? outcome?.currentProbability))
    .filter((value) => typeof value === 'number');

  if (probabilities.length < 2) {
    return null;
  }

  const total = probabilities.reduce((sum, value) => sum + value, 0);
  return Math.abs(1 - total);
}

export async function buildEventAggregation(env, event) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - HISTORY_WINDOW_SECONDS;
  const liveMarkets = event.markets.filter((market) =>
    market.outcomes.some((outcome) => typeof outcome.probability === 'number')
  );

  const aggregatedMarkets = await Promise.all(
    liveMarkets.map(async (market) => {
      const outcomes = await Promise.all(
        market.outcomes.map(async (outcome) => {
          const history = typeof outcome.probability === 'number'
            ? {
                points: [{ timestamp: endTs, price: outcome.probability }],
                summary: summarizeHistory([{ timestamp: endTs, price: outcome.probability }])
              }
            : { points: [], summary: summarizeHistory([]) };

          return {
            ...outcome,
            history: history.points,
            historySummary: history.summary
          };
        })
      );

      return {
        conditionId: market.conditionId,
        question: market.question,
        title: market.title ?? null,
        subtitle: market.subtitle ?? null,
        description: market.description ?? null,
        rules: market.rules ?? null,
        resolutionSource: market.resolutionSource ?? null,
        category: typeof market?.category === 'string' ? market.category.toLowerCase() : null,
        liquidity: market.liquidity,
        volume: market.volume,
        outcomes,
        leader: sortOutcomes(outcomes)[0] ?? null,
        liquidityShare: event.liquidity ? (market.liquidity ?? 0) / event.liquidity : null,
        volumeShare: event.volume ? (market.volume ?? 0) / event.volume : null
      };
    })
  );

  const weatherContext = buildWeatherContext(event, {
    markets: aggregatedMarkets.map((market) => ({
      conditionId: market.conditionId,
      question: market.question,
      title: market.title ?? null,
      subtitle: market.subtitle ?? null,
      category: market.category,
      description: market.description ?? null,
      rules: market.rules ?? null,
      resolutionSource: market.resolutionSource ?? null,
      outcomes: market.outcomes.map((outcome) => ({
        label: outcome.label,
        currentProbability: outcome.probability
      }))
    }))
  });
  const weatherMarketsByConditionId = new Map(
    (Array.isArray(weatherContext.markets) ? weatherContext.markets : []).map((market) => [market.conditionId, market])
  );
  const weatherSnapshots = await buildWeatherSnapshots(env, weatherContext);
  const weatherSnapshotsByConditionId = new Map(
    weatherSnapshots.map((snapshot) => [snapshot.conditionId, snapshot])
  );

  return {
    generatedAt: new Date().toISOString(),
    historyWindow: {
      intervalLabel: '7d',
      startTs,
      endTs,
      fidelityMinutes: HISTORY_FIDELITY_MINUTES
    },
    liquiditySnapshot: {
      eventLiquidity: event.liquidity,
      eventVolume: event.volume,
      liveMarketCount: aggregatedMarkets.length,
      pricedOutcomeCount: aggregatedMarkets.reduce((count, market) => {
        return count + market.outcomes.filter((outcome) => typeof outcome.probability === 'number').length;
      }, 0),
      markets: aggregatedMarkets.map((market) => ({
        conditionId: market.conditionId,
        question: market.question,
        category: market.category,
        liquidity: market.liquidity,
        volume: market.volume,
        spread: getImpliedSpreadFromOutcomes(market.outcomes),
        liquidityShare: market.liquidityShare,
        volumeShare: market.volumeShare
      }))
    },
    derivedMetrics: {
      topOutcome: getTopOutcome(aggregatedMarkets),
      highestVolumeMarket: getHighestValueMarket(aggregatedMarkets, 'volume'),
      highestLiquidityMarket: getHighestValueMarket(aggregatedMarkets, 'liquidity'),
      mostCompetitiveMarket: getMostCompetitiveMarket(aggregatedMarkets),
      averageLiquidityPerLiveMarket: aggregatedMarkets.length
        ? aggregatedMarkets.reduce((sum, market) => sum + (market.liquidity ?? 0), 0) / aggregatedMarkets.length
        : null,
      averageVolumePerLiveMarket: aggregatedMarkets.length
        ? aggregatedMarkets.reduce((sum, market) => sum + (market.volume ?? 0), 0) / aggregatedMarkets.length
        : null
    },
    weatherContext,
    weatherSnapshots,
    historicalPrices: {
      markets: aggregatedMarkets.map((market) => ({
        conditionId: market.conditionId,
        question: market.question,
        title: market.title,
        subtitle: market.subtitle,
        category: market.category,
        weatherContext: weatherMarketsByConditionId.get(market.conditionId) ?? null,
        weatherSnapshot: weatherSnapshotsByConditionId.get(market.conditionId) ?? null,
        leader: market.leader
          ? {
              label: market.leader.label,
              probability: market.leader.probability
            }
          : null,
        outcomes: market.outcomes.map((outcome) => ({
          label: outcome.label,
          tokenId: outcome.tokenId,
          currentProbability: outcome.probability,
          historySummary: outcome.historySummary,
          history: outcome.history
        }))
      }))
    }
  };
}
