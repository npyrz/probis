import { buildChicagoSnapshot } from './chicago.js';
import {
  getChicagoAlerts,
  getChicagoSignalDrift,
  getChicagoSourceAudit,
  persistChicagoAlerts,
  persistChicagoSnapshot
} from '../persistence/postgres.js';

function normalizeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function round(value, digits = 4) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
}

function metricText(value, formatter = (entry) => String(entry)) {
  return typeof value === 'number' && Number.isFinite(value) ? formatter(value) : 'n/a';
}

function shortHash(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 12) : 'missing';
}

function buildAlert({
  type,
  severity,
  eventDate,
  keyParts,
  title,
  message,
  triggeredAt,
  details = {}
}) {
  const normalizedDate = normalizeDate(eventDate);
  const alertKey = ['kmdw', normalizedDate ?? 'undated', type, ...keyParts]
    .map((part) => String(part ?? 'unknown').replace(/\s+/g, '-').toLowerCase())
    .join(':');

  return {
    id: alertKey,
    stationId: 'KMDW',
    eventDate: normalizedDate,
    alertKey,
    type,
    severity,
    status: 'active',
    title,
    message,
    triggeredAt: normalizeTimestamp(triggeredAt) ?? new Date().toISOString(),
    raw: details
  };
}

function formatChange(change) {
  if (!change) {
    return null;
  }

  if (typeof change.delta === 'number') {
    return `${change.name} ${change.delta > 0 ? '+' : ''}${change.delta}`;
  }

  return change.name;
}

function buildDriftAlerts(drift) {
  if (!drift?.enabled || drift.materialChange !== true) {
    return [];
  }

  const changes = Array.isArray(drift.changes) ? drift.changes.filter((change) => change.material) : [];
  const changeNames = changes.map((change) => change.name);
  const critical = changeNames.includes('best-bucket')
    || changeNames.includes('action')
    || changes.some((change) => change.name === 'threshold-status' && change.to === 'knife-edge')
    || changes.some((change) => change.name === 'source-stale' && change.to === true);
  const title = critical ? 'KMDW material signal move' : 'KMDW material probability drift';
  const message = changes.length > 0
    ? changes.map(formatChange).filter(Boolean).join(', ')
    : 'Latest KMDW signal changed materially from the prior snapshot.';

  return [buildAlert({
    type: 'signal-drift',
    severity: critical ? 'critical' : 'warning',
    eventDate: drift.date,
    keyParts: [drift.latestAt ?? 'latest', changeNames.join('-') || 'material'],
    title,
    message,
    triggeredAt: drift.latestAt ?? drift.generatedAt,
    details: {
      driftStatus: drift.status,
      latest: drift.latest,
      previous: drift.previous,
      changes
    }
  })];
}

function buildSourceAuditAlerts(sourceAudit) {
  if (!sourceAudit?.enabled || !Array.isArray(sourceAudit.markets)) {
    return [];
  }

  return sourceAudit.markets
    .filter((market) => market.hashChanged === true)
    .map((market) => {
      const hashes = Array.isArray(market.distinctSourceTextHashes) ? market.distinctSourceTextHashes : [];
      const hashKey = hashes.map(shortHash).join('-') || shortHash(market.sourceTextHash);
      const label = market.outcomeLabel ?? market.marketSlug ?? market.conditionId ?? 'KMDW bucket';

      return buildAlert({
        type: 'source-hash-change',
        severity: 'critical',
        eventDate: market.eventDate ?? sourceAudit.date,
        keyParts: [market.conditionId ?? market.marketSlug ?? label, hashKey],
        title: 'KMDW source text changed',
        message: `${label} has ${hashes.length} distinct source hashes.`,
        triggeredAt: market.latestCapturedAt ?? sourceAudit.generatedAt,
        details: {
          market,
          sourceAuditStatus: market.status,
          distinctSourceTextHashes: hashes
        }
      });
    });
}

