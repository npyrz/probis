import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  backfillChicagoArchive,
  backfillChicagoForecastVintages,
  backfillChicagoHistoricalBoards,
  createChicagoTradeIntent,
  deleteTradeIntent as deleteTradeIntentRequest,
  evaluateChicagoWeatherModel,
  executeTradeIntent as executeTradeIntentRequest,
  fetchChicagoAlerts,
  fetchChicagoMarketCatalog,
  fetchChicagoSnapshot,
  fetchTradeIntents,
  pollTradeIntent,
  repriceChicagoMarkets,
  sellTradeIntent as sellTradeIntentRequest,
  stopTradeIntent as stopTradeIntentRequest,
  trainChicagoWeatherModel,
  updateTradeIntent as updateTradeIntentRequest
} from './lib/api.js';

const DEFAULT_CATALOG_DAYS_AHEAD = 14;
const DEFAULT_KMDW_SNAPSHOT_POLL_INTERVAL_MS = 180000;
const DEFAULT_TRAINING_WINDOW_DAYS = 45;
const DEFAULT_TRAINING_FIDELITY_MINUTES = 60;
const DEFAULT_TRAINING_LEAD_DAYS = '1,2,3';

const TRAINING_WINDOW_PRESETS = [
  { value: '14', label: '14 days', days: 14 },
  { value: '30', label: '30 days', days: 30 },
  { value: '45', label: '45 days', days: 45 },
  { value: '90', label: '90 days', days: 90 },
  { value: 'custom', label: 'Custom', days: null }
];

const TRAINING_STEP_DEFINITIONS = [
  { id: 'archive', label: 'Official Actuals' },
  { id: 'forecastVintages', label: 'Forecast Vintages' },
  { id: 'historicalBoards', label: 'Market Boards' },
  { id: 'train', label: 'Train Model' },
  { id: 'evaluate', label: 'Evaluate Model' }
];

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function toDateInputValue(date) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate())
  ].join('-');
}

function getDefaultTrainingDateRange(days = DEFAULT_TRAINING_WINDOW_DAYS) {
  const dateTo = new Date();
  dateTo.setHours(0, 0, 0, 0);
  dateTo.setDate(dateTo.getDate() - 1);

  const dateFrom = new Date(dateTo);
  dateFrom.setDate(dateTo.getDate() - Math.max(1, days) + 1);

  return {
    dateFrom: toDateInputValue(dateFrom),
    dateTo: toDateInputValue(dateTo)
  };
}

function createTrainingSteps() {
  return TRAINING_STEP_DEFINITIONS.map((step) => ({
    ...step,
    status: 'idle',
    detail: '',
    startedAt: null,
    finishedAt: null
  }));
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatPercent(value, digits = 1) {
  const number = numberOrNull(value);
  return number === null ? 'n/a' : `${(number * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value, digits = 1) {
  const number = numberOrNull(value);

  if (number === null) {
    return 'n/a';
  }

  return `${number > 0 ? '+' : ''}${(number * 100).toFixed(digits)}%`;
}

function formatPrice(value) {
  const number = numberOrNull(value);
  return number === null ? 'n/a' : `$${number.toFixed(3)}`;
}

function formatCurrency(value) {
  const number = numberOrNull(value);

  if (number === null) {
    return 'n/a';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(number);
}

function formatCompactNumber(value) {
  const number = numberOrNull(value);

  if (number === null) {
    return 'n/a';
  }

  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(number);
}

function formatTemperature(value) {
  const number = numberOrNull(value);
  return number === null ? 'n/a' : `${number.toFixed(1)} F`;
}

function formatDate(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00` : value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parsed);
}

function formatShortDate(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(`${value}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric'
  }).format(parsed);
}

function formatDateTime(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
}

function formatRelativeAge(value, now = new Date()) {
  if (!value) {
    return 'n/a';
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  const seconds = Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 1000));

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(startedAt, finishedAt = new Date()) {
  if (!startedAt) {
    return '';
  }

  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const end = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return '';
  }

  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  return `${minutes}m ${remainderSeconds}s`;
}

function parseLeadDaysInput(value) {
  const leadDays = String(value ?? '')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 7);

  if (leadDays.length === 0) {
    throw new Error('Lead days must include at least one value from 0 through 7.');
  }

  return [...new Set(leadDays)].sort((left, right) => left - right);
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }

  return parsed;
}

function validateTrainingDateRange({ dateFrom, dateTo }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo))) {
    throw new Error('Choose a valid training date range.');
  }

  if (dateFrom > dateTo) {
    throw new Error('Training start date must be before the end date.');
  }
}

function summarizeTrainingResult(stepId, result) {
  if (stepId === 'archive') {
    return `${result?.archive?.recordCount ?? 0} official actual rows`;
  }

  if (stepId === 'forecastVintages') {
    return `${result?.archive?.recordCount ?? 0} forecast rows`;
  }

  if (stepId === 'historicalBoards') {
    const summary = result?.archive?.summary ?? {};
    return `${summary.boardSnapshotCount ?? 0} board snapshots, ${summary.pricePointCount ?? 0} prices`;
  }

  if (stepId === 'train') {
    const rowCount = result?.trainingRows?.rowCount ?? 0;
    const status = result?.model?.status ?? (result?.ok ? 'ready' : 'insufficient');
    return `${formatStatus(status)} from ${rowCount} rows`;
  }

  if (stepId === 'evaluate') {
    const rowCount = result?.trainingRows?.rowCount ?? 0;
    return result?.ok ? `Evaluated ${rowCount} rows` : (result?.reason ?? 'Evaluation did not complete');
  }

  return 'Complete';
}

function formatBucketLabel(bucket) {
  if (!bucket) {
    return 'Bucket';
  }

  if (typeof bucket.lowTemp === 'number' && typeof bucket.highTemp === 'number') {
    return bucket.lowTemp === bucket.highTemp
      ? `${bucket.lowTemp} F`
      : `${bucket.lowTemp}-${bucket.highTemp} F`;
  }

  if (typeof bucket.lowTemp === 'number') {
    return `${bucket.lowTemp} F+`;
  }

  if (typeof bucket.highTemp === 'number') {
    return `${bucket.highTemp} F or lower`;
  }

  return bucket.outcomeLabel ?? bucket.marketTitle ?? bucket.marketQuestion ?? 'Bucket';
}

function formatAction(recommendation) {
  if (!recommendation) {
    return 'NO SIGNAL';
  }

  return recommendation.action === 'recommend-buy-yes' ? 'BUY YES' : 'WATCH';
}

function formatStatus(value) {
  const text = String(value ?? 'unranked').trim();

  if (!text) {
    return 'UNRANKED';
  }

  return text
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatMarketDataMode(policy) {
  if (policy?.transport === 'polling' && policy?.streamingEnabled === false) {
    return 'POLLING';
  }

  return policy?.transport ? String(policy.transport).toUpperCase() : 'POLLING';
}

function getPollingIntervalMs(snapshot) {
  const value = Number.parseInt(
    String(snapshot?.marketDataPolicy?.polling?.kmdwSnapshotPollIntervalMs ?? ''),
    10
  );

  return Number.isFinite(value) && value > 0 ? value : DEFAULT_KMDW_SNAPSHOT_POLL_INTERVAL_MS;
}

function getToneClass(value) {
  const number = numberOrNull(value);

  if (number === null) {
    return 'metric-neutral';
  }

  if (number > 0.002) {
    return 'metric-good';
  }

  if (number < -0.002) {
    return 'metric-bad';
  }

  return 'metric-neutral';
}

function getMarketUrl(row) {
  if (row?.eventSlug) {
    return `https://polymarket.us/event/${row.eventSlug}`;
  }

  if (row?.marketSlug) {
    return `https://polymarket.us/market/${row.marketSlug}`;
  }

  return null;
}

