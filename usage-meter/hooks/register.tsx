// usage-meter — live usage UI for Claude Code / Cowork sessions.
// Observes only: it never changes models, prompts or tools.
//
//   /meter             live dashboard card in the conversation (drawn gauges in the app)
//   /meter pane        the same dashboard in a side pane
//   /meter band on|off show or hide the compact bar above the prompt

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Limit, ModelTally, Sample, SessionStats, UsageSnap } from '../types'

const PANE = 'usage-meter'
const HOUR = 3600000
const HISTORY_MS = 7 * 24 * HOUR

const band = atom({ plugin: 'usage-meter', key: 'band' } as const, true)
const tallies = atom({ plugin: 'usage-meter', key: 'tallies' } as const, [] as ModelTally[], { shape: 'tallies-2' })
const usage = atom({ plugin: 'usage-meter', key: 'usage' } as const, null as UsageSnap | null, { shape: 'usage-1' })
const history = atom({ plugin: 'usage-meter', key: 'history' } as const, [] as Sample[], { shape: 'history-1' })
const stats = atom(
  { plugin: 'usage-meter', key: 'stats' } as const,
  { turns: 0, lastTurnMs: 0, totalTurnMs: 0 } as SessionStats,
  { shape: 'stats-1' },
)

// ---------- formatting ----------

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
  return String(Math.round(n))
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
  if (kind === 'five_hour') return '5-hour'
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'seven_day_opus') return 'Weekly Opus'
  if (kind === 'seven_day_sonnet') return 'Weekly Sonnet'
  if (kind === 'spend_limit') return 'Spend'
  return kind.replace(/_/g, ' ')
}

function shortLimit(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'wk'
  return kind.replace(/_/g, '').slice(0, 6)
}

function resetAt(l: Limit): number | null {
  if (!l.resetsAt) return null
  const t = Date.parse(l.resetsAt)
  return Number.isNaN(t) ? null : t
}

function resetIn(l: Limit, now: number): string {
  const t = resetAt(l)
  return t === null ? '?' : fmtDur(t - now)
}

function resetClock(l: Limit): string {
  const t = resetAt(l)
  if (t === null) return ''
  return new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------- pace ----------

type Pace = { kind: 'idle' } | { kind: 'safe'; perHour: number } | { kind: 'hits'; inMs: number; perHour: number }

/** Burn rate over the last hour of readings for one limit, and whether it reaches 100% before the reset. */
function pace(l: Limit, samples: readonly Sample[], now: number): Pace {
  const mine = samples.filter(s => s.kind === l.kind && s.t >= now - HOUR)
  const first = mine[0]
  if (!first || now - first.t < 5 * 60000) return { kind: 'idle' }
  const rise = l.percentUsed - first.pct
  if (rise <= 0) return { kind: 'idle' }
  const perHour = rise / ((now - first.t) / HOUR)
  const inMs = ((100 - l.percentUsed) / perHour) * HOUR
  const reset = resetAt(l)
  if (reset !== null && now + inMs >= reset) return { kind: 'safe', perHour }
  return { kind: 'hits', inMs, perHour }
}

function paceText(p: Pace): string {
  if (p.kind === 'idle') return 'Not enough recent use to estimate'
  if (p.kind === 'safe') return 'On pace: resets before you hit it (+' + p.perHour.toFixed(1) + '%/h)'
  return 'At this pace: limit in ' + fmtDur(p.inMs) + ' (+' + p.perHour.toFixed(1) + '%/h)'
}

// ---------- data ----------

function snapFrom(u: {
  startedAt?: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly Limit[]
  cost?: { usd: number }
}, startedAt: number): UsageSnap {
  return {
    startedAt: u.startedAt ?? startedAt,
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    contextPercent: u.context.percent,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: u.cost?.usd,
  }
}

async function recordSamples($: EngineInterface, limits: readonly Limit[]): Promise<void> {
  if (limits.length === 0) return
  const now = await $.clock.now()
  const saved = ((await $.store.get('history')) ?? []) as Sample[]
  const next = saved.filter(s => s.t >= now - HISTORY_MS)
  for (const l of limits) {
    const last = [...next].reverse().find(s => s.kind === l.kind)
    // One point per limit per 2 minutes unless the value moved.
    if (!last || last.pct !== l.percentUsed || now - last.t > 2 * 60000) {
      next.push({ t: now, kind: l.kind, pct: l.percentUsed })
    }
  }
  const trimmed = next.slice(-1500)
  await $.store.set('history', trimmed)
  await update($, history, () => trimmed)
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  const snap = snapFrom(u, u.startedAt)
  await update($, usage, () => snap)
  await recordSamples($, snap.limits)
}

async function addTally($: EngineInterface, model: string, u: ModelUsage): Promise<void> {
  await update($, tallies, list => {
    const t = list.find(x => x.model === model) ?? { model, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    return [
      ...list.filter(x => x.model !== model),
      {
        model,
        steps: t.steps + 1,
        input: t.input + u.input_tokens,
        output: t.output + u.output_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
      },
    ]
  })
}

type View = {
  u: UsageSnap | null
  list: ModelTally[]
  samples: Sample[]
  st: SessionStats
  now: number
}

async function view($: EngineInterface): Promise<View> {
  return {
    u: await read($, usage),
    list: await read($, tallies),
    samples: await read($, history),
    st: await read($, stats),
    now: Date.now(),
  }
}

function totals(list: readonly ModelTally[]) {
  const input = list.reduce((s, t) => s + t.input + t.cacheRead + t.cacheWrite, 0)
  const output = list.reduce((s, t) => s + t.output, 0)
  const cacheRead = list.reduce((s, t) => s + t.cacheRead, 0)
  const steps = list.reduce((s, t) => s + t.steps, 0)
  return { input, output, cacheRead, steps, cacheHit: input > 0 ? (cacheRead / input) * 100 : 0 }
}

// ---------- SVG (desktop, mobile, vscode) ----------

const C = {
  bg: '#1b1b1d',
  panel: '#242427',
  line: '#333338',
  text: '#ececf1',
  dim: '#9b9ba5',
  faint: '#6b6b75',
  green: '#34c759',
  amber: '#ff9f0a',
  red: '#ff453a',
  blue: '#3d8bff',
  violet: '#a76bff',
}
const MODEL_COLORS = ['#3d8bff', '#a76bff', '#34c759', '#ff9f0a', '#ff6482', '#5ac8fa']

function toneHex(pct: number): string {
  return pct >= 85 ? C.red : pct >= 60 ? C.amber : C.green
}

function ring(cx: number, cy: number, r: number, pct: number, color: string): string {
  const circ = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct))
  const dash = (p / 100) * circ
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.line}" stroke-width="9"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" ` +
    `stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
  )
}

