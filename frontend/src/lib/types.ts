export interface AccountSummary {
  label: string
  mode: 'paper' | 'live-ready'
  trading_ready: boolean
  api_key_configured: boolean
  paper_balance: number
  buying_power: number
  max_trade_risk_pct: number
  max_daily_loss: number
  notes: string[]
}

export interface AccountResponse {
  account: AccountSummary
}

export interface MarketOutcome {
  name: string
  price: number
}

export interface MarketSnapshot {
  url: string
  title: string
  question: string
  slug: string
  event_title?: string | null
  event_slug?: string | null
  category?: string | null
  description: string
  liquidity?: number | null
  volume?: number | null
  volume_24hr?: number | null
  end_date?: string | null
  resolution_source?: string | null
  outcomes: MarketOutcome[]
  source_status: 'live'
  raw_market: Record<string, unknown>
  raw_event?: Record<string, unknown> | null
}

export interface ExternalSignal {
  label: string
  direction: 'positive' | 'neutral' | 'risk'
  score: number
  detail: string
}

export interface AISynthesis {
  mode: string
  summary: string
  drivers: string[]
  caveats: string[]
}

export interface TradePlan {
  action: 'buy_yes' | 'buy_no' | 'wait'
  target_outcome: string
  market_probability: number
  model_probability: number
  edge_pct: number
  conviction: number
  entry_window: string
  sizing: string
  invalidation: string
  rationale: string[]
  risk_flags: string[]
}

export interface AnalyzeResponse {
  generated_at: string
  account: AccountSummary
  market: MarketSnapshot
  external_signals: ExternalSignal[]
  ai_synthesis: AISynthesis
  trade_plan: TradePlan
  source_notes: string[]
}
