Pause your token spend until an event occurs.

<frame>
`await_one` is NOT "block until jobs complete" — that's a thread-model that doesn't fit LLM agents. You yield your cognition budget; while parked, the cost of waiting is zero. Don't reach for "something useful to do" in the meantime — there isn't one. Parking and re-entering is cheap.
</frame>

<semantics>
Returns on the **first** of these events:

1. **`job_event`** — a watched background job transitions to completed/failed/cancelled.
2. **`pending_message`** — a user message lands in the session queue.
3. **`timeout`** — `timeoutSec` elapses (default `600` / 10 min). Not cumulative across calls — each invocation resets.
4. **`aborted`** — the tool call was externally cancelled.

The call is **non-cancelling**: jobs keep running regardless of wake reason. If a user message lands while you were waiting on a long job, the tool returns with the job still running; you decide via judgment whether to `cancel_job` or let it finish.
</semantics>

<usage>
- Use this instead of polling `read jobs://` in a loop. Polling burns tokens; parking doesn't.
- Pass `jobs: ["id1", "id2"]` to watch specific jobs. Omit to wait on any running job.
- Re-call `await_one` to continue parking — timeout is a wake-ceiling, not a deadline.
- Any need for `Promise.all`-style "wait for everything" resolves to a loop of `await_one` calls; there is no `await_all`.
</usage>

<returns>
A report of watched jobs with their current status plus a `wakeReason` indicating which event ended the wait.
</returns>
