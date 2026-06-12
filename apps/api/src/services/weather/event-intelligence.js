const MONTH_INDEX = new Map([
  ['jan', 0],
  ['january', 0],
  ['feb', 1],
  ['february', 1],
  ['mar', 2],
  ['march', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['jun', 5],
  ['june', 5],
  ['jul', 6],
  ['july', 6],
  ['aug', 7],
  ['august', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11]
]);

const WEATHER_CATEGORY_VALUES = new Set(['weather', 'climate']);
const WEATHER_STRONG_TERMS = [
  'weather',
  'temperature',
  'forecast',
  'wunderground',
  'weather underground',
  'rainfall',
  'precipitation',
  'snowfall',
  'hurricane',
  'tropical storm',
  'wind speed',
  'degrees fahrenheit',
  'degrees celsius',
  '°f',
  '°c'
];
const WEATHER_WEAK_TERMS = [
  'rain',
  'snow',
  'wind',
  'storm',
  'high temp',
  'low temp',
  'heat',
  'cold',
  'airport station',
  'station'
];

function toTitleCase(value) {
  return String(value ?? '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function compactText(...values) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(' ');
}

function getEventWeatherText(event, markets = []) {
  return compactText(
    event?.category,
    event?.slug,
    event?.title,
    event?.description,
    event?.rules,
    event?.resolutionSource,
    ...(Array.isArray(markets) ? markets.flatMap((market) => [
      market?.category,
      market?.slug,
      market?.question,
      market?.title,
      market?.subtitle,
      market?.description,
      market?.rules,
      market?.resolutionSource
    ]) : [])
  );
}

function isWeatherCategory(value) {
  const normalized = normalizeText(value).trim();
  return WEATHER_CATEGORY_VALUES.has(normalized);
}

export function isWeatherEvent(event, markets = []) {
  const categories = [
    normalizeText(event?.category).trim(),
    ...(Array.isArray(markets) ? markets.map((market) => normalizeText(market?.category).trim()) : [])
  ].filter(Boolean);

  if (isWeatherCategory(event?.category)) {
    return true;
  }

  if ((Array.isArray(markets) ? markets : []).some((market) => isWeatherCategory(market?.category))) {
    return true;
  }

  if (categories.length > 0 && categories.every((category) => category === 'sports')) {
    return false;
  }

  const normalized = normalizeText(getEventWeatherText(event, markets));
  const hasStrongTerm = WEATHER_STRONG_TERMS.some((term) => normalized.includes(term));

  if (hasStrongTerm) {
    return true;
  }

  const weakHits = WEATHER_WEAK_TERMS.filter((term) => normalized.includes(term)).length;
  return weakHits >= 2;
}

function getMarketWeatherText(event, market) {
  return compactText(
    market?.category,
    market?.slug,
    market?.question,
    market?.title,
    market?.subtitle,
    market?.description,
    market?.rules,
    market?.resolutionSource,
    event?.title,
    event?.description,
    event?.rules,
    event?.resolutionSource
  );
}

function extractUrl(text, preferredHost = null) {
  const matches = String(text ?? '').match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];

  if (preferredHost) {
    const preferred = matches.find((url) => {
      try {
        return new URL(url).hostname.toLowerCase().includes(preferredHost);
      } catch {
        return false;
      }
    });

    if (preferred) {
      return preferred.replace(/[.,;]+$/g, '');
    }
  }

  return matches[0]?.replace(/[.,;]+$/g, '') ?? null;
}

function extractWundergroundLocation(url) {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);

    if (!parsedUrl.hostname.toLowerCase().includes('wunderground.com')) {
      return null;
    }

    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const dailyIndex = segments.findIndex((segment) => segment.toLowerCase() === 'daily');

    if (dailyIndex === -1) {
      return null;
    }

    const country = segments[dailyIndex + 1]?.toUpperCase() ?? null;
    const state = segments[dailyIndex + 2]?.toUpperCase() ?? null;
    const citySlug = segments[dailyIndex + 3] ?? null;
    const station = segments[dailyIndex + 4]?.toUpperCase() ?? null;
    const city = citySlug ? toTitleCase(citySlug) : null;

    if (!country && !state && !city && !station) {
      return null;
    }

    return {
      country,
      state,
      city,
      station,
      displayName: [city, state].filter(Boolean).join(', ') || station || null
    };
  } catch {
    return null;
  }
}

