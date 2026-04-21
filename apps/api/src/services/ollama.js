import axios from 'axios';

function formatEventIntelligence(aggregation) {
  const intelligence = aggregation?.eventIntelligence;

  if (!intelligence?.available) {
    return 'Event intelligence: unavailable';
  }

  const teams = (Array.isArray(intelligence.teams) ? intelligence.teams : [])
    .map((team) => team.displayName ?? team.teamName)
    .filter(Boolean)
    .join(', ');
  const gameFeed = intelligence.gameFeed
    ? `Game feed: ${intelligence.gameFeed.name ?? 'n/a'} | status=${intelligence.gameFeed.status ?? 'n/a'} | detail=${intelligence.gameFeed.detail ?? 'n/a'} | score=${(intelligence.gameFeed.competitors ?? []).map((competitor) => `${competitor.teamName}:${competitor.score ?? 'n/a'}`).join(', ')}`
    : 'Game feed: unavailable';
  const players = (Array.isArray(intelligence.playerMentions) ? intelligence.playerMentions : [])
    .map((player) => player.name)
    .filter(Boolean)
    .slice(0, 8)
    .join(', ');
  const headlines = (Array.isArray(intelligence.articles) ? intelligence.articles : [])
    .slice(0, 6)
    .map((article) => {
      const signals = Array.isArray(article.impactSignals) && article.impactSignals.length > 0
        ? ` signals=${article.impactSignals.join('/')}`
        : '';
      const playersMentioned = Array.isArray(article.matchedPlayers) && article.matchedPlayers.length > 0
        ? ` players=${article.matchedPlayers.map((player) => player.name).join(', ')}`
        : '';

      return `- ${article.headline ?? 'n/a'} | impact=${article.impactScore ?? 0}${signals}${playersMentioned} | ${article.description ?? ''}`.trim();
    })
    .join('\n');
  const social = (Array.isArray(intelligence.socialPosts) ? intelligence.socialPosts : [])
    .slice(0, 4)
    .map((post) => {
      const signals = Array.isArray(post.impactSignals) && post.impactSignals.length > 0
        ? ` signals=${post.impactSignals.join('/')}`
        : '';

      return `- [${String(post.provider ?? 'social').toUpperCase()}] ${post.headline ?? 'n/a'} | impact=${post.impactScore ?? 0}${signals}`;
    })
    .join('\n');

  return [
    `Event intelligence league: ${intelligence.league}`,
    `Tracked teams: ${teams || 'n/a'}`,
    gameFeed,
    `Player mentions: ${players || 'none'}`,
    'Relevant news:',
    headlines || '- none',
    'Relevant social:',
    social || '- none'
  ].join('\n');
}

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

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model response did not contain a JSON object.');
  }

  return JSON.parse(text.slice(start, end + 1));
}

export async function runAiJson(env, prompt) {
  const result = await runAiTest(env, prompt);
  const parsed = extractFirstJsonObject(result.response);

  return {
    ...result,
    parsed
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
    formatEventIntelligence(aggregation),
    'Live markets:',
    marketLines
  ].join('\n');
}

export function buildDecisionEnginePrompt(event, aggregation, statisticalModel, options = {}) {
  const topMarkets = statisticalModel.markets
    .filter((market) => Array.isArray(market.outcomes) && market.outcomes.length > 0)
    .sort((left, right) => {
      const leftScore = typeof left.opportunity?.score === 'number' ? left.opportunity.score : -Infinity;
      const rightScore = typeof right.opportunity?.score === 'number' ? right.opportunity.score : -Infinity;

      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      return (right.confidence ?? 0) - (left.confidence ?? 0);
    })
    .slice(0, 3)
    .map((market) => {
      const best = market.opportunity
        ?? [...market.outcomes]
          .filter((candidate) => typeof candidate.currentProbability === 'number' || typeof candidate.estimatedProbability === 'number')
          .sort((left, right) => {
            const leftValue = typeof left.estimatedProbability === 'number'
              ? left.estimatedProbability
              : (left.currentProbability ?? -1);
            const rightValue = typeof right.estimatedProbability === 'number'
              ? right.estimatedProbability
              : (right.currentProbability ?? -1);

            return rightValue - leftValue;
          })[0]
        ?? null;

      if (!best) {
        return null;
      }

      return {
        marketQuestion: market.question,
        outcomeLabel: best.label,
        marketProbability: typeof best.currentProbability === 'number' ? Number(best.currentProbability.toFixed(3)) : null,
        modelProbability: typeof best.estimatedProbability === 'number' ? Number(best.estimatedProbability.toFixed(3)) : null,
        edge: typeof best.edge === 'number' ? Number(best.edge.toFixed(3)) : 0,
        confidence: typeof best.confidence === 'number' ? Number(best.confidence.toFixed(3)) : Number((market.confidence ?? 0.5).toFixed(3))
      };
    })
    .filter(Boolean);

  return [
    'You are a decision engine for a prediction-market trading assistant.',
    'Return exactly one JSON object and no extra text.',
    'The JSON schema is:',
    '{"marketQuestion":"string","outcomeLabel":"string","confidence":0.0,"agreeWithModel":true,"stopLossProbability":0.0,"takeProfitProbability":0.0,"thesis":"string","keyRisk":"string","reasons":["string","string","string"]}',
    'Choose a recommendation from the provided model-ranked live markets only.',
    'If no positive-edge opportunity is present, choose the strongest priced market from validCandidates anyway and keep confidence calibrated.',
    'Use the marketQuestion and outcomeLabel values exactly as provided in validCandidates.',
    typeof options.tradeAmount === 'number'
      ? `Planned buying amount: $${options.tradeAmount.toFixed(2)}. Calibrate stopLossProbability and takeProfitProbability for this amount, liquidity, edge, and confidence.`
      : 'No planned buying amount was provided; use conservative default stopLossProbability and takeProfitProbability values.',
    `Event: ${event.title}`,
    `Slug: ${event.slug}`,
    `Event volume: ${aggregation.liquiditySnapshot.eventVolume ?? 'n/a'}`,
    `Event liquidity: ${aggregation.liquiditySnapshot.eventLiquidity ?? 'n/a'}`,
    formatEventIntelligence(aggregation),
    `validCandidates: ${JSON.stringify(topMarkets)}`
  ].join('\n');
}
