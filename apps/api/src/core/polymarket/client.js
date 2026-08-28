import { getPolymarketUsTradingStatus } from './us-orders.js';

export const POLYMARKET_MARKET_DATA_POLICY_ID = 'polymarket-us-rest-polling-v1';
export const POLYMARKET_MARKET_DATA_STREAMING_DISABLED_REASON = 'Streaming market data is not implemented. The near-term Polymarket US market-data plan uses REST polling.';

function positiveIntegerMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPolymarketMarketDataPolicy(env = {}) {
  const quotePollIntervalMs = positiveIntegerMs(env.polymarketMarketDataPollIntervalMs, 5000);
  const statusPollIntervalMs = positiveIntegerMs(env.polymarketMarketDataStatusPollIntervalMs, quotePollIntervalMs);
  const boardPollIntervalMs = positiveIntegerMs(env.polymarketMarketDataBoardPollIntervalMs, 120000);

  return {
    policyId: POLYMARKET_MARKET_DATA_POLICY_ID,
    scope: 'polymarket-us-market-data',
    transport: 'polling',
    mode: 'rest-polling',
    pollingEnabled: true,
    streamingEnabled: false,
    polling: {
      enabled: true,
      quotePollIntervalMs,
      statusPollIntervalMs,
      boardPollIntervalMs,
      sources: [
        'polymarket-us-gateway-rest',
        'polymarket-clob-rest',
        'polymarket-data-api-rest'
      ]
    },
    streaming: {
      enabled: false,
      supported: false,
      websocketClient: false,
      reason: POLYMARKET_MARKET_DATA_STREAMING_DISABLED_REASON
    },
    note: POLYMARKET_MARKET_DATA_STREAMING_DISABLED_REASON
  };
}

export async function getPolymarketStatus(env) {
  const usTrading = await getPolymarketUsTradingStatus(env);

  return {
    configured: env.hasUsTradingCredentials,
    host: env.polymarketUsBaseUrl,
    gateway: env.polymarketUsGatewayUrl,
    marketData: getPolymarketMarketDataPolicy(env),
    usTrading,
    publicReadOk: usTrading.authenticated,
    auth: {
      keyIdPresent: Boolean(env.polymarketUsKeyId),
      secretKeyValid: usTrading.secretKeyValid,
      authenticated: usTrading.authenticated,
      error: usTrading.error
    }
  };
}
