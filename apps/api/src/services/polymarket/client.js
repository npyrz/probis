import { ClobClient } from '@polymarket/clob-client';

const POLYMARKET_HOST = 'https://clob.polymarket.com';
const POLYMARKET_CHAIN_ID = 137;

export function createPolymarketClient(env) {
  if (!env.hasTradingCredentials) {
    return null;
  }

  return new ClobClient(
    POLYMARKET_HOST,
    env.polymarketPrivateKey,
    POLYMARKET_CHAIN_ID,
    undefined,
    {
      headers: {
        Authorization: `Bearer ${env.polymarketApiKey}`
      }
    }
  );
}

export async function getPolymarketStatus(env) {
  const client = createPolymarketClient(env);

  return {
    configured: Boolean(client),
    host: POLYMARKET_HOST,
    chainId: POLYMARKET_CHAIN_ID
  };
}