function txt(x: number, y: number, s: string, size: number, color: string, weight = 400, anchor = 'start'): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`
}

function sparkline(x: number, y: number, w: number, h: number, pts: readonly Sample[], from: number, to: number, color: string): string {
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${C.bg}"/>`
  for (const g of [25, 50, 75]) {
    const gy = y + h - (g / 100) * h
    out += `<line x1="${x}" x2="${x + w}" y1="${gy}" y2="${gy}" stroke="${C.line}" stroke-dasharray="2 4"/>`
  }
  if (pts.length < 2) return out + txt(x + w / 2, y + h / 2 + 4, 'History builds up as you use Claude', 11, C.faint, 400, 'middle')
  const xy = pts.map(p => {
    const px = x + ((p.t - from) / (to - from)) * w
    const py = y + h - (Math.min(100, p.pct) / 100) * h
    return [Math.max(x, Math.min(x + w, px)), py] as const
  })
  const line = xy.map(([a, b]) => a.toFixed(1) + ',' + b.toFixed(1)).join(' ')
  const lastPt = xy[xy.length - 1]!
  const firstPt = xy[0]!
  const area = `${firstPt[0].toFixed(1)},${y + h} ${line} ${lastPt[0].toFixed(1)},${y + h}`
  out += `<polygon points="${area}" fill="${color}" fill-opacity="0.15"/>`
  out += `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`
  out += `<circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="3.5" fill="${color}"/>`
  return out
}

