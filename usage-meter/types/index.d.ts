export type ModelTally = {
  model: string
  steps: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnap = {
  startedAt: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: Limit[]
  costUsd?: number
}

/** One reading of a plan limit, kept across sessions for the pace and history charts. */
export type Sample = { t: number; kind: string; pct: number }

export type SessionStats = { turns: number; lastTurnMs: number; totalTurnMs: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      band: boolean
      tallies: Shaped<ModelTally[]>
      usage: Shaped<UsageSnap | null>
      history: Shaped<Sample[]>
      stats: Shaped<SessionStats>
    }
  }
}
