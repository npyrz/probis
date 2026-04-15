import { buildEventAggregation } from './aggregation.js';
import { fetchEventByInput } from './gamma.js';

export async function resolveEventWithAggregation(env, input) {
  const event = await fetchEventByInput(env, input);
  const aggregation = await buildEventAggregation(env, event);

  return {
    ...event,
    aggregation
  };
}