function extractWundergroundDate(url) {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const dateIndex = segments.findIndex((segment) => segment.toLowerCase() === 'date');
    const dateSegment = dateIndex !== -1 ? segments[dateIndex + 1] : null;

    if (!dateSegment) {
      return null;
    }

    const match = dateSegment.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

    if (!match) {
      return null;
    }

    const year = Number.parseInt(match[1], 10);
    const monthIndex = Number.parseInt(match[2], 10) - 1;
    const day = Number.parseInt(match[3], 10);

    return buildDateResult(
      year,
      monthIndex,
      day,
      `${match[2].padStart(2, '0')}/${match[3].padStart(2, '0')}/${year}`
    );
  } catch {
    return null;
  }
}

function extractResolutionSourceName(text, url) {
  const normalized = normalizeText(text);

  if (normalized.includes('wunderground') || normalizeText(url).includes('wunderground')) {
    return 'Wunderground';
  }

  if (normalized.includes('national weather service') || normalized.includes('weather.gov')) {
    return 'National Weather Service';
  }

  return url ? new URL(url).hostname.replace(/^www\./, '') : null;
}

function extractStationCode(text, url) {
  if (url) {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      const lastSegment = segments.at(-1);

      if (/^[A-Z0-9]{3,5}$/i.test(lastSegment ?? '')) {
        return lastSegment.toUpperCase();
      }
    } catch {
      // Fall through to text extraction.
    }
  }

  const stationMatch = String(text ?? '').match(/\bK[A-Z0-9]{3}\b/i);
  return stationMatch ? stationMatch[0].toUpperCase() : null;
}

function extractStationName(text) {
  const patterns = [
    /recorded at the\s+(.+?\s+Station)\b/i,
    /recorded at\s+(.+?)\s+\([A-Z0-9]{3,5}\)/i,
    /Forecast for the\s+(.+?\s+Station)\b/i,
    /at the\s+(.+?\s+Airport)\b/i
  ];

  for (const pattern of patterns) {
    const match = String(text ?? '').match(pattern);

    if (match?.[1]) {
      return match[1].replace(/\s+/g, ' ').trim();
    }
  }

  return null;
}

function extractUnit(text) {
  const normalized = normalizeText(text);

  if (normalized.includes('fahrenheit') || normalized.includes('°f')) {
    return 'F';
  }

  if (/\b-?\d+(?:\.\d+)?\s*f\b/i.test(String(text ?? ''))) {
    return 'F';
  }

  if (normalized.includes('celsius') || normalized.includes('°c')) {
    return 'C';
  }

  if (/\b-?\d+(?:\.\d+)?\s*c\b/i.test(String(text ?? ''))) {
    return 'C';
  }

  if (normalized.includes('inches')) {
    return 'in';
  }

  if (normalized.includes('millimeters')) {
    return 'mm';
  }

  return null;
}

function extractMetric(text) {
  const normalized = normalizeText(text);

  if (normalized.includes('highest temperature') || normalized.includes('high temperature')) {
    return 'highest-temperature';
  }

  if (normalized.includes('lowest temperature') || normalized.includes('low temperature')) {
    return 'lowest-temperature';
  }

  if (normalized.includes('rainfall') || normalized.includes('precipitation')) {
    return 'precipitation';
  }

  if (normalized.includes('snowfall') || normalized.includes('snow')) {
    return 'snowfall';
  }

  if (normalized.includes('wind speed') || normalized.includes('wind gust')) {
    return 'wind';
  }

  if (normalized.includes('hurricane') || normalized.includes('tropical storm')) {
    return 'storm';
  }

  return 'weather';
}

function normalizeTwoDigitYear(value) {
  const year = Number.parseInt(value, 10);

  if (!Number.isFinite(year)) {
    return null;
  }

  return value.length === 2 ? 2000 + year : year;
}

function buildDateResult(year, monthIndex, day, label) {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return null;
  }

  const date = new Date(Date.UTC(year, monthIndex, day));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== monthIndex
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    date: date.toISOString().slice(0, 10),
    label
  };
}

