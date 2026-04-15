import { Wallet } from '@ethersproject/wallet';
import { ClobClient } from '@polymarket/clob-client';

const POLYMARKET_HOST = 'https://clob.polymarket.com';
const POLYMARKET_CHAIN_ID = 137;

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown Polymarket error';
}

export function createPolymarketSigner(env) {
  if (!env.polymarketPrivateKey) {
    return null;
  }

  try {
    return new Wallet(env.polymarketPrivateKey);
  } catch {
    return null;
  }
}

export function createPolymarketClient(env, signer = createPolymarketSigner(env)) {
  return new ClobClient(POLYMARKET_HOST, POLYMARKET_CHAIN_ID, signer ?? undefined);
}

export async function getPolymarketStatus(env) {
  const signer = createPolymarketSigner(env);
  const publicClient = createPolymarketClient(env, null);

  const status = {
    configured: env.hasTradingCredentials,
    host: POLYMARKET_HOST,
    chainId: POLYMARKET_CHAIN_ID,
    publicReadOk: false,
    auth: {
      privateKeyValid: Boolean(signer),
      signerAddress: signer?.address ?? null,
      derivedApiCredsReady: false,
      derivedApiKeyMatchesEnv: null,
      error: null
    }
  };

  try {
    const okResponse = await publicClient.getOk();
    status.publicReadOk = Boolean(okResponse);
  } catch (error) {
    status.auth.error = getErrorMessage(error);
    return status;
  }

  if (!signer) {
    if (env.polymarketPrivateKey) {
      status.auth.error = 'Private key format is not compatible with the Polymarket CLOB SDK.';
    }

    return status;
  }

  try {
    const authClient = createPolymarketClient(env, signer);
    const derivedCreds = await authClient.createOrDeriveApiKey();

    status.auth.derivedApiCredsReady = Boolean(
      derivedCreds?.apiKey && derivedCreds?.secret && derivedCreds?.passphrase
    );
    status.auth.derivedApiKeyMatchesEnv = env.polymarketApiKey
      ? derivedCreds.apiKey === env.polymarketApiKey
      : null;
  } catch (error) {
    status.auth.error = getErrorMessage(error);
  }

  return status;
}