# usage-meter

A Claude Code mod that shows your usage live, with no other side effects (it never changes models, prompts or tools).

- A bar above the prompt: `5h 34% ↻2h 5m │ wk 12% ↻3d 4h │ ctx 25% · $1.23`
- `/meter` opens a dashboard: 5-hour and weekly limit bars, % left, time until reset (countdown and clock time), context fill, session cost, tokens by model
- A popup when a limit passes 90%
- `/meter band off` hides the bar, `/meter band on` brings it back

Install in the Claude app: Add marketplace → `ikrayse/duo-market` → install **usage-meter**.
Limit readings appear after the first reply in a session, and only on a Pro/Max plan.
