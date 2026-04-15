import { FormEvent, useEffect, useState } from 'react'
import { analyzeMarket, getAccount } from './lib/api'
import { AccountSummary, AnalyzeResponse, MarketOutcome } from './lib/types'


const formatCurrency = (value?: number | null) => {
  if (value == null) {
    return 'N/A'
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

const formatPercent = (value?: number | null) => {
  if (value == null) {
    return 'N/A'
  }

  return `${(value * 100).toFixed(1)}%`
}

const formatDate = (value?: string | null) => {
  if (!value) {
    return 'Open-ended'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString()
}

const OutcomeTape = ({ outcomes }: { outcomes: MarketOutcome[] }) => (
  <div className="outcome-tape">
    {outcomes.map((outcome) => (
      <div className="outcome-chip" key={outcome.name}>
        <span>{outcome.name}</span>
        <strong>{formatPercent(outcome.price)}</strong>
      </div>
    ))}
  </div>
)


export default function App() {
  const [clock, setClock] = useState(() => new Date())
  const [url, setUrl] = useState('')
  const [account, setAccount] = useState<AccountSummary | null>(null)
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingAccount, setLoadingAccount] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const loadAccount = async () => {
      try {
        setLoadingAccount(true)
        const response = await getAccount()
        setAccount(response.account)
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Failed to load account status')
      } finally {
        setLoadingAccount(false)
      }
    }

    void loadAccount()
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setAnalyzing(true)

    try {
      const response = await analyzeMarket(url)
      setAnalysis(response)
      setAccount(response.account)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  const activeAction = analysis?.trade_plan.action ?? 'wait'

  return (
    <div className="shell">
      <div className="shell__overlay" />
      <header className="topbar panel">
        <div>
          <p className="eyebrow">Probis / Operator Surface</p>
          <h1>Prediction Market Terminal</h1>
          <p className="lede">
            Paste a Polymarket event URL to pull the live public market snapshot, layer deterministic pricing and risk logic,
            and produce a trade plan.
          </p>
        </div>
        <div className="topbar__meta">
          <div>
            <span className="label">Clock</span>
            <strong>{clock.toLocaleTimeString()}</strong>
          </div>
          <div>
            <span className="label">Mode</span>
            <strong>{account?.mode ?? 'loading'}</strong>
          </div>
          <div>
            <span className="label">Action Bias</span>
            <strong className={`tone tone--${activeAction}`}>{activeAction.replace('_', ' ')}</strong>
          </div>
        </div>
      </header>

      <main className="layout">
        <aside className="rail">
          <section className="panel panel--accent">
            <div className="section-heading">
              <span>Account</span>
              <strong>{loadingAccount ? '...' : account?.label ?? 'Unavailable'}</strong>
            </div>
            <div className="metric-grid">
              <div>
                <span className="label">Buying Power</span>
                <strong>{formatCurrency(account?.buying_power)}</strong>
              </div>
              <div>
                <span className="label">Max Trade Risk</span>
                <strong>{formatPercent(account?.max_trade_risk_pct)}</strong>
              </div>
              <div>
                <span className="label">Daily Loss Cap</span>
                <strong>{formatCurrency(account?.max_daily_loss)}</strong>
              </div>
              <div>
                <span className="label">Trading Ready</span>
                <strong>{account?.trading_ready ? 'Yes' : 'Paper only'}</strong>
              </div>
            </div>
            <div className="note-stack">
              {(account?.notes ?? ['Waiting on backend account state.']).map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="section-heading">
              <span>Engine</span>
              <strong>Deterministic</strong>
            </div>
            <ul className="plain-list">
              <li>Critical path remains price, liquidity, and risk first.</li>
              <li>AI synthesis is separated from execution logic.</li>
              <li>Raw Polymarket payloads stay visible for operator review.</li>
            </ul>
          </section>

          {analysis && (
            <section className="panel">
              <div className="section-heading">
                <span>Signals</span>
                <strong>{analysis.external_signals.length}</strong>
              </div>
              <div className="signal-stack">
                {analysis.external_signals.map((signal) => (
                  <article className={`signal signal--${signal.direction}`} key={signal.label}>
                    <div>
                      <span className="label">{signal.label}</span>
                      <strong>{formatPercent(signal.score)}</strong>
                    </div>
                    <p>{signal.detail}</p>
                  </article>
                ))}
              </div>
            </section>
          )}
        </aside>

        <section className="workspace">
          <section className="panel panel--hero">
            <form className="lookup-form" onSubmit={handleSubmit}>
              <label htmlFor="market-url">Polymarket Bet URL</label>
              <div className="lookup-form__row">
                <input
                  id="market-url"
                  type="url"
                  placeholder="https://polymarket.com/event/..."
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                />
                <button type="submit" disabled={analyzing}>
                  {analyzing ? 'Analyzing...' : 'Analyze Bet'}
                </button>
              </div>
              <p className="hint">Supports event or market URLs. The backend normalizes the Polymarket Gamma payload and scores the setup.</p>
            </form>
            {error && <p className="error-banner">{error}</p>}
          </section>

          {analysis ? (
            <>
              <section className="panel panel--market">
                <div className="section-heading">
                  <span>Market Snapshot</span>
                  <strong>{analysis.market.category ?? 'General'}</strong>
                </div>
                <h2>{analysis.market.title}</h2>
                <p className="lede lede--compact">{analysis.market.description || analysis.market.question}</p>
                <OutcomeTape outcomes={analysis.market.outcomes} />
                <div className="metric-grid metric-grid--wide">
                  <div>
                    <span className="label">Market Slug</span>
                    <strong>{analysis.market.slug}</strong>
                  </div>
                  <div>
                    <span className="label">Close</span>
                    <strong>{formatDate(analysis.market.end_date)}</strong>
                  </div>
                  <div>
                    <span className="label">Liquidity</span>
                    <strong>{formatCurrency(analysis.market.liquidity)}</strong>
                  </div>
                  <div>
                    <span className="label">Volume</span>
                    <strong>{formatCurrency(analysis.market.volume)}</strong>
                  </div>
                  <div>
                    <span className="label">24h Volume</span>
                    <strong>{formatCurrency(analysis.market.volume_24hr)}</strong>
                  </div>
                  <div>
                    <span className="label">Resolution Source</span>
                    <strong>{analysis.market.resolution_source ?? 'Not listed'}</strong>
                  </div>
                </div>
              </section>

              <div className="dual-grid">
                <section className="panel panel--plan">
                  <div className="section-heading">
                    <span>Trade Plan</span>
                    <strong className={`tone tone--${analysis.trade_plan.action}`}>{analysis.trade_plan.action.replace('_', ' ')}</strong>
                  </div>
                  <div className="plan-metrics">
                    <div>
                      <span className="label">Target</span>
                      <strong>{analysis.trade_plan.target_outcome}</strong>
                    </div>
                    <div>
                      <span className="label">Market Prob.</span>
                      <strong>{formatPercent(analysis.trade_plan.market_probability)}</strong>
                    </div>
                    <div>
                      <span className="label">Model Prob.</span>
                      <strong>{formatPercent(analysis.trade_plan.model_probability)}</strong>
                    </div>
                    <div>
                      <span className="label">Edge</span>
                      <strong>{formatPercent(analysis.trade_plan.edge_pct)}</strong>
                    </div>
                    <div>
                      <span className="label">Conviction</span>
                      <strong>{formatPercent(analysis.trade_plan.conviction)}</strong>
                    </div>
                  </div>
                  <div className="note-stack">
                    <p>{analysis.trade_plan.entry_window}</p>
                    <p>{analysis.trade_plan.sizing}</p>
                    <p>{analysis.trade_plan.invalidation}</p>
                  </div>
                  <ul className="plain-list">
                    {analysis.trade_plan.rationale.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <div className="tag-row">
                    {analysis.trade_plan.risk_flags.map((flag) => (
                      <span className="tag" key={flag}>{flag}</span>
                    ))}
                  </div>
                </section>

                <section className="panel">
                  <div className="section-heading">
                    <span>AI Synthesis</span>
                    <strong>{analysis.ai_synthesis.mode}</strong>
                  </div>
                  <p className="lede lede--compact">{analysis.ai_synthesis.summary}</p>
                  <div className="subsection">
                    <span className="label">Drivers</span>
                    <ul className="plain-list">
                      {analysis.ai_synthesis.drivers.map((driver) => (
                        <li key={driver}>{driver}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="subsection">
                    <span className="label">Caveats</span>
                    <ul className="plain-list">
                      {analysis.ai_synthesis.caveats.map((caveat) => (
                        <li key={caveat}>{caveat}</li>
                      ))}
                    </ul>
                  </div>
                </section>
              </div>

              <div className="dual-grid">
                <section className="panel panel--raw">
                  <div className="section-heading">
                    <span>Raw Market Payload</span>
                    <strong>Gamma</strong>
                  </div>
                  <pre>{JSON.stringify(analysis.market.raw_market, null, 2)}</pre>
                </section>

                <section className="panel panel--raw">
                  <div className="section-heading">
                    <span>Raw Event Payload</span>
                    <strong>{analysis.market.raw_event ? 'Attached' : 'None'}</strong>
                  </div>
                  <pre>{JSON.stringify(analysis.market.raw_event ?? {}, null, 2)}</pre>
                </section>
              </div>
            </>
          ) : (
            <section className="panel panel--empty">
              <p className="eyebrow">Boot Sequence</p>
              <h2>Paste a live Polymarket URL to build the first trade memo.</h2>
              <p className="lede lede--compact">
                This reset keeps the operator loop simple: account state on the left, raw public market data in the middle,
                and a deterministic trade plan on the right.
              </p>
            </section>
          )}
        </section>
      </main>
    </div>
  )
}
