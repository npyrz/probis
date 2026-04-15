import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { fetchEventByInput } from './polymarket/gamma.js';

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

function getSharesEstimate(tradeAmount, entryProbability) {
  if (!Number.isFinite(tradeAmount) || !Number.isFinite(entryProbability) || entryProbability <= 0) {
    return null;
  }

  return tradeAmount / entryProbability;
}

function buildExecutionRequestShape(payload) {
  const entryProbability = Number.parseFloat(
    payload?.recommendation?.currentProbability ?? payload?.tradeSuggestion?.entryProbability ?? NaN
  );
  const tradeAmount = Number.parseFloat(payload?.tradeAmount ?? payload?.tradeSuggestion?.amount ?? NaN);
  const stopLossProbability = Number.parseFloat(payload?.tradeSuggestion?.stopLossProbability ?? NaN);
  const takeProfitProbability = Number.parseFloat(payload?.tradeSuggestion?.takeProfitProbability ?? NaN);

  return {
    requestId: randomUUID(),
    requestType: 'market-buy-intent',
    venue: 'polymarket-us',
    side: 'buy',
    orderType: 'market-intent',
    readyForExecution: false,
    createdAt: new Date().toISOString(),
    eventSlug: payload.eventSlug,
    conditionId: payload.conditionId ?? null,
    marketQuestion: payload.marketQuestion,
    outcomeLabel: payload.outcomeLabel,
    tradeAmount,
    entryProbability: Number.isFinite(entryProbability) ? entryProbability : null,
    sharesEstimate: getSharesEstimate(tradeAmount, entryProbability),
    stopLossProbability: Number.isFinite(stopLossProbability) ? stopLossProbability : null,
    takeProfitProbability: Number.isFinite(takeProfitProbability) ? takeProfitProbability : null,
    maxSlippageBps: 100,
    constraints: {
      requiresManualSubmission: true,
      credentialsConfigured: false
    }
  };
}

function buildMonitoringState(intent) {
  return {
    state: 'active',
    activatedAt: new Date().toISOString(),
    lastEvaluationAt: null,
    currentProbability: intent.recommendation?.currentProbability ?? null,
    entryProbability: intent.executionRequest?.entryProbability ?? intent.recommendation?.currentProbability ?? null,
    stopLossProbability: intent.tradeSuggestion?.stopLossProbability ?? null,
    takeProfitProbability: intent.tradeSuggestion?.takeProfitProbability ?? null,
    stopTriggeredAt: null,
    takeProfitTriggeredAt: null,
    exitReason: null,
    notes: 'Tracking live probability against configured stop-loss and take-profit levels.'
  };
}

function buildExitRequestShape(intent, exitReason) {
  return {
    requestId: randomUUID(),
    requestType: 'market-sell-intent',
    venue: 'polymarket-us',
    side: 'sell',
    orderType: 'market-intent',
    createdAt: new Date().toISOString(),
    readyForExecution: false,
    eventSlug: intent.eventSlug,
    conditionId: intent.conditionId ?? null,
    marketQuestion: intent.marketQuestion,
    outcomeLabel: intent.outcomeLabel,
    sharesEstimate: intent.executionRequest?.sharesEstimate ?? null,
    exitReason
  };
}

function replaceTradeIntent(intents, nextIntent) {
  return intents.map((intent) => (intent.id === nextIntent.id ? nextIntent : intent));
}

function getEditablePatch(payload = {}) {
  const patch = {};

  if (payload.eventTitle !== undefined) {
    patch.eventTitle = payload.eventTitle;
  }

  if (payload.tradeAmount !== undefined) {
    patch.tradeAmount = Number.parseFloat(payload.tradeAmount);
  }

  if (payload.tradeSuggestion) {
    patch.tradeSuggestion = {
      ...payload.tradeSuggestion,
      amount: payload.tradeAmount !== undefined
        ? Number.parseFloat(payload.tradeAmount)
        : Number.parseFloat(payload.tradeSuggestion.amount ?? NaN)
    };
  }

  return patch;
}

