# Subagent prepare/spawn: plans as data

Author: Carter Schonwald (via agent)
Date: 2026-04-20
Repo: `oh-punkin-pi`
Related: `docs/subagent-prompt-overhead-feedback.md`

## 1. Motivation

Three concerns collapse into one refactor.

### 1.1 Prompt-prefix tax (prior feedback note)

Per the 2026-04-19 feedback note, sibling subagents launched via the `task` tool burn 100–200K tokens each on what should be sub-5K-token judgment work. Tracing the harness:

- `packages/coding-agent/src/task/index.ts:721-724` passes `session.skills` and `session.contextFiles` verbatim into every subagent (only `AGENTS.md` is filtered).
- `packages/coding-agent/src/task/executor.ts:965-972` wraps the full parent `system-prompt.md` expansion as `{{base}}` inside `subagent-system-prompt.md`.
- `packages/ai/src/providers/anthropic.ts` and `openai-responses.ts` key prompt caches by per-subagent `sessionId`, so sibling subagents in the same batch cannot share a cache entry even when their system prompts are identical except for the per-task assignment.

Floor per subagent is ~15–25K input tokens before any work; with 10 turns and 8 siblings, 150–250K is the expected cost even for trivial tasks.

### 1.2 Model/prompt experimentation

There is no first-class way to run "same task, five models" or "same task, prompt variants A/B/C" in one harness. People hand-build ad-hoc harnesses.

### 1.3 Parent-agent cost-awareness

The `task` tool is atomic: fill args, fan out, pay. The parent has no way to inspect what it is about to spend before committing, or to reason about the spawn plan in subsequent turns.

All three problems share a root cause: the subagent invocation is a **hidden, one-shot computation** instead of a **data record the parent can inspect, vary, and commit**.

## 2. Architecture

Two-phase: `prepare` (pure, returns plan) → `spawn` (side-effectful, consumes plans).

### 2.1 SubagentPlan record

```ts
interface SubagentPlan {
  id: string;                    // artifact id, referenceable as plan://<id>
  createdAt: string;             // ISO-8601
  agent: string;                 // resolved agent name
  task: string;                  // the actual work prompt
  assignment?: string;           // batch-item assignment body

  // Fully resolved prompt material (snapshot at prepare time)
  systemPrompt: string;          // pre-rendered, ready to send
  toolNames: string[];           // resolved tool allowlist
  contextFiles: ContextFileSnapshot[];  // {path, content, sha256}
  skills: SkillSnapshot[];       // {name, description, sha256}
  outputSchema?: JTDSchema;

  // Execution config
  model: string;
  thinking: "minimal" | "low" | "medium" | "high";
  isolation: { mode: "worktree" | "fuse-overlay" | "projfs" | "none"; worktree?: string };

  // Batch / cache coordination
  cacheKey: string;              // hash of systemPrompt + toolNames; siblings sharing this key share cache
  cacheGroup?: string;           // optional caller-supplied group; overrides automatic grouping

  // Accounting (pre-execution estimates)
  estimate: {
    inputTokens: number;         // prompt + tool schemas
    toolSchemaTokens: number;
    contextFileTokens: number;
    skillTokens: number;
    systemPromptTokens: number;
  };

  // Provenance
  resolvedFrom: {
    agentFrontmatter: Record<string, unknown>;
    intentOverrides: Record<string, unknown>;
    computedDefaults: Record<string, unknown>;
  };
}
```

Plans are **immutable** once created. Context file content and skill content are snapshotted at prepare time (by hash). A plan is a receipt: "here is exactly what would be sent if you spawn this."

### 2.2 `prepare(intent) → SubagentPlan`

Pure function of `(intent, parentSessionState, time)`. No network I/O, no subprocess launch.

```ts
interface SubagentIntent {
  agent: string;                 // required; resolves to AgentDefinition
  task: string;                  // required
  assignment?: string;
  context?: string;              // shared batch context string

  // Overrides (each has a default from agent frontmatter, then a hardcoded fallback)
  inherit_context?: boolean | string[];   // which parent context files
  inherit_skills?: boolean | string[];    // which parent skills
  tools?: string[];                       // tool allowlist override
  mini_prompt?: boolean;                  // skip full base system-prompt.md
  model?: string;
  thinking?: "minimal" | "low" | "medium" | "high";
  output_schema?: JTDSchema;
  isolated?: boolean;

  // From previous plan (shortcut for variants)
  from_plan?: string;            // plan://<id> or <id>
}
```

`from_plan` clones the resolved config from an existing plan; any other field in intent overrides. This is the primary ergonomics for experiments.

