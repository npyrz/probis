// Family-agnostic gating: evaluate a list of hard/warning gates and score a candidate.
//
// A gate is { name, passed, severity } where severity 'warning' never blocks.
import { clamp, round } from './number.js';

export function evaluateGates(gates) {
  const rows = Array.isArray(gates) ? gates : [];

  return {
    passed: rows.every((gate) => gate.passed || gate.severity === 'warning'),
    failedBlockingGateNames: rows
      .filter((gate) => !gate.passed && gate.severity !== 'warning')
      .map((gate) => gate.name),
    warningGateNames: rows
      .filter((gate) => !gate.passed && gate.severity === 'warning')
      .map((gate) => gate.name)
  };
}

export function getLiquidityScore(value) {
  if (typeof value !== 'number' || value <= 0) {
    return 0.45;
  }

  return clamp(Math.log10(value + 1) / 4, 0, 1);
}

export function getSpreadScore(value) {
  if (typeof value !== 'number') {
    return 0.55;
  }

  return 1 - clamp(value / 0.08, 0, 1);
}

// `timingScore` is supplied by the family — only the family knows what "good timing"
// means for its markets (weather uses day phase, crypto would use time-to-expiry).
export function scoreCandidate({ edge, confidence, spread, liquidity, askDepth, timingScore }) {
  const expectedValueScore = clamp((edge ?? 0) / 0.14, 0, 1);
  const liquidityScore = Math.max(getLiquidityScore(liquidity), getLiquidityScore(askDepth));
  const modelAgreementScore = getSpreadScore(spread);

  return round(
    0.45 * expectedValueScore
    + 0.2 * clamp(confidence ?? 0, 0, 1)
    + 0.15 * liquidityScore
    + 0.1 * modelAgreementScore
    + 0.1 * (timingScore ?? 0.45),
    4
  );
}
