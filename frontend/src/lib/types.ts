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
  condition_id?: string | null
  asset_id?: string | null
  no_asset_id?: string | null
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
  last_price: number
  model_probability: number
  edge: number
  position: number
  monitored: boolean
  session_id: string | null
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

export type TerminalEvent =
  | ({ type: 'snapshot' } & TerminalSnapshot)
  | ({ type: 'market'; market: string; outcome: string; market_probability: number; your_probability: number; edge: number; should_trade: boolean; position: number; session_id: string | null; ts: string })
  | { type: 'account'; account: PolymarketAccount }
