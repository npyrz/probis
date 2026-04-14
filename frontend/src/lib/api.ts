import type { TerminalSnapshot } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'

export function getApiBaseUrl() {
  return API_BASE_URL
}

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
  return response.json()
}

export function createTerminalSocket() {
  const url = new URL(getApiBaseUrl())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/terminal'
  return new WebSocket(url.toString())
}
