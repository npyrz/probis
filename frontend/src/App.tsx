import { startTransition, useEffect, useMemo, useState } from 'react'
import { createTerminalSocket, fetchTerminalSnapshot, refreshPolymarketAccount } from './lib/api'
import type { Market, PolymarketAccount, TerminalEvent, TerminalSnapshot } from './lib/types'

const emptyAccount: PolymarketAccount = {
  status: 'disconnected',
  configured: false,
  trading_ready: false,
  key_id_fingerprint: null,
  balance_usd: null,
  open_orders: 0,
  position_count: 0,
  error: null,
  updated_at: new Date(0).toISOString(),
}

const emptySnapshot: TerminalSnapshot = {
  markets: [],
  account: emptyAccount,
}

function formatPrice(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return '--'
  }
  return `$${value.toFixed(3)}`
}

function formatProbability(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return '--'
  }
  return new Date(value).toLocaleString()
}

function formatMoney(value: string | number | null | undefined) {
  if (value == null || value === '') {
    return '--'
  }
  const numeric = Number(value)
  if (Number.isNaN(numeric)) {
    return String(value)
  }
  return `$${numeric.toFixed(2)}`
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase()
}

function titleCase(value: string) {
  if (!value) {
    return value
  }
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function getLoginLabel(account: PolymarketAccount) {
  if (account.configured) {
    return 'logged in via .env'
  }
  return 'not logged in'
}

function getConnectionLabel(account: PolymarketAccount) {
  if (account.status === 'connected') {
    return 'connected'
  }
  if (account.status === 'error') {
    return 'credentials rejected'
  }
  if (account.configured) {
    return 'credentials loaded'
  }
  return 'awaiting credentials'
}

function outcomeEntries(market: Market) {
  const labels = market.outcomes.length > 0 ? market.outcomes : ['Yes']
  return labels.map((label, index) => ({
    label,
    price: market.outcome_prices[index] ?? null,
  }))
}

function App() {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot>(emptySnapshot)
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [selectedType, setSelectedType] = useState('all')
  const [selectedMarketId, setSelectedMarketId] = useState('')
  const [statusText, setStatusText] = useState('Loading Polymarket markets...')
  const [errorMessage, setErrorMessage] = useState('')
  const [connectionState, setConnectionState] = useState<'connecting' | 'live' | 'offline'>('connecting')
  const [refreshingAccount, setRefreshingAccount] = useState(false)

  useEffect(() => {
    let active = true

    async function loadSnapshot() {
      try {
        const nextSnapshot = await fetchTerminalSnapshot()
        if (!active) {
          return
        }
        setSnapshot(nextSnapshot)
        setStatusText(`Loaded ${nextSnapshot.markets.length} live Polymarket markets.`)
      } catch (error) {
        if (!active) {
          return
        }
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load market catalog')
        setStatusText('Backend unavailable.')
      }
    }

    loadSnapshot()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const socket = createTerminalSocket()

    socket.onopen = () => {
      setConnectionState('live')
      setStatusText('Live market updates connected.')
    }

    socket.onclose = () => {
      setConnectionState('offline')
      setStatusText('Live market updates disconnected.')
    }

    socket.onerror = () => {
      setConnectionState('offline')
    }

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TerminalEvent
      startTransition(() => {
        setSnapshot((current) => applyTerminalEvent(current, payload))
      })
    }

    return () => {
      socket.close()
    }
  }, [])

  const query = normalizeSearch(search)
  const categoryOptions = useMemo(() => {
    return Array.from(new Set(snapshot.markets.map((market) => String(market.category || '').toLowerCase()).filter(Boolean))).sort()
  }, [snapshot.markets])

  const typeOptions = useMemo(() => {
    return Array.from(new Set(snapshot.markets.map((market) => market.market_type?.trim()).filter(Boolean) as string[])).sort((left, right) => left.localeCompare(right))
  }, [snapshot.markets])

  const filteredMarkets = useMemo(() => {
    return snapshot.markets.filter((market) => {
      const categoryMatch = selectedCategory === 'all' || String(market.category || '').toLowerCase() === selectedCategory
      const typeMatch = selectedType === 'all' || (market.market_type ?? '') === selectedType
      if (!categoryMatch || !typeMatch) {
        return false
      }
      if (!query) {
        return true
      }
      const haystack = [
        market.title,
        market.category,
        market.market,
        market.subtitle,
        market.description,
        market.market_type,
        ...market.outcomes,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }, [snapshot.markets, query, selectedCategory, selectedType])

  useEffect(() => {
    const candidate = filteredMarkets[0]?.market ?? snapshot.markets[0]?.market ?? ''
    if (!selectedMarketId || !filteredMarkets.some((market) => market.market === selectedMarketId)) {
      setSelectedMarketId(candidate)
    }
  }, [filteredMarkets, selectedMarketId, snapshot.markets])

  const selectedMarket = filteredMarkets.find((market) => market.market === selectedMarketId)
    ?? snapshot.markets.find((market) => market.market === selectedMarketId)
    ?? filteredMarkets[0]
    ?? snapshot.markets[0]
    ?? null

  async function handleRefreshAccount() {
    setRefreshingAccount(true)
    setErrorMessage('')
    try {
      const response = await refreshPolymarketAccount()
      setSnapshot((current) => ({ ...current, account: response.account }))
      setStatusText(`Account refresh complete: ${response.account.status}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to refresh account')
    } finally {
      setRefreshingAccount(false)
    }
  }

  const loginLabel = getLoginLabel(snapshot.account)
  const connectionLabel = getConnectionLabel(snapshot.account)
  const selectedOutcomes = selectedMarket ? outcomeEntries(selectedMarket) : []

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Probis / frontend terminal</p>
          <h1>Polymarket trade browser</h1>
          <p className="subhead">Browse live markets, confirm your backend account state, and click any market to inspect prices and contract details.</p>
        </div>
        <div className="status-grid">
          <StatusCard label="Login" value={loginLabel} tone={snapshot.account.configured ? 'positive' : 'neutral'} />
          <StatusCard label="Account" value={connectionLabel} tone={snapshot.account.status === 'error' ? 'negative' : snapshot.account.status === 'connected' ? 'positive' : 'neutral'} />
          <StatusCard label="Feed" value={connectionState} tone={connectionState === 'live' ? 'positive' : 'negative'} />
          <StatusCard label="Markets" value={String(filteredMarkets.length)} tone="neutral" />
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="panel list-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Available trades</p>
              <h2>All active markets</h2>
            </div>
            <span>{snapshot.markets.length} total</span>
          </div>

          <label className="search-box">
            <span>Search</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search market, category, slug, or outcome"
            />
          </label>

          <div className="filter-stack">
            <div className="chip-group">
              <span className="chip-group-label">Categories</span>
              <div className="chip-row">
                <button className={`filter-chip ${selectedCategory === 'all' ? 'active' : ''}`} onClick={() => setSelectedCategory('all')} type="button">
                  All
                </button>
                {categoryOptions.map((category) => (
                  <button
                    className={`filter-chip ${selectedCategory === category ? 'active' : ''}`}
                    key={category}
                    onClick={() => setSelectedCategory(category)}
                    type="button"
                  >
                    {titleCase(category)}
                  </button>
                ))}
              </div>
            </div>

            <div className="chip-group">
              <span className="chip-group-label">Sports / Types</span>
              <div className="chip-row">
                <button className={`filter-chip ${selectedType === 'all' ? 'active' : ''}`} onClick={() => setSelectedType('all')} type="button">
                  All
                </button>
                {typeOptions.map((type) => (
                  <button
                    className={`filter-chip ${selectedType === type ? 'active' : ''}`}
                    key={type}
                    onClick={() => setSelectedType(type)}
                    type="button"
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="market-list">
            {filteredMarkets.map((market) => {
              const selected = selectedMarket?.market === market.market
              return (
                <button
                  className={`market-card ${selected ? 'selected' : ''}`}
                  key={market.market}
                  onClick={() => setSelectedMarketId(market.market)}
                  type="button"
                >
                  <div className="market-card-header">
                    <span>{market.category}</span>
                    <span>{market.market_type ?? market.venue}</span>
                  </div>
                  <strong>{market.title}</strong>
                  <p>{market.subtitle || market.market}</p>
                  <div className="market-prices">
                    <Metric label="Last" value={formatProbability(market.last_price)} />
                    <Metric label="Bid" value={formatProbability(market.best_bid)} />
                    <Metric label="Ask" value={formatProbability(market.best_ask)} />
                  </div>
                </button>
              )
            })}
            {filteredMarkets.length === 0 ? <p className="empty-state">No markets matched the current search.</p> : null}
          </div>
        </aside>

        <section className="panel detail-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Selected trade</p>
              <h2>{selectedMarket?.title ?? 'No market selected'}</h2>
            </div>
            <button className="secondary-button" disabled={refreshingAccount} onClick={handleRefreshAccount} type="button">
              {refreshingAccount ? 'Refreshing...' : 'Refresh account'}
            </button>
          </div>

          {selectedMarket ? (
            <div className="detail-layout">
              <section className="hero-card">
                <div className="hero-copy">
                  <p className="eyebrow">{selectedMarket.category}</p>
                  <h3>{selectedMarket.title}</h3>
                  <p>{selectedMarket.description || selectedMarket.subtitle || 'No extra market description was provided by the API.'}</p>
                </div>
                <div className="hero-meta-grid">
                  <StatusCard label="Last price" value={formatProbability(selectedMarket.last_price)} tone="neutral" />
                  <StatusCard label="Best bid" value={formatProbability(selectedMarket.best_bid)} tone="neutral" />
                  <StatusCard label="Best ask" value={formatProbability(selectedMarket.best_ask)} tone="neutral" />
                  <StatusCard label="Last trade" value={formatProbability(selectedMarket.last_trade_price)} tone="neutral" />
                </div>
              </section>

              <section className="split-grid">
                <article className="detail-card">
                  <p className="eyebrow">Trade details</p>
                  <DetailRow label="Slug" value={selectedMarket.market} />
                  <DetailRow label="Venue" value={selectedMarket.venue} />
                  <DetailRow label="Type" value={selectedMarket.market_type ?? '--'} />
                  <DetailRow label="Start date" value={formatDate(selectedMarket.start_date)} />
                  <DetailRow label="End date" value={formatDate(selectedMarket.end_date)} />
                  <DetailRow label="Updated" value={formatDate(selectedMarket.updated_at)} />
                  <DetailRow label="Min tick" value={formatPrice(selectedMarket.min_tick_size)} />
                  <DetailRow label="Reference" value={formatProbability(selectedMarket.reference_price)} />
                  <DetailRow label="Status" value={selectedMarket.closed ? 'closed' : selectedMarket.active ? 'active' : 'inactive'} />
                </article>

                <article className="detail-card">
                  <p className="eyebrow">Outcome prices</p>
                  <div className="outcome-list">
                    {selectedOutcomes.map((entry) => (
                      <div className="outcome-row" key={entry.label}>
                        <span>{entry.label}</span>
                        <strong>{formatProbability(entry.price)}</strong>
                      </div>
                    ))}
                  </div>
                </article>
              </section>

              <section className="split-grid">
                <article className="detail-card">
                  <p className="eyebrow">Backend account</p>
                  <DetailRow label="Logged in" value={loginLabel} />
                  <DetailRow label="Connection" value={connectionLabel} />
                  <DetailRow label="Trading ready" value={snapshot.account.trading_ready ? 'yes' : 'no'} />
                  <DetailRow label="Balance" value={formatMoney(snapshot.account.balance_usd)} />
                  <DetailRow label="Open orders" value={String(snapshot.account.open_orders)} />
                  <DetailRow label="Positions" value={String(snapshot.account.position_count)} />
                  <DetailRow label="Key fingerprint" value={snapshot.account.key_id_fingerprint ?? '--'} />
                </article>

                <article className="detail-card terminal-card">
                  <p className="eyebrow">Terminal</p>
                  <p className="terminal-line">{statusText}</p>
                  <p className="terminal-line muted">{snapshot.account.error ?? 'Account credentials are read only on the backend from .env.'}</p>
                  {errorMessage ? <p className="terminal-line error">{errorMessage}</p> : null}
                </article>
              </section>
            </div>
          ) : (
            <div className="empty-detail">
              <p>No market data is available yet. Start the backend and wait for the Polymarket catalog to load.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  )
}

function applyTerminalEvent(current: TerminalSnapshot, event: TerminalEvent): TerminalSnapshot {
  if (event.type === 'snapshot') {
    return {
      markets: event.markets,
      account: event.account,
    }
  }

  if (event.type === 'account') {
    return {
      ...current,
      account: event.account,
    }
  }

  if (event.type === 'market') {
    return {
      ...current,
      markets: current.markets.map((market) =>
        market.market === event.market && market.outcome === event.outcome
          ? {
              ...market,
              last_price: event.market_probability,
              model_probability: event.your_probability,
              edge: event.edge,
              position: event.position,
              monitored: event.session_id !== null,
              session_id: event.session_id,
            }
          : market,
      ),
    }
  }

  return current
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: 'positive' | 'negative' | 'neutral' }) {
  return (
    <article className={`status-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export default App
