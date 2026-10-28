export type ModelTally = {
  model: string
  steps: number
  input: number
  output: number
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

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      band: boolean
      tallies: Shaped<ModelTally[]>
      usage: Shaped<UsageSnap | null>
    }
  }
}
