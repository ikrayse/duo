# usage-meter

A Claude Code / Cowork mod that shows your usage live. It only reads usage numbers: it never changes models, prompts or tools.

- `/meter` puts a live dashboard card in the conversation: ring gauges for the 5-hour and weekly limits and context, % left, reset countdowns and clock times, a pace forecast (will you hit the limit before it resets?), a 5-hour history chart, turns, tokens, cache hit rate, cost per turn, and tokens by model.
- A compact bar above the prompt: limit bars, reset countdowns, context and cost.
- `/meter pane` opens the dashboard in a side pane. `/meter band off` hides the bar, `/meter band on` brings it back.
- A popup when a limit passes 90%.

Install: Customize → Plugins → Add marketplace → `ikrayse/duo` → install **usage-meter**.
Limit readings appear after the first reply in a session, and only on Pro/Max plans.
