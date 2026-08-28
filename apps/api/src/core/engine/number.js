// Shared numeric helpers. Moved verbatim from the weather family so every family
// shares one rounding/clamping convention.
//
// NOTE: round() and average() return null (not NaN, not a pass-through) for
// non-finite input. Call sites depend on that via `?? 0` guards — do not "fix".
export function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function average(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}
