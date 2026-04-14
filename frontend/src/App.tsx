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
    address: null,
    funder_address: null,
    signature_type: null,
    signature_type_label: null,
    chain_id: null,
    host: null,
    api_key_present: false,
    api_key_fingerprint: null,
    collateral_balance: null,
    collateral_allowance: null,
    open_orders: 0,
    closed_only_mode: null,
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

function mergeSession(sessions: MonitorSession[], next: MonitorSession) {
  const existing = sessions.filter((session) => session.session_id !== next.session_id)
  return [next, ...existing].sort((left, right) => right.started_at.localeCompare(left.started_at))
}

function App() {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot>(emptySnapshot)
  const [selectedMarketId, setSelectedMarketId] = useState<string>('')
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

  useEffect(() => {
    if (!selectedMarketId && snapshot.markets[0]) {
      setSelectedMarketId(snapshot.markets[0].market)
    }
  }, [selectedMarketId, snapshot.markets])

  const selectedMarket = snapshot.markets.find((market) => market.market === selectedMarketId) ?? snapshot.markets[0] ?? null
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
      <section className="hero-bar">
        <div>
          <p className="hero-kicker">PROBIS / OPERATOR TERMINAL</p>
          <h1>Prediction Market Command Deck</h1>
          <p className="hero-copy">
            Deterministic execution, event-driven monitoring, and author-controlled thresholds.
          </p>
        </div>
        <div className="hero-meta">
          <StatusPill label="Feed" value={connectionState} />
          <StatusPill label="Account" value={account.status} />
          <StatusPill label="Mode" value="live polymarket" />
          <StatusPill label="Engine" value="deterministic" />
        </div>
      </section>

      <section className="account-ribbon">
        <div className="account-ribbon-copy">
          <p className="hero-kicker">POLYMARKET ACCOUNT</p>
          <strong>{account.address ?? 'Server-side account not configured'}</strong>
          <p className="account-ribbon-subtitle">
            {account.error ?? 'Authenticated CLOB status is managed entirely by the backend.'}
          </p>
        </div>
        <div className="account-ribbon-metrics">
          <MetricCard label="Status" value={account.status} tone={account.status === 'connected' ? 'positive' : account.status === 'error' ? 'negative' : 'neutral'} />
          <MetricCard label="Trading" value={account.trading_ready ? 'ready' : 'not ready'} tone={account.trading_ready ? 'positive' : 'negative'} />
          <MetricCard label="USDC Bal" value={formatNullable(account.collateral_balance)} />
          <MetricCard label="Allowance" value={formatNullable(account.collateral_allowance)} />
          <MetricCard label="Orders" value={String(account.open_orders)} />
          <MetricCard label="API Key" value={account.api_key_fingerprint ?? (account.api_key_present ? 'loaded' : '--')} />
        </div>
        <div className="account-ribbon-actions">
          <button className="action-primary" disabled={accountBusy} onClick={handleRefreshAccount} type="button">
            Refresh Account
          </button>
          <p className="operator-status">Updated {formatTimestamp(account.updated_at)}</p>
        </div>
      </section>

      <section className="layout-grid">
        <section className="panel panel-markets">
          <div className="panel-header">
            <h2>Market Scope</h2>
            <span>{snapshot.markets.length} instruments</span>
          </div>
          <div className="market-list">
            {snapshot.markets.map((market) => {
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
                  <strong>{market.title}</strong>
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
          </div>
        </section>

        <section className="panel panel-focus">
          <div className="panel-header">
            <h2>Session Control</h2>
            <span>{selectedSession?.status ?? 'ready'}</span>
          </div>
          {selectedMarket ? (
            <>
              <div className="focus-card">
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

        <section className="panel panel-sessions">
          <div className="panel-header">
            <h2>Live Sessions</h2>
            <span>{snapshot.sessions.length} tracked</span>
          </div>
          <div className="session-list">
            {snapshot.sessions.length === 0 ? (
              <p className="empty-state">No active sessions. Select a market and engage monitoring.</p>
            ) : (
              snapshot.sessions.map((session) => (
                <article className="session-card" key={session.session_id}>
                  <div className="session-card-top">
                    <strong>{session.title}</strong>
                    <span className={`market-flag ${session.status === 'running' ? 'live' : ''}`}>{session.status}</span>
                  </div>
                  <p>{session.last_action}</p>
                  <div className="session-card-meta">
                    <span>Started {formatTimestamp(session.started_at)}</span>
                    <span>Last Px {session.last_price == null ? '--' : session.last_price.toFixed(3)}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="panel panel-activity">
          <div className="panel-header">
            <h2>Operator Tape</h2>
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
