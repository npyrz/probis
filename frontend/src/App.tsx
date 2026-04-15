import { useEffect, useState } from 'react'
import { analyzeMarket, fetchTerminalSnapshot, refreshPolymarketAccount, searchMarkets, startMonitoring } from './lib/api'
import type { Market, MarketAnalysisResponse, MonitorSettings, PolymarketAccount } from './lib/types'

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

function formatProbability(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatDecimal(value: number | null | undefined, digits = 2) {
  if (value == null || Number.isNaN(value)) {
    return '--'
  }
  return value.toFixed(digits)
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

function getLoginLabel(account: PolymarketAccount) {
  return account.configured ? 'logged in via .env' : 'not logged in'
}

function App() {
  const [account, setAccount] = useState<PolymarketAccount>(emptyAccount)
  const [searchResults, setSearchResults] = useState<Market[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null)
  const [notes, setNotes] = useState('')
  const [report, setReport] = useState<MarketAnalysisResponse | null>(null)
  const [settings, setSettings] = useState<MonitorSettings | null>(null)
  const [statusText, setStatusText] = useState('Search Polymarket by title using the official search endpoint to begin analysis.')
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)
  const [tradeBusy, setTradeBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [tradeMessage, setTradeMessage] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const snapshot = await fetchTerminalSnapshot()
        if (!active) {
          return
        }
        setAccount(snapshot.account)
      } catch {
        if (!active) {
          return
        }
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const trimmedQuery = searchQuery.trim()
    if (!trimmedQuery) {
      setSearchResults([])
      setSearchBusy(false)
      return
    }

    let active = true
    setSearchBusy(true)
    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await searchMarkets(trimmedQuery)
        if (!active) {
          return
        }
        setSearchResults(response.markets)
      } catch (error) {
        if (!active) {
          return
        }
        setSearchResults([])
        setErrorMessage(error instanceof Error ? error.message : 'Failed to search markets')
      } finally {
        if (active) {
          setSearchBusy(false)
        }
      }
    }, 250)

    return () => {
      active = false
      window.clearTimeout(timeoutId)
    }
  }, [searchQuery])

  async function handleAnalyze() {
    if (!selectedMarket) {
      setErrorMessage('Select a Polymarket market from the search results.')
      return
    }

    setAnalysisBusy(true)
    setTradeMessage('')
    setErrorMessage('')
    setStatusText(`Analyzing ${selectedMarket.title}...`)
    try {
      const response = await analyzeMarket({ slug: selectedMarket.market, notes: notes.trim() || undefined })
      setReport(response.report)
      setSettings(response.report.recommended_settings)
      setSelectedMarket(response.report.market)
      setSearchQuery(response.report.market.title)
      setStatusText(`Analysis complete for ${response.report.market.title}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to analyze market')
      setReport(null)
      setSettings(null)
      setStatusText('Analysis failed.')
    } finally {
      setAnalysisBusy(false)
    }
  }

  async function handleRefreshAccount() {
    setAccountBusy(true)
    setErrorMessage('')
    try {
      const response = await refreshPolymarketAccount()
      setAccount(response.account)
      setStatusText(`Account refresh complete: ${response.account.status}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to refresh account')
    } finally {
      setAccountBusy(false)
    }
  }

  async function handleStartAutomation() {
    if (!report || !settings) {
      return
    }

    setTradeBusy(true)
    setErrorMessage('')
    try {
      const response = await startMonitoring({
        market: report.market.market,
        outcome: report.market.outcome,
        settings,
      })
      setTradeMessage(`Automation started: ${response.session.session_id}`)
      setStatusText(`Automation running for ${response.session.title}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start automation')
    } finally {
      setTradeBusy(false)
    }
  }

  function handleSearchChange(value: string) {
    setSearchQuery(value)
    setSelectedMarket(null)
    setTradeMessage('')
    setErrorMessage('')
  }

  function handleSelectMarket(market: Market) {
    setSearchQuery(market.title)
    setSelectedMarket(market)
    setErrorMessage('')
    setTradeMessage('')
    setStatusText(`Selected ${market.title}. Run analysis when ready.`)
  }

  function updateSetting<K extends keyof MonitorSettings>(key: K, value: MonitorSettings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current))
  }

  const loginLabel = getLoginLabel(account)

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Probis / title terminal</p>
          <h1>Search a Polymarket title. Get a trade memo. Then automate it.</h1>
          <p className="subhead">This terminal searches Polymarket using the official search endpoint, including pasted Polymarket event URLs, pulls the selected market, adds optional live news, deterministic pricing and risk logic, AI synthesis, and then lets you edit the execution rules before handing control to the model.</p>
        </div>

        <div className="status-grid">
          <StatusCard label="Login" value={loginLabel} tone={account.configured ? 'positive' : 'neutral'} />
          <StatusCard label="Account" value={account.status} tone={account.status === 'connected' ? 'positive' : account.status === 'error' ? 'negative' : 'neutral'} />
          <StatusCard label="Trading" value={account.trading_ready ? 'ready' : 'blocked'} tone={account.trading_ready ? 'positive' : 'negative'} />
          <StatusCard label="Balance" value={formatMoney(account.balance_usd)} tone="neutral" />
        </div>
      </section>

      <section className="workspace-grid">
        <section className="panel input-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">1 / Input</p>
              <h2>Search by title</h2>
            </div>
            <button className="secondary-button" disabled={accountBusy} onClick={handleRefreshAccount} type="button">
              {accountBusy ? 'Refreshing...' : 'Refresh account'}
            </button>
          </div>

          <label className="field-block">
            <span>Trade title</span>
            <input value={searchQuery} onChange={(event) => handleSearchChange(event.target.value)} placeholder="John Castaneda vs. Mark Vologdin or https://polymarket.us/events/..." type="text" />
          </label>

          <div className="search-panel">
            <div className="search-panel-header">
              <span>{searchQuery.trim() ? `${searchResults.length} matches` : 'Enter a title or event URL'}</span>
              <strong>{selectedMarket ? 'Selected' : 'Pick one'}</strong>
            </div>
            <div className="search-results">
              {!searchQuery.trim() ? (
                <p className="muted-copy">Type a trade title or paste a Polymarket event URL to query the official search API.</p>
              ) : searchBusy ? (
                <p className="muted-copy">Searching Polymarket...</p>
              ) : searchResults.length === 0 ? (
                <p className="muted-copy">No active market titles matched that search from the Polymarket search API.</p>
              ) : (
                searchResults.map((market) => {
                  const isSelected = market.market === selectedMarket?.market
                  return (
                    <button className={`search-result ${isSelected ? 'selected' : ''}`} key={market.market} onClick={() => handleSelectMarket(market)} type="button">
                      <strong>{market.title}</strong>
                      <span>{market.category}{market.market_type ? ` / ${market.market_type}` : ''}</span>
                      <span>{formatProbability(market.reference_price)}</span>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <label className="field-block">
            <span>Notes for the model</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional thesis, risk limits, or things you want the AI to focus on." rows={5} />
          </label>

          <div className="action-row">
            <button className="primary-button" disabled={analysisBusy} onClick={handleAnalyze} type="button">
              {analysisBusy ? 'Analyzing...' : 'Analyze selected market'}
            </button>
            <p className="terminal-line">{statusText}</p>
          </div>
          {errorMessage ? <p className="terminal-line error">{errorMessage}</p> : null}
          {tradeMessage ? <p className="terminal-line success">{tradeMessage}</p> : null}
        </section>

        <section className="panel report-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">2 / Report</p>
              <h2>{report?.market.title ?? 'No analysis yet'}</h2>
            </div>
          </div>

          {report ? (
            <div className="report-layout">
              <section className="market-hero">
                <div>
                  <p className="eyebrow">Polymarket info</p>
                  <h3>{report.market.title}</h3>
                  <p className="hero-description">{report.market.description || report.market.subtitle || 'No extra market description available.'}</p>
                </div>
                <div className="metric-grid">
                  <StatusCard label="Category" value={report.market.category} tone="neutral" />
                  <StatusCard label="Type" value={report.market.market_type ?? report.market.venue} tone="neutral" />
                  <StatusCard label="Market" value={formatProbability(report.deterministic.market_probability)} tone="neutral" />
                  <StatusCard label="Fair" value={formatProbability(report.deterministic.fair_probability)} tone={report.deterministic.edge > 0 ? 'positive' : 'negative'} />
                </div>
              </section>

              <section className="detail-grid">
                <article className="detail-card">
                  <p className="eyebrow">Deterministic pricing / risk</p>
                  <DetailRow label="Best bid" value={formatProbability(report.deterministic.best_bid)} />
                  <DetailRow label="Best ask" value={formatProbability(report.deterministic.best_ask)} />
                  <DetailRow label="Spread" value={report.deterministic.spread == null ? '--' : formatProbability(report.deterministic.spread)} />
                  <DetailRow label="Edge" value={formatProbability(report.deterministic.edge)} />
                  <DetailRow label="Liquidity score" value={formatDecimal(report.deterministic.liquidity_score)} />
                  <DetailRow label="Risk score" value={formatDecimal(report.deterministic.risk_score)} />
                  <DetailRow label="Open interest" value={formatDecimal(report.deterministic.open_interest, 0)} />
                  <DetailRow label="Shares traded" value={formatDecimal(report.deterministic.shares_traded, 0)} />
                  <div className="pill-list">
                    {report.deterministic.risk_flags.map((flag) => (
                      <span className="info-pill" key={flag}>{flag}</span>
                    ))}
                  </div>
                </article>

                <article className="detail-card">
                  <p className="eyebrow">AI synthesis</p>
                  <DetailRow label="Status" value={report.ai.status} />
                  <DetailRow label="Verdict" value={report.ai.verdict} />
                  <DetailRow label="Confidence" value={formatProbability(report.ai.confidence)} />
                  <DetailRow label="Estimated probability" value={formatProbability(report.ai.estimated_probability)} />
                  <p className="summary-copy">{report.ai.summary}</p>
                  <TextBlock label="Thesis" items={report.ai.thesis} />
                  <TextBlock label="Catalysts" items={report.ai.catalysts} />
                  <TextBlock label="Risks" items={report.ai.risks} />
                </article>
              </section>

              <section className="detail-grid">
                <article className="detail-card">
                  <p className="eyebrow">External event data</p>
                  {report.event_context.length === 0 ? (
                    <p className="muted-copy">No extra event context was available for this market.</p>
                  ) : (
                    report.event_context.map((item) => <DetailRow key={`${item.label}-${item.value}`} label={item.label} value={item.value} />)
                  )}
                  <DetailRow label="Starts" value={formatDate(report.market.start_date)} />
                  <DetailRow label="Ends" value={formatDate(report.market.end_date)} />
                  <DetailRow label="Updated" value={formatDate(report.market.updated_at)} />
                </article>

                <article className="detail-card">
                  <p className="eyebrow">Live news API</p>
                  {report.news.length === 0 ? (
                    <p className="muted-copy">No live news articles were returned. Configure NEWS_API_KEY to populate this section.</p>
                  ) : (
                    <div className="news-list">
                      {report.news.map((article) => (
                        <a className="news-card" href={article.url} key={article.url} rel="noreferrer" target="_blank">
                          <strong>{article.title}</strong>
                          <span>{article.source} / {formatDate(article.published_at)}</span>
                          <p>{article.summary || 'Open source article'}</p>
                        </a>
                      ))}
                    </div>
                  )}
                </article>
              </section>

              {settings ? (
                <section className="detail-card settings-card">
                  <div className="settings-header">
                    <div>
                      <p className="eyebrow">3 / Execution settings</p>
                      <h3>Adjust rules, then let the model trade</h3>
                    </div>
                    <button className="primary-button" disabled={tradeBusy || !account.trading_ready} onClick={handleStartAutomation} type="button">
                      {tradeBusy ? 'Starting...' : 'Start automation'}
                    </button>
                  </div>

                  <div className="settings-grid">
                    <NumberField label="Entry min" value={settings.entry_price_min} onChange={(value) => updateSetting('entry_price_min', value)} />
                    <NumberField label="Entry max" value={settings.entry_price_max} onChange={(value) => updateSetting('entry_price_max', value)} />
                    <NumberField label="Order size" value={settings.order_size} onChange={(value) => updateSetting('order_size', value ?? 0)} />
                    <NumberField label="Max position" value={settings.max_position} onChange={(value) => updateSetting('max_position', value ?? 0)} />
                    <NumberField label="Add price" value={settings.add_price} onChange={(value) => updateSetting('add_price', value)} />
                    <NumberField label="Add size" value={settings.add_order_size} onChange={(value) => updateSetting('add_order_size', value)} />
                    <NumberField label="Trim price" value={settings.trim_price} onChange={(value) => updateSetting('trim_price', value)} />
                    <NumberField label="Trim size" value={settings.trim_order_size} onChange={(value) => updateSetting('trim_order_size', value)} />
                    <NumberField label="Take-profit price" value={settings.take_profit_price} onChange={(value) => updateSetting('take_profit_price', value)} />
                    <NumberField label="Stop-loss price" value={settings.stop_loss_price} onChange={(value) => updateSetting('stop_loss_price', value)} />
                    <NumberField label="Edge threshold" value={settings.edge_threshold} onChange={(value) => updateSetting('edge_threshold', value ?? 0)} />
                    <NumberField label="Exit threshold" value={settings.exit_threshold} onChange={(value) => updateSetting('exit_threshold', value ?? 0)} />
                  </div>

                  <label className="field-block field-block-wide">
                    <span>Trading notes</span>
                    <textarea rows={4} value={settings.author_notes} onChange={(event) => updateSetting('author_notes', event.target.value)} />
                  </label>
                </section>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">
              <p>Search by title, pick a live market, run analysis, and this panel will show Polymarket data, AI synthesis, live news, deterministic risk logic, and editable automation settings.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  )
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: 'positive' | 'negative' | 'neutral' }) {
  return (
    <article className={`status-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
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

function TextBlock({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className="text-block">
      <span>{label}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: number | null | undefined; onChange: (value: number | null) => void }) {
  return (
    <label className="field-block">
      <span>{label}</span>
      <input
        type="number"
        step="0.01"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
      />
    </label>
  )
}

export default App
