import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIRECTORY = path.resolve(process.cwd(), 'data');
const TRADE_INTENTS_FILE = path.join(DATA_DIRECTORY, 'trade-intents.json');

async function ensureStore() {
  await mkdir(DATA_DIRECTORY, { recursive: true });

  try {
    await readFile(TRADE_INTENTS_FILE, 'utf8');
  } catch {
    await writeFile(TRADE_INTENTS_FILE, '[]\n', 'utf8');
  }
}

async function readTradeIntents() {
  await ensureStore();
  const raw = await readFile(TRADE_INTENTS_FILE, 'utf8');
  const parsed = JSON.parse(raw);

  return Array.isArray(parsed) ? parsed : [];
}

async function writeTradeIntents(intents) {
  await ensureStore();
  await writeFile(TRADE_INTENTS_FILE, `${JSON.stringify(intents, null, 2)}\n`, 'utf8');
}

export function buildTradeIntentPayload(payload) {
  const tradeAmount = Number.parseFloat(payload?.tradeAmount ?? payload?.tradeSuggestion?.amount ?? NaN);
  const stopLossProbability = Number.parseFloat(payload?.tradeSuggestion?.stopLossProbability ?? NaN);
  const takeProfitProbability = Number.parseFloat(payload?.tradeSuggestion?.takeProfitProbability ?? NaN);

  if (!payload?.eventSlug || !payload?.marketQuestion || !payload?.outcomeLabel) {
    throw new Error('Trade intent requires eventSlug, marketQuestion, and outcomeLabel.');
  }

  if (!Number.isFinite(tradeAmount) || tradeAmount <= 0) {
    throw new Error('Trade intent requires a positive tradeAmount.');
  }

  if (!Number.isFinite(stopLossProbability) || stopLossProbability <= 0 || stopLossProbability >= 1) {
    throw new Error('Trade intent requires a stopLossProbability between 0 and 1.');
  }

  if (!Number.isFinite(takeProfitProbability) || takeProfitProbability <= 0 || takeProfitProbability >= 1) {
    throw new Error('Trade intent requires a takeProfitProbability between 0 and 1.');
  }

  return {
    id: randomUUID(),
    status: 'draft',
    createdAt: new Date().toISOString(),
    confirmedAt: payload.confirmedAt ?? new Date().toISOString(),
    eventSlug: payload.eventSlug,
    eventTitle: payload.eventTitle ?? null,
    input: payload.input ?? payload.eventSlug,
    conditionId: payload.conditionId ?? null,
    marketQuestion: payload.marketQuestion,
    outcomeLabel: payload.outcomeLabel,
    action: payload.action ?? 'watch',
    tradeAmount,
    recommendation: payload.recommendation ?? null,
    tradeSuggestion: {
      ...payload.tradeSuggestion,
      amount: tradeAmount,
      stopLossProbability,
      takeProfitProbability
    },
    analysis: payload.analysis ?? null,
    generatedAt: payload.generatedAt ?? new Date().toISOString()
  };
}

export async function createTradeIntent(payload) {
  const tradeIntent = buildTradeIntentPayload(payload);
  const intents = await readTradeIntents();
  intents.unshift(tradeIntent);
  await writeTradeIntents(intents.slice(0, 50));

  return tradeIntent;
}

export async function listTradeIntents(limit = 10) {
  const intents = await readTradeIntents();
  return intents.slice(0, Math.max(1, limit));
}