function dashboardSvg(v: View): { source: string; alt: string } {
  const W = 720
  const { u, list, samples, st, now } = v
  const limits = u?.limits ?? []
  const ctx = u?.contextPercent ?? 0
  const t = totals(list)
  let s = ''
  let y = 0

  // header
  s += txt(24, 34, 'Usage', 18, C.text, 600)
  s += `<circle cx="88" cy="28" r="4" fill="${C.green}"/>`
  s += txt(98, 33, 'live', 12, C.dim)
  s += txt(W - 24, 33, u && u.startedAt > 0 ? 'session ' + fmtDur(now - u.startedAt) : '', 12, C.dim, 400, 'end')
  y = 54

  // gauges: each limit plus context
  const gauges: { label: string; pct: number; color: string; sub1: string; sub2: string }[] = limits.map(l => ({
    label: limitName(l.kind),
    pct: l.percentUsed,
    color: toneHex(l.percentUsed),
    sub1: Math.max(0, Math.round((100 - l.percentUsed) * 10) / 10) + '% left',
    sub2: 'resets in ' + resetIn(l, now),
  }))
  gauges.push({
    label: 'Context',
    pct: ctx,
    color: ctx >= 85 ? C.red : C.blue,
    sub1: u?.contextTokens !== undefined ? fmtTok(u.contextTokens) + ' / ' + fmtTok(u.contextWindow) : '—',
    sub2: 'this conversation',
  })
  const n = Math.min(4, gauges.length)
  const colW = (W - 48) / n
  s += `<rect x="16" y="${y}" width="${W - 32}" height="176" rx="12" fill="${C.panel}"/>`
  gauges.slice(0, n).forEach((g, i) => {
    const cx = 24 + colW * i + colW / 2
    const cy = y + 62
    s += ring(cx, cy, 40, g.pct, g.color)
    s += txt(cx, cy + 7, Math.round(g.pct) + '%', 20, C.text, 600, 'middle')
    s += txt(cx, cy + 62, g.label, 13, C.text, 600, 'middle')
    s += txt(cx, cy + 80, g.sub1, 12, C.dim, 400, 'middle')
    s += txt(cx, cy + 96, g.sub2, 12, C.dim, 400, 'middle')
  })
  if (limits.length === 0) {
    s += txt(W / 2, y + 168, 'Plan limits appear after the next reply (Pro/Max plans only)', 11, C.faint, 400, 'middle')
  }
  y += 192

  // pace + reset details per limit
  if (limits.length > 0) {
    const rowH = 26
    const h = 20 + limits.length * rowH
    s += `<rect x="16" y="${y}" width="${W - 32}" height="${h}" rx="12" fill="${C.panel}"/>`
    limits.forEach((l, i) => {
      const ry = y + 28 + i * rowH
      const p = pace(l, samples, now)
      const icon = p.kind === 'hits' ? C.amber : p.kind === 'safe' ? C.green : C.faint
      s += `<circle cx="34" cy="${ry - 4}" r="4" fill="${icon}"/>`
      s += txt(46, ry, limitName(l.kind), 13, C.text, 600)
      s += txt(150, ry, paceText(p), 12, C.dim)
      s += txt(W - 32, ry, resetClock(l) ? 'resets ' + resetClock(l) : '', 12, C.dim, 400, 'end')
    })
    y += h + 16
  }

  // history chart for the 5-hour window (or the first limit)
  const main = limits.find(l => l.kind === 'five_hour') ?? limits[0]
  if (main) {
    const span = main.kind === 'five_hour' ? 5 * HOUR : 7 * 24 * HOUR
    const from = now - span
    const pts = samples.filter(p => p.kind === main.kind && p.t >= from)
    s += `<rect x="16" y="${y}" width="${W - 32}" height="132" rx="12" fill="${C.panel}"/>`
    s += txt(32, y + 26, limitName(main.kind) + ' usage, last ' + (main.kind === 'five_hour' ? '5 hours' : '7 days'), 13, C.text, 600)
    s += txt(W - 32, y + 26, main.percentUsed + '% now', 12, C.dim, 400, 'end')
    s += sparkline(32, y + 38, W - 64, 78, pts, from, now, toneHex(main.percentUsed))
    y += 148
  }

  // stat tiles
  const tiles: [string, string, string][] = [
    ['Turns', String(st.turns), st.turns > 0 ? 'avg ' + fmtDur(st.totalTurnMs / st.turns) : '—'],
    ['Tokens', fmtTok(t.input + t.output), fmtTok(t.input) + ' in · ' + fmtTok(t.output) + ' out'],
    ['Cache hit', Math.round(t.cacheHit) + '%', fmtTok(t.cacheRead) + ' reused'],
    [
      'Cost',
      u?.costUsd !== undefined ? '$' + u.costUsd.toFixed(2) : '—',
      u?.costUsd !== undefined && st.turns > 0 ? '$' + (u.costUsd / st.turns).toFixed(2) + ' / turn' : 'API-priced',
    ],
  ]
  const tw = (W - 32 - 12 * 3) / 4
  tiles.forEach(([label, big, small], i) => {
    const tx = 16 + i * (tw + 12)
    s += `<rect x="${tx}" y="${y}" width="${tw}" height="78" rx="12" fill="${C.panel}"/>`
    s += txt(tx + 14, y + 22, label, 12, C.dim)
    s += txt(tx + 14, y + 50, big, 22, C.text, 600)
    s += txt(tx + 14, y + 68, small, 11, C.faint)
  })
  y += 94

  // models
  const sorted = list.slice().sort((a, b) => b.input + b.output - (a.input + a.output))
  const grand = sorted.reduce((sum, m) => sum + m.input + m.output + m.cacheRead + m.cacheWrite, 0)
  const mh = 54 + Math.max(1, sorted.length) * 20
  s += `<rect x="16" y="${y}" width="${W - 32}" height="${mh}" rx="12" fill="${C.panel}"/>`
  s += txt(32, y + 26, 'Tokens by model', 13, C.text, 600)
  if (sorted.length === 0 || grand === 0) {
    s += txt(32, y + 52, 'Nothing yet', 12, C.faint)
  } else {
    let bx = 32
    const bw = W - 64
    sorted.forEach((m, i) => {
      const share = (m.input + m.output + m.cacheRead + m.cacheWrite) / grand
      const w = Math.max(2, share * bw)
      s += `<rect x="${bx.toFixed(1)}" y="${y + 36}" width="${w.toFixed(1)}" height="8" fill="${MODEL_COLORS[i % MODEL_COLORS.length]}"/>`
      bx += w
      const ly = y + 64 + i * 20
      s += `<rect x="32" y="${ly - 9}" width="10" height="10" rx="2" fill="${MODEL_COLORS[i % MODEL_COLORS.length]}"/>`
      s += txt(50, ly, m.model.replace(/^claude-/, ''), 12, C.text)
      s += txt(W - 32, ly, fmtTok(m.input + m.cacheRead + m.cacheWrite) + ' in · ' + fmtTok(m.output) + ' out · ' + m.steps + ' req · ' + Math.round(share * 100) + '%', 12, C.dim, 400, 'end')
    })
  }
  y += mh + 16

  const H = y
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ` +
    `font-family="-apple-system, Segoe UI, Inter, Roboto, sans-serif">` +
    `<rect width="${W}" height="${H}" rx="16" fill="${C.bg}"/>` +
    s +
    `</svg>`
  const alt =
    'Usage: ' +
    (limits.map(l => limitName(l.kind) + ' ' + l.percentUsed + '% used, resets in ' + resetIn(l, now)).join('; ') ||
      'no plan readings yet') +
    '; context ' + Math.round(ctx) + '%' +
    (u?.costUsd !== undefined ? '; cost $' + u.costUsd.toFixed(2) : '')
  return { source, alt }
}

function bandSvg(v: View, width: number): { source: string; alt: string } {
  const { u, now } = v
  const W = Math.max(320, Math.min(900, width))
  const items: { label: string; pct: number; color: string; tail: string }[] = (u?.limits ?? []).map(l => ({
    label: shortLimit(l.kind),
    pct: l.percentUsed,
    color: toneHex(l.percentUsed),
    tail: '↻ ' + resetIn(l, now),
  }))
  const ctx = u?.contextPercent ?? 0
  items.push({ label: 'ctx', pct: ctx, color: ctx >= 85 ? C.red : C.blue, tail: u?.costUsd !== undefined ? '$' + u.costUsd.toFixed(2) : '' })
  const slot = W / items.length
  let s = ''
  items.forEach((it, i) => {
    const x = i * slot + 6
    const bw = Math.max(40, slot - 150)
    s += txt(x, 17, it.label, 12, C.dim, 600)
    s += `<rect x="${x + 28}" y="9" width="${bw}" height="8" rx="4" fill="${C.line}"/>`
    s += `<rect x="${x + 28}" y="9" width="${((Math.min(100, it.pct) / 100) * bw).toFixed(1)}" height="8" rx="4" fill="${it.color}"/>`
    s += txt(x + 36 + bw, 17, Math.round(it.pct) + '%', 12, C.text, 600)
    s += txt(x + 72 + bw, 17, it.tail, 12, C.dim)
  })
  return {
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 26" width="${W}" height="26" font-family="-apple-system, Segoe UI, Inter, Roboto, sans-serif">` +
      s +
      `</svg>`,
    alt: items.map(it => it.label + ' ' + Math.round(it.pct) + '% ' + it.tail).join(' · '),
  }
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('band')
    if (typeof saved === 'boolean') await update($, band, () => saved)
    const hist = ((await $.store.get('history')) ?? []) as Sample[]
    await update($, history, () => hist)
    try {
      await refreshUsage($)
    } catch {
      // no reading yet; session.measure fills it in
    }
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    $.clock.every(60000, () => {
      void refreshUsage($).catch(() => undefined)
    })
    try {
      await $.command.register({
        name: 'meter',
        description: 'Live usage dashboard: limits, resets, pace, context, tokens, cost',
        argumentHint: '[pane | band on|off]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('could not register /meter: ' + String(err))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const prev = await read($, usage)
    const snap = snapFrom(e, prev?.startedAt ?? 0)
    await update($, usage, () => snap)
    if (e.changed.includes('rateLimits')) {
      await recordSamples($, snap.limits)
      for (const l of snap.limits) {
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

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await update($, stats, s => ({
        turns: s.turns + 1,
        lastTurnMs: e.durationMs,
        totalTurnMs: s.totalTurnMs + e.durationMs,
      }))
    }
    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const [sub, val] = e.args.trim().toLowerCase().split(/\s+/)
    if (sub === 'band' && (val === 'on' || val === 'off')) {
      await update($, band, () => val === 'on')
      await $.store.set('band', val === 'on')
      return { text: 'Usage bar ' + (val === 'on' ? 'shown.' : 'hidden.') }
    }
    if (sub === 'pane') {
      await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true })
      return {}
    }
    // The row this prints is redrawn as a live dashboard by the CommandOutput hook below.
    return { text: 'Usage dashboard' }
  })

  // The live dashboard card, drawn in the conversation where /meter printed its row.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'meter' || e.props.isErrored || e.props.args.trim() !== '') return next(e)
    const v = await view($)
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const d = dashboardSvg(v)
      return <Svg source={d.source} alt={d.alt} />
    }
    return textDashboard($, e, v, 40)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await view($)
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const d = dashboardSvg(v)
      return <Svg source={d.source} alt={d.alt} />
    }
    return textDashboard($, e, v, (e.props.bodyColumns ?? 40) - 16)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, band))) return next(e)
    const v = await view($)
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const b = bandSvg(v, (e.props.bodyColumns ?? 80) * 8)
      return <Svg source={b.source} alt={b.alt} />
    }
    const { Box, Text } = $.ui.resolve(e)
    const { u, now } = v
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

