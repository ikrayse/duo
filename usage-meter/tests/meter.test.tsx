import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'usage-meter',
  component: 'Pane',
  requestId: 'usage-meter',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const IN_2H = new Date(Date.now() + 2 * 3600000 + 5 * 60000).toISOString()

function engine(on: On) {
  mock.store(on)
  mock.clock(on, { now: Date.now() })
  on('session.usage', () => ({
    value: {
      startedAt: Date.now() - 600000,
      context: { tokens: 50000, window: 200000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 34, resetsAt: IN_2H },
        { kind: 'seven_day', percentUsed: 12, resetsAt: IN_2H },
      ],
      cost: { usd: 1.23 },
    },
  }))
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('the dashboard shows limits, % left, reset time and cost', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /5-hour session/ }))?.text).toContain('34%')
    expect((await ui.find({ type: 'Text', text: /left/ }))?.text).toMatch(/66% left · resets in 2h [45]m/)
    expect((await ui.find({ type: 'Text', text: /Cost/ }))?.text).toContain('$1.23')
    await ui.unmount()
  }
})

test('the band shows a compact line and can be hidden', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toMatch(/5h 34% ↻2h/)
  await ui.unmount()

  await $.command.run({ command: 'meter', args: 'band off' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('model requests pass through unchanged and are tallied', async ($, on) => {
  engine(on)
  const seen: string[] = []
  on('turn.step', async function* (_, e) {
    seen.push(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s) void _
  await s.result
  expect(seen).toEqual(['claude-opus-5-5'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /opus-5-5/ }))?.text).toContain('1.0k in · 500 out · 1 req')
  await ui.unmount()
})
