// Family-agnostic execution-cost estimation for a single outcome/contract.
import { clamp, round } from './number.js';

export const MIN_EXECUTION_COST = 0.005;
export const MAX_EXECUTION_COST = 0.08;

export function estimateExecutionCost(bucket) {
  const spreadCost = typeof bucket?.spread === 'number'
    ? clamp(bucket.spread * 0.35, 0, 0.04)
    : 0.01;
  const depthPenalty = typeof bucket?.askDepth === 'number' && bucket.askDepth < 20 ? 0.01 : 0;
  const liquidityPenalty = typeof bucket?.liquidity === 'number' && bucket.liquidity < 100 ? 0.005 : 0;
  const total = spreadCost + depthPenalty + liquidityPenalty;

  return {
    totalCost: round(clamp(total, MIN_EXECUTION_COST, MAX_EXECUTION_COST), 4),
    spreadCost: round(spreadCost, 4),
    depthPenalty: round(depthPenalty, 4),
    liquidityPenalty: round(liquidityPenalty, 4),
    feeCost: 0
  };
}