// Terminal fallback: the same figures as text.
function textDashboard($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], v: View, cols: number) {
  const { Box, Text } = $.ui.resolve(e)
  const { u, list, samples, st, now } = v
  const w = Math.max(8, Math.min(30, cols))
  const limits = u?.limits ?? []
  const ctxPct = u?.contextPercent ?? 0
  const t = totals(list)
  return (
    <Box flexDirection="column">
      <Text bold>Plan limits</Text>
      {limits.length === 0 && <Text dimColor>No readings yet — they arrive with the next reply (Pro/Max plans only).</Text>}
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
          <Text dimColor>
            {'  '}
            {paceText(pace(l, samples, now))}
          </Text>
        </Box>
      ))}
      <Text> </Text>
      <Text bold>This session</Text>
      <Text>
        Context: <Text color={tone(ctxPct)}>{bar(ctxPct, w)}</Text> {Math.round(ctxPct)}%
        {u?.contextTokens !== undefined ? ' (' + fmtTok(u.contextTokens) + ' / ' + fmtTok(u.contextWindow) + ')' : ''}
      </Text>
      <Text>
        Turns: {st.turns} · Tokens: {fmtTok(t.input)} in · {fmtTok(t.output)} out · Cache hit {Math.round(t.cacheHit)}%
      </Text>
      {u?.costUsd !== undefined && <Text>Cost (API-priced): ${u.costUsd.toFixed(2)}</Text>}
      <Text> </Text>
      <Text bold>Tokens by model</Text>
      {list.length === 0 && <Text dimColor>Nothing yet.</Text>}
      {list
        .slice()
        .sort((a, b) => b.output - a.output)
        .map(m => (
          <Text>
            {m.model.replace(/^claude-/, '')}: {fmtTok(m.input + m.cacheRead + m.cacheWrite)} in · {fmtTok(m.output)} out · {m.steps} req
          </Text>
        ))}
    </Box>
  )
}
