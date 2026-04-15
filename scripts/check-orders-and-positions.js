const fs = require('fs');
const axios = require('axios');
const nacl = require('tweetnacl');

function readEnv() {
  const raw = fs.readFileSync('.env', 'utf8');
  const out = {};

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) {
      continue;
    }

    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();

    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }

    out[k] = v;
  }

  return out;
}

function signedHeaders(keyId, secretKey, method, path) {
  const bytes = Buffer.from(secretKey, 'base64');
  const seed = new Uint8Array(bytes.subarray(0, 32));
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const ts = String(Date.now());
  const msg = `${ts}${method.toUpperCase()}${path}`;
  const sig = nacl.sign.detached(Buffer.from(msg, 'utf8'), kp.secretKey);

  return {
    'X-PM-Access-Key': keyId,
    'X-PM-Timestamp': ts,
    'X-PM-Signature': Buffer.from(sig).toString('base64')
  };
}

async function getOrder(baseUrl, keyId, secret, orderId) {
  const path = `/v1/order/${encodeURIComponent(orderId)}`;
  const response = await axios.get(`${baseUrl}${path}`, {
    headers: signedHeaders(keyId, secret, 'GET', path),
    timeout: 30000
  });

  const d = response.data || {};
  const executions = Array.isArray(d.executions) ? d.executions : [];
  const filledShares = executions.reduce((sum, execution) => {
    const value = Number.parseFloat(execution?.lastShares ?? Number.NaN);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  const states = [...new Set([d.state, ...executions.map((execution) => execution?.order?.state)].filter(Boolean))];

  return {
    id: orderId,
    ok: true,
    state: d.state ?? null,
    states,
    executionCount: executions.length,
    filledShares
  };
}

async function getPositions(baseUrl, keyId, secret) {
  const path = '/v1/portfolio/positions';
  const response = await axios.get(`${baseUrl}${path}`, {
    headers: signedHeaders(keyId, secret, 'GET', path),
    timeout: 30000
  });

  const raw = response.data;
  let positions = [];

  if (Array.isArray(raw)) {
    positions = raw;
  } else if (Array.isArray(raw?.positions)) {
    positions = raw.positions;
  } else if (Array.isArray(raw?.data?.positions)) {
    positions = raw.data.positions;
  } else if (Array.isArray(raw?.data)) {
    positions = raw.data;
  }

  return {
    ok: true,
    topLevelType: Array.isArray(raw) ? 'array' : typeof raw,
    topLevelKeys: raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).slice(0, 20) : [],
    parsedCount: positions.length,
    sample: positions.slice(0, 10).map((position) => ({
      marketSlug: position.marketSlug || position.slug || position.market?.slug || position.marketMetadata?.slug || null,
      outcome: position.outcome || position.outcomeLabel || position.marketMetadata?.outcome || position.side || null,
      quantity: position.quantity ?? position.position ?? position.size ?? position.netQuantity ?? null,
      available: position.availableQuantity ?? position.available ?? null,
      avgPrice: position.avgPrice?.value ?? position.averagePrice?.value ?? position.avgPx?.value ?? position.price?.value ?? null
    }))
  };
}

async function main() {
  const env = readEnv();
  const keyId = env.POLYMARKET_US_KEY_ID || env.POLYMARKET_API_KEY;
  const secret = env.POLYMARKET_US_SECRET_KEY || env.POLYMARKET_PRIVATE_KEY;
  const baseUrl = env.POLYMARKET_US_BASE_URL || 'https://api.polymarket.us';

  const intents = JSON.parse(fs.readFileSync('data/trade-intents.json', 'utf8'));
  const orderIds = [...new Set(intents.map((intent) => intent?.executionRequest?.venueOrderId).filter(Boolean))].slice(0, 20);

  const orderChecks = [];

  for (const orderId of orderIds) {
    try {
      orderChecks.push(await getOrder(baseUrl, keyId, secret, orderId));
    } catch (error) {
      orderChecks.push({
        id: orderId,
        ok: false,
        status: error.response?.status ?? null,
        error: error.response?.data?.message || error.response?.data?.error || String(error.message)
      });
    }
  }

  let positionsSummary;

  try {
    positionsSummary = await getPositions(baseUrl, keyId, secret);
  } catch (error) {
    positionsSummary = {
      ok: false,
      status: error.response?.status ?? null,
      error: error.response?.data?.message || error.response?.data?.error || String(error.message)
    };
  }

  console.log(JSON.stringify({ orderChecks, positionsSummary }, null, 2));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
