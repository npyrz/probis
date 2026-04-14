import { startTransition, useEffect, useState } from 'react'
import { abortMonitoring, createTerminalSocket, fetchTerminalSnapshot, refreshPolymarketAccount, startMonitoring } from './lib/api'
import type { MonitorSession, MonitorSettings, PolymarketAccount, TerminalEvent, TerminalSnapshot } from './lib/types'

const defaultSettings: MonitorSettings = {
  edge_threshold: 0.05,
  exit_threshold: 0.01,
  order_size: 1,
  max_position: 3,
  take_profit: 0.08,
  stop_loss: 0.04,
  author_notes: 'Buy edge expansion, exit on reversal or risk triggers.',
}

const emptySnapshot: TerminalSnapshot = {
  markets: [],
  sessions: [],
  fills: [],
  logs: [],
  positions: {},
  account: {
    status: 'disconnected',
    configured: false,
    trading_ready: false,
    key_id_fingerprint: null,
    balance_usd: null,
    open_orders: 0,
    position_count: 0,
    error: null,
    updated_at: new Date(0).toISOString(),
  },
}

function formatProbability(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatSignedProbability(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return '--'
  }
  const sign = value >= 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(1)}%`
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return '--'
  }
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function compactLabel(value: string | null | undefined) {
  if (!value) {
    return '--'
  }
  return value.length > 22 ? `${value.slice(0, 22)}…` : value
}

function formatNullable(value: string | number | boolean | null | undefined) {
  if (value == null || value === '') {
    return '--'
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no'
  }
  return String(value)
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

function mergeSession(sessions: MonitorSession[], next: MonitorSession) {
  const existing = sessions.filter((session) => session.session_id !== next.session_id)
  return [next, ...existing].sort((left, right) => right.started_at.localeCompare(left.started_at))
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase()
}

function inferMarketType(category: string | null | undefined, title: string | null | undefined) {
  const haystack = `${category ?? ''} ${title ?? ''}`.toLowerCase()
  if (/nba|nfl|mlb|nhl|soccer|football|basketball|baseball|tennis|golf|fight|ufc|f1|formula 1/.test(haystack)) {
    return 'sports'
  }
  if (/election|president|senate|house|governor|democrat|republican|vote|policy|politic/.test(haystack)) {
    return 'politics'
  }
  if (/btc|bitcoin|eth|ethereum|solana|crypto|token|coin/.test(haystack)) {
    return 'crypto'
  }
  if (/fed|cpi|inflation|gdp|rates|recession|economy|tariff|jobs/.test(haystack)) {
    return 'macro'
  }
  if (/tesla|apple|nvidia|meta|google|microsoft|earnings|company|stock/.test(haystack)) {
    return 'companies'
  }
  if (/movie|oscar|music|tv|celebrity|show|album/.test(haystack)) {
    return 'culture'
  }
  if (/court|judge|trial|legal|scotus|law/.test(haystack)) {
    return 'legal'
  }
  if (/war|country|prime minister|president of|geopolitic|china|russia|ukraine|israel/.test(haystack)) {
    return 'world'
  }
  return 'general'
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function getMarketTypeLabel(market: TerminalSnapshot['markets'][number]) {
  return market.market_type ?? titleCase(inferMarketType(market.category, market.title))
}

function getDeskViewLabel(market: TerminalSnapshot['markets'][number]) {
  const category = (market.category || '').toLowerCase()
  if (category && category !== 'sports') {
    return titleCase(category)
  }
  return getMarketTypeLabel(market)
}

function App() {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot>(emptySnapshot)
  const [selectedMarketId, setSelectedMarketId] = useState<string>('')
  const [globalSearch, setGlobalSearch] = useState<string>('')
  const [deskFilter, setDeskFilter] = useState<string>('all')
  const [localSearch, setLocalSearch] = useState<string>('')
  const [settings, setSettings] = useState<MonitorSettings>(defaultSettings)
  const [connectionState, setConnectionState] = useState<'connecting' | 'live' | 'offline'>('connecting')
  const [operatorStatus, setOperatorStatus] = useState<string>('Booting terminal...')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)
  const [accountBusy, setAccountBusy] = useState<boolean>(false)

  useEffect(() => {
    let alive = true
    async function loadSnapshot() {
      try {
        const nextSnapshot = await fetchTerminalSnapshot()
        if (!alive) {
          return
        }
        setSnapshot(nextSnapshot)
        setOperatorStatus('Terminal synchronized with backend.')
      } catch (error) {
        if (!alive) {
          return
        }
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load terminal snapshot')
        setOperatorStatus('Backend unavailable.')
      }
    }

    loadSnapshot()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const socket = createTerminalSocket()

    socket.onopen = () => {
      setConnectionState('live')
      setOperatorStatus('Live event stream attached.')
    }

    socket.onclose = () => {
      setConnectionState('offline')
      setOperatorStatus('Event stream disconnected.')
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

  const globalQuery = normalizeSearch(globalSearch)
  const localQuery = normalizeSearch(localSearch)

  const deskViews = Array.from(new Set(snapshot.markets.map((market) => getDeskViewLabel(market)))).sort((left, right) => left.localeCompare(right))

  const globallyFilteredMarkets = snapshot.markets.filter((market) => {
    if (!globalQuery) {
      return true
    }
    const haystack = `${market.title} ${market.market} ${market.category} ${market.outcome}`.toLowerCase()
    return haystack.includes(globalQuery)
  })

  const scopedMarkets = globallyFilteredMarkets.filter((market) => {
    const deskMatch = deskFilter === 'all' || getDeskViewLabel(market) === deskFilter
    const localMatch = !localQuery || `${market.title} ${market.market} ${market.category}`.toLowerCase().includes(localQuery)
    return deskMatch && localMatch
  })

  useEffect(() => {
    const nextSelected = scopedMarkets.find((market) => market.market === selectedMarketId) ?? scopedMarkets[0] ?? globallyFilteredMarkets[0] ?? snapshot.markets[0] ?? null
    if (nextSelected && nextSelected.market !== selectedMarketId) {
      setSelectedMarketId(nextSelected.market)
    }
  }, [selectedMarketId, scopedMarkets, globallyFilteredMarkets, snapshot.markets])

  const selectedMarket = scopedMarkets.find((market) => market.market === selectedMarketId) ?? globallyFilteredMarkets.find((market) => market.market === selectedMarketId) ?? snapshot.markets.find((market) => market.market === selectedMarketId) ?? scopedMarkets[0] ?? globallyFilteredMarkets[0] ?? snapshot.markets[0] ?? null
  const account = snapshot.account

  const selectedSession = !selectedMarket?.session_id
    ? null
    : snapshot.sessions.find((session) => session.session_id === selectedMarket.session_id) ?? null

  const recentActivity = [...snapshot.fills.slice(0, 8).map((fill) => ({
      id: fill.order_id,
      ts: fill.ts,
      tone: fill.side === 'buy' ? 'positive' : 'negative',
      text: `${formatTimestamp(fill.ts)}  ${fill.side.toUpperCase()}  ${fill.market}  ${fill.size.toFixed(2)} @ ${fill.price.toFixed(3)}  (${fill.reason})`,
    })), ...snapshot.logs.slice(0, 10).map((log, index) => ({
      id: `${log.ts}-${index}`,
      ts: log.ts,
      tone: log.level === 'WARN' ? 'negative' : log.level === 'INFO' ? 'neutral' : 'positive',
      text: `${formatTimestamp(log.ts)}  ${log.level.padEnd(4, ' ')}  ${log.message}`,
    }))]
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, 14)

  const orderHistory = snapshot.fills.slice(0, 14)
  const activeSessions = snapshot.sessions.filter((session) => session.status === 'running')
  const inactiveSessions = snapshot.sessions.filter((session) => session.status !== 'running').slice(0, 8)

  async function handleStartMonitoring() {
    if (!selectedMarket) {
      return
    }

    setBusy(true)
    setErrorMessage('')
    try {
      await startMonitoring({
        market: selectedMarket.market,
        outcome: selectedMarket.outcome,
        settings,
      })
      setOperatorStatus(`Monitoring engaged for ${selectedMarket.title}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start monitoring')
    } finally {
      setBusy(false)
    }
  }

  async function handleAbort() {
    if (!selectedSession) {
      return
    }

    setBusy(true)
    setErrorMessage('')
    try {
      await abortMonitoring(selectedSession.session_id)
      setOperatorStatus(`Monitoring aborted for ${selectedSession.title}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to abort monitoring')
    } finally {
      setBusy(false)
    }
  }

  async function handleRefreshAccount() {
    setAccountBusy(true)
    setErrorMessage('')
    try {
      const response = await refreshPolymarketAccount()
      setSnapshot((current) => ({ ...current, account: response.account }))
      setOperatorStatus(`Polymarket account status: ${response.account.status}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to refresh Polymarket account')
    } finally {
      setAccountBusy(false)
    }
  }

  return (
    <main className="shell">
      <section className="hero-bar compact">
        <div className="hero-title-block">
          <p className="hero-kicker">PROBIS / OPERATOR TERMINAL</p>
          <h1>Market Desk</h1>
        </div>
        <label className="search-box search-box-global">
          <span>Search All Markets</span>
          <input
            type="search"
            value={globalSearch}
            onChange={(event) => setGlobalSearch(event.target.value)}
            placeholder="Search title, category, slug"
          />
        </label>
        <div className="hero-meta hero-meta-compact">
          <StatusPill label="Feed" value={connectionState} />
          <StatusPill label="Account" value={account.status} />
          <StatusPill label="Trading" value={account.trading_ready ? 'ready' : 'blocked'} />
          <StatusPill label="Engine" value="deterministic" />
        </div>
      </section>

      <section className="layout-grid">
        <section className="panel panel-markets">
          <div className="panel-header">
            <h2>Markets</h2>
            <span>{scopedMarkets.length} shown</span>
          </div>
          <div className="market-filters">
            <div className="market-filter-group">
              <div className="filter-header">
                <span>Views</span>
                <button className={`filter-chip ${deskFilter === 'all' ? 'active' : ''}`} onClick={() => setDeskFilter('all')} type="button">
                  All
                </button>
              </div>
              <div className="chip-list">
                {deskViews.map((view) => (
                  <button
                    className={`filter-chip ${deskFilter === view ? 'active' : ''}`}
                    key={view}
                    onClick={() => setDeskFilter(view)}
                    type="button"
                  >
                    {view}
                  </button>
                ))}
              </div>
            </div>
            <label className="search-box search-box-local">
              <span>Search In Selection</span>
              <input
                type="search"
                value={localSearch}
                onChange={(event) => setLocalSearch(event.target.value)}
                placeholder="Filter inside chosen view"
              />
            </label>
          </div>
          <div className="market-list">
            {scopedMarkets.map((market) => {
              const selected = selectedMarket?.market === market.market
              return (
                <button
                  className={`market-row ${selected ? 'selected' : ''}`}
                  key={market.market}
                  onClick={() => setSelectedMarketId(market.market)}
                  type="button"
                >
                  <div className="market-row-top">
                    <span className="market-category">{compactLabel(market.category)}</span>
                    <span className={`market-flag ${market.monitored ? 'live' : ''}`}>
                      {market.monitored ? 'LIVE' : 'IDLE'}
                    </span>
                  </div>
                  <strong>{compactLabel(market.title)}</strong>
                  <div className="market-stats-row">
                    <span>PX {formatProbability(market.last_price)}</span>
                    <span>BID {formatProbability(market.best_bid)}</span>
                    <span>ASK {formatProbability(market.best_ask)}</span>
                  </div>
                  <div className="market-stats-row">
                    <span>MODEL {formatProbability(market.model_probability)}</span>
                    <span className={market.edge >= 0 ? 'tone-positive' : 'tone-negative'}>
                      EDGE {formatSignedProbability(market.edge)}
                    </span>
                  </div>
                </button>
              )
            })}
            {scopedMarkets.length === 0 ? <p className="empty-state">No markets match the current subject, type, and search filters.</p> : null}
          </div>
        </section>

        <section className="panel panel-focus">
          <div className="panel-header">
            <h2>Control</h2>
            <span>{selectedSession?.status ?? 'ready'}</span>
          </div>
          {selectedMarket ? (
            <>
              <div className="focus-card focus-card-tight">
                <div>
                  <p className="focus-label">Selected Market</p>
                  <h3>{selectedMarket.title}</h3>
                  <p className="focus-subtitle">{selectedMarket.category} / {selectedMarket.outcome} / {selectedMarket.venue}</p>
                </div>
                <div className="focus-metrics">
                  <MetricCard label="Market" value={formatProbability(selectedMarket.last_price)} />
                  <MetricCard label="Bid" value={formatProbability(selectedMarket.best_bid)} />
                  <MetricCard label="Ask" value={formatProbability(selectedMarket.best_ask)} />
                  <MetricCard label="Model" value={formatProbability(selectedMarket.model_probability)} />
                  <MetricCard label="Edge" value={formatSignedProbability(selectedMarket.edge)} tone={selectedMarket.edge >= 0 ? 'positive' : 'negative'} />
                  <MetricCard label="Last" value={formatProbability(selectedMarket.last_trade_price)} />
                  <MetricCard label="Position" value={selectedMarket.position.toFixed(2)} />
                  <MetricCard label="Ends" value={selectedMarket.end_date ? selectedMarket.end_date.slice(0, 10) : '--'} />
                </div>
              </div>

              <div className="form-grid">
                <NumberField
                  label="Entry Edge"
                  step="0.01"
                  value={settings.edge_threshold}
                  onChange={(value) => setSettings((current) => ({ ...current, edge_threshold: value }))}
                />
                <NumberField
                  label="Exit Edge"
                  step="0.01"
                  value={settings.exit_threshold}
                  onChange={(value) => setSettings((current) => ({ ...current, exit_threshold: value }))}
                />
                <NumberField
                  label="Order Size"
                  step="0.25"
                  value={settings.order_size}
                  onChange={(value) => setSettings((current) => ({ ...current, order_size: value }))}
                />
                <NumberField
                  label="Max Position"
                  step="0.5"
                  value={settings.max_position}
                  onChange={(value) => setSettings((current) => ({ ...current, max_position: value }))}
                />
                <NumberField
                  label="Take Profit"
                  step="0.01"
                  value={settings.take_profit}
                  onChange={(value) => setSettings((current) => ({ ...current, take_profit: value }))}
                />
                <NumberField
                  label="Stop Loss"
                  step="0.01"
                  value={settings.stop_loss}
                  onChange={(value) => setSettings((current) => ({ ...current, stop_loss: value }))}
                />
              </div>

              <label className="notes-field">
                <span>Author Notes</span>
                <textarea
                  value={settings.author_notes}
                  onChange={(event) => setSettings((current) => ({ ...current, author_notes: event.target.value }))}
                  rows={4}
                />
              </label>

              <div className="action-bar">
                <button className="action-primary" disabled={busy || !!selectedSession} onClick={handleStartMonitoring} type="button">
                  Engage Monitor
                </button>
                <button className="action-secondary" disabled={busy || !selectedSession} onClick={handleAbort} type="button">
                  Abort Session
                </button>
                <p className="operator-status">{operatorStatus}</p>
              </div>
              {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
            </>
          ) : (
            <p className="empty-state">No markets available yet. Start the backend to populate the terminal.</p>
          )}
        </section>

        <section className="panel panel-account">
          <div className="panel-header">
            <h2>Account</h2>
            <span>updated {formatTimestamp(account.updated_at)}</span>
          </div>
          <div className="account-panel-body">
            <div className="account-grid">
              <MetricCard label="Status" value={account.status} tone={account.status === 'connected' ? 'positive' : account.status === 'error' ? 'negative' : 'neutral'} />
              <MetricCard label="Trading" value={account.trading_ready ? 'ready' : 'blocked'} tone={account.trading_ready ? 'positive' : 'negative'} />
              <MetricCard label="Balance" value={formatMoney(account.balance_usd)} />
              <MetricCard label="Open Orders" value={String(account.open_orders)} />
              <MetricCard label="Positions" value={String(account.position_count)} />
              <MetricCard label="Key ID" value={account.key_id_fingerprint ?? '--'} />
            </div>
            <div className="account-actions-row">
              <button className="action-primary" disabled={accountBusy} onClick={handleRefreshAccount} type="button">
                Refresh Account
              </button>
              <p className="operator-status">{account.error ?? 'Account data is fetched server-side through the Polymarket US SDK.'}</p>
            </div>
          </div>
        </section>

        <section className="panel panel-sessions">
          <div className="panel-header">
            <h2>Sessions</h2>
            <span>{snapshot.sessions.length} tracked</span>
          </div>
          <div className="session-list compact-list">
            {snapshot.sessions.length === 0 ? (
              <p className="empty-state">No sessions yet.</p>
            ) : (
              [...activeSessions, ...inactiveSessions].map((session) => (
                <article className="session-card" key={session.session_id}>
                  <div className="session-card-top">
                    <strong>{compactLabel(session.title)}</strong>
                    <span className={`market-flag ${session.status === 'running' ? 'live' : ''}`}>{session.status}</span>
                  </div>
                  <p>{session.last_action}</p>
                  <div className="session-card-meta">
                    <span>{formatTimestamp(session.started_at)}</span>
                    <span>{session.last_price == null ? '--' : session.last_price.toFixed(3)}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="panel panel-orders">
          <div className="panel-header">
            <h2>Order History</h2>
            <span>{orderHistory.length} recent fills</span>
          </div>
          <div className="orders-table-wrap">
            {orderHistory.length === 0 ? (
              <p className="empty-state">No orders filled yet.</p>
            ) : (
              <table className="orders-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Side</th>
                    <th>Market</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {orderHistory.map((fill) => (
                    <tr key={fill.order_id}>
                      <td>{formatTimestamp(fill.ts)}</td>
                      <td className={fill.side === 'buy' ? 'tone-positive' : 'tone-negative'}>{fill.side.toUpperCase()}</td>
                      <td>{compactLabel(fill.market)}</td>
                      <td>{fill.size.toFixed(2)}</td>
                      <td>{fill.price.toFixed(3)}</td>
                      <td>{fill.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="panel panel-activity">
          <div className="panel-header">
            <h2>Tape</h2>
            <span>fills + logs</span>
          </div>
          <div className="tape-list">
            {recentActivity.length === 0 ? (
              <p className="empty-state">No fills or logs yet.</p>
            ) : (
              recentActivity.map((entry) => (
                <div className={`tape-line ${entry.tone}`} key={entry.id}>
                  {entry.text}
                </div>
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  )
}

function applyTerminalEvent(current: TerminalSnapshot, event: TerminalEvent): TerminalSnapshot {
  if (event.type === 'snapshot') {
    return {
      markets: event.markets,
      sessions: event.sessions,
      fills: event.fills,
      logs: event.logs,
      positions: event.positions,
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

  if (event.type === 'fill') {
    return {
      ...current,
      fills: [event, ...current.fills].slice(0, 100),
      markets: current.markets.map((market) =>
        market.market === event.market && market.outcome === event.outcome
          ? { ...market, position: event.position ?? market.position, session_id: event.session_id }
          : market,
      ),
    }
  }

  if (event.type === 'log') {
    return {
      ...current,
      logs: [event, ...current.logs].slice(0, 200),
    }
  }

  return {
    ...current,
    sessions: mergeSession(current.sessions, event.session),
    markets: current.markets.map((market) =>
      market.market === event.session.market && market.outcome === event.session.outcome
        ? {
            ...market,
            monitored: event.session.status === 'running',
            session_id: event.session.status === 'running' ? event.session.session_id : null,
          }
        : market,
    ),
  }
}

function MetricCard({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'positive' | 'negative' | 'neutral' }) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function NumberField({ label, value, onChange, step }: { label: string; value: number; onChange: (value: number) => void; step: string }) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input type="number" value={value} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export default App
