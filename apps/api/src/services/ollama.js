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

export function buildEventAnalysisPrompt(event) {
  const marketLines = event.markets
    .map((market) => {
      const outcomes = market.outcomes
        .map((outcome) => `${outcome.label}: ${outcome.price ?? 'n/a'}`)
        .join(', ');

      return `- ${market.question} | outcomes: ${outcomes}`;
    })
    .join('\n');

  return [
    'You are testing local model connectivity for a prediction-market trading assistant.',
    'Summarize the event and highlight one market that appears most interesting based only on the quoted prices.',
    'Keep the response to 4 short bullet points.',
    `Event: ${event.title}`,
    `Slug: ${event.slug}`,
    'Markets:',
    marketLines
  ].join('\n');
}