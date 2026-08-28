import { useEffect, useMemo, useState } from 'react';

import { fetchMarketCatalog, fetchMarketFamilies } from '../../lib/api.js';

const DEFAULT_LIMIT = 100;

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : '—';
}

function formatCloseTime(value) {
  const parsed = Date.parse(String(value ?? ''));

  if (!Number.isFinite(parsed)) {
    return '—';
  }

  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatPrice(outcome) {
  return typeof outcome?.price === 'number'
    ? `${Math.round(outcome.price * 100)}%`
    : '—';
}

// A market whose family has no model is still first-class here — it just shows no
// fair-value panel. That is what lets the terminal cover every market on day one.
function FamilyChip({ familyId }) {
  return familyId
    ? <span className="chip chip-good">{familyId}</span>
    : <span className="chip chip-muted">unmodeled</span>;
}

export default function MarketExplorer({ onClose }) {
  const [catalog, setCatalog] = useState(null);
  const [families, setFamilies] = useState([]);
  const [familyFilter, setFamilyFilter] = useState('');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  async function load(options = {}) {
    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchMarketCatalog({ limit: DEFAULT_LIMIT, ...options });
      setCatalog(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load the market catalog');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void load();
    fetchMarketFamilies().then(setFamilies).catch(() => setFamilies([]));
  }, []);

  const markets = useMemo(() => catalog?.markets ?? [], [catalog]);
  const selected = useMemo(
    () => markets.find((market) => market.id === selectedId) ?? null,
    [markets, selectedId]
  );

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="market-explorer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="market-explorer-title"
      >
        <div className="market-explorer-header">
          <div>
            <p className="eyebrow">Polymarket US · read-only</p>
            <h2 id="market-explorer-title">All Markets</h2>
          </div>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="market-explorer-controls">
          <input
            type="search"
            className="market-explorer-search"
            placeholder="Filter by title or slug"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void load({ family: familyFilter || undefined, search: search || undefined });
              }
            }}
          />
          <select
            className="market-explorer-select"
            value={familyFilter}
            onChange={(event) => {
              setFamilyFilter(event.target.value);
              void load({ family: event.target.value || undefined, search: search || undefined });
            }}
          >
            <option value="">All families</option>
            {families.map((family) => (
              <option key={family.id} value={family.id}>{family.name}</option>
            ))}
            <option value="unmodeled">Unmodeled</option>
          </select>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void load({ family: familyFilter || undefined, search: search || undefined })}
            disabled={isLoading}
          >
            {isLoading ? 'Loading' : 'Refresh'}
          </button>
        </div>

        {error ? <p className="trade-error">{error}</p> : null}

        {catalog ? (
          <p className="timestamp">
            {formatNumber(catalog.marketCount)} open markets across {formatNumber(catalog.eventCount)} events
            {catalog.byFamily
              ? ` · ${Object.entries(catalog.byFamily).map(([key, count]) => `${key}: ${count}`).join(' · ')}`
              : null}
          </p>
        ) : null}

        <div className="table-scroll market-explorer-table">
          <table className="rank-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Family</th>
                <th>Outcomes</th>
                <th>Volume</th>
                <th>Closes</th>
              </tr>
            </thead>
            <tbody>
              {markets.length === 0 && !isLoading ? (
                <tr>
                  <td colSpan={5}><span className="empty-copy">No open markets returned.</span></td>
                </tr>
              ) : null}
              {markets.map((market) => (
                <tr
                  key={market.id ?? market.marketSlug}
                  onClick={() => setSelectedId(market.id)}
                  className={selectedId === market.id ? 'is-selected' : undefined}
                >
                  <td>
                    <span className="market-title">{market.title || market.marketSlug}</span>
                    {market.outcomeKey ? <span className="chip chip-muted">{market.outcomeKey}</span> : null}
                    <span className="market-slug">{market.eventSlug}</span>
                  </td>
                  <td><FamilyChip familyId={market.familyId} /></td>
                  <td>
                    {market.outcomes.slice(0, 3).map((outcome) => (
                      <span key={outcome.label} className="quote-row">
                        {outcome.label} {formatPrice(outcome)}
                      </span>
                    ))}
                  </td>
                  <td>{formatNumber(market.volume)}</td>
                  <td>{formatCloseTime(market.closeTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected ? (
          <div className="panel market-explorer-detail">
            <p className="section-heading">{selected.title}</p>
            <ul className="detail-list">
              <li><span>Market slug</span><span>{selected.marketSlug ?? '—'}</span></li>
              <li><span>Event</span><span>{selected.eventTitle || '—'}</span></li>
              <li><span>Category</span><span>{selected.category ?? '—'}</span></li>
              <li><span>Family</span><span>{selected.familyId ?? 'unmodeled'}</span></li>
              <li><span>Closes</span><span>{formatCloseTime(selected.closeTime)}</span></li>
              <li><span>Resolution source</span><span>{selected.resolutionSource ?? '—'}</span></li>
              <li><span>Rules hash</span><span>{selected.rulesTextHash ? `${selected.rulesTextHash.slice(0, 12)}…` : '—'}</span></li>
            </ul>
            {selected.familyId ? null : (
              <p className="empty-copy">
                No family model covers this market yet, so there is no fair-value or edge panel.
                Quotes, rules, and metadata are still shown.
              </p>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
