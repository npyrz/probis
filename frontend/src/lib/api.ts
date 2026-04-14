import type { MarketAnalysisResponse, MonitorSession, MonitorSettings, TerminalSnapshot } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'

export async function fetchTerminalSnapshot(): Promise<TerminalSnapshot> {
  const response = await fetch(`${API_BASE_URL}/terminal`)
  if (!response.ok) {
    throw new Error('failed to fetch terminal snapshot')
  }
  return response.json()
}

export async function refreshPolymarketAccount() {
  const response = await fetch(`${API_BASE_URL}/polymarket/account/refresh`, {
    method: 'POST',
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || 'failed to refresh polymarket account')
  }
  return response.json() as Promise<{ account: TerminalSnapshot['account'] }>
}

export async function analyzeMarket(payload: { slug: string; notes?: string }) {
  const response = await fetch(`${API_BASE_URL}/analyze-market`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || 'failed to analyze market')
  }
  return response.json() as Promise<{ report: MarketAnalysisResponse }>
}

export async function startMonitoring(payload: { market: string; outcome: string; settings: MonitorSettings }) {
  const response = await fetch(`${API_BASE_URL}/monitor-sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || 'failed to start monitoring')
  }
  return response.json() as Promise<{ session: MonitorSession }>
}
