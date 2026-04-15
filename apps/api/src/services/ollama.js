import axios from 'axios';

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown Ollama error';
}

function createOllamaClient(env) {
  return axios.create({
    baseURL: env.ollamaBaseUrl,
    timeout: 120000,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function resolveModel(models, requestedModel) {
  const names = models.map((model) => model.name);

  if (requestedModel && names.includes(requestedModel)) {
    return requestedModel;
  }

  const requestedFamily = requestedModel?.split(':')[0];

  if (requestedFamily) {
    const familyMatch = names.find((name) => name.startsWith(`${requestedFamily}:`));
    if (familyMatch) {
      return familyMatch;
    }
  }

  return names[0] ?? null;
}

export async function getOllamaStatus(env) {
  try {
    const ollamaClient = createOllamaClient(env);
    const response = await ollamaClient.get('/api/tags');
    const models = Array.isArray(response.data?.models) ? response.data.models : [];
    const resolvedModel = resolveModel(models, env.ollamaModel);

    return {
      reachable: true,
      requestedModel: env.ollamaModel,
      resolvedModel,
      availableModels: models.map((model) => model.name)
    };
  } catch (error) {
    return {
      reachable: false,
      requestedModel: env.ollamaModel,
      resolvedModel: null,
      availableModels: [],
      error: getErrorMessage(error)
    };
  }
}

export async function runAiTest(env, prompt) {
  const status = await getOllamaStatus(env);

  if (!status.reachable) {
    throw new Error(status.error ?? 'Ollama is not reachable.');
  }

  if (!status.resolvedModel) {
    throw new Error('No local Ollama model is available.');
  }

  const ollamaClient = createOllamaClient(env);
  const response = await ollamaClient.post('/api/generate', {
    model: status.resolvedModel,
    prompt,
    stream: false
  });

  return {
    ...status,
    response: response.data?.response?.trim() ?? '',
    done: Boolean(response.data?.done)
  };
}

export function buildEventAnalysisPrompt(event, aggregation, statisticalModel) {
  const marketLines = aggregation.historicalPrices.markets
    .map((market) => {
      const outcomes = market.outcomes
        .map((outcome) => {
          const currentProbability = typeof outcome.currentProbability === 'number'
            ? outcome.currentProbability.toFixed(3)
            : 'n/a';
          const move = typeof outcome.historySummary?.percentChange === 'number'
            ? `${(outcome.historySummary.percentChange * 100).toFixed(1)}%`
            : 'n/a';

          return `${outcome.label}: now=${currentProbability}, move_7d=${move}`;
        })
        .join(', ');

      return `- ${market.question} | ${outcomes}`;
    })
    .join('\n');

  const bestOpportunity = statisticalModel.summary.bestOpportunity;

  return [
    'You are an offline analysis assistant for a prediction-market trading system.',
    'Use the statistical model and aggregated market data to identify the most mispriced live opportunity.',
    'Return exactly 4 bullet points:',
    '1) event state, 2) strongest market/opportunity, 3) why the model differs from market price, 4) key risk.',
    `Event: ${event.title}`,
    `Slug: ${event.slug}`,
    `Event volume: ${aggregation.liquiditySnapshot.eventVolume ?? 'n/a'}`,
    `Event liquidity: ${aggregation.liquiditySnapshot.eventLiquidity ?? 'n/a'}`,
    `Top outcome: ${statisticalModel.summary.bestOpportunity ? `${bestOpportunity.label} in ${bestOpportunity.question}` : 'n/a'}`,
    `Model methodology: ${statisticalModel.methodology.description}`,
    'Live markets:',
    marketLines
  ].join('\n');
}