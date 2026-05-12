import { getPolymarketUsTradingStatus } from './us-orders.js';

export async function getPolymarketStatus(env) {
  const usTrading = await getPolymarketUsTradingStatus(env);

  return {
    configured: env.hasUsTradingCredentials,
    host: env.polymarketUsBaseUrl,
    gateway: env.polymarketUsGatewayUrl,
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