function getFallbackYear(event) {
  const candidates = [event?.endDate, event?.startDate];

  for (const candidate of candidates) {
    const parsed = new Date(candidate);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getUTCFullYear();
    }
  }

  return new Date().getUTCFullYear();
}

function extractTargetDate(text, fallbackYear = null) {
  const value = String(text ?? '');
  const isoDate = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);

  if (isoDate) {
    const year = Number.parseInt(isoDate[1], 10);
    const monthIndex = Number.parseInt(isoDate[2], 10) - 1;
    const day = Number.parseInt(isoDate[3], 10);

    return buildDateResult(year, monthIndex, day, `${isoDate[2]}/${isoDate[3]}/${isoDate[1]}`);
  }

  const monthDayYear = value.match(/\b(?:on\s+)?([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+'?(\d{2}|\d{4})\b/);

  if (monthDayYear) {
    const monthIndex = MONTH_INDEX.get(monthDayYear[1].toLowerCase());
    const day = Number.parseInt(monthDayYear[2], 10);
    const year = normalizeTwoDigitYear(monthDayYear[3]);

    return buildDateResult(year, monthIndex, day, `${monthDayYear[1]} ${day}, ${year}`);
  }

  const dayMonthYear = value.match(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Z][a-z]+)\s+'?(\d{2}|\d{4})\b/);

  if (dayMonthYear) {
    const day = Number.parseInt(dayMonthYear[1], 10);
    const monthIndex = MONTH_INDEX.get(dayMonthYear[2].toLowerCase());
    const year = normalizeTwoDigitYear(dayMonthYear[3]);

    return buildDateResult(year, monthIndex, day, `${day} ${dayMonthYear[2]} ${year}`);
  }

  if (Number.isFinite(fallbackYear)) {
    const monthDay = value.match(/\b(?:on\s+)?([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);

    if (monthDay) {
      const monthIndex = MONTH_INDEX.get(monthDay[1].toLowerCase());
      const day = Number.parseInt(monthDay[2], 10);

      return buildDateResult(fallbackYear, monthIndex, day, `${monthDay[1]} ${day}, ${fallbackYear}`);
    }

    const slashDate = value.match(/\b(\d{1,2})\/(\d{1,2})\b/);

    if (slashDate) {
      const monthIndex = Number.parseInt(slashDate[1], 10) - 1;
      const day = Number.parseInt(slashDate[2], 10);

      return buildDateResult(
        fallbackYear,
        monthIndex,
        day,
        `${slashDate[1].padStart(2, '0')}/${slashDate[2].padStart(2, '0')}/${fallbackYear}`
      );
    }
  }

  return null;
}

function extractPrecision(text, unit) {
  const normalized = normalizeText(text);

  if (normalized.includes('whole degrees')) {
    return unit === 'F' ? 'whole degrees Fahrenheit' : 'whole degrees';
  }

  if (normalized.includes('nearest tenth')) {
    return 'nearest tenth';
  }

  return null;
}

function extractFinalizationRule(text) {
  const normalized = normalizeText(text);

  if (normalized.includes('can not resolve') && normalized.includes('finalized')) {
    return 'requires finalized source data before Yes resolution';
  }

  if (normalized.includes('cannot resolve') && normalized.includes('finalized')) {
    return 'requires finalized source data before Yes resolution';
  }

  if (normalized.includes('revisions') && normalized.includes('finalized')) {
    return 'ignores revisions after source data is finalized';
  }

  return null;
}

function parseOutcomeRange(label, unit) {
  const value = String(label ?? '').trim();
  const exactMatch = value.match(/^(-?\d+(?:\.\d+)?)\s*(?:(?:°\s?[FC]?)|(?:[FC]))?(?:\s+degrees?)?$/i);

  if (exactMatch) {
    const exactValue = Number.parseFloat(exactMatch[1]);

    return {
      min: exactValue,
      max: exactValue,
      inclusiveMin: true,
      inclusiveMax: true,
      unit
    };
  }

  const rangeMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:[-–]|\bto\b)\s*(-?\d+(?:\.\d+)?)/i);

  if (rangeMatch) {
    return {
      min: Number.parseFloat(rangeMatch[1]),
      max: Number.parseFloat(rangeMatch[2]),
      inclusiveMin: true,
      inclusiveMax: true,
      unit
    };
  }

  const plusMatch = value.match(/^(-?\d+(?:\.\d+)?)\s*(?:(?:°\s?[FC]?)|(?:[FC]))?\s*\+$/i);

  if (plusMatch) {
    return {
      min: Number.parseFloat(plusMatch[1]),
      max: null,
      inclusiveMin: true,
      inclusiveMax: false,
      unit
    };
  }

  const aboveMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:(?:°\s?[FC]?)|(?:[FC]))?\s+(?:or\s+)?(?:higher|above|more|greater)/i)
    ?? value.match(/(?:at\s+least|above|over|greater\s+than)\s+(-?\d+(?:\.\d+)?)/i);

  if (aboveMatch) {
    return {
      min: Number.parseFloat(aboveMatch[1]),
      max: null,
      inclusiveMin: true,
      inclusiveMax: false,
      unit
    };
  }

  const belowMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:(?:°\s?[FC]?)|(?:[FC]))?\s+(?:or\s+)?(?:below|lower|under|less)/i)
    ?? value.match(/(?:below|under|less\s+than)\s+(-?\d+(?:\.\d+)?)/i);

  if (belowMatch) {
    return {
      min: null,
      max: Number.parseFloat(belowMatch[1]),
      inclusiveMin: false,
      inclusiveMax: true,
      unit
    };
  }

  return null;
}

