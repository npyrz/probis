import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { fetchEventByInput } from './polymarket/gamma.js';
import {
  findRecentFilledSellOrderForIntent,
  getLiveOutcomeProbabilityFromUsMarket,
  getOrderState,
  getPolymarketUsOrderById,
  getSharesFromOrder,
  getSpentFromOrder,
  placeBuyOrderForIntent,
  placeSellOrderForIntent,
  resolveIntentOrderFillState,
  resolveLivePositionShares
} from './polymarket/us-orders.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '../../../../');
const DATA_DIRECTORY = path.join(repoRoot, 'data');
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

function normalizeTrackedOutcomeLabel(label) {
  return String(label ?? '').trim().toLowerCase();
}

function isBinaryTrackedOutcomeLabel(label) {
  const normalized = normalizeTrackedOutcomeLabel(label);
  return normalized === 'yes' || normalized === 'no';
}

function getOrderCommissionNotional(orderResponse) {
  const order = orderResponse?.order ?? orderResponse;
  const commission = Number.parseFloat(order?.commissionNotionalTotalCollected?.value ?? NaN);
  return Number.isFinite(commission) && commission >= 0 ? commission : 0;
}

function getTrackedDisplayNotionalSpent({ entryIntent, outcomeLabel, sharesFilled, rawNotionalSpent, orderResponse }) {
  if (!Number.isFinite(rawNotionalSpent) || rawNotionalSpent < 0) {
    return null;
  }

  if (entryIntent !== 'ORDER_INTENT_BUY_SHORT' || isBinaryTrackedOutcomeLabel(outcomeLabel)) {
    return rawNotionalSpent;
  }

  if (!Number.isFinite(sharesFilled) || sharesFilled <= 0) {
    return rawNotionalSpent;
  }

  const commission = getOrderCommissionNotional(orderResponse);
  return Math.max(0, sharesFilled - rawNotionalSpent + commission);
}

function buildExecutionRequestShape(payload) {
  const entryProbability = Number.parseFloat(
    payload?.recommendation?.currentProbability ?? payload?.tradeSuggestion?.entryProbability ?? NaN
  );
  const tradeAmount = Number.parseFloat(payload?.tradeAmount ?? payload?.tradeSuggestion?.amount ?? NaN);
  const stopLossProbability = Number.parseFloat(payload?.tradeSuggestion?.stopLossProbability ?? NaN);
  const takeProfitProbability = Number.parseFloat(payload?.tradeSuggestion?.takeProfitProbability ?? NaN);
  const marketSlug = payload.marketSlug ?? null;

  return {
    requestId: randomUUID(),
    requestType: 'market-buy-intent',
    venue: 'polymarket-us',
    side: 'buy',
    orderType: 'market-intent',
    readyForExecution: false,
    createdAt: new Date().toISOString(),
    eventSlug: payload.eventSlug,
    marketSlug,
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
      requiresManualSubmission: false,
      credentialsConfigured: true
    }
  };
}

function buildMonitoringState(intent) {
  return {
    state: 'active',
    activatedAt: new Date().toISOString(),
    lastEvaluationAt: null,
    lastPolymarketQuoteAt: null,
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

function getExecutedEntryProbability(intent, buyOrder) {
  const shares = Number.parseFloat(buyOrder?.sharesFilled ?? intent?.executionRequest?.sharesEstimate ?? NaN);
  const rawSpent = Number.parseFloat(buyOrder?.notionalSpent ?? intent?.tradeAmount ?? NaN);
  const spent = getTrackedDisplayNotionalSpent({
    entryIntent: buyOrder?.entryIntent,
    outcomeLabel: intent?.outcomeLabel,
    sharesFilled: shares,
    rawNotionalSpent: rawSpent,
    orderResponse: buyOrder?.response
  });

  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(spent) || spent <= 0) {
    return intent.executionRequest?.entryProbability ?? intent.recommendation?.currentProbability ?? null;
  }

  return spent / shares;
}

function deriveRemainingPositionCostBasis({ entryShares, entryNotionalSpent, remainingShares }) {
  if (!Number.isFinite(entryShares) || entryShares <= 0) {
    return null;
  }

  if (!Number.isFinite(entryNotionalSpent) || entryNotionalSpent <= 0) {
    return null;
  }

  if (!Number.isFinite(remainingShares) || remainingShares < 0) {
    return null;
  }

  return (entryNotionalSpent / entryShares) * remainingShares;
}

function getPositionSideFromEntryIntent(entryIntent) {
  return entryIntent === 'ORDER_INTENT_BUY_SHORT' ? 'short' : 'long';
}

function buildExitRequestShape(intent, exitReason) {
  return {
    requestId: randomUUID(),
    requestType: 'market-sell-intent',
    venue: 'polymarket-us',
    side: 'sell',
    orderType: 'market-intent',
    createdAt: new Date().toISOString(),
    readyForExecution: true,
    eventSlug: intent.eventSlug,
    marketSlug: intent.marketSlug ?? null,
    conditionId: intent.conditionId ?? null,
    marketQuestion: intent.marketQuestion,
    outcomeLabel: intent.outcomeLabel,
    sharesEstimate: intent.executionRequest?.sharesEstimate ?? null,
    exitReason
  };
}

function findMatchingMarket(event, intent) {
  return event.markets.find((candidate) => candidate.conditionId && candidate.conditionId === intent.conditionId)
    ?? event.markets.find((candidate) => candidate.question === intent.marketQuestion)
    ?? null;
}

async function resolveIntentMarketMetadata(env, intent) {
  if (intent.marketSlug && intent.conditionId) {
    return {
      marketSlug: intent.marketSlug,
      conditionId: intent.conditionId
    };
  }

  const event = await fetchEventByInput(env, intent.input ?? intent.eventSlug);
  const market = findMatchingMarket(event, intent);

  if (!market?.slug) {
    throw new Error('Unable to resolve market slug for this intent. Re-run event analysis and save a fresh intent.');
  }

  return {
    marketSlug: market.slug,
    conditionId: market.conditionId ?? intent.conditionId ?? null
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

  if (payload.marketSlug !== undefined) {
    patch.marketSlug = payload.marketSlug;
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

function isTerminalUnfilledOrderState(orderState) {
  const normalized = String(orderState ?? '').trim().toUpperCase();

  return normalized === 'ORDER_STATE_EXPIRED'
    || normalized === 'ORDER_STATE_REJECTED'
    || normalized === 'ORDER_STATE_CANCELED'
    || normalized === 'ORDER_STATE_CANCELLED';
}

function getTerminalOrderStateFromVenueOrder(venueOrder) {
  const states = [getOrderState(venueOrder)];
  const executions = Array.isArray(venueOrder?.executions) ? venueOrder.executions : [];

  for (const execution of executions) {
    states.push(execution?.order?.state ?? null);
  }

  for (const state of states) {
    if (isTerminalUnfilledOrderState(state)) {
      return String(state);
    }
  }

  return getOrderState(venueOrder);
}

function shouldKeepExitPending(sellOrder) {
  if (sellOrder?.fullyClosed) {
    return false;
  }

  const orderState = String(sellOrder?.orderState ?? '').trim().toUpperCase();

  if (isTerminalUnfilledOrderState(orderState)) {
    return false;
  }

  return true;
}

function describeExitFailure(sellOrder, reasonLabel = 'Exit') {
  const orderId = sellOrder?.orderId ?? 'unknown';
  const orderState = String(sellOrder?.orderState ?? 'unknown').trim() || 'unknown';
  const exitMethod = String(sellOrder?.exitMethod ?? 'sell-order').trim() || 'sell-order';
  const sharesFilled = Number.parseFloat(sellOrder?.sharesFilled ?? NaN);
  const sharesRequested = Number.parseFloat(sellOrder?.sharesRequested ?? NaN);
  const partialFillDetail = Number.isFinite(sharesFilled) && sharesFilled > 0
    ? ` Filled ${sharesFilled}${Number.isFinite(sharesRequested) && sharesRequested > 0 ? ` of ${sharesRequested}` : ''} shares before the order became terminal.`
    : ' No shares were filled.';

  return `${reasonLabel} order ${orderId} via ${exitMethod} ended in ${orderState}.${partialFillDetail}`;
}

function buildVenueSyncClosedIntent(intent, nextState, notes, { exitReason } = {}) {
  return withApiVerification({
    ...intent,
    status: 'closed',
    monitoring: {
      ...intent.monitoring,
      state: nextState,
      lastEvaluationAt: new Date().toISOString(),
      exitReason: exitReason ?? 'entry-order-unfilled',
      notes
    },
    updatedAt: new Date().toISOString()
  }, {
    apiVerifiedFilledPosition: false,
    method: 'order-by-id',
    reason: nextState,
    orderId: intent.executionRequest?.venueOrderId ?? intent.position?.entryOrderId ?? null
  });
}

function isVenuePositionNotFoundError(error) {
  const message = String(error instanceof Error ? error.message : error ?? '').trim().toLowerCase();
  return message.includes('position not found');
}

function buildVenuePositionMissingClosedIntent(intent, { exitReason, notes, verificationReason }) {
  const nextIntent = finalizeTrackedIntent(intent, exitReason, {
    ...intent.monitoring,
    state: 'venue-position-missing',
    lastEvaluationAt: new Date().toISOString(),
    exitReason,
    notes
  });

  nextIntent.position = {
    ...nextIntent.position,
    sharesFilled: 0,
    notionalSpent: 0,
    lastExecutionAt: new Date().toISOString()
  };

  return withApiVerification(nextIntent, {
    apiVerifiedFilledPosition: false,
    method: 'close-position',
    reason: verificationReason,
    orderId: intent.executionRequest?.venueOrderId ?? intent.position?.entryOrderId ?? null
  });
}

function withApiVerification(intent, {
  apiVerifiedFilledPosition,
  method,
  reason,
  orderId,
  verifiedAt = null,
  checkedAt = new Date().toISOString()
}) {
  const isVerified = apiVerifiedFilledPosition === true;

  return {
    ...intent,
    verification: {
      source: 'polymarket-us',
      apiVerifiedFilledPosition: isVerified,
      method: method ?? null,
      reason: reason ?? (isVerified ? 'verified' : 'not-verified'),
      orderId: orderId ?? null,
      checkedAt,
      verifiedAt: isVerified
        ? (verifiedAt ?? checkedAt)
        : null
    }
  };
}

function ensureApiVerificationField(intent) {
  if (intent?.verification?.source === 'polymarket-us'
    && typeof intent?.verification?.apiVerifiedFilledPosition === 'boolean') {
    return intent;
  }

  return withApiVerification(intent, {
    apiVerifiedFilledPosition: false,
    method: 'not-checked',
    reason: 'not-verified',
    orderId: intent?.executionRequest?.venueOrderId ?? intent?.position?.entryOrderId ?? null
  });
}

async function reconcilePassiveIntentVerificationWithVenue(env, intent) {
  const status = String(intent?.status ?? '').trim().toLowerCase();

  if (!status || status === 'tracking' || status === 'closed') {
    return intent;
  }

  if (!intent?.marketSlug) {
    return withApiVerification(intent, {
      apiVerifiedFilledPosition: false,
      method: 'order-fills-only',
      reason: 'missing-market-slug',
      orderId: intent?.executionRequest?.venueOrderId ?? intent?.position?.entryOrderId ?? null
    });
  }

  let liveShares;

  try {
    liveShares = Number.parseFloat(await resolveLivePositionShares(env, intent) ?? NaN);
  } catch {
    liveShares = NaN;
  }

  const hasLiveShares = Number.isFinite(liveShares) && liveShares > 0;
  const orderId = intent?.executionRequest?.venueOrderId ?? intent?.position?.entryOrderId ?? null;

  if (hasLiveShares) {
    return withApiVerification({
      ...intent,
      position: {
        ...intent.position,
        sharesFilled: Number.isFinite(intent?.position?.sharesFilled)
          ? intent.position.sharesFilled
          : liveShares,
        lastExecutionAt: intent?.position?.lastExecutionAt ?? new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    }, {
      apiVerifiedFilledPosition: true,
      method: 'order-fills-only',
      reason: 'remaining-shares-detected',
      orderId,
      verifiedAt: intent?.verification?.verifiedAt ?? null
    });
  }

  return withApiVerification(intent, {
    apiVerifiedFilledPosition: false,
    method: 'order-fills-only',
    reason: 'no-remaining-shares-detected',
    orderId
  });
}

async function reconcileTrackingIntentWithVenue(env, intent) {
  if (intent.status !== 'tracking') {
    return intent;
  }

  const orderId = intent.executionRequest?.venueOrderId ?? intent.position?.entryOrderId ?? null;

  if (!orderId) {
    return buildVenueSyncClosedIntent(
      intent,
      'sync-removed-missing-order',
      'Removed from tracking because no venue order ID is attached to this intent.'
    );
  }

  let venueOrder;

  try {
    venueOrder = await getPolymarketUsOrderById(env, orderId);
  } catch (error) {
    return withApiVerification({
      ...intent,
      monitoring: {
        ...intent.monitoring,
        lastEvaluationAt: new Date().toISOString(),
        notes: error instanceof Error
          ? `Venue sync warning: order lookup failed temporarily (${error.message}). Keeping trade active pending next poll.`
          : 'Venue sync warning: order lookup failed temporarily. Keeping trade active pending next poll.'
      },
      updatedAt: new Date().toISOString()
    }, {
      apiVerifiedFilledPosition: false,
      method: 'order-by-id',
      reason: 'order-lookup-temporary-failure',
      orderId
    });
  }

  const sharesFilled = Number.parseFloat(getSharesFromOrder(venueOrder) ?? NaN);
  const rawNotionalSpent = Number.parseFloat(getSpentFromOrder(venueOrder) ?? NaN);
  const notionalSpent = getTrackedDisplayNotionalSpent({
    entryIntent: intent?.position?.entryIntent,
    outcomeLabel: intent?.outcomeLabel,
    sharesFilled,
    rawNotionalSpent,
    orderResponse: venueOrder
  });
  const orderState = getTerminalOrderStateFromVenueOrder(venueOrder);
  const hasEntryFills = Number.isFinite(sharesFilled) && sharesFilled > 0;

  let fillState;

  try {
    fillState = await resolveIntentOrderFillState(env, {
      ...intent,
      executionRequest: {
        ...intent.executionRequest,
        venueOrderId: orderId,
        venueOrder
      }
    });
  } catch {
    return withApiVerification({
      ...intent,
      executionRequest: {
        ...intent.executionRequest,
        venueOrder
      },
      monitoring: {
        ...intent.monitoring,
        lastEvaluationAt: new Date().toISOString(),
        notes: 'Venue sync warning: order history lookup failed temporarily. Keeping trade active pending next poll.'
      },
      updatedAt: new Date().toISOString()
    }, {
      apiVerifiedFilledPosition: false,
      method: 'order-fills-authoritative',
      reason: 'order-history-lookup-temporary-failure',
      orderId
    });
  }

  const remainingShares = Number.parseFloat(fillState?.remainingShares ?? NaN);
  const hasRemainingShares = Number.isFinite(remainingShares) && remainingShares > 0;
  const remainingNotionalSpent = Number.isFinite(remainingShares) && remainingShares >= 0
    ? (deriveRemainingPositionCostBasis({
        entryShares: sharesFilled,
        entryNotionalSpent: notionalSpent,
        remainingShares
      }) ?? (intent.position?.notionalSpent ?? null))
    : (Number.isFinite(notionalSpent) && notionalSpent > 0
      ? notionalSpent
      : (intent.position?.notionalSpent ?? null));

  if (!hasRemainingShares && hasEntryFills && fillState?.latestSellOrder) {
    const matchedSellOrderId = fillState.latestSellOrder?.id ?? null;
    const matchedSellShares = Number.parseFloat(getSharesFromOrder(fillState.latestSellOrder) ?? NaN);
    const closedIntent = finalizeTrackedIntent({
      ...intent,
      executionRequest: {
        ...intent.executionRequest,
        venueOrderId: orderId,
        venueOrder
      }
    }, 'external-sell-detected', {
      ...intent.monitoring,
      state: 'venue-sell-detected',
      lastEvaluationAt: new Date().toISOString(),
      exitReason: 'manual-sell',
      notes: `Detected filled sell order ${matchedSellOrderId ?? 'unknown'} on the venue after entry order ${orderId}; marking position closed.`
    });

    closedIntent.exitRequest = {
      ...closedIntent.exitRequest,
      venueOrderId: matchedSellOrderId,
      venueOrder: fillState.latestSellOrder,
      executedAt: fillState.latestSellOrder?.createTime ?? fillState.latestSellOrder?.insertTime ?? new Date().toISOString()
    };
    closedIntent.position = {
      ...closedIntent.position,
      exitOrderId: matchedSellOrderId,
      exitSharesFilled: Number.isFinite(matchedSellShares) && matchedSellShares > 0
        ? matchedSellShares
        : (closedIntent.position?.sharesFilled ?? null),
      lastExecutionAt: new Date().toISOString()
    };

    return withApiVerification(closedIntent, {
      apiVerifiedFilledPosition: true,
      method: 'entry-order-plus-external-sell-order',
      reason: 'external-sell-detected',
      orderId
    });
  }

  if (!hasRemainingShares && hasEntryFills) {
    return withApiVerification({
      ...intent,
      executionRequest: {
        ...intent.executionRequest,
        venueOrderId: orderId,
        venueOrder
      },
      position: {
        ...intent.position,
        entryOrderId: orderId,
        sharesFilled: 0,
        notionalSpent: 0,
        lastExecutionAt: new Date().toISOString()
      },
      monitoring: {
        ...intent.monitoring,
        lastEvaluationAt: new Date().toISOString(),
        syncNoLiveSharesCount: 0,
        notes: `Order ${orderId} is ${orderState} with ${sharesFilled} entry shares filled. Remaining open shares inferred from order fills: 0.`
      },
      updatedAt: new Date().toISOString()
    }, {
      apiVerifiedFilledPosition: true,
      method: 'order-fills-authoritative',
      reason: 'order-confirmed-filled',
      orderId
    });
  }

  if (!hasEntryFills && isTerminalUnfilledOrderState(orderState)) {
    return buildVenueSyncClosedIntent(
      {
        ...intent,
        executionRequest: {
          ...intent.executionRequest,
          venueOrder
        }
      },
      'sync-removed-unfilled',
      `Removed from tracking because venue order ${orderId} is ${orderState ?? 'terminal'} with no fills.`
    );
  }

  return withApiVerification({
    ...intent,
    executionRequest: {
      ...intent.executionRequest,
      venueOrderId: orderId,
      venueOrder
    },
    position: {
      ...intent.position,
      entryOrderId: orderId,
      sharesFilled: hasRemainingShares
        ? remainingShares
        : (Number.isFinite(fillState?.entryShares) && fillState.entryShares > 0
          ? fillState.entryShares
          : (intent.position?.sharesFilled ?? null)),
      notionalSpent: remainingNotionalSpent,
      lastExecutionAt: new Date().toISOString()
    },
    monitoring: {
      ...intent.monitoring,
      entryProbability: Number.isFinite(remainingShares) && remainingShares > 0 && Number.isFinite(remainingNotionalSpent) && remainingNotionalSpent > 0
        ? remainingNotionalSpent / remainingShares
        : intent.monitoring?.entryProbability ?? null,
      lastEvaluationAt: new Date().toISOString(),
      syncNoLiveSharesCount: 0,
      notes: `Order ${orderId} is ${orderState} with ${sharesFilled} entry shares filled. Remaining open shares inferred from order fills: ${hasRemainingShares ? remainingShares : sharesFilled}.`
    },
    updatedAt: new Date().toISOString()
  }, {
    apiVerifiedFilledPosition: true,
    method: 'order-fills-authoritative',
    reason: 'order-and-fill-history-verified',
    orderId
  });
}

async function reconcileSyncRemovedIntentWithVenue(env, intent) {
  if (intent.status !== 'closed') {
    return intent;
  }

  const monitoringState = String(intent.monitoring?.state ?? '');

  if (!monitoringState.startsWith('sync-removed')) {
    return intent;
  }

  const orderId = intent.executionRequest?.venueOrderId ?? intent.position?.entryOrderId ?? null;

  if (!orderId) {
    return intent;
  }

  let venueOrder;

  try {
    venueOrder = await getPolymarketUsOrderById(env, orderId);
  } catch {
    return intent;
  }

  const sharesFilled = Number.parseFloat(getSharesFromOrder(venueOrder) ?? NaN);
  const rawNotionalSpent = Number.parseFloat(getSpentFromOrder(venueOrder) ?? NaN);
  const notionalSpent = getTrackedDisplayNotionalSpent({
    entryIntent: intent?.position?.entryIntent,
    outcomeLabel: intent?.outcomeLabel,
    sharesFilled,
    rawNotionalSpent,
    orderResponse: venueOrder
  });

  let liveShares;

  try {
    liveShares = Number.parseFloat(await resolveLivePositionShares(env, intent) ?? NaN);
  } catch {
    liveShares = NaN;
  }

  const hasLiveShares = Number.isFinite(liveShares) && liveShares > 0;

  if (!hasLiveShares) {
    return intent;
  }

  return withApiVerification({
    ...intent,
    status: 'tracking',
    executionRequest: {
      ...intent.executionRequest,
      venueOrderId: orderId,
      venueOrder
    },
    position: {
      ...intent.position,
      entryOrderId: orderId,
      sharesFilled: Number.isFinite(sharesFilled) && sharesFilled > 0
        ? sharesFilled
        : (Number.isFinite(liveShares) && liveShares > 0 ? liveShares : intent.position?.sharesFilled ?? null),
      notionalSpent: Number.isFinite(notionalSpent) && notionalSpent > 0
        ? notionalSpent
        : (intent.position?.notionalSpent ?? null),
      lastExecutionAt: new Date().toISOString()
    },
    monitoring: {
      ...intent.monitoring,
      state: 'active',
      exitReason: null,
      entryProbability: Number.isFinite(sharesFilled) && sharesFilled > 0 && Number.isFinite(notionalSpent) && notionalSpent > 0
        ? notionalSpent / sharesFilled
        : intent.monitoring?.entryProbability ?? null,
      lastEvaluationAt: new Date().toISOString(),
      notes: `Recovered from venue sync for order ${orderId}; active position shares detected.`
    },
    updatedAt: new Date().toISOString()
  }, {
    apiVerifiedFilledPosition: true,
    method: 'order-by-id-plus-live-position',
    reason: 'recovered-live-shares-detected',
    orderId
  });
}

async function syncTrackingIntentsWithVenue(env, intents) {
  if (!env?.hasUsTradingCredentials) {
    return intents;
  }

  const nextIntents = [];

  for (const intent of intents) {
    if (intent.status === 'tracking') {
      nextIntents.push(await reconcileTrackingIntentWithVenue(env, intent));
      continue;
    }

    if (intent.status === 'closed') {
      nextIntents.push(await reconcileSyncRemovedIntentWithVenue(env, intent));
      continue;
    }

    nextIntents.push(await reconcilePassiveIntentVerificationWithVenue(env, intent));
  }

  return nextIntents;
}

async function executeTriggeredExit(env, intent, exitReason, monitoringState) {
  const resolvedMarket = await resolveIntentMarketMetadata(env, intent);
  const executableIntent = {
    ...intent,
    marketSlug: resolvedMarket.marketSlug,
    conditionId: resolvedMarket.conditionId
  };
  let sellOrder;

  try {
    sellOrder = await placeSellOrderForIntent(env, executableIntent);
  } catch (error) {
    if (isVenuePositionNotFoundError(error)) {
      return buildVenuePositionMissingClosedIntent(executableIntent, {
        exitReason,
        notes: 'Polymarket US reported that no active position remains for this market during exit. Marking the trade closed.',
        verificationReason: 'exit-position-missing'
      });
    }

    throw error;
  }

  if (!sellOrder.fullyClosed) {
    if (!shouldKeepExitPending(sellOrder)) {
      throw new Error(describeExitFailure(sellOrder, 'Exit'));
    }

    return {
      ...executableIntent,
      exitRequest: {
        ...executableIntent.exitRequest,
        venueOrderId: sellOrder.orderId,
        venueOrder: sellOrder.response,
        submission: sellOrder.request,
        executedAt: new Date().toISOString()
      },
      monitoring: {
        ...monitoringState,
        state: 'exit-submitted-awaiting-fill',
        notes: `Exit order ${sellOrder.orderId ?? 'unknown'} submitted via close-position endpoint with state ${sellOrder.orderState ?? 'unknown'}. Keeping trade active until the venue confirms all shares are closed.`
      },
      updatedAt: new Date().toISOString()
    };
  }

  const closedIntent = finalizeTrackedIntent(executableIntent, exitReason, monitoringState);

  closedIntent.exitRequest = {
    ...closedIntent.exitRequest,
    venueOrderId: sellOrder.orderId,
    venueOrder: sellOrder.response,
    submission: sellOrder.request,
    executedAt: new Date().toISOString()
  };
  closedIntent.position = {
    ...closedIntent.position,
    exitOrderId: sellOrder.orderId,
    exitSharesFilled: sellOrder.sharesFilled,
    lastExecutionAt: new Date().toISOString()
  };

  return closedIntent;
}

async function evaluateMonitoringState(env, intent, trackedQuote) {
  const currentProbability = trackedQuote?.currentProbability ?? null;
  const lastPolymarketQuoteAt = trackedQuote?.lastPolymarketQuoteAt ?? null;
  const currentMonitoringState = String(intent.monitoring?.state ?? '').trim();
  const baseMonitoring = {
    ...intent.monitoring,
    lastEvaluationAt: new Date().toISOString(),
    lastPolymarketQuoteAt,
    currentProbability,
    stopLossProbability: intent.tradeSuggestion?.stopLossProbability ?? intent.monitoring?.stopLossProbability ?? null,
    takeProfitProbability: intent.tradeSuggestion?.takeProfitProbability ?? intent.monitoring?.takeProfitProbability ?? null
  };
  const stopLossProbability = baseMonitoring.stopLossProbability;
  const takeProfitProbability = baseMonitoring.takeProfitProbability;
  const hasSubmittedExitOrder = Boolean(intent.exitRequest?.venueOrderId);
  const legacyFailedExitState = currentMonitoringState === 'stop-loss-triggered-exit-failed'
    || currentMonitoringState === 'take-profit-triggered-exit-failed'
    || currentMonitoringState === 'exit-failed-needs-manual-sell';
  const previousExitAttempts = legacyFailedExitState && !hasSubmittedExitOrder
    ? 0
    : (Number.parseInt(String(intent.monitoring?.exitAttemptFailures ?? '0'), 10) || 0);
  const MAX_EXIT_ATTEMPTS = 3;
  const exitAttemptsExhausted = previousExitAttempts >= MAX_EXIT_ATTEMPTS;

  if (intent.monitoring?.state === 'exit-submitted-awaiting-fill') {
    return {
      ...intent,
      monitoring: {
        ...baseMonitoring,
        state: 'exit-submitted-awaiting-fill',
        notes: intent.monitoring?.notes ?? 'Exit has been submitted. Waiting for the venue to confirm the position is closed.'
      },
      updatedAt: new Date().toISOString()
    };
  }

  if (typeof currentProbability === 'number' && typeof stopLossProbability === 'number' && currentProbability <= stopLossProbability) {
    if (exitAttemptsExhausted) {
      return {
        ...intent,
        monitoring: {
          ...baseMonitoring,
          state: 'exit-failed-needs-manual-sell',
          exitReason: 'stop-loss-hit',
          exitAttemptFailures: previousExitAttempts,
          notes: `Stop-loss triggered but sell has failed ${previousExitAttempts} times. Use Cash Out to sell manually.`
        },
        updatedAt: new Date().toISOString()
      };
    }

    const nextMonitoring = {
      ...baseMonitoring,
      state: 'stop-loss-hit',
      stopTriggeredAt: new Date().toISOString(),
      exitReason: 'stop-loss-hit',
      notes: 'Stop-loss threshold reached; submitting live sell order.'
    };

    try {
      return await executeTriggeredExit(env, intent, 'stop-loss-hit', nextMonitoring);
    } catch (error) {
      return {
        ...intent,
        monitoring: {
          ...baseMonitoring,
          state: 'stop-loss-triggered-exit-failed',
          stopTriggeredAt: new Date().toISOString(),
          exitReason: 'stop-loss-hit',
          exitAttemptFailures: previousExitAttempts + 1,
          notes: error instanceof Error
            ? `Stop-loss triggered but sell order failed (attempt ${previousExitAttempts + 1}/${MAX_EXIT_ATTEMPTS}): ${error.message}`
            : 'Stop-loss triggered but sell order failed.'
        },
        updatedAt: new Date().toISOString()
      };
    }
  }

  if (typeof currentProbability === 'number' && typeof takeProfitProbability === 'number' && currentProbability >= takeProfitProbability) {
    if (exitAttemptsExhausted) {
      return {
        ...intent,
        monitoring: {
          ...baseMonitoring,
          state: 'exit-failed-needs-manual-sell',
          exitReason: 'take-profit-hit',
          exitAttemptFailures: previousExitAttempts,
          notes: `Take-profit triggered but sell has failed ${previousExitAttempts} times. Use Cash Out to sell manually.`
        },
        updatedAt: new Date().toISOString()
      };
    }

    const nextMonitoring = {
      ...baseMonitoring,
      state: 'take-profit-hit',
      takeProfitTriggeredAt: new Date().toISOString(),
      exitReason: 'take-profit-hit',
      notes: 'Take-profit threshold reached; submitting live sell order.'
    };

    try {
      return await executeTriggeredExit(env, intent, 'take-profit-hit', nextMonitoring);
    } catch (error) {
      return {
        ...intent,
        monitoring: {
          ...baseMonitoring,
          state: 'take-profit-triggered-exit-failed',
          takeProfitTriggeredAt: new Date().toISOString(),
          exitReason: 'take-profit-hit',
          exitAttemptFailures: previousExitAttempts + 1,
          notes: error instanceof Error
            ? `Take-profit triggered but sell order failed (attempt ${previousExitAttempts + 1}/${MAX_EXIT_ATTEMPTS}): ${error.message}`
            : 'Take-profit triggered but sell order failed.'
        },
        updatedAt: new Date().toISOString()
      };
    }
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

async function resolveTrackedProbability(env, intent) {
  const liveOutcomeProbability = await getLiveOutcomeProbabilityFromUsMarket(
    env,
    intent.marketSlug,
    intent.outcomeLabel
  );

  if (typeof liveOutcomeProbability === 'number') {
    return {
      currentProbability: liveOutcomeProbability,
      lastPolymarketQuoteAt: new Date().toISOString()
    };
  }

  // US market price unavailable — return last known probability rather than falling back to international API.
  return {
    currentProbability: intent.monitoring?.currentProbability ?? null,
    lastPolymarketQuoteAt: intent.monitoring?.lastPolymarketQuoteAt ?? null
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
    marketSlug: payload.marketSlug ?? null,
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
    verification: {
      source: 'polymarket-us',
      apiVerifiedFilledPosition: false,
      method: 'not-checked',
      reason: 'intent-created-unverified',
      orderId: null,
      checkedAt: new Date().toISOString(),
      verifiedAt: null
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

export async function listTradeIntents(limit = 10, env = null) {
  const intents = await readTradeIntents();
  const syncedIntents = env ? await syncTrackingIntentsWithVenue(env, intents) : intents;
  let verificationBackfilled = false;
  const verifiedIntents = syncedIntents.map((intent) => {
    const nextIntent = ensureApiVerificationField(intent);

    if (nextIntent !== intent) {
      verificationBackfilled = true;
    }

    return nextIntent;
  });

  if (syncedIntents !== intents || verificationBackfilled) {
    await writeTradeIntents(verifiedIntents);
  }

  return verifiedIntents.slice(0, Math.max(1, limit));
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

export async function executeTradeIntent(env, id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);

  const resolvedMarket = await resolveIntentMarketMetadata(env, existing);
  const executableIntent = {
    ...existing,
    marketSlug: resolvedMarket.marketSlug,
    conditionId: resolvedMarket.conditionId
  };
  const buyOrder = await placeBuyOrderForIntent(env, executableIntent);
  const sharesFilled = Number.parseFloat(buyOrder?.sharesFilled ?? NaN);

  if (!Number.isFinite(sharesFilled) || sharesFilled <= 0) {
    const orderState = getOrderState(buyOrder?.response);
    const orderId = buyOrder?.orderId ?? null;
    const orderStateText = typeof orderState === 'string' && orderState.trim().length > 0
      ? ` state=${orderState}`
      : '';
    const orderIdText = typeof orderId === 'string' && orderId.trim().length > 0
      ? ` orderId=${orderId}`
      : '';
    const entryIntentText = typeof buyOrder?.entryIntent === 'string' && buyOrder.entryIntent.trim().length > 0
      ? ` intent=${buyOrder.entryIntent}`
      : '';
    const limitAttempts = Array.isArray(buyOrder?.attempts?.aggressiveLimit)
      ? buyOrder.attempts.aggressiveLimit
      : (buyOrder?.attempts?.aggressiveLimit ? [buyOrder.attempts.aggressiveLimit] : []);
    const attemptSummary = limitAttempts
      .map((attempt) => {
        const attemptedPrice = attempt?.request?.price?.value;
        const attemptedState = getOrderState(attempt?.response) ?? 'unknown';

        if (typeof attemptedPrice === 'string' || typeof attemptedPrice === 'number') {
          return `${attemptedPrice}:${attemptedState}`;
        }

        return attemptedState;
      })
      .filter(Boolean)
      .join(', ');
    const attemptsText = attemptSummary.length > 0
      ? ` attempts=${attemptSummary}`
      : '';
    throw new Error(`Order submitted but no shares were filled.${entryIntentText}${orderStateText}${orderIdText}${attemptsText} Trade remains unstarted; adjust price/size and try again.`);
  }

  const nextIntent = withApiVerification({
    ...executableIntent,
    status: 'tracking',
    executionRequest: {
      ...executableIntent.executionRequest,
      readyForExecution: true,
      marketSlug: resolvedMarket.marketSlug,
      preparedAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
      venueOrderId: buyOrder.orderId,
      venueOrder: buyOrder.response,
      submission: buyOrder.request
    },
    position: {
      side: getPositionSideFromEntryIntent(buyOrder.entryIntent),
      entryIntent: buyOrder.entryIntent,
      entryOrderId: buyOrder.orderId,
      sharesFilled: buyOrder.sharesFilled,
      notionalSpent: getTrackedDisplayNotionalSpent({
        entryIntent: buyOrder.entryIntent,
        outcomeLabel: executableIntent.outcomeLabel,
        sharesFilled: Number.parseFloat(buyOrder?.sharesFilled ?? NaN),
        rawNotionalSpent: Number.parseFloat(buyOrder?.notionalSpent ?? NaN),
        orderResponse: buyOrder.response
      }),
      lastExecutionAt: new Date().toISOString()
    },
    monitoring: buildMonitoringState(executableIntent),
    updatedAt: new Date().toISOString()
  }, {
    apiVerifiedFilledPosition: true,
    method: 'place-buy-order-response',
    reason: 'entry-fill-confirmed-at-order-placement',
    orderId: buyOrder.orderId
  });

  nextIntent.monitoring = {
    ...nextIntent.monitoring,
    entryProbability: getExecutedEntryProbability(executableIntent, buyOrder)
  };

  await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
  return nextIntent;
}

export async function pollTradeIntent(env, id) {
  const intents = await readTradeIntents();
  const syncedIntents = await syncTrackingIntentsWithVenue(env, intents);
  const existing = findTradeIntentOrThrow(syncedIntents, id);

  if (existing.status !== 'tracking') {
    if (syncedIntents !== intents) {
      await writeTradeIntents(syncedIntents);
    }

    return existing;
  }

  const currentProbability = await resolveTrackedProbability(env, existing);
  const nextIntent = await evaluateMonitoringState(env, existing, currentProbability);

  await writeTradeIntents(replaceTradeIntent(syncedIntents, nextIntent));
  return nextIntent;
}

export async function pollTrackingTradeIntents(env) {
  const intents = await readTradeIntents();
  const syncedIntents = await syncTrackingIntentsWithVenue(env, intents);
  const nextIntents = await Promise.all(syncedIntents.map(async (intent) => {
    if (intent.status !== 'tracking') {
      return intent;
    }

    try {
      const trackedProbability = await resolveTrackedProbability(env, intent);
      return await evaluateMonitoringState(env, intent, trackedProbability);
    } catch {
      return {
        ...intent,
        monitoring: {
          ...intent.monitoring,
          lastEvaluationAt: new Date().toISOString(),
          notes: 'Monitoring refresh failed on the last poll attempt.'
        },
        updatedAt: new Date().toISOString()
      };
    }
  }));

  await writeTradeIntents(nextIntents);
  return nextIntents;
}

export async function sellTradeIntent(env, id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);

  if (existing.status !== 'tracking') {
    throw new Error('Sell Now is only available for tracked positions.');
  }

  const resolvedMarket = await resolveIntentMarketMetadata(env, existing);
  const executableIntent = {
    ...existing,
    marketSlug: resolvedMarket.marketSlug,
    conditionId: resolvedMarket.conditionId
  };
  let sellOrder;

  try {
    sellOrder = await placeSellOrderForIntent(env, executableIntent);
  } catch (error) {
    if (isVenuePositionNotFoundError(error)) {
      const nextIntent = buildVenuePositionMissingClosedIntent(executableIntent, {
        exitReason: 'manual-sell',
        notes: 'Polymarket US reported that this position no longer exists. Marking the trade closed and removing it from active monitoring.',
        verificationReason: 'manual-sell-position-missing'
      });

      await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
      return nextIntent;
    }

    throw error;
  }

  if (!sellOrder.fullyClosed) {
    if (!shouldKeepExitPending(sellOrder)) {
      const nextIntent = {
        ...executableIntent,
        status: 'tracking',
        monitoring: {
          ...executableIntent.monitoring,
          state: 'exit-failed-needs-manual-sell',
          lastEvaluationAt: new Date().toISOString(),
          exitReason: 'manual-sell',
          notes: describeExitFailure(sellOrder, 'Cash Out')
        },
        exitRequest: {
          ...executableIntent.exitRequest,
          venueOrderId: sellOrder.orderId,
          venueOrder: sellOrder.response,
          submission: sellOrder.request,
          executedAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      };

      await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
      return nextIntent;
    }

    const nextIntent = {
      ...executableIntent,
      status: 'tracking',
      monitoring: {
        ...executableIntent.monitoring,
        state: 'exit-submitted-awaiting-fill',
        lastEvaluationAt: new Date().toISOString(),
        exitReason: 'manual-sell',
        notes: `Cash Out order ${sellOrder.orderId ?? 'unknown'} submitted via close-position endpoint with state ${sellOrder.orderState ?? 'unknown'}. Keeping trade active until fully closed on the venue.`
      },
      exitRequest: {
        ...executableIntent.exitRequest,
        venueOrderId: sellOrder.orderId,
        venueOrder: sellOrder.response,
        submission: sellOrder.request,
        executedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    };

    await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
    return nextIntent;
  }

  let nextIntent = finalizeTrackedIntent(executableIntent, 'manual-sell', {
    ...executableIntent.monitoring,
    state: 'sold-manual',
    lastEvaluationAt: new Date().toISOString(),
    exitReason: 'manual-sell',
    notes: 'Manual sell requested from the dashboard.'
  });
  const previouslyVerified = existing?.verification?.apiVerifiedFilledPosition === true;
  nextIntent = withApiVerification(nextIntent, {
    apiVerifiedFilledPosition: previouslyVerified,
    method: previouslyVerified ? 'inherited' : 'order-by-id-plus-live-position',
    reason: previouslyVerified ? 'entry-verification-retained-after-sell' : 'not-verified',
    orderId: existing.executionRequest?.venueOrderId ?? existing.position?.entryOrderId ?? null,
    verifiedAt: previouslyVerified ? existing?.verification?.verifiedAt ?? null : null
  });
  nextIntent.exitRequest = {
    ...nextIntent.exitRequest,
    venueOrderId: sellOrder.orderId,
    venueOrder: sellOrder.response,
    submission: sellOrder.request,
    executedAt: new Date().toISOString()
  };
  nextIntent.position = {
    ...nextIntent.position,
    exitOrderId: sellOrder.orderId,
    exitSharesFilled: sellOrder.sharesFilled,
    lastExecutionAt: new Date().toISOString()
  };

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

export async function closeTradeIntent(id) {
  const intents = await readTradeIntents();
  const existing = findTradeIntentOrThrow(intents, id);

  if (existing.status === 'closed') {
    return existing;
  }

  const nextIntent = {
    ...existing,
    status: 'closed',
    monitoring: existing.monitoring
      ? {
          ...existing.monitoring,
          state: 'closed-manual',
          lastEvaluationAt: new Date().toISOString(),
          exitReason: 'intent-closed-manual',
          notes: 'Intent closed manually from Trade Center.'
        }
      : existing.monitoring,
    updatedAt: new Date().toISOString()
  };

  await writeTradeIntents(replaceTradeIntent(intents, nextIntent));
  return nextIntent;
}