function findTradeIntentOrThrow(intents, id) {
  const existing = intents.find((intent) => intent.id === id);

  if (!existing) {
    throw new Error(`Trade intent ${id} was not found.`);
  }

  return existing;
}

function findTrackedMarketOutcome(event, intent) {
  const market = event.markets.find((candidate) => candidate.conditionId === intent.conditionId)
    ?? event.markets.find((candidate) => candidate.question === intent.marketQuestion)
    ?? null;
  const outcome = market?.outcomes.find((candidate) => candidate.label === intent.outcomeLabel) ?? null;

  return {
    market,
    outcome
  };
}

function finalizeTrackedIntent(intent, exitReason, monitoringState) {
  return {
    ...intent,
    status: 'closed',
    monitoring: monitoringState,
    exitRequest: buildExitRequestShape(intent, exitReason),
    updatedAt: new Date().toISOString()
  };
}

function evaluateMonitoringState(intent, currentProbability) {
  const baseMonitoring = {
    ...intent.monitoring,
    lastEvaluationAt: new Date().toISOString(),
    currentProbability,
    stopLossProbability: intent.tradeSuggestion?.stopLossProbability ?? intent.monitoring?.stopLossProbability ?? null,
    takeProfitProbability: intent.tradeSuggestion?.takeProfitProbability ?? intent.monitoring?.takeProfitProbability ?? null
  };
  const stopLossProbability = baseMonitoring.stopLossProbability;
  const takeProfitProbability = baseMonitoring.takeProfitProbability;

  if (typeof currentProbability === 'number' && typeof stopLossProbability === 'number' && currentProbability <= stopLossProbability) {
    return finalizeTrackedIntent(intent, 'stop-loss-hit', {
      ...baseMonitoring,
      state: 'stop-loss-hit',
      stopTriggeredAt: new Date().toISOString(),
      exitReason: 'stop-loss-hit',
      notes: 'Stop-loss threshold reached during monitoring.'
    });
  }

  if (typeof currentProbability === 'number' && typeof takeProfitProbability === 'number' && currentProbability >= takeProfitProbability) {
    return finalizeTrackedIntent(intent, 'take-profit-hit', {
      ...baseMonitoring,
      state: 'take-profit-hit',
      takeProfitTriggeredAt: new Date().toISOString(),
      exitReason: 'take-profit-hit',
      notes: 'Take-profit threshold reached during monitoring.'
    });
  }

  return {
    ...intent,
    monitoring: {
      ...baseMonitoring,
      state: 'active',
      notes: 'Monitoring live probability against configured stop-loss and take-profit levels.'
    },
    updatedAt: new Date().toISOString()
  };
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
    status: payload.status ?? (payload.confirmedAt ? 'confirmed' : 'draft'),
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
    executionRequest: buildExecutionRequestShape({
      ...payload,
      tradeAmount,
      tradeSuggestion: {
        ...payload.tradeSuggestion,
        amount: tradeAmount,
        stopLossProbability,
        takeProfitProbability
      }
    }),
    monitoring: payload.monitoring ?? null,
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

export async function updateTradeIntent(id, payload) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);
  const editablePatch = getEditablePatch(payload);
  const nextTradeSuggestion = {
    ...existing.tradeSuggestion,
    ...editablePatch.tradeSuggestion
  };
  const nextTradeAmount = Number.isFinite(editablePatch.tradeAmount)
    ? editablePatch.tradeAmount
    : existing.tradeAmount;
  const updatedIntent = {
    ...existing,
    ...editablePatch,
    tradeAmount: nextTradeAmount,
    tradeSuggestion: {
      ...nextTradeSuggestion,
      amount: nextTradeAmount
    },
    executionRequest: buildExecutionRequestShape({
      ...existing,
      ...editablePatch,
      tradeAmount: nextTradeAmount,
      tradeSuggestion: {
        ...nextTradeSuggestion,
        amount: nextTradeAmount
      }
    }),
    monitoring: existing.monitoring
      ? {
          ...existing.monitoring,
          stopLossProbability: nextTradeSuggestion.stopLossProbability ?? existing.monitoring.stopLossProbability,
          takeProfitProbability: nextTradeSuggestion.takeProfitProbability ?? existing.monitoring.takeProfitProbability
        }
      : existing.monitoring,
    updatedAt: new Date().toISOString()
  };

  updatedIntent.executionRequest = {
    ...updatedIntent.executionRequest,
    requestId: existing.executionRequest?.requestId ?? updatedIntent.executionRequest.requestId,
    createdAt: existing.executionRequest?.createdAt ?? updatedIntent.executionRequest.createdAt,
    readyForExecution: existing.executionRequest?.readyForExecution ?? updatedIntent.executionRequest.readyForExecution,
    preparedAt: existing.executionRequest?.preparedAt ?? null
  };

  await writeTradeIntents(replaceTradeIntent(intents, updatedIntent));
  return updatedIntent;
}

