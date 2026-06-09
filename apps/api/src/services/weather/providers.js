export const WEATHER_PROVIDER_INTERFACE_VERSION = 'weather-provider-v1';
export const DEFAULT_WEATHER_PROVIDER_ID = 'kmdw-nws-climdw';

const weatherProviders = new Map();
const REQUIRED_PROVIDER_METHODS = [
  'getTargetDate',
  'getClimateDayWindow',
  'fetchSettlement',
  'fetchObservations',
  'fetchForecasts',
  'fetchModelForecast',
  'fetchMarkets'
];

function requireFunction(provider, methodName) {
  if (typeof provider?.[methodName] !== 'function') {
    throw new Error(`Weather provider "${provider?.id ?? 'unknown'}" is missing ${methodName}().`);
  }
}

export function describeWeatherProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    interfaceVersion: provider.interfaceVersion ?? WEATHER_PROVIDER_INTERFACE_VERSION,
    scope: provider.scope ?? null,
    station: provider.station ?? null,
    capabilities: provider.capabilities ?? {},
    dataSources: provider.dataSources ?? []
  };
}

export function createWeatherProvider(provider) {
  const id = String(provider?.id ?? '').trim();

  if (!id) {
    throw new Error('Weather provider id is required.');
  }

  if (!provider?.station?.stationId) {
    throw new Error(`Weather provider "${id}" requires station.stationId.`);
  }

  for (const methodName of REQUIRED_PROVIDER_METHODS) {
    requireFunction(provider, methodName);
  }

  return Object.freeze({
    ...provider,
    id,
    interfaceVersion: WEATHER_PROVIDER_INTERFACE_VERSION,
    capabilities: {
      settlement: true,
      observations: true,
      forecasts: true,
      modelForecast: true,
      markets: true,
      ...(provider.capabilities ?? {})
    },
    describe() {
      return describeWeatherProvider(this);
    }
  });
}

export function registerWeatherProvider(provider) {
  const normalizedProvider = provider?.interfaceVersion === WEATHER_PROVIDER_INTERFACE_VERSION
    ? provider
    : createWeatherProvider(provider);

  weatherProviders.set(normalizedProvider.id, normalizedProvider);
  return normalizedProvider;
}

export function getWeatherProvider(id = DEFAULT_WEATHER_PROVIDER_ID) {
  return weatherProviders.get(id) ?? null;
}

export function listWeatherProviders() {
  return [...weatherProviders.values()].map((provider) => describeWeatherProvider(provider));
}

export function resolveWeatherProvider(env = {}, options = {}) {
  const providerId = String(
    options.providerId
      ?? options.weatherProviderId
      ?? env.weatherProviderId
      ?? DEFAULT_WEATHER_PROVIDER_ID
  ).trim();
  const provider = getWeatherProvider(providerId);

  if (!provider) {
    throw new Error(`Weather provider "${providerId}" is not registered.`);
  }

  return provider;
}

export async function fetchWeatherProviderSnapshotInputs(provider, env = {}, options = {}) {
  const targetDate = provider.getTargetDate(options.date);
  const climateDayWindow = provider.getClimateDayWindow(targetDate);
  const context = {
    ...options,
    targetDate,
    climateDayWindow,
    force: options.force === true
  };
  const [settlement, observations, forecasts, modelForecast, markets] = await Promise.all([
    provider.fetchSettlement(env, context),
    provider.fetchObservations(env, context),
    provider.fetchForecasts(env, context),
    provider.fetchModelForecast(env, context),
    provider.fetchMarkets(env, context)
  ]);

  return {
    provider: describeWeatherProvider(provider),
    targetDate,
    climateDayWindow,
    settlement,
    observations,
    forecasts,
    modelForecast,
    markets
  };
}
