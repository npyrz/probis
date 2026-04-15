import { buildEventAggregation } from './aggregation.js';
import { fetchEventByInput } from './gamma.js';
import { buildStatisticalModel } from './statistical-model.js';

export async function resolveEventWithAggregation(env, input) {
  const event = await fetchEventByInput(env, input);
  const aggregation = await buildEventAggregation(env, event);
  const statisticalModel = buildStatisticalModel(event, aggregation);

  return {
    ...event,
    aggregation,
    statisticalModel
  };
}

export async function resolveEventAnalytics(env, input) {
  const event = await fetchEventByInput(env, input);
  const aggregation = await buildEventAggregation(env, event);
  const statisticalModel = buildStatisticalModel(event, aggregation);

  return {
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      resolvedFromFallback: event.resolvedFromFallback ?? false,
      requestedSlug: event.requestedSlug ?? null
    },
    aggregation,
    statisticalModel
  };
}