export async function deleteTradeIntent(id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);
  const remaining = intents.filter((intent) => intent.id !== id);

  await writeTradeIntents(remaining);
  return existing;
}

export async function executeTradeIntent(id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);
  const nextIntent = {
    ...existing,
    status: 'tracking',
    executionRequest: {
      ...existing.executionRequest,
      readyForExecution: true,
      preparedAt: new Date().toISOString()
    },
    monitoring: buildMonitoringState(existing),
    updatedAt: new Date().toISOString()
  };

  await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
  return nextIntent;
}

export async function pollTradeIntent(env, id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);

  if (existing.status !== 'tracking') {
    return existing;
  }

  const event = await fetchEventByInput(env, existing.input ?? existing.eventSlug);
  const { outcome } = findTrackedMarketOutcome(event, existing);
  const currentProbability = outcome?.probability ?? null;
  const nextIntent = evaluateMonitoringState(existing, currentProbability);

  await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
  return nextIntent;
}

export async function pollTrackingTradeIntents(env) {
  const intents = await readTradeIntents();
  const nextIntents = [];

  for (const intent of intents) {
    if (intent.status !== 'tracking') {
      nextIntents.push(intent);
      continue;
    }

    try {
      const event = await fetchEventByInput(env, intent.input ?? intent.eventSlug);
      const { outcome } = findTrackedMarketOutcome(event, intent);
      nextIntents.push(evaluateMonitoringState(intent, outcome?.probability ?? null));
    } catch {
      nextIntents.push({
        ...intent,
        monitoring: {
          ...intent.monitoring,
          lastEvaluationAt: new Date().toISOString(),
          notes: 'Monitoring refresh failed on the last poll attempt.'
        },
        updatedAt: new Date().toISOString()
      });
    }
  }

  await writeTradeIntents(nextIntents);
  return nextIntents.filter((intent) => intent.status === 'tracking');
}

export async function sellTradeIntent(id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);

  if (existing.status !== 'tracking') {
    throw new Error('Sell Now is only available for tracked positions.');
  }

  const nextIntent = finalizeTrackedIntent(existing, 'manual-sell', {
    ...existing.monitoring,
    state: 'sold-manual',
    lastEvaluationAt: new Date().toISOString(),
    exitReason: 'manual-sell',
    notes: 'Manual sell requested from the dashboard.'
  });

  await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
  return nextIntent;
}

export async function stopTradeIntent(id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);

  if (existing.status !== 'tracking') {
    throw new Error('Stop Bot is only available for tracked positions.');
  }

  const nextIntent = {
    ...existing,
    status: 'paused',
    monitoring: {
      ...existing.monitoring,
      state: 'stopped',
      lastEvaluationAt: new Date().toISOString(),
      exitReason: 'bot-stopped',
      notes: 'Automation paused manually from the dashboard.'
    },
    updatedAt: new Date().toISOString()
  };

  await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
  return nextIntent;
}