function getActiveAlerts(alerts) {
  if (Array.isArray(alerts?.alerts)) {
    return alerts.alerts;
  }

  if (Array.isArray(alerts)) {
    return alerts;
  }

  return [];
}

function getAlertCount(alerts) {
  const activeAlerts = getActiveAlerts(alerts);
  return alerts?.summary?.activeCount ?? alerts?.activeCount ?? activeAlerts.length;
}

function getVerificationLabel(bucket) {
  if (bucket?.designatedSource?.verified === true) {
    return 'VERIFIED';
  }

  if (bucket?.ruleFlags?.hasKmdwSource === true && bucket?.ruleFlags?.ruleAmbiguity !== true) {
    return 'KMDW RULES';
  }

  return 'REVIEW';
}

function compareRankedRows(left, right) {
  const leftPassed = left.status === 'passed' ? 1 : 0;
  const rightPassed = right.status === 'passed' ? 1 : 0;

  if (leftPassed !== rightPassed) {
    return rightPassed - leftPassed;
  }

  const leftRankValue = left.score ?? left.riskAdjustedEdge ?? left.edge ?? -Infinity;
  const rightRankValue = right.score ?? right.riskAdjustedEdge ?? right.edge ?? -Infinity;

  if (leftRankValue !== rightRankValue) {
    return rightRankValue - leftRankValue;
  }

  return String(left.targetDate ?? '').localeCompare(String(right.targetDate ?? ''));
}

function buildRankedBetRows(snapshot) {
  const buckets = Array.isArray(snapshot?.markets?.buckets) ? snapshot.markets.buckets : [];
  const recommendations = Array.isArray(snapshot?.recommendations?.recommendations)
    ? snapshot.recommendations.recommendations
    : [];
  const bucketById = new Map(buckets.map((bucket) => [bucket.conditionId, bucket]));
  const recommendationById = new Map(recommendations.map((recommendation) => [recommendation.conditionId, recommendation]));
  const conditionIds = new Set([
    ...buckets.map((bucket) => bucket.conditionId),
    ...recommendations.map((recommendation) => recommendation.conditionId)
  ]);

  return [...conditionIds]
    .filter(Boolean)
    .map((conditionId) => {
      const bucket = bucketById.get(conditionId) ?? {};
      const recommendation = recommendationById.get(conditionId) ?? null;
      const fairProbability = numberOrNull(recommendation?.fairProbability)
        ?? numberOrNull(snapshot?.prediction?.bucketProbabilities?.[conditionId]);
      const marketPrice = numberOrNull(recommendation?.marketPrice)
        ?? numberOrNull(bucket.bestAsk)
        ?? numberOrNull(bucket.marketProbability);
      const edge = numberOrNull(recommendation?.edge)
        ?? (fairProbability !== null && marketPrice !== null ? fairProbability - marketPrice : null);
      const riskAdjustedEdge = numberOrNull(recommendation?.riskAdjustedEdge) ?? edge;
      const score = numberOrNull(recommendation?.score);

      return {
        conditionId,
        targetDate: recommendation?.targetDate ?? bucket.targetDate ?? snapshot?.targetDate ?? null,
        marketSlug: recommendation?.marketSlug ?? bucket.marketSlug ?? null,
        eventSlug: bucket.eventSlug ?? null,
        eventTitle: bucket.eventTitle ?? null,
        marketQuestion: bucket.marketQuestion ?? bucket.marketTitle ?? recommendation?.outcomeLabel ?? '',
        label: formatBucketLabel(recommendation ?? bucket),
        action: formatAction(recommendation),
        status: recommendation?.status ?? 'unranked',
        fairProbability,
        marketPrice,
        edge,
        riskAdjustedEdge,
        score,
        maxEntryPrice: numberOrNull(recommendation?.maxEntryPrice),
        bestBid: numberOrNull(bucket.bestBid),
        bestAsk: numberOrNull(bucket.bestAsk),
        marketProbability: numberOrNull(bucket.marketProbability),
        spread: numberOrNull(bucket.spread),
        liquidity: numberOrNull(bucket.askDepth) ?? numberOrNull(bucket.liquidity),
        volume: numberOrNull(bucket.volume),
        verificationLabel: getVerificationLabel(bucket),
        gates: Array.isArray(recommendation?.gates) ? recommendation.gates : [],
        bucket,
        recommendation
      };
    })
    .sort(compareRankedRows);
}

function buildBoardRankedRows(snapshots) {
  return (Array.isArray(snapshots) ? snapshots : [])
    .flatMap((boardSnapshot) => buildRankedBetRows(boardSnapshot))
    .sort(compareRankedRows);
}

function getCatalogTargetDates(catalog, fallbackDate = null) {
  const groupedDates = (Array.isArray(catalog?.dateGroups) ? catalog.dateGroups : [])
    .map((group) => group.targetDate)
    .filter(Boolean);
  const bucketDates = (Array.isArray(catalog?.buckets) ? catalog.buckets : [])
    .map((bucket) => bucket.targetDate)
    .filter(Boolean);
  const dates = [...groupedDates, ...bucketDates, fallbackDate].filter(Boolean);

  return [...new Set(dates)]
    .sort((left, right) => String(left).localeCompare(String(right)))
    .slice(0, DEFAULT_CATALOG_DAYS_AHEAD + 1);
}

function sortSnapshotsByDate(snapshots) {
  return (Array.isArray(snapshots) ? snapshots : [])
    .filter(Boolean)
    .sort((left, right) => String(left.targetDate ?? '').localeCompare(String(right.targetDate ?? '')));
}

function formatDateRange(rows, fallbackDate = null) {
  const dates = [...new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => row.targetDate)
      .filter(Boolean)
  )].sort((left, right) => String(left).localeCompare(String(right)));

  if (dates.length === 0) {
    return fallbackDate ?? 'n/a';
  }

  if (dates.length === 1) {
    return dates[0];
  }

  return `${formatShortDate(dates[0])} to ${formatShortDate(dates[dates.length - 1])}`;
}

function getTemperatureDistributionRows(snapshot) {
  return Object.entries(snapshot?.prediction?.temperatureDistribution ?? {})
    .map(([temperature, probability]) => ({
      temperature: Number.parseInt(temperature, 10),
      probability
    }))
    .filter((row) => Number.isFinite(row.temperature) && typeof row.probability === 'number')
    .sort((left, right) => right.probability - left.probability)
    .slice(0, 8);
}

function formatAmountInput(value) {
  const number = numberOrNull(value);

  if (number === null || number <= 0) {
    return '';
  }

  return number.toFixed(2);
}

function parseTradeAmount(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getRecommendedTradeAmount(row) {
  return [
    row?.recommendation?.suggestedSize,
    row?.recommendation?.executionPlan?.suggestedNotional,
    row?.recommendation?.tradeSuggestion?.amount
  ].map(numberOrNull).find((value) => typeof value === 'number' && value > 0) ?? null;
}

function getSharesEstimate(amount, price) {
  const tradeAmount = numberOrNull(amount);
  const entryPrice = numberOrNull(price);

  if (tradeAmount === null || entryPrice === null || entryPrice <= 0) {
    return null;
  }

  return tradeAmount / entryPrice;
}

function getGateSeverity(gate) {
  return gate?.severity ?? (gate?.name === 'spread <= 5pp' ? 'warning' : 'blocker');
}

function isSpreadWarningBlocker(blocker) {
  const text = String(blocker ?? '').trim().toLowerCase();
  return text === 'gate failed: spread <= 5pp' || text === 'spread <= 5pp';
}

function getTradeBlockers(row) {
  const executionBlockers = Array.isArray(row?.recommendation?.executionPlan?.blockers)
    ? row.recommendation.executionPlan.blockers.filter(Boolean).filter((blocker) => !isSpreadWarningBlocker(blocker))
    : [];

  if (executionBlockers.length > 0) {
    return executionBlockers;
  }

  return (Array.isArray(row?.gates) ? row.gates : [])
    .filter((gate) => !gate.passed && getGateSeverity(gate) !== 'warning')
    .map((gate) => gate.name)
    .filter(Boolean);
}

function getTradeWarnings(row) {
  const executionWarnings = Array.isArray(row?.recommendation?.executionPlan?.warnings)
    ? row.recommendation.executionPlan.warnings.filter(Boolean)
    : [];
  const gateWarnings = (Array.isArray(row?.gates) ? row.gates : [])
    .filter((gate) => !gate.passed && getGateSeverity(gate) === 'warning')
    .map((gate) => gate.name)
    .filter(Boolean);

  return [...new Set([...executionWarnings, ...gateWarnings])];
}

function formatTradeStatus(intent, row = null, canPrepare = false) {
  if (intent?.status) {
    return formatStatus(intent.status);
  }

  if (!row) {
    return 'No Selection';
  }

  return canPrepare ? 'Ready' : 'Blocked';
}

function isDraftTradeIntent(intent) {
  return intent?.status === 'draft';
}

function getTradePolicyCopy(intent, row = null, canPrepare = false) {
  const blocker = intent?.liveTradingPolicy?.blocker
    ?? intent?.executionRequest?.liveRoutingBlockedReason
    ?? null;

  if (blocker) {
    return blocker;
  }

  if (intent?.executionRequest?.constraints?.requiresManualSubmission === true) {
    return 'Backend review is required before venue routing this order.';
  }

  if (!row) {
    return 'Select a ranked Chicago weather bet to prepare or submit a trade.';
  }

  if (canPrepare) {
    const warnings = getTradeWarnings(row);

    if (warnings.length > 0) {
      return `Warning: ${warnings.slice(0, 2).join('; ')}. Submit Trade still routes after your button confirmation.`;
    }

    return 'Submit Trade routes this order from Probis after your button confirmation.';
  }

  const blockers = getTradeBlockers(row);

  if (blockers.length > 0) {
    return `Blocked: ${blockers.slice(0, 2).join('; ')}.`;
  }

  return 'Prepare a draft or adjust the amount before submitting.';
}

function getMatchingTradeIntent(intents, row) {
  if (!row) {
    return null;
  }

  return (Array.isArray(intents) ? intents : []).find((intent) => (
    (row.conditionId && intent.conditionId === row.conditionId)
    || (row.marketSlug && intent.marketSlug === row.marketSlug)
  )) ?? null;
}

function isManagedChicagoIntent(intent, rankedRows) {
  if (!intent) {
    return false;
  }

  const rankedConditionIds = new Set(rankedRows.map((row) => row.conditionId).filter(Boolean));
  const text = [
    intent.eventSlug,
    intent.eventTitle,
    intent.marketQuestion,
    intent.input,
    intent.executionRequest?.requestType
  ].filter(Boolean).join(' ').toLowerCase();

  return rankedConditionIds.has(intent.conditionId)
    || text.includes('kmdw')
    || text.includes('midway')
    || text.includes('chicago');
}

function Metric({ label, value, tone = 'metric-neutral' }) {
  return (
    <article className="metric-cell">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </article>
  );
}

function GateList({ gates }) {
  if (!Array.isArray(gates) || gates.length === 0) {
    return <span className="chip chip-muted">No gates</span>;
  }

  return (
    <div className="gate-list">
      {gates.map((gate) => {
        const severity = getGateSeverity(gate);
        const className = gate.passed
          ? 'chip chip-good'
          : severity === 'warning'
            ? 'chip chip-warn'
            : 'chip chip-bad';
        const label = gate.passed ? 'Pass' : severity === 'warning' ? 'Warn' : 'Block';

        return (
          <span
            key={gate.name}
            className={className}
            title={gate.name}
          >
            {label} {gate.name}
          </span>
        );
      })}
    </div>
  );
}

function TrainingPortal({
  isOpen,
  config,
  steps,
  isRunning,
  error,
  notice,
  onClose,
  onRun,
  onConfigChange,
  onPresetChange
}) {
  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="training-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="training-modal-title"
      >
        <div className="training-modal-header">
          <div>
            <p className="eyebrow">Local Training</p>
            <h2 id="training-modal-title">Training Data Portal</h2>
          </div>
          <button
            type="button"
            className="inline-action-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="training-form-grid">
          <label className="training-field" htmlFor="training-window-preset">
            <span>Window</span>
            <select
              id="training-window-preset"
              value={config.windowPreset}
              onChange={(event) => onPresetChange(event.target.value)}
              disabled={isRunning}
            >
              {TRAINING_WINDOW_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>

          <label className="training-field" htmlFor="training-date-from">
            <span>From</span>
            <input
              id="training-date-from"
              type="date"
              value={config.dateFrom}
              onChange={(event) => onConfigChange({ dateFrom: event.target.value, windowPreset: 'custom' })}
              disabled={isRunning}
            />
          </label>

          <label className="training-field" htmlFor="training-date-to">
            <span>To</span>
            <input
              id="training-date-to"
              type="date"
              value={config.dateTo}
              onChange={(event) => onConfigChange({ dateTo: event.target.value, windowPreset: 'custom' })}
              disabled={isRunning}
            />
          </label>

          <label className="training-field" htmlFor="training-fidelity">
            <span>Board Interval</span>
            <select
              id="training-fidelity"
              value={config.fidelityMinutes}
              onChange={(event) => onConfigChange({ fidelityMinutes: event.target.value })}
              disabled={isRunning}
            >
              <option value="15">15 min</option>
              <option value="30">30 min</option>
              <option value="60">60 min</option>
              <option value="120">2 hr</option>
              <option value="240">4 hr</option>
            </select>
          </label>

          <label className="training-field" htmlFor="training-lead-days">
            <span>Lead Days</span>
            <input
              id="training-lead-days"
              type="text"
              value={config.leadDays}
              onChange={(event) => onConfigChange({ leadDays: event.target.value })}
              disabled={isRunning}
            />
          </label>

          <label className="training-check" htmlFor="training-include-trades">
            <input
              id="training-include-trades"
              type="checkbox"
              checked={config.includeTrades}
              onChange={(event) => onConfigChange({ includeTrades: event.target.checked })}
              disabled={isRunning}
            />
            <span>Include trades</span>
          </label>
        </div>

        <div className="training-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={onRun}
            disabled={isRunning}
          >
            {isRunning ? 'Running' : 'Run All Training Data'}
          </button>
        </div>

        {notice ? <p className="trade-notice">{notice}</p> : null}
        {error ? <p className="trade-error">{error}</p> : null}

        <div className="training-step-list">
          {steps.map((step) => (
            <article key={step.id} className={`training-step training-step-${step.status}`}>
              <div>
                <strong>{step.label}</strong>
                <span>{formatStatus(step.status)}</span>
              </div>
              <p>
                {step.detail || (step.status === 'idle' ? 'Waiting' : '')}
                {step.finishedAt ? ` (${formatDuration(step.startedAt, step.finishedAt)})` : ''}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>,
    document.body
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [boardSnapshots, setBoardSnapshots] = useState([]);
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRepricing, setIsRepricing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [clock, setClock] = useState(() => new Date());
  const [selectedConditionId, setSelectedConditionId] = useState(null);
  const [tradeAmount, setTradeAmount] = useState('');
  const [tradeIntent, setTradeIntent] = useState(null);
  const [tradeIntents, setTradeIntents] = useState([]);
  const [tradeNotice, setTradeNotice] = useState('');
  const [tradeError, setTradeError] = useState('');
  const [isPreparingTrade, setIsPreparingTrade] = useState(false);
  const [isSubmittingTrade, setIsSubmittingTrade] = useState(false);
  const [isManagingTrade, setIsManagingTrade] = useState(false);
  const [isTrainingPortalOpen, setIsTrainingPortalOpen] = useState(false);
  const [isRunningTraining, setIsRunningTraining] = useState(false);
  const [trainingError, setTrainingError] = useState('');
  const [trainingNotice, setTrainingNotice] = useState('');
  const [trainingSteps, setTrainingSteps] = useState(() => createTrainingSteps());
  const [trainingConfig, setTrainingConfig] = useState(() => ({
    windowPreset: String(DEFAULT_TRAINING_WINDOW_DAYS),
    ...getDefaultTrainingDateRange(DEFAULT_TRAINING_WINDOW_DAYS),
    fidelityMinutes: String(DEFAULT_TRAINING_FIDELITY_MINUTES),
    leadDays: DEFAULT_TRAINING_LEAD_DAYS,
    includeTrades: true
  }));

  const rankedRows = useMemo(() => buildBoardRankedRows(boardSnapshots), [boardSnapshots]);
  const temperatureRows = useMemo(() => getTemperatureDistributionRows(snapshot), [snapshot]);
  const activeAlerts = getActiveAlerts(alerts);
  const bestRow = rankedRows[0] ?? null;
  const selectedTradeRow = rankedRows.find((row) => row.conditionId === selectedConditionId) ?? bestRow;
  const recommendedTradeAmount = getRecommendedTradeAmount(selectedTradeRow);
  const parsedTradeAmount = parseTradeAmount(tradeAmount);
  const selectedSharesEstimate = getSharesEstimate(parsedTradeAmount, selectedTradeRow?.marketPrice);
  const selectedPayoutEstimate = selectedSharesEstimate;
  const selectedProfitEstimate = selectedPayoutEstimate === null || parsedTradeAmount === null
    ? null
    : selectedPayoutEstimate - parsedTradeAmount;
  const selectedTradeBlockers = getTradeBlockers(selectedTradeRow);
  const selectedTradeWarnings = getTradeWarnings(selectedTradeRow);
  const canPrepareSelectedTrade = Boolean(selectedTradeRow?.conditionId)
    && selectedTradeBlockers.length === 0
    && (
      selectedTradeRow?.action === 'BUY YES'
      || selectedTradeRow?.recommendation?.executionPlan?.executable === true
      || selectedTradeWarnings.length > 0
    );
  const hasSelectedTradeWarning = canPrepareSelectedTrade && selectedTradeWarnings.length > 0;
  const managedTradeIntents = tradeIntents
    .filter((intent) => isManagedChicagoIntent(intent, rankedRows))
    .slice(0, 4);
  const pollIntervalMs = getPollingIntervalMs(snapshot);
  const marketDataMode = formatMarketDataMode(snapshot?.marketDataPolicy);
  const rankByConditionId = new Map(rankedRows.map((row, index) => [row.conditionId, index + 1]));
  const rankedDateRange = formatDateRange(rankedRows, snapshot?.targetDate);

  const refreshTradeIntents = useCallback(async (row = selectedTradeRow) => {
    const intents = await fetchTradeIntents(10);
    setTradeIntents(intents);

    const matchingIntent = getMatchingTradeIntent(intents, row);

    if (matchingIntent) {
      setTradeIntent(matchingIntent);
    }

    return intents;
  }, [selectedTradeRow]);

  const loadChicagoBoard = useCallback(async ({ force = false, silent = false } = {}) => {
    if (force) {
      setIsRepricing(true);
    } else if (!silent) {
      setIsLoading(true);
    }

    try {
      const [primarySnapshotResult, catalogResult] = await Promise.allSettled([
        force ? repriceChicagoMarkets() : fetchChicagoSnapshot(),
        fetchChicagoMarketCatalog({
          daysAhead: DEFAULT_CATALOG_DAYS_AHEAD,
          openOnly: true,
          includeOpenOutsideDateRange: true
        })
      ]);

      if (primarySnapshotResult.status !== 'fulfilled') {
        throw primarySnapshotResult.reason;
      }

      const nextSnapshot = primarySnapshotResult.value;
      const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
      const targetDates = getCatalogTargetDates(catalog, nextSnapshot?.targetDate);
      const extraDates = targetDates.filter((targetDate) => (
        targetDate && targetDate !== nextSnapshot?.targetDate
      ));
      const extraSnapshotResults = await Promise.allSettled(
        extraDates.map((targetDate) => (
          force ? repriceChicagoMarkets(targetDate) : fetchChicagoSnapshot(targetDate)
        ))
      );
      const extraSnapshots = extraSnapshotResults
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);

      setSnapshot(nextSnapshot);
      setBoardSnapshots(sortSnapshotsByDate([nextSnapshot, ...extraSnapshots]));

      const [alertsResult, tradeIntentsResult] = await Promise.allSettled([
        fetchChicagoAlerts(nextSnapshot?.targetDate, { limit: 8 }),
        fetchTradeIntents(10)
      ]);

      if (alertsResult.status === 'fulfilled') {
        setAlerts(alertsResult.value);
      }

      if (tradeIntentsResult.status === 'fulfilled') {
        setTradeIntents(tradeIntentsResult.value);
      }

      setLastRefreshAt(new Date());
      setError('');
    } catch (loadError) {
      if (!silent) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load Chicago weather bets');
      }
    } finally {
      setIsLoading(false);
      setIsRepricing(false);
    }
  }, []);

  useEffect(() => {
    void loadChicagoBoard();
  }, [loadChicagoBoard]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClock(new Date());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadChicagoBoard({ silent: true });
    }, pollIntervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadChicagoBoard, pollIntervalMs]);

  useEffect(() => {
    if (!selectedConditionId && bestRow?.conditionId) {
      setSelectedConditionId(bestRow.conditionId);
    }
  }, [bestRow?.conditionId, selectedConditionId]);

  useEffect(() => {
    if (!selectedTradeRow) {
      setTradeAmount('');
      setTradeIntent(null);
      return;
    }

    setTradeAmount(formatAmountInput(getRecommendedTradeAmount(selectedTradeRow)));
    setTradeIntent(getMatchingTradeIntent(tradeIntents, selectedTradeRow));
    setTradeNotice('');
    setTradeError('');
  }, [selectedTradeRow?.conditionId, selectedTradeRow?.targetDate]);

  useEffect(() => {
    const matchingIntent = getMatchingTradeIntent(tradeIntents, selectedTradeRow);

    if (matchingIntent) {
      setTradeIntent(matchingIntent);
    }
  }, [tradeIntents, selectedTradeRow?.conditionId, selectedTradeRow?.targetDate]);

  function handleTrainingConfigChange(patch) {
    setTrainingConfig((current) => ({
      ...current,
      ...patch
    }));
  }

  function handleTrainingPresetChange(value) {
    setTrainingConfig((current) => {
      if (value === 'custom') {
        return {
          ...current,
          windowPreset: value
        };
      }

      const preset = TRAINING_WINDOW_PRESETS.find((candidate) => candidate.value === value);
      const range = getDefaultTrainingDateRange(preset?.days ?? DEFAULT_TRAINING_WINDOW_DAYS);

      return {
        ...current,
        ...range,
        windowPreset: value
      };
    });
  }

  function updateTrainingStep(stepId, patch) {
    setTrainingSteps((current) => current.map((step) => (
      step.id === stepId
        ? {
            ...step,
            ...patch
          }
        : step
    )));
  }

  async function handleRunTrainingData() {
    if (isRunningTraining) {
      return;
    }

    let runOptions;

    try {
      validateTrainingDateRange(trainingConfig);

      runOptions = {
        dateFrom: trainingConfig.dateFrom,
        dateTo: trainingConfig.dateTo,
        fidelityMinutes: parsePositiveInteger(trainingConfig.fidelityMinutes, 'Board interval'),
        leadDays: parseLeadDaysInput(trainingConfig.leadDays),
        includeTrades: trainingConfig.includeTrades
      };
    } catch (validationError) {
      setTrainingNotice('');
      setTrainingError(validationError instanceof Error ? validationError.message : 'Training settings are invalid.');
      return;
    }

    const jobs = [
      {
        id: 'archive',
        run: () => backfillChicagoArchive(runOptions)
      },
      {
        id: 'forecastVintages',
        run: () => backfillChicagoForecastVintages(runOptions)
      },
      {
        id: 'historicalBoards',
        run: () => backfillChicagoHistoricalBoards(runOptions)
      },
      {
        id: 'train',
        run: () => trainChicagoWeatherModel(runOptions)
      },
      {
        id: 'evaluate',
        run: () => evaluateChicagoWeatherModel(runOptions)
      }
    ];

    setIsRunningTraining(true);
    setTrainingNotice('');
    setTrainingError('');
    setTrainingSteps(createTrainingSteps());

    try {
      for (const job of jobs) {
        const startedAt = new Date();

        updateTrainingStep(job.id, {
          status: 'running',
          detail: 'Running',
          startedAt,
          finishedAt: null
        });

        try {
          const result = await job.run();
          updateTrainingStep(job.id, {
            status: 'done',
            detail: summarizeTrainingResult(job.id, result),
            finishedAt: new Date()
          });
        } catch (jobError) {
          const message = jobError instanceof Error ? jobError.message : 'Training job failed.';

          updateTrainingStep(job.id, {
            status: 'failed',
            detail: message,
            finishedAt: new Date()
          });

          throw jobError;
        }
      }

      setTrainingNotice(`Completed ${formatDate(runOptions.dateFrom)} to ${formatDate(runOptions.dateTo)}.`);
      await loadChicagoBoard({ force: true, silent: true }).catch(() => null);
    } catch (runError) {
      setTrainingError(runError instanceof Error ? runError.message : 'Training data run failed.');
    } finally {
      setIsRunningTraining(false);
    }
  }

  async function handlePrepareTrade() {
    if (!selectedTradeRow || !parsedTradeAmount) {
      setTradeError('Enter a positive trade amount first.');
      return null;
    }

    setIsPreparingTrade(true);
    setTradeNotice('');
    setTradeError('');

    try {
      const intent = await createChicagoTradeIntent({
        date: selectedTradeRow.targetDate ?? snapshot?.targetDate,
        conditionId: selectedTradeRow.conditionId,
        tradeAmount: parsedTradeAmount
      });

      setTradeIntent(intent);
      setTradeNotice(`Prepared ${formatCurrency(intent.tradeAmount)} draft for ${intent.outcomeLabel}.`);
      await refreshTradeIntents(selectedTradeRow);
      return intent;
    } catch (prepareError) {
      const message = prepareError instanceof Error ? prepareError.message : 'Unable to prepare trade intent';
      setTradeError(message);
      return null;
    } finally {
      setIsPreparingTrade(false);
    }
  }

  async function handleSaveTradeAmount() {
    if (!tradeIntent?.id || !parsedTradeAmount) {
      setTradeError('Prepare a trade and enter a positive amount first.');
      return null;
    }

    setIsPreparingTrade(true);
    setTradeNotice('');
    setTradeError('');

    try {
      const intent = await updateTradeIntentRequest(tradeIntent.id, {
        tradeAmount: parsedTradeAmount,
        tradeSuggestion: {
          ...(tradeIntent.tradeSuggestion ?? {}),
          amount: parsedTradeAmount
        }
      });

      setTradeIntent(intent);
      setTradeNotice(`Saved amount override: ${formatCurrency(intent.tradeAmount)}.`);
      await refreshTradeIntents(selectedTradeRow);
      return intent;
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Unable to save trade amount';
      setTradeError(message);
      return null;
    } finally {
      setIsPreparingTrade(false);
    }
  }

  async function handleSubmitTrade() {
    if (!selectedTradeRow || !parsedTradeAmount) {
      setTradeError('Enter a positive trade amount first.');
      return;
    }

    setIsSubmittingTrade(true);
    setTradeNotice('');
    setTradeError('');

    try {
      const baseIntent = tradeIntent?.id
        ? tradeIntent
        : await createChicagoTradeIntent({
            date: selectedTradeRow.targetDate ?? snapshot?.targetDate,
            conditionId: selectedTradeRow.conditionId,
            tradeAmount: parsedTradeAmount
          });
      const confirmedIntent = await updateTradeIntentRequest(baseIntent.id, {
        confirm: true,
        tradeAmount: parsedTradeAmount,
        tradeSuggestion: {
          ...(baseIntent.tradeSuggestion ?? {}),
          amount: parsedTradeAmount
        }
      });

      setTradeIntent(confirmedIntent);

      const executedIntent = await executeTradeIntentRequest(confirmedIntent.id);
      setTradeIntent(executedIntent);
      setTradeNotice(`Submitted trade and started tracking ${executedIntent.outcomeLabel}.`);
      await refreshTradeIntents(selectedTradeRow);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Unable to submit trade';
      setTradeError(message);
      await refreshTradeIntents(selectedTradeRow).catch(() => null);
    } finally {
      setIsSubmittingTrade(false);
    }
  }

  async function handleRefreshManagedTrade(intent = tradeIntent) {
    if (!intent?.id) {
      return;
    }

    setIsManagingTrade(true);
    setTradeNotice('');
    setTradeError('');

    try {
      const nextIntent = await pollTradeIntent(intent.id);
      setTradeIntent(nextIntent);
      setTradeNotice(`Refreshed ${nextIntent.outcomeLabel}.`);
      await refreshTradeIntents(selectedTradeRow);
    } catch (manageError) {
      setTradeError(manageError instanceof Error ? manageError.message : 'Unable to refresh trade');
    } finally {
      setIsManagingTrade(false);
    }
  }

  async function handleSellManagedTrade(intent = tradeIntent) {
    if (!intent?.id) {
      return;
    }

    setIsManagingTrade(true);
    setTradeNotice('');
    setTradeError('');

    try {
      const nextIntent = await sellTradeIntentRequest(intent.id);
      setTradeIntent(nextIntent);
      setTradeNotice(`Submitted sell request for ${nextIntent.outcomeLabel}.`);
      await refreshTradeIntents(selectedTradeRow);
    } catch (manageError) {
      setTradeError(manageError instanceof Error ? manageError.message : 'Unable to sell trade');
    } finally {
      setIsManagingTrade(false);
    }
  }

  async function handleStopManagedTrade(intent = tradeIntent) {
    if (!intent?.id) {
      return;
    }

    setIsManagingTrade(true);
    setTradeNotice('');
    setTradeError('');

    try {
      const nextIntent = await stopTradeIntentRequest(intent.id);
      setTradeIntent(nextIntent);
      setTradeNotice(`Stopped tracking ${nextIntent.outcomeLabel}.`);
      await refreshTradeIntents(selectedTradeRow);
    } catch (manageError) {
      setTradeError(manageError instanceof Error ? manageError.message : 'Unable to stop tracking trade');
    } finally {
      setIsManagingTrade(false);
    }
  }

  async function handleDeleteDraft(intent = tradeIntent) {
    if (!intent?.id || !isDraftTradeIntent(intent)) {
      return;
    }

    setIsManagingTrade(true);
    setTradeNotice('');
    setTradeError('');

    try {
      const deletedIntent = await deleteTradeIntentRequest(intent.id);
      setTradeIntents((current) => current.filter((candidate) => candidate.id !== intent.id));

      if (tradeIntent?.id === intent.id) {
        setTradeIntent(null);
      }

      setTradeNotice(`Deleted draft for ${deletedIntent.outcomeLabel ?? intent.outcomeLabel}.`);
      await refreshTradeIntents(selectedTradeRow);
    } catch (deleteError) {
      setTradeError(deleteError instanceof Error ? deleteError.message : 'Unable to delete draft');
    } finally {
      setIsManagingTrade(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-cluster">
          <img src="/logo.png" alt="Probis logo" className="brand-logo" />
          <div>
            <p className="eyebrow">Chicago Weather Markets</p>
            <h1>KMDW High Temp Bets</h1>
          </div>
        </div>

        <div className="topbar-actions">
          <span className="timestamp">Updated {formatRelativeAge(lastRefreshAt, clock)}</span>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setIsTrainingPortalOpen(true)}
          >
            Training
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void loadChicagoBoard()}
            disabled={isLoading || isRepricing}
          >
            {isLoading ? 'Loading' : 'Refresh'}
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void loadChicagoBoard({ force: true })}
            disabled={isLoading || isRepricing}
          >
            {isRepricing ? 'Repricing' : 'Reprice'}
          </button>
        </div>
      </header>

      <TrainingPortal
        isOpen={isTrainingPortalOpen}
        config={trainingConfig}
        steps={trainingSteps}
        isRunning={isRunningTraining}
        error={trainingError}
        notice={trainingNotice}
        onClose={() => setIsTrainingPortalOpen(false)}
        onRun={() => void handleRunTrainingData()}
        onConfigChange={handleTrainingConfigChange}
        onPresetChange={handleTrainingPresetChange}
      />

      {error ? <p className="system-banner">{error}</p> : null}

      <section className="summary-grid" aria-label="Chicago weather status">
        <Metric label="Dates" value={rankedDateRange} />
        <Metric label="Observed High" value={formatTemperature(snapshot?.observations?.observedHighSoFar)} />
        <Metric label="Current KMDW" value={formatTemperature(snapshot?.observations?.currentObservedTemp)} />
        <Metric label="Model Mean" value={formatTemperature(snapshot?.prediction?.expectedHigh)} />
        <Metric label="Best Edge" value={formatSignedPercent(bestRow?.riskAdjustedEdge)} tone={getToneClass(bestRow?.riskAdjustedEdge)} />
        <Metric label="Markets" value={rankedRows.length || 'n/a'} />
        <Metric label="Market Data" value={marketDataMode} />
        <Metric label="Alerts" value={getAlertCount(alerts)} tone={getAlertCount(alerts) > 0 ? 'metric-bad' : 'metric-good'} />
      </section>

      {isLoading && !snapshot ? (
        <section className="empty-panel">
          <p className="eyebrow">Loading</p>
          <h2>Chicago board is loading.</h2>
        </section>
      ) : null}

      {snapshot ? (
        <>
          <section className="board-grid">
            <section className="panel ranking-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Ranking</p>
                  <h2>Open Chicago Weather Bets</h2>
                </div>
                <span className="chip chip-muted">{rankedRows.length} bets</span>
              </div>

              <div className="table-scroll">
                <table className="rank-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Date</th>
                      <th>Bet</th>
                      <th>Action</th>
                      <th>Manage</th>
                      <th>Fair</th>
                      <th>Entry</th>
                      <th>Edge</th>
                      <th>Score</th>
                      <th>Spread</th>
                      <th>Liquidity</th>
                      <th>Rules</th>
                      <th>Gates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankedRows.map((row, index) => {
                      const marketUrl = getMarketUrl(row);

                      return (
                        <tr
                          key={`${row.targetDate ?? 'undated'}-${row.conditionId}`}
                          className={row.conditionId === selectedTradeRow?.conditionId ? 'selected-market-row' : ''}
                        >
                          <td>
                            <span className="rank-number">{index + 1}</span>
                          </td>
                          <td>{formatShortDate(row.targetDate)}</td>
                          <td className="bet-cell">
                            <strong>{row.label}</strong>
                            <span>{row.marketQuestion || row.eventTitle || row.conditionId}</span>
                            <div className="quote-row">
                              <span>Bid {formatPrice(row.bestBid)}</span>
                              <span>Ask {formatPrice(row.bestAsk)}</span>
                              <span>Max {formatPrice(row.maxEntryPrice)}</span>
                              {marketUrl ? (
                                <a href={marketUrl} target="_blank" rel="noreferrer">
                                  Open
                                </a>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <span className={row.action === 'BUY YES' ? 'chip chip-good' : 'chip chip-muted'}>
                              {row.action}
                            </span>
                            <small>{formatStatus(row.status)}</small>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="inline-action-button"
                              onClick={() => setSelectedConditionId(row.conditionId)}
                            >
                              Manage
                            </button>
                          </td>
                          <td>{formatPercent(row.fairProbability)}</td>
                          <td>{formatPrice(row.marketPrice)}</td>
                          <td>
                            <strong className={getToneClass(row.riskAdjustedEdge)}>
                              {formatSignedPercent(row.riskAdjustedEdge)}
                            </strong>
                            <small>raw {formatSignedPercent(row.edge)}</small>
                          </td>
                          <td>{formatPercent(row.score)}</td>
                          <td>{formatSignedPercent(row.spread, 1)}</td>
                          <td>
                            <span>{formatCompactNumber(row.liquidity)}</span>
                            <small>vol {formatCompactNumber(row.volume)}</small>
                          </td>
                          <td>
                            <span className={row.verificationLabel === 'REVIEW' ? 'chip chip-warn' : 'chip chip-good'}>
                              {row.verificationLabel}
                            </span>
                          </td>
                          <td>
                            <GateList gates={row.gates} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {rankedRows.length === 0 ? (
                <p className="empty-copy">No active Chicago weather bets were returned.</p>
              ) : null}
            </section>

            <aside className="side-stack">
              <section className="panel trade-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Trade</p>
                    <h2>Manual Trade Control</h2>
                  </div>
                  <span className={canPrepareSelectedTrade ? 'chip chip-good' : 'chip chip-muted'}>
                    {canPrepareSelectedTrade ? 'Ready' : 'Blocked'}
                  </span>
                </div>

                {selectedTradeRow ? (
                  <>
                    <div className="trade-selected-card">
                      <span className="chip chip-muted">#{rankByConditionId.get(selectedTradeRow.conditionId) ?? 'n/a'}</span>
                      <div>
                        <strong>{selectedTradeRow.label}</strong>
                        <p>Date: {formatDate(selectedTradeRow.targetDate)} | {selectedTradeRow.marketQuestion || selectedTradeRow.eventTitle || selectedTradeRow.conditionId}</p>
                      </div>
                    </div>

                    <div className="trade-amount-grid">
                      <label htmlFor="trade-amount-input">
                        <span>Amount</span>
                        <input
                          id="trade-amount-input"
                          type="number"
                          min="1"
                          step="0.01"
                          inputMode="decimal"
                          value={tradeAmount}
                          onChange={(event) => setTradeAmount(event.target.value)}
                        />
                      </label>
                      <article>
                        <span>Recommended</span>
                        <strong>{recommendedTradeAmount ? formatCurrency(recommendedTradeAmount) : 'n/a'}</strong>
                      </article>
                      <article>
                        <span>Shares Est.</span>
                        <strong>{selectedSharesEstimate ? selectedSharesEstimate.toFixed(2) : 'n/a'}</strong>
                      </article>
                      <article>
                        <span>Entry</span>
                        <strong>{formatPrice(selectedTradeRow.marketPrice)}</strong>
                      </article>
                      <article>
                        <span>Payout If Correct</span>
                        <strong>{selectedPayoutEstimate === null ? 'n/a' : formatCurrency(selectedPayoutEstimate)}</strong>
                      </article>
                      <article>
                        <span>Profit If Correct</span>
                        <strong>{selectedProfitEstimate === null ? 'n/a' : formatCurrency(selectedProfitEstimate)}</strong>
                      </article>
                    </div>

                    <div className="trade-actions">
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void handlePrepareTrade()}
                        disabled={!canPrepareSelectedTrade || !parsedTradeAmount || isPreparingTrade || isSubmittingTrade}
                      >
                        {isPreparingTrade ? 'Preparing' : 'Prepare Draft'}
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void handleSaveTradeAmount()}
                        disabled={!tradeIntent?.id || !parsedTradeAmount || isPreparingTrade || isSubmittingTrade}
                      >
                        Save Amount
                      </button>
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => void handleSubmitTrade()}
                        disabled={!canPrepareSelectedTrade || !parsedTradeAmount || isPreparingTrade || isSubmittingTrade}
                      >
                        {isSubmittingTrade ? 'Submitting' : 'Submit Trade'}
                      </button>
                      {isDraftTradeIntent(tradeIntent) ? (
                        <button
                          type="button"
                          className="button button-danger"
                          onClick={() => void handleDeleteDraft()}
                          disabled={isPreparingTrade || isSubmittingTrade || isManagingTrade}
                        >
                          Delete Draft
                        </button>
                      ) : null}
                    </div>

                    <div className={hasSelectedTradeWarning ? 'trade-status-box trade-status-warning' : 'trade-status-box'}>
                      <div>
                        <span>Status</span>
                        <strong>{formatTradeStatus(tradeIntent, selectedTradeRow, canPrepareSelectedTrade)}</strong>
                      </div>
                      <p>{getTradePolicyCopy(tradeIntent, selectedTradeRow, canPrepareSelectedTrade)}</p>
                    </div>

                    {tradeNotice ? <p className="trade-notice">{tradeNotice}</p> : null}
                    {tradeError ? <p className="trade-error">{tradeError}</p> : null}

                    {managedTradeIntents.length > 0 ? (
                      <div className="managed-trade-list">
                        {managedTradeIntents.map((intent) => (
                          <article key={intent.id} className="managed-trade-row">
                            <div>
                              <strong>{intent.outcomeLabel}</strong>
                              <span>{formatCurrency(intent.tradeAmount)} / {formatTradeStatus(intent)}</span>
                            </div>
                            <div className="managed-trade-actions">
                              <button
                                type="button"
                                className="inline-action-button"
                                onClick={() => {
                                  setTradeIntent(intent);
                                  setTradeAmount(formatAmountInput(intent.tradeAmount));
                                }}
                              >
                                Select
                              </button>
                              {intent.status === 'tracking' ? (
                                <>
                                  <button
                                    type="button"
                                    className="inline-action-button"
                                    onClick={() => void handleRefreshManagedTrade(intent)}
                                    disabled={isManagingTrade}
                                  >
                                    Poll
                                  </button>
                                  <button
                                    type="button"
                                    className="inline-action-button inline-action-danger"
                                    onClick={() => void handleSellManagedTrade(intent)}
                                    disabled={isManagingTrade}
                                  >
                                    Sell
                                  </button>
                                  <button
                                    type="button"
                                    className="inline-action-button"
                                    onClick={() => void handleStopManagedTrade(intent)}
                                    disabled={isManagingTrade}
                                  >
                                    Stop
                                  </button>
                                </>
                              ) : null}
                              {isDraftTradeIntent(intent) ? (
                                <button
                                  type="button"
                                  className="inline-action-button inline-action-danger"
                                  onClick={() => void handleDeleteDraft(intent)}
                                  disabled={isManagingTrade}
                                >
                                  Delete
                                </button>
                              ) : null}
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="empty-copy">Select a ranked Chicago weather bet to prepare a trade.</p>
                )}
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Weather</p>
                    <h2>Model Inputs</h2>
                  </div>
                  <span className={snapshot?.prediction?.sourceFreshness?.isStale ? 'chip chip-warn' : 'chip chip-good'}>
                    {snapshot?.prediction?.sourceFreshness?.isStale ? 'STALE' : 'FRESH'}
                  </span>
                </div>

                <div className="detail-list">
                  <div>
                    <span>Latest Observation</span>
                    <strong>{formatDateTime(snapshot?.observations?.latestObservationAt)}</strong>
                  </div>
                  <div>
                    <span>Settlement</span>
                    <strong>{snapshot?.settlement?.status ?? 'n/a'}</strong>
                  </div>
                  <div>
                    <span>NWS Forecast</span>
                    <strong>{formatTemperature(snapshot?.forecasts?.features?.forecast_max_nws_hourly)}</strong>
                  </div>
                  <div>
                    <span>NBM p50</span>
                    <strong>{formatTemperature(snapshot?.nbm?.features?.nbm_p50)}</strong>
                  </div>
                  <div>
                    <span>Confidence</span>
                    <strong>{formatPercent(snapshot?.prediction?.confidence)}</strong>
                  </div>
                  <div>
                    <span>Blend</span>
                    <strong>{formatPercent(snapshot?.prediction?.marketBlendWeight)}</strong>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Distribution</p>
                    <h2>Top Temperatures</h2>
                  </div>
                </div>

                <div className="distribution-list">
                  {temperatureRows.map((row) => (
                    <div className="distribution-row" key={row.temperature}>
                      <span>{row.temperature} F</span>
                      <div className="distribution-track">
                        <div style={{ width: `${Math.max(2, Math.min(100, row.probability * 100))}%` }} />
                      </div>
                      <strong>{formatPercent(row.probability)}</strong>
                    </div>
                  ))}
                </div>

                {temperatureRows.length === 0 ? (
                  <p className="empty-copy">No temperature distribution is available.</p>
                ) : null}
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Alerts</p>
                    <h2>Chicago Watch</h2>
                  </div>
                  <span className={activeAlerts.length > 0 ? 'chip chip-warn' : 'chip chip-good'}>
                    {activeAlerts.length > 0 ? `${activeAlerts.length} active` : 'Clear'}
                  </span>
                </div>

                <div className="alert-list">
                  {activeAlerts.slice(0, 5).map((alert) => (
                    <article className="alert-row" key={alert.id ?? alert.alertKey ?? alert.title}>
                      <span className={String(alert.severity ?? '').toLowerCase() === 'critical' ? 'chip chip-bad' : 'chip chip-warn'}>
                        {String(alert.severity ?? 'info').toUpperCase()}
                      </span>
                      <div>
                        <strong>{alert.title ?? 'Weather alert'}</strong>
                        <p>{alert.message ?? 'No alert detail available.'}</p>
                        <small>{formatDateTime(alert.triggeredAt)}</small>
                      </div>
                    </article>
                  ))}
                </div>

                {activeAlerts.length === 0 ? (
                  <p className="empty-copy">No active Chicago weather alerts.</p>
                ) : null}
              </section>
            </aside>
          </section>
        </>
      ) : null}
    </main>
  );
}
