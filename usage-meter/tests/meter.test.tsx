import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.now()
const IN_2H = new Date(NOW + 2 * 3600000 + 5 * 60000).toISOString()
const IN_3D = new Date(NOW + 3 * 86400000 + 4 * 3600000).toISOString()

const CARD = {
  plugin: 'usage-meter',
  component: 'CommandOutput',
  requestId: 'msg-1',
  props: { command: 'meter', args: '', text: 'Usage dashboard', isErrored: false },
} as const

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

// Five-hour readings over the last 3 hours, rising from 12% to 34%.
const HISTORY = Array.from({ length: 19 }, (_, i) => ({
  t: NOW - (18 - i) * 10 * 60000,
  kind: 'five_hour',
  pct: Math.round(12 + (22 * i) / 18),
}))

function engine(on: On, step = true) {
  mock.store(on, { history: HISTORY })
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 42 * 60000,
      context: { tokens: 50000, window: 200000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 34, resetsAt: IN_2H },
        { kind: 'seven_day', percentUsed: 12, resetsAt: IN_3D },
      ],
      cost: { usd: 1.23 },
    },
  }))
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  if (step) on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: e.model,
        input_tokens: 1200,
        output_tokens: 800,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 300,
      },
    }
  })
}

async function work($: Parameters<Parameters<typeof test>[1]>[0]) {
  for (const [i, model] of ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'].entries()) {
    const s = $.turn.step({ turnId: 't' + i, index: 0, model, messageCount: 1 })
    for await (const _ of s) void _
    await s.result
    await $.turn.complete({ turnId: 't' + i, answer: 'ok', durationMs: 14000 } as never)
  }
}

test('/meter draws a live SVG dashboard card in the app', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await work($)

  const ui = await $.ui.mount({ ...CARD, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  const source = String(svg?.props.source)
  expect(String(svg?.props.alt)).toContain('5-hour 34% used, resets in 2h')
  expect(source).toContain('66% left')
  expect(source).toContain('Cache hit')
  expect(source).toContain('opus-5-5')
  expect(source).toContain('On pace')
  expect(source.length).toBeLessThan(131072)
  console.log('SVG_START' + source + 'SVG_END')
  await ui.unmount()
})

test('the terminal gets the same figures as text', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...CARD, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /5-hour/ }))?.text).toContain('34%')
  expect((await ui.find({ type: 'Text', text: /left/ }))?.text).toMatch(/66% left · resets in 2h [45]m/)
  await ui.unmount()
})

test('the band draws bars in the app and can be hidden', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(String(svg?.props.alt)).toMatch(/5h 34% ↻ 2h/)
  console.log('BAND_START' + String(svg?.props.source) + 'BAND_END')
  await ui.unmount()

  await $.command.run({ command: 'meter', args: 'band off' })
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('model requests pass through unchanged', async ($, on) => {
  engine(on, false)
  const seen: string[] = []
  on('turn.step', async function* (_, e) {
    seen.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s) void _
  await s.result
  expect(seen).toEqual(['claude-opus-5-5'])
})
