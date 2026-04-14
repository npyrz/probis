export type Market = {
  market: string
  title: string
  category: string
  subtitle?: string | null
  description?: string | null
  market_type?: string | null
  outcome: string
  outcomes: string[]
  outcome_prices: number[]
  venue: 'polymarket' | 'sim'
  reference_price: number
  active: boolean
  closed: boolean
  best_bid?: number | null
  best_ask?: number | null
  last_trade_price?: number | null
  min_tick_size?: number | null
  start_date?: string | null
  end_date?: string | null
  created_at?: string | null
  updated_at?: string | null
  image?: string | null
}

export type PolymarketAccount = {
  status: 'disconnected' | 'connected' | 'error'
  configured: boolean
  trading_ready: boolean
  key_id_fingerprint: string | null
  balance_usd: string | null
  open_orders: number
  position_count: number
  error: string | null
  updated_at: string
}

export type TerminalSnapshot = {
  markets: Market[]
  account: PolymarketAccount
}

export type NewsArticle = {
  title: string
  source: string
  url: string
  published_at?: string | null
  summary?: string | null
}

export type EventContext = {
  label: string
  value: string
}

export type DeterministicAnalysis = {
  market_probability: number
  fair_probability: number
  edge: number
  best_bid?: number | null
  best_ask?: number | null
  spread?: number | null
  spread_bps?: number | null
  last_trade_price?: number | null
  open_interest?: number | null
  shares_traded?: number | null
  bid_depth?: number | null
  ask_depth?: number | null
  liquidity_score: number
  risk_score: number
  risk_flags: string[]
}

export type AITradeAnalysis = {
  status: 'available' | 'fallback' | 'unavailable'
  verdict: 'buy' | 'watch' | 'avoid'
  confidence: number
  estimated_probability?: number | null
  summary: string
  thesis: string[]
  catalysts: string[]
  risks: string[]
}

export type MonitorSettings = {
  edge_threshold: number
  exit_threshold: number
  order_size: number
  max_position: number
  take_profit: number
  stop_loss: number
  entry_price_min?: number | null
  entry_price_max?: number | null
  add_price?: number | null
  add_order_size?: number | null
  trim_price?: number | null
  trim_order_size?: number | null
  take_profit_price?: number | null
  stop_loss_price?: number | null
  author_notes: string
}

export type MarketAnalysisResponse = {
  market: Market
  event_context: EventContext[]
  news: NewsArticle[]
  deterministic: DeterministicAnalysis
  ai: AITradeAnalysis
  recommended_settings: MonitorSettings
  trading_ready: boolean
}

export type MonitorSession = {
  session_id: string
  market: string
  outcome: string
  title: string
  status: 'running' | 'aborted' | 'completed'
  started_at: string
  stopped_at?: string | null
  reason?: string | null
  last_action: string
  last_price?: number | null
}