### 2.3 Resolution cascade

Every knob resolves by walking:

1. **Hardcoded default** (e.g. `inherit_context: false` for read-only agents, `true` for `task`)
2. **Agent frontmatter** (if author set one, wins over hardcoded)
3. **Intent override** (if caller set one, wins over frontmatter)
4. **Computed implications** (applied last; only fire for knobs the caller did not set explicitly)

Example implication: `mini_prompt: true` with no explicit `inherit_skills` → computed `inherit_skills: false`. Spelled out in one table in the implementation so it is greppable.

### 2.4 `spawn(plans) → Handle[]`

```ts
spawn(plans: SubagentPlan[], opts?: {
  dry_run?: boolean;             // if true, return would-be handles with estimates only
  share_cache?: boolean;         // default true; groups plans by cacheKey
}): Promise<SubagentHandle[]>
```

Inside `spawn`:

1. Group `plans` by `cacheKey` (or `cacheGroup` if supplied).
2. For each group, pick one plan as the cache seed; subsequent plans in the group reuse that cache key at the provider call site.
3. Launch in parallel (or serial if caller requests), stream results as they arrive.
4. Each `SubagentHandle` carries `plan_id`, `usage`, `result`, `error`, `artifacts`.

## 3. Tool surface

Surfaced to the parent agent as two tools, not one.

### 3.1 `prepare_subagent`

```
input:  SubagentIntent
output: {
  plan_id: string;
  estimate: { inputTokens, toolSchemaTokens, contextFileTokens, skillTokens, systemPromptTokens };
  model, thinking, cacheKey;
  contextFilesIncluded: string[];
  skillsIncluded: string[];
  toolNames: string[];
  artifact_uri: "plan://<id>";
}
```

Side-effect-free except for persisting the plan artifact. Cheap to call; no model invocation.

### 3.2 `spawn_subagents`

```
input:  { plan_ids: string[], dry_run?: boolean, share_cache?: boolean }
output: { handles: [{ plan_id, handle_id, result_uri, usage, error? }] }
```

If `dry_run: true`, returns handles with `estimate` only, no execution. Useful for budget checks.

### 3.3 Plan artifact URIs

Plans are addressable via `plan://<id>`. Parent agent can:

- `read(plan://<id>)` to inspect
- pass `plan://<id>` as `from_plan:` in a subsequent `prepare_subagent` call for variants
- list `spawn_subagents` plan_ids

Plan artifacts persist for the session; cleanup on session close.

### 3.4 Backward compat: `task` becomes sugar

```
task({ agent, tasks, context, schema, isolated }) =
  spawn_subagents({
    plan_ids: tasks.map(t => prepare_subagent({ agent, task: t.task, assignment: t.assignment, context, output_schema: schema, isolated }).plan_id)
  })
```

Existing `task` callers see no change. New capability is additive.

## 4. Cross-sibling optimizations

### 4.1 Shared cache key

Current: each subagent session has its own `sessionId`, used as cache key at provider edge. Siblings cannot share.

New: `cacheKey = sha256(systemPrompt + JSON.stringify(toolNames) + model)`. Plans with identical prefix hash to the same key. At provider call site:

- **Anthropic**: use this key to select the ephemeral cache block; first sibling writes, rest read.
- **OpenAI Responses**: set `prompt_cache_key = cacheKey` instead of `sessionId`.

Cost collapse: `N × floor` → `1 × floor + (N-1) × cache-read`, where cache-read is typically 10–30% of full-write depending on provider.

### 4.2 Worktree reuse

If multiple plans share `cacheKey` and are read-only (no write tools in `toolNames`), they can share one worktree instead of one per subagent. Cheap and already safe — today every subagent gets its own worktree even for read-only agents.

### 4.3 Model batching

Where provider supports batched inference (Anthropic batch API, OpenAI batch), `spawn_subagents` with many plans can route through it. Not MVP, but the plan abstraction makes it a drop-in later.

## 5. Experiment runner

The killer feature. Plans are data, so variation is just a map.

```ts
const base = await prepare_subagent({
  agent: "reviewer",
  task: "find correctness bugs in src/parser.ts",
});

const variants = await Promise.all([
  prepare_subagent({ from_plan: base.plan_id, model: "claude-sonnet-4.5" }),
  prepare_subagent({ from_plan: base.plan_id, model: "gpt-5" }),
  prepare_subagent({ from_plan: base.plan_id, model: "pi/smol", thinking: "minimal" }),
  prepare_subagent({ from_plan: base.plan_id, tools: base.toolNames.filter(t => t !== "web_search") }),
]);

const results = await spawn_subagents({ plan_ids: variants.map(v => v.plan_id) });
// structured outputs via shared schema; diff by plan_id.
```

