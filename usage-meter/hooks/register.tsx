// usage-meter — live usage UI for Claude Code / Cowork sessions.
// Observes only: it never changes models, prompts or tools.
//
//   band above the prompt:  5h 34% ↻2h 5m │ wk 12% ↻3d 4h │ ctx 25% · $1.23
//   /meter                   opens the full dashboard pane
//   /meter band on|off       shows or hides the band

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Limit, ModelTally, UsageSnap } from '../types'

const PANE = 'usage-meter'

const band = atom({ plugin: 'usage-meter', key: 'band' } as const, true)
const tallies = atom({ plugin: 'usage-meter', key: 'tallies' } as const, [] as ModelTally[], { shape: 'tallies-1' })
const usage = atom({ plugin: 'usage-meter', key: 'usage' } as const, null as UsageSnap | null, { shape: 'usage-1' })

function fmtDur(ms: number): string {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return d + 'd ' + h + 'h'
  if (h > 0) return h + 'h ' + mm + 'm'
  if (m > 0) return mm + 'm'
  return Math.max(1, Math.floor(ms / 1000)) + 's'
}

function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function bar(pct: number, width: number): string {
  const p = Math.max(0, Math.min(100, pct))
  const full = Math.round((p / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

function tone(pct: number): string {
  return pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green'
}

function limitName(kind: string): string {
  if (kind === 'five_hour') return '5-hour session'
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'seven_day_opus') return 'Weekly (Opus)'
  if (kind === 'spend_limit') return 'Spend limit'
  return kind.replace(/_/g, ' ')
}

function shortLimit(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'wk'
  return kind.replace(/_/g, '').slice(0, 6)
}

function resetIn(l: Limit, now: number): string {
  if (!l.resetsAt) return '?'
  const t = Date.parse(l.resetsAt)
  return Number.isNaN(t) ? '?' : fmtDur(t - now)
}

function resetClock(l: Limit): string {
  if (!l.resetsAt) return ''
  const t = new Date(l.resetsAt)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  const snap: UsageSnap = {
    startedAt: u.startedAt,
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    contextPercent: u.context.percent,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: u.cost?.usd,
  }
  await update($, usage, () => snap)
}

async function addTally($: EngineInterface, model: string, u: ModelUsage): Promise<void> {
  await update($, tallies, list => {
    const t = list.find(x => x.model === model) ?? { model, steps: 0, input: 0, output: 0 }
    return [
      ...list.filter(x => x.model !== model),
      {
        model,
        steps: t.steps + 1,
        input: t.input + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        output: t.output + u.output_tokens,
      },
    ]
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('band')
    if (typeof saved === 'boolean') await update($, band, () => saved)
    try {
      await refreshUsage($)
    } catch {
      // no reading yet; session.measure fills it in
    }
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    $.clock.every(30000, () => {
      void refreshUsage($).catch(() => undefined)
    })
    try {
      await $.command.register({
        name: 'meter',
        description: 'Open the usage dashboard (limits, resets, context, cost)',
        argumentHint: '[band on|off]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('could not register /meter: ' + String(err))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const prev = await read($, usage)
    await update($, usage, () => ({
      startedAt: prev?.startedAt ?? 0,
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      contextPercent: e.context.percent,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      costUsd: e.cost?.usd,
    }))
    if (e.changed.includes('rateLimits')) {
      for (const l of e.rateLimits) {
        if (l.percentUsed >= 90) {
          $.ui.toast(limitName(l.kind) + ' limit at ' + l.percentUsed + '% — resets in ' + resetIn(l, Date.now()))
        }
      }
    }
    return next(e)
  })

  // Observe each model request's token usage; the request itself is passed on unchanged.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage) await addTally($, result.usage.model, result.usage)
    return result
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const [sub, val] = e.args.trim().toLowerCase().split(/\s+/)
    if (sub === 'band' && (val === 'on' || val === 'off')) {
      await update($, band, () => val === 'on')
      await $.store.set('band', val === 'on')
      return { text: 'Usage bar ' + (val === 'on' ? 'shown.' : 'hidden.') }
    }
    await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const u = await read($, usage)
    const list = await read($, tallies)
    const now = Date.now()
    const w = Math.max(8, Math.min(30, (e.props.bodyColumns ?? 40) - 16))
    const limits = u?.limits ?? []
    const ctxPct = u?.contextPercent ?? 0
    const totalOut = list.reduce((s, t) => s + t.output, 0)

    return (
      <Box flexDirection="column">
        <Text bold>Plan limits</Text>
        {limits.length === 0 && (
          <Text dimColor>No readings yet — they arrive with the next reply (none on API-key billing).</Text>
        )}
        {limits.map(l => (
          <Box flexDirection="column">
            <Text>
              {limitName(l.kind)}: <Text color={tone(l.percentUsed)}>{bar(l.percentUsed, w)}</Text> {l.percentUsed}%
            </Text>
            <Text dimColor>
              {'  '}
              {Math.max(0, Math.round((100 - l.percentUsed) * 10) / 10)}% left · resets in {resetIn(l, now)}
              {resetClock(l) ? ' (' + resetClock(l) + ')' : ''}
            </Text>
          </Box>
        ))}
        <Text> </Text>
        <Text bold>This session</Text>
        <Text>
          Context: <Text color={tone(ctxPct)}>{bar(ctxPct, w)}</Text> {Math.round(ctxPct)}%
          {u?.contextTokens !== undefined ? ' (' + fmtTok(u.contextTokens) + ' / ' + fmtTok(u.contextWindow) + ')' : ''}
        </Text>
        {u?.costUsd !== undefined && <Text>Cost (API-priced): ${u.costUsd.toFixed(2)}</Text>}
        {u && u.startedAt > 0 && <Text dimColor>Running for {fmtDur(now - u.startedAt)}</Text>}
        <Text> </Text>
        <Text bold>Tokens by model</Text>
        {list.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {list
          .slice()
          .sort((a, b) => b.output - a.output)
          .map(t => (
            <Text>
              {t.model.replace(/^claude-/, '')}: {fmtTok(t.input)} in · {fmtTok(t.output)} out · {t.steps} req
              {totalOut > 0 ? ' · ' + Math.round((t.output / totalOut) * 100) + '%' : ''}
            </Text>
          ))}
        <Text> </Text>
        <Text dimColor>/meter band on|off · Esc closes</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, band))) return next(e)
    const u = await read($, usage)
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()

    return (
      <Box flexDirection="row" columnGap={1}>
        {(u?.limits ?? []).map(l => (
          <Text dimColor>
            {shortLimit(l.kind)} <Text color={tone(l.percentUsed)}>{l.percentUsed}%</Text> ↻{resetIn(l, now)} │
          </Text>
        ))}
        <Text dimColor>
          ctx {Math.round(u?.contextPercent ?? 0)}%{u?.costUsd !== undefined ? ' · $' + u.costUsd.toFixed(2) : ''}
        </Text>
      </Box>
    )
  })
}
