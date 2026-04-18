const POLITICS_NEWS_TTL_MS = 5 * 60 * 1000;
const POLITICS_NEWS_FETCH_TIMEOUT_MS = 12000;
const MAX_POLITICS_ARTICLES = 18;
const MAX_POLITICS_QUERY_TERMS = 8;
const POLITICS_RELEVANCE_MIN = 0.07;

const POLITICS_TERM_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'will', 'would', 'could', 'should',
  'into', 'about', 'than', 'then', 'over', 'under', 'above', 'below', 'more', 'less',
  'year', 'month', 'week', 'day', 'percent', 'percentage', 'market', 'event', 'outcome',
  'price', 'probability', 'yes', 'no', 'who', 'what', 'when', 'where', 'which', 'how',
  'has', 'have', 'had', 'been', 'being', 'after', 'before', 'their', 'there', 'them',
  'they', 'your', 'ours', 'ourselves', 'it', 'its', 'is', 'are', 'was', 'were', 'be'
]);

const POLITICS_RSS_FEEDS = [
  'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
  'https://www.politico.com/rss/politicopicks.xml',
  'https://feeds.bbci.co.uk/news/politics/rss.xml'
];

const politicsNewsCache = new Map();

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.%$\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function stripHtml(value) {
  return decodeXmlEntities(String(value ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePublishedTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function extractTag(block, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(regex);
  return match ? stripHtml(match[1]) : null;
}

function extractLink(block) {
  const explicitTag = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);

  if (explicitTag && explicitTag[1]) {
    const value = stripHtml(explicitTag[1]);
    if (value) {
      return value;
    }
  }

  const hrefTag = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i);

  if (hrefTag && hrefTag[1]) {
    return hrefTag[1];
  }

  return null;
}

function parseRssItems(xmlText) {
  const blocks = String(xmlText ?? '').match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) ?? [];

  return blocks
    .map((block, index) => {
      const headline = extractTag(block, 'title');
      const description = extractTag(block, 'description') ?? extractTag(block, 'summary') ?? '';
      const published = extractTag(block, 'pubDate') ?? extractTag(block, 'published') ?? extractTag(block, 'updated');
      const link = extractLink(block);
      const source = extractTag(block, 'source') ?? extractTag(block, 'author') ?? 'rss';
      const guid = extractTag(block, 'guid') ?? extractTag(block, 'id') ?? null;

      if (!headline) {
        return null;
      }

      const id = guid || link || `${headline}-${published ?? index}`;

      return {
        id,
        headline,
        description,
        published,
        link,
        source
      };
    })
    .filter(Boolean);
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, text/plain'
      }
    });

    if (!response.ok) {
      return null;
    }

    return response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function pruneExpiredCache(cache, now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if ((entry?.expiresAt ?? 0) <= now) {
      cache.delete(key);
    }
  }
}

async function getCachedValue(cache, key, ttlMs, factory) {
  const now = Date.now();
  pruneExpiredCache(cache, now);

  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = Promise.resolve().then(factory).catch((error) => {
    const current = cache.get(key);

    if (current?.promise === promise) {
      cache.delete(key);
    }

    throw error;
  });

  cache.set(key, {
    expiresAt: now + ttlMs,
    promise
  });

  return promise;
}

function getDefaultPoliticsContext(reason = 'unsupported-event') {
  return {
    generatedAt: new Date().toISOString(),
    available: false,
    reason,
    searchTerms: [],
    articleCount: 0,
    articles: [],
    recognizedMarketCount: 0,
    markets: []
  };
}

