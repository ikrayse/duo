# usage-meter

A Claude Code / Cowork mod that shows your usage live. It only reads usage numbers: it never changes models, prompts or tools.

- `/meter` opens a live dashboard in a pane beside the chat, so it stays in view and keeps updating as you work: ring gauges for the 5-hour and weekly limits and context, % left, reset countdowns and clock times, a pace forecast (will you hit the limit before it resets?), a 5-hour history chart, turns, tokens, cache hit rate, cost per turn, and tokens by model.
- A compact bar above the prompt: limit bars, reset countdowns, context and cost.
- `/meter card` drops the same dashboard into the conversation instead (it scrolls with the chat). `/meter band off` hides the bar, `/meter band on` brings it back.
- A popup when a limit passes 90%.

Install: Customize → Plugins → Add marketplace → `ikrayse/duo` → install **usage-meter**.
Limit readings appear after the first reply in a session, and only on Pro/Max plans.
