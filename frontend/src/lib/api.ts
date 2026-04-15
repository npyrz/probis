import { AccountResponse, AnalyzeResponse } from './types'


const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message = payload && typeof payload.detail === 'string' ? payload.detail : `Request failed with ${response.status}`
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export function getAccount() {
  return request<AccountResponse>('/api/account')
}

export function analyzeMarket(url: string) {
  return request<AnalyzeResponse>('/api/analyze', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}