function isPoliticsEvent(event, markets) {
  const category = normalizeText(event?.category);

  if (category === 'politics') {
    return true;
  }

  if ((Array.isArray(markets) ? markets : []).some((market) => normalizeText(market?.category) === 'politics')) {
    return true;
  }

  const joined = normalizeText([
    event?.slug,
    event?.title,
    event?.description,
    ...(Array.isArray(markets) ? markets.flatMap((market) => [market?.question, market?.title, market?.subtitle]) : [])
  ].filter(Boolean).join(' '));

  if (!joined) {
    return false;
  }

  const politicsTokens = [
    'election',
    'president',
    'senate',
    'house',
    'campaign',
    'governor',
    'politic',
    'congress',
    'vote',
    'approval',
    'poll',
    'cpi',
    'inflation',
    'fed',
    'white house'
  ];

  return politicsTokens.some((token) => joined.includes(token));
}

function normalizeMarkets(markets) {
  if (!Array.isArray(markets)) {
    return [];
  }

  return markets
    .map((market, index) => {
      const conditionId = String(market?.conditionId ?? market?.id ?? `market-${index + 1}`);
      const outcomesRaw = Array.isArray(market?.outcomes) ? market.outcomes : parseStringArray(market?.outcomes);
      const outcomes = outcomesRaw
        .map((outcome) => {
          if (!outcome) {
            return null;
          }

          if (typeof outcome === 'string') {
            return {
              label: outcome,
              currentProbability: null
            };
          }

          return {
            label: String(outcome.label ?? outcome.outcome ?? '').trim(),
            currentProbability: typeof outcome.currentProbability === 'number'
              ? outcome.currentProbability
              : (typeof outcome.probability === 'number' ? outcome.probability : null)
          };
        })
        .filter((outcome) => outcome && outcome.label);

      return {
        conditionId,
        question: String(market?.question ?? market?.title ?? conditionId),
        title: String(market?.title ?? '').trim() || null,
        subtitle: String(market?.subtitle ?? '').trim() || null,
        category: normalizeText(market?.category) || null,
        outcomes
      };
    })
    .filter((market) => market.outcomes.length > 0);
}

function collectQueryTerms(event, markets) {
  const terms = [];

  function pushTerm(value) {
    const text = stripHtml(value);

    if (!text || text.length < 3) {
      return;
    }

    terms.push(text);
  }

  pushTerm(event?.title);

  for (const market of markets.slice(0, 12)) {
    pushTerm(market.question);
    pushTerm(market.title);

    for (const outcome of market.outcomes) {
      const normalized = normalizeText(outcome.label);

      if (normalized === 'yes' || normalized === 'no') {
        continue;
      }

      pushTerm(outcome.label);
    }
  }

  const uniq = [];
  const seen = new Set();

  for (const term of terms) {
    const normalized = normalizeText(term);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniq.push(term.trim());

    if (uniq.length >= MAX_POLITICS_QUERY_TERMS) {
      break;
    }
  }

  return uniq;
}

