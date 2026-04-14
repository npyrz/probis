import type { MonitorSettings, TerminalSnapshot } from './types'

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
  return response.json()
}

export async function abortMonitoring(sessionId: string) {
  const response = await fetch(`${API_BASE_URL}/monitor-sessions/${sessionId}/abort`, {
    method: 'POST',
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || 'failed to abort monitoring')
  }
  return response.json()
}

export function createTerminalSocket() {
  const url = new URL(getApiBaseUrl())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/terminal'
  return new WebSocket(url.toString())
}
