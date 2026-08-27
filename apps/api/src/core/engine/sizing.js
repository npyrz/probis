// Family-agnostic position sizing: fractional Kelly against a research bankroll.
import { clamp, round } from './number.js';

export const DEFAULT_RESEARCH_BANKROLL_USD = 100;
export const FRACTIONAL_KELLY_SHRINK = 0.15;
export const MAX_STAKE_FRACTION = 0.02;

export function fractionalKellyStake({ probability, price, bankroll = DEFAULT_RESEARCH_BANKROLL_USD }) {
  if (
    typeof probability !== 'number'
    || typeof price !== 'number'
    || probability <= price
    || price <= 0
    || price >= 1
  ) {
    return {
      kellyFraction: 0,
      suggestedSize: 0
    };
  }

  const fullKellyFraction = (probability - price) / (1 - price);
  const shrunkFraction = clamp(fullKellyFraction * FRACTIONAL_KELLY_SHRINK, 0, MAX_STAKE_FRACTION);

  return {
    kellyFraction: round(shrunkFraction, 4),
    suggestedSize: round(bankroll * shrunkFraction, 2)
  };
}