function buildPoliticsNewsUrls(queryTerms) {
  const query = queryTerms.slice(0, 5).join(' OR ');
  const urls = [...POLITICS_RSS_FEEDS];

  if (query) {
    urls.push(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`);
  }

  return urls;
}

function getArticleImpactSignals(normalizedText) {
  const signalRules = [
    { signal: 'polling', patterns: [/\bpoll\b/i, /\bapproval\b/i, /\bsurvey\b/i] },
    { signal: 'election', patterns: [/\belection\b/i, /\bprimary\b/i, /\bcaucus\b/i] },
    { signal: 'endorsement', patterns: [/\bendorse\b/i, /\bbacking\b/i] },
    { signal: 'legal', patterns: [/\bindict\b/i, /\blawsuit\b/i, /\binvestigat\b/i, /\bconvict\b/i] },
    { signal: 'macro', patterns: [/\bcpi\b/i, /\binflation\b/i, /\bjobs\b/i, /\bunemployment\b/i, /\bfed\b/i] },
    { signal: 'debate', patterns: [/\bdebate\b/i, /\bcampaign\b/i] }
  ];

  return signalRules
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(normalizedText)))
    .map((rule) => rule.signal);
}

function getDirectionalImpact(normalizedText) {
  const positivePatterns = [
    /\blead(?:s|ing)?\b/i,
    /\bgain(?:s|ed)?\b/i,
    /\bsurge(?:s|d)?\b/i,
    /\bendorse(?:d|ment)?\b/i,
    /\bwin(?:s|ning)?\b/i,
    /\bstrong(?:er)?\b/i,
    /\bcools?\b/i,
    /\bdeclin(?:e|es|ed)\b/i
  ];

  const negativePatterns = [
    /\btrail(?:s|ing|ed)?\b/i,
    /\bdrop(?:s|ped)?\b/i,
    /\bslump(?:s|ed)?\b/i,
    /\bscandal\b/i,
    /\bindict(?:ed|ment)?\b/i,
    /\blawsuit\b/i,
    /\binvestigat(?:e|ion)\b/i,
    /\bspike(?:s|d)?\b/i,
    /\brise(?:s|n)?\b/i
  ];

  const positiveHits = positivePatterns.filter((pattern) => pattern.test(normalizedText)).length;
  const negativeHits = negativePatterns.filter((pattern) => pattern.test(normalizedText)).length;

  if (positiveHits === 0 && negativeHits === 0) {
    return 0;
  }

  return clamp((positiveHits - negativeHits) / Math.max(positiveHits + negativeHits, 2), -1, 1);
}

function scoreArticle(article, queryTerms) {
  const combinedText = normalizeText(`${article.headline ?? ''} ${article.description ?? ''}`);
  const signals = getArticleImpactSignals(combinedText);
  const directionalImpact = getDirectionalImpact(combinedText);
  const termMatches = queryTerms.filter((term) => {
    const normalizedTerm = normalizeText(term);
    return normalizedTerm && combinedText.includes(normalizedTerm);
  }).length;
  const publishedTimestamp = parsePublishedTimestamp(article.published);
  const ageHours = Number.isFinite(publishedTimestamp)
    ? Math.max(0, (Date.now() - publishedTimestamp) / 3600000)
    : null;

  let impactScore = termMatches * 2 + signals.length * 1.5 + Math.abs(directionalImpact) * 4;

  if (typeof ageHours === 'number') {
    if (ageHours <= 6) {
      impactScore += 3;
    } else if (ageHours <= 24) {
      impactScore += 1.5;
    } else if (ageHours > 96) {
      impactScore -= 2;
    }
  }

  return {
    ...article,
    impactSignals: signals,
    directionalImpact,
    impactScore: Number(impactScore.toFixed(3)),
    text: combinedText
  };
}

function extractMarketTerms(market) {
  const terms = [];

  const push = (value) => {
    const normalized = normalizeText(value);

    if (!normalized || normalized.length < 3) {
      return;
    }

    terms.push(normalized);

    for (const token of normalized.split(' ')) {
      if (token.length < 3) {
        continue;
      }

      if (POLITICS_TERM_STOPWORDS.has(token)) {
        continue;
      }

      if (/^\d+(?:\.\d+)?$/.test(token)) {
        continue;
      }

      terms.push(token);
    }
  };

  push(market.question);
  push(market.title);
  push(market.subtitle);

  for (const outcome of market.outcomes) {
    const normalized = normalizeText(outcome.label);

    if (normalized === 'yes' || normalized === 'no') {
      continue;
    }

    push(outcome.label);
  }

  return [...new Set(terms)].slice(0, 28);
}

function getComparatorDirection(market) {
  const context = normalizeText(`${market.question ?? ''} ${market.title ?? ''} ${market.subtitle ?? ''}`);

  if (/\b(over|above|higher|greater|or more|at least|more than)\b/i.test(context)) {
    return 1;
  }

  if (/\b(under|below|lower|less|or less|at most|fewer than)\b/i.test(context)) {
    return -1;
  }

  return 0;
}

function getTrendDirection(articleText) {
  const upWords = ['up', 'rise', 'higher', 'hotter', 'increase', 'accelerate', 'surge'];
  const downWords = ['down', 'lower', 'cool', 'decrease', 'ease', 'decline', 'fall'];
  const upHits = upWords.filter((word) => articleText.includes(word)).length;
  const downHits = downWords.filter((word) => articleText.includes(word)).length;

  if (upHits === 0 && downHits === 0) {
    return 0;
  }

  return clamp((upHits - downHits) / Math.max(upHits + downHits, 2), -1, 1);
}

function getMarketRelevance(articleText, marketTerms) {
  if (marketTerms.length === 0) {
    return 0;
  }

  let weightedMatches = 0;

  for (const term of marketTerms) {
    if (!articleText.includes(term)) {
      continue;
    }

    weightedMatches += term.includes(' ') ? 1.35 : 0.75;
  }

  if (weightedMatches <= 0) {
    return 0;
  }

  const normalization = Math.max(3.5, Math.min(marketTerms.length * 0.72, 10.5));
  return clamp(weightedMatches / normalization, 0, 1);
}

function getOutcomeSpecificity(outcomeLabel, articleText) {
  const normalized = normalizeText(outcomeLabel);

  if (!normalized || normalized === 'yes' || normalized === 'no') {
    return 0;
  }

  const labelTokens = normalized.split(' ').filter((token) => token.length > 2);

  if (labelTokens.length === 0) {
    return articleText.includes(normalized) ? 1 : 0;
  }

  const tokenMatches = labelTokens.filter((token) => articleText.includes(token)).length;

  if (tokenMatches === 0) {
    return 0;
  }

  return clamp(tokenMatches / labelTokens.length, 0, 1);
}

function buildPoliticsMarketContext(market, scoredArticles) {
  const marketTerms = extractMarketTerms(market);
  const comparatorDirection = getComparatorDirection(market);

  const related = scoredArticles
    .map((article) => {
      const relevance = getMarketRelevance(article.text, marketTerms);

      if (relevance < POLITICS_RELEVANCE_MIN) {
        return null;
      }

      return {
        ...article,
        relevance,
        trendDirection: getTrendDirection(article.text)
      };
    })
    .filter(Boolean);

  const marketConfidence = clamp(
    0.25
      + Math.min(related.length, 10) / 20
      + (average(related.map((article) => article.relevance)) ?? 0) * 0.35,
    0.2,
    0.9
  );

  const outcomes = market.outcomes.map((outcome) => {
    const label = String(outcome.label ?? '').trim();
    const normalizedLabel = normalizeText(label);
    const currentProbability = typeof outcome.currentProbability === 'number'
      ? clamp(outcome.currentProbability, 0.001, 0.999)
      : null;

    if (typeof currentProbability !== 'number') {
      return {
        label,
        fairProbability: null,
        modelConfidence: marketConfidence,
        features: {
          politicsNewsImpact: 0,
          matchedArticleCount: 0,
          averageRelevance: 0,
          directionalScore: 0,
          source: 'politics-news-ingestion-v1'
        }
      };
    }

    const weightedDirectional = related.map((article) => {
      const specificity = getOutcomeSpecificity(label, article.text);
      let directional = article.directionalImpact;

      if (normalizedLabel === 'yes' || normalizedLabel === 'no') {
        const binaryDirection = comparatorDirection === 0
          ? article.directionalImpact
          : clamp(article.directionalImpact * 0.5 + comparatorDirection * article.trendDirection * 0.8, -1, 1);
        directional = normalizedLabel === 'yes' ? binaryDirection : -binaryDirection;
      } else if (specificity > 0) {
        directional = directional * (0.6 + specificity * 0.8);
      } else {
        directional = directional * 0.25;
      }

      const weight = article.relevance * (0.5 + Math.max(0.2, Math.abs(article.directionalImpact)));

      return {
        directional,
        weight,
        relevance: article.relevance,
        impactSignals: article.impactSignals
      };
    }).filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0);

    const totalWeight = weightedDirectional.reduce((sum, entry) => sum + entry.weight, 0);
    const directionalScore = totalWeight > 0
      ? weightedDirectional.reduce((sum, entry) => sum + entry.directional * entry.weight, 0) / totalWeight
      : 0;
    const avgRelevance = average(weightedDirectional.map((entry) => entry.relevance)) ?? 0;
    const impactDelta = clamp(directionalScore * marketConfidence * 0.08, -0.12, 0.12);
    const fairProbability = clamp(currentProbability + impactDelta, 0.01, 0.99);

    return {
      label,
      fairProbability,
      modelConfidence: marketConfidence,
      features: {
        politicsNewsImpact: Number(impactDelta.toFixed(4)),
        matchedArticleCount: weightedDirectional.length,
        averageRelevance: Number(avgRelevance.toFixed(4)),
        directionalScore: Number(directionalScore.toFixed(4)),
        source: 'politics-news-ingestion-v1'
      }
    };
  });

  return {
    conditionId: market.conditionId,
    question: market.question,
    category: market.category,
    title: market.title,
    subtitle: market.subtitle,
    model: {
      name: 'politics-news-ingestion-v1',
      description: 'Event-driven politics news relevance and directional impact blended into per-outcome fair probabilities.'
    },
    marketConfidence,
    relatedArticleCount: related.length,
    outcomes
  };
}

async function fetchPoliticsArticles(event, queryTerms) {
  const cacheKey = `${String(event?.slug ?? event?.id ?? event?.title ?? 'event').toLowerCase()}::${queryTerms.map((term) => normalizeText(term)).join('|')}`;

  return getCachedValue(politicsNewsCache, cacheKey, POLITICS_NEWS_TTL_MS, async () => {
    const urls = buildPoliticsNewsUrls(queryTerms);
    const payloads = await Promise.all(urls.map((url) => fetchTextWithTimeout(url, POLITICS_NEWS_FETCH_TIMEOUT_MS)));
    const seen = new Set();
    const merged = [];

    for (const payload of payloads.filter(Boolean)) {
      for (const article of parseRssItems(payload)) {
        const key = normalizeText(article.id || `${article.headline}-${article.link ?? ''}`);

        if (!key || seen.has(key)) {
          continue;
        }

        seen.add(key);
        merged.push(article);
      }
    }

    return merged;
  });
}

export async function buildPoliticsContext(env, event, options = {}) {
  const normalizedMarkets = normalizeMarkets(options.markets ?? event?.markets ?? []);

  if (!isPoliticsEvent(event, normalizedMarkets)) {
    return getDefaultPoliticsContext('unsupported-or-non-politics-event');
  }

  if (normalizedMarkets.length === 0) {
    return getDefaultPoliticsContext('no-politics-markets-found');
  }

  const queryTerms = collectQueryTerms(event, normalizedMarkets);
  const rawArticles = await fetchPoliticsArticles(event, queryTerms);
  const scoredArticles = rawArticles
    .map((article) => scoreArticle(article, queryTerms))
    .sort((left, right) => {
      if (right.impactScore !== left.impactScore) {
        return right.impactScore - left.impactScore;
      }

      return (parsePublishedTimestamp(right.published) ?? 0) - (parsePublishedTimestamp(left.published) ?? 0);
    })
    .slice(0, MAX_POLITICS_ARTICLES);

  const markets = normalizedMarkets.map((market) => buildPoliticsMarketContext(market, scoredArticles));

  return {
    generatedAt: new Date().toISOString(),
    available: true,
    reason: null,
    searchTerms: queryTerms,
    articleCount: scoredArticles.length,
    articles: scoredArticles.map((article) => ({
      id: article.id,
      headline: article.headline,
      published: article.published,
      source: article.source,
      link: article.link,
      impactSignals: article.impactSignals,
      directionalImpact: article.directionalImpact,
      impactScore: article.impactScore
    })),
    recognizedMarketCount: markets.length,
    markets
  };
}
