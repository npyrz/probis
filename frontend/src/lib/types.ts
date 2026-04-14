export type Market = {
  market: string
  title: string
  category: string
  market_type?: string | null
  outcome: string
  venue: 'polymarket' | 'sim'
  reference_price: number
  condition_id?: string | null
  asset_id?: string | null
  no_asset_id?: string | null
  best_bid?: number | null
  best_ask?: number | null
  last_trade_price?: number | null
  end_date?: string | null
  image?: string | null
  last_price: number
  model_probability: number
  edge: number
  position: number
  monitored: boolean
  session_id: string | null
}

export type MonitorSettings = {
  edge_threshold: number
  exit_threshold: number
  order_size: number
  max_position: number
  take_profit: number
  stop_loss: number
  author_notes: string
}

export type MonitorSession = {
  session_id: string
  market: string
  outcome: string
  title: string
  status: 'running' | 'aborted' | 'completed'
  settings: MonitorSettings
  started_at: string
  stopped_at: string | null
  reason: string | null
  last_action: string
  last_price: number | null
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

export type Fill = {
  type?: 'fill'
  ts: string
  market: string
  outcome: string
  side: 'buy' | 'sell'
  size: number
  price: number
  venue: 'polymarket' | 'sim'
  order_id: string
  session_id: string | null
  reason: string
  position?: number
}

export type LogEntry = {
  type?: 'log'
  ts: string
  session_id: string | null
  level: string
  message: string
}

export type TerminalSnapshot = {
  markets: Market[]
  sessions: MonitorSession[]
  fills: Fill[]
  logs: LogEntry[]
  positions: Record<string, number>
  account: PolymarketAccount
}

export type TerminalEvent =
  | ({ type: 'snapshot' } & TerminalSnapshot)
  | ({ type: 'market'; market: string; outcome: string; market_probability: number; your_probability: number; edge: number; should_trade: boolean; position: number; session_id: string | null; ts: string })
  | ({ type: 'fill' } & Fill)
  | ({ type: 'log' } & LogEntry)
  | { type: 'account'; account: PolymarketAccount }
  | { type: 'session'; action: 'started' | 'aborted'; session: MonitorSession }
