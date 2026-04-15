import { useEffect, useState, useTransition } from 'react';

import { analyzeEvent, fetchActiveEvents, fetchStatus, resolveEvent } from './lib/api.js';

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return `${(value * 100).toFixed(1)}%`;
}

function marketHasLivePrices(market) {
  return market.outcomes.some((outcome) => typeof outcome.probability === 'number');
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [activeEvents, setActiveEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [eventInput, setEventInput] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let isCancelled = false;

    async function loadInitialData() {
      try {
        const [nextStatus, nextEvents] = await Promise.all([fetchStatus(), fetchActiveEvents(5)]);

        if (isCancelled) {
          return;
        }

        setStatus(nextStatus);
        setActiveEvents(nextEvents);
      } catch (loadError) {
        if (!isCancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load initial data');
        }
      }
    }

    loadInitialData();

    return () => {
      isCancelled = true;
    };
  }, []);

  async function handleResolveEvent(submittedInput) {
    setError('');
    setAnalysis('');

    try {
      const event = await resolveEvent(submittedInput);
      setSelectedEvent(event);
      setEventInput(submittedInput);
    } catch (resolveError) {
      setSelectedEvent(null);
      setError(resolveError instanceof Error ? resolveError.message : 'Unable to resolve event');
    }
  }

  function handleSubmit(formEvent) {
    formEvent.preventDefault();

    if (!eventInput.trim()) {
      setError('Paste a Polymarket event URL or slug.');
      return;
    }

    startTransition(() => {
      void handleResolveEvent(eventInput.trim());
    });
  }

  function handleUseEvent(slug) {
    startTransition(() => {
      void handleResolveEvent(slug);
    });
  }

  function handleAnalyze() {
    if (!selectedEvent?.slug) {
      return;
    }

    setError('');

    startTransition(async () => {
      try {
        const result = await analyzeEvent(selectedEvent.slug);
        setAnalysis(result.analysis);
      } catch (analysisError) {
        setError(analysisError instanceof Error ? analysisError.message : 'Unable to run AI analysis');
      }
    });
  }

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Steps 2 and 3 live</p>
          <h1>Resolve a Polymarket event URL and inspect every outcome.</h1>
          <p className="lede">
            The app now loads active Polymarket events from Gamma, resolves a specific event by URL or slug,
            and can run a local Ollama smoke test against the selected event.
          </p>
        </div>

        <div className="status-grid">
          <article>
            <span>Polymarket Read API</span>
            <strong>{status?.polymarket?.publicReadOk ? 'Reachable' : 'Checking...'}</strong>
            <p>
              {status?.polymarket?.auth?.privateKeyValid
                ? 'Private key parses for CLOB auth checks.'
                : 'Gamma reads work even when CLOB auth is not ready.'}
            </p>
          </article>
          <article>
            <span>Ollama</span>
            <strong>{status?.ai?.reachable ? status.ai.resolvedModel ?? 'Reachable' : 'Unavailable'}</strong>
            <p>Requested model: {status?.ai?.requestedModel ?? 'n/a'}</p>
          </article>
          <article>
            <span>Event Input</span>
            <strong>{selectedEvent ? selectedEvent.slug : 'Waiting for lookup'}</strong>
            <p>Paste a full Polymarket event URL or just the slug.</p>
          </article>
        </div>
      </section>

      <section className="control-card">
        <form className="event-form" onSubmit={handleSubmit}>
          <label htmlFor="event-input">Event URL or slug</label>
          <div className="input-row">
            <input
              id="event-input"
              name="event-input"
              type="text"
              placeholder="https://polymarket.com/event/..."
              value={eventInput}
              onChange={(inputEvent) => setEventInput(inputEvent.target.value)}
            />
            <button type="submit" disabled={isPending}>
              {isPending ? 'Loading...' : 'Resolve Event'}
            </button>
          </div>
        </form>

        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="content-grid">
        <article className="panel-card">
          <div className="panel-heading">
            <p className="eyebrow">Step 2</p>
            <h2>High-volume active events</h2>
          </div>
          <div className="event-list">
            {activeEvents.map((event) => (
              <button key={event.slug} className="event-list-item" onClick={() => handleUseEvent(event.slug)}>
                <strong>{event.title}</strong>
                <span>{event.markets.length} markets</span>
              </button>
            ))}
          </div>
        </article>

        <article className="panel-card panel-card-wide">
          <div className="panel-heading panel-heading-inline">
            <div>
              <p className="eyebrow">Step 3</p>
              <h2>{selectedEvent ? selectedEvent.title : 'Resolve an event to inspect its markets'}</h2>
            </div>
            <button type="button" className="secondary-button" onClick={handleAnalyze} disabled={!selectedEvent || isPending}>
              Test AI on Event
            </button>
          </div>

          {selectedEvent ? (
            <>
              <p className="event-meta">
                slug: {selectedEvent.slug} · {selectedEvent.markets.length} markets
              </p>
              <div className="market-grid">
                {selectedEvent.markets.map((market) => (
                  <section key={market.conditionId ?? market.question} className="market-card">
                    {!marketHasLivePrices(market) ? (
                      <p className="market-status market-status-unavailable">Not live on Polymarket</p>
                    ) : null}
                    <h3>{market.question}</h3>
                    <div className="outcome-list">
                      {market.outcomes.map((outcome) => (
                        <div key={`${market.conditionId}-${outcome.label}`} className="outcome-row">
                          <span>{outcome.label}</span>
                          <strong>{formatPercent(outcome.probability)}</strong>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <p className="empty-state">No event loaded yet.</p>
          )}

          {analysis ? (
            <section className="analysis-card">
              <p className="eyebrow">AI Smoke Test</p>
              <pre>{analysis}</pre>
            </section>
          ) : null}
        </article>
      </section>
    </main>
  );
}