function buildWeatherMarketContext(event, market) {
  const text = getMarketWeatherText(event, market);
  const resolutionSourceUrl = extractUrl(text, 'wunderground.com');
  const wundergroundLocation = extractWundergroundLocation(resolutionSourceUrl);
  const metric = extractMetric(text);
  const unit = extractUnit(text)
    ?? (metric.includes('temperature') && wundergroundLocation?.country === 'US' ? 'F' : null);
  const targetDate = extractTargetDate(text, getFallbackYear(event)) ?? extractWundergroundDate(resolutionSourceUrl);
  const marketRange = parseOutcomeRange(market.title, unit)
    ?? parseOutcomeRange(market.subtitle, unit)
    ?? parseOutcomeRange(market.question, unit);

  return {
    conditionId: market.conditionId,
    question: market.question,
    title: market.title ?? null,
    subtitle: market.subtitle ?? null,
    category: typeof market?.category === 'string' ? market.category.toLowerCase() : null,
    metric,
    location: wundergroundLocation?.displayName ?? null,
    country: wundergroundLocation?.country ?? null,
    state: wundergroundLocation?.state ?? null,
    city: wundergroundLocation?.city ?? null,
    stationName: extractStationName(text),
    stationCode: wundergroundLocation?.station ?? extractStationCode(text, resolutionSourceUrl),
    targetDate: targetDate?.date ?? null,
    targetDateLabel: targetDate?.label ?? null,
    unit,
    resolutionSourceName: resolutionSourceUrl ? extractResolutionSourceName(text, resolutionSourceUrl) : extractResolutionSourceName(text, null),
    resolutionSourceUrl,
    precision: extractPrecision(text, unit),
    finalizationRule: extractFinalizationRule(text),
    outcomes: (Array.isArray(market.outcomes) ? market.outcomes : []).map((outcome) => ({
      label: outcome.label,
      currentProbability: typeof outcome.currentProbability === 'number'
        ? outcome.currentProbability
        : (typeof outcome.probability === 'number' ? outcome.probability : null),
      range: parseOutcomeRange(outcome.label, unit) ?? (String(outcome.label ?? '').toLowerCase() === 'yes' ? marketRange : null)
    })),
    model: {
      name: 'weather-rules-context-v1',
      description: 'Extracts weather market resolution rules, station/source details, target date, unit, and outcome ranges from Polymarket rules text.'
    }
  };
}

export function buildWeatherContext(event, options = {}) {
  const markets = Array.isArray(options.markets) ? options.markets : [];
  const recognizedMarkets = markets
    .filter((market) => isWeatherEvent(event, [market]))
    .map((market) => buildWeatherMarketContext(event, market));

  const available = recognizedMarkets.length > 0 || isWeatherEvent(event, markets);

  return {
    available,
    generatedAt: new Date().toISOString(),
    source: 'weather-rules-context-v1',
    recognizedMarketCount: recognizedMarkets.length,
    markets: recognizedMarkets
  };
}
