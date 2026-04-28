Set the harness scheduler mode to `co_design` when autonomous continuation should yield to Carter.

Use this when progress needs user choice, design review, risk-boundary confirmation, blocker resolution, or other feedback before continuing.

Rules:
- You may only enter `co_design`.
- You may not switch back to eager/autonomous mode; Carter or the harness does that.
- Provide a concise `message` describing exactly what input is needed.
- Do not use this just because a task is incomplete. Incomplete runnable work should continue in eager mode.