function buildThresholdAlerts(snapshot) {
  const threshold = snapshot?.prediction?.thresholdDiagnostics;
  const status = threshold?.status;

  if (status !== 'knife-edge' && status !== 'contested') {
    return [];
  }

  const topBucket = threshold?.topBucket ?? null;
  const distance = threshold?.nearestBoundary?.distanceF;
  const margin = threshold?.topBucketMargin;
  const label = topBucket?.outcomeLabel ?? topBucket?.conditionId ?? 'top bucket';
  const severity = status === 'knife-edge' ? 'critical' : 'warning';
  const title = status === 'knife-edge'
    ? 'KMDW threshold danger'
    : 'KMDW threshold contested';
  const message = [
    `${label} is ${status}.`,
    `Boundary distance ${metricText(distance, (value) => `${value.toFixed(1)}F`)}.`,
    `Bucket gap ${metricText(margin, (value) => `${(value * 100).toFixed(1)}%`)}.`
  ].join(' ');

  return [buildAlert({
    type: 'threshold-danger',
    severity,
    eventDate: snapshot?.targetDate,
    keyParts: [status, topBucket?.conditionId ?? label],
    title,
    message,
    triggeredAt: snapshot?.prediction?.predictionTime ?? snapshot?.generatedAt,
    details: {
      thresholdDiagnostics: threshold,
      expectedHigh: round(snapshot?.prediction?.expectedHigh, 2)
    }
  })];
}

function summarizeAlerts(alerts, { generatedAt = new Date().toISOString(), date = null } = {}) {
  const severityCounts = alerts.reduce((counts, alert) => {
    counts[alert.severity] = (counts[alert.severity] ?? 0) + 1;
    return counts;
  }, {});
  const typeCounts = alerts.reduce((counts, alert) => {
    counts[alert.type] = (counts[alert.type] ?? 0) + 1;
    return counts;
  }, {});

  return {
    generatedAt,
    date,
    alertCount: alerts.length,
    activeCount: alerts.length,
    criticalCount: severityCounts.critical ?? 0,
    warningCount: severityCounts.warning ?? 0,
    severityCounts,
    typeCounts
  };
}

export function buildChicagoAlertSummary({
  snapshot = null,
  drift = null,
  sourceAudit = null,
  generatedAt = new Date().toISOString()
} = {}) {
  const date = normalizeDate(snapshot?.targetDate ?? drift?.date ?? sourceAudit?.date);
  const byId = new Map();

  for (const alert of [
    ...buildDriftAlerts(drift),
    ...buildSourceAuditAlerts(sourceAudit),
    ...buildThresholdAlerts(snapshot)
  ]) {
    byId.set(alert.id, alert);
  }

  const alerts = [...byId.values()].sort((left, right) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    const severityComparison = (severityOrder[left.severity] ?? 9) - (severityOrder[right.severity] ?? 9);

    if (severityComparison !== 0) {
      return severityComparison;
    }

    return String(right.triggeredAt ?? '').localeCompare(String(left.triggeredAt ?? ''));
  });

  return {
    enabled: true,
    ...summarizeAlerts(alerts, { generatedAt, date }),
    alerts,
    inputs: {
      driftStatus: drift?.status ?? null,
      materialDrift: drift?.materialChange === true,
      sourceChangedCount: sourceAudit?.changedCount ?? null,
      thresholdStatus: snapshot?.prediction?.thresholdDiagnostics?.status ?? null
    }
  };
}

export async function evaluateChicagoWeatherAlerts(env, {
  date = null,
  snapshot = null,
  force = false,
  persistSnapshot = false,
  persistAlerts = true
} = {}) {
  const activeSnapshot = snapshot ?? await buildChicagoSnapshot(env, { date, force });
  const targetDate = normalizeDate(activeSnapshot?.targetDate ?? date);
  const snapshotPersistence = persistSnapshot
    ? await persistChicagoSnapshot(env, activeSnapshot)
    : null;
  const [drift, sourceAudit] = await Promise.all([
    getChicagoSignalDrift(env, { date: targetDate }),
    getChicagoSourceAudit(env, { date: targetDate })
  ]);
  const summary = buildChicagoAlertSummary({
    snapshot: activeSnapshot,
    drift,
    sourceAudit
  });
  const alertPersistence = persistAlerts
    ? await persistChicagoAlerts(env, summary.alerts, {
      date: targetDate,
      generatedAt: summary.generatedAt,
      resolveMissing: true
    })
    : null;
  const stored = persistAlerts
    ? await getChicagoAlerts(env, { date: targetDate, status: 'active', limit: 50 })
    : null;

  return {
    ...summary,
    snapshotPersistence,
    persistence: alertPersistence,
    stored
  };
}