### 5.1 Ablations

Flip one knob, re-prepare, compare. `inherit_skills: false` vs `true`, `mini_prompt` on vs off, tool subset A vs B.

### 5.2 Prompt regression testing

Plans serialize as JSON. Freeze a set of plans + expected outputs → rerun monthly → diff. No separate harness; the `plan://` URIs are the fixtures.

### 5.3 Cross-provider drift detection

Same plan, rotate `model:` across providers. Structured outputs via `output_schema` make the diff mechanical.

### 5.4 Failure replay

A failed subagent run has a `plan_id`. Re-spawn that plan_id. Modulo model nondeterminism (controllable via temperature in the plan), reproduces.

## 6. Observability

### 6.1 Plan-level accounting

`prepare_subagent` returns `estimate.*Tokens` pre-execution. Sibling project's "how much is fixed overhead vs work" question answered before spending a cent.

### 6.2 Spawn-level accounting

`handle.usage` includes actual `input`, `output`, `cacheRead`, `cacheWrite`. `handle.usage.input - plan.estimate.inputTokens * numTurns` approximates additional per-turn overhead (tool results, reminders). Prefix-vs-generation split becomes arithmetic on existing fields.

### 6.3 Cache hit telemetry

Group by `cacheKey`. Expected ratio: one write + (N-1) reads per group. Deviations mean the cache sharing is broken; easy to alarm on.

## 7. Edge cases

### 7.1 Plan staleness

Context file content is **snapshotted** (content + sha256) at prepare time. If the parent edits a context file between `prepare` and `spawn`, the plan uses the snapshot, not the current content. Callers who want freshness re-prepare.

This is deliberate. Plans as data means plans must be deterministic once created.

### 7.2 Skill set changes

Same rule: skills snapshotted by `{name, description, sha256(body)}`. If a skill updates between prepare and spawn, the old one runs. Re-prepare for fresh.

### 7.3 Worktree lifecycle

Worktrees are created at `spawn`, not `prepare`. A prepared-but-unspawned plan has no worktree. Multiple plans in a `spawn_subagents` call with `isolated: true` each get their own worktree (unless 4.2 read-only sharing applies).

### 7.4 Parent context mutation

If the parent session loads a new context file or skill between `prepare` and a later `prepare` of a variant, the variant sees the new parent state. Plans are independent receipts; they do not reach back into parent state.

### 7.5 Security boundary

Plans contain full `systemPrompt`, `contextFiles` content, and `toolNames`. Persisting to `plan://<id>` means the artifact carries the same sensitivity as the session. Artifacts MUST obey session-scope deletion; do not leak across sessions.

## 8. Migration

Phased.

**Phase 1**: Add `prepare_subagent` / `spawn_subagents` alongside existing `task`. Internal refactor: `task` delegates to them. No behavior change for callers.

**Phase 2**: Add cache-key sharing inside `spawn`. Immediate cost win for all existing `task` callers.

**Phase 3**: Expose prepare/spawn in tool registry. Update agent prompts to mention them for experiment-style workflows; keep `task` as the ergonomic default.

**Phase 4**: Add `inherit_context`, `inherit_skills`, `mini_prompt`, `tools` overrides. Default values tuned per agent archetype (explore/reviewer/librarian get narrow defaults; `task` stays permissive).

**Phase 5**: Observability surface: `plan.estimate` in tool output, handle.usage split, cache-hit telemetry.

Each phase is independently shippable; phase 2 alone would resolve the prior feedback note's immediate complaint.

## 9. Open questions

- Should `prepare_subagent` itself cost any tokens? If it renders the system prompt eagerly, it spends compute but no API tokens. Probably fine.
- How long do `plan://` artifacts live? Session-scoped is the default; cross-session persistence is a separate feature.
- Who decides the cache grouping when plans differ only slightly? Simple rule: exact `cacheKey` match. No fuzzy grouping in v1.
- Where do "computed defaults" live? One table in `prepare.ts`; greppable, testable.

## 10. Short version

Make the subagent plan a data record. `prepare` produces it, `spawn` consumes one or many. Parent agent can inspect, vary, commit. Sibling subagents with identical plans share cache. Model and prompt experiments fall out for free because varying a plan is `{...base, model: "X"}`. The prior feedback note's prompt-overhead complaint and Carter's experiment-harness wish are the same refactor.
