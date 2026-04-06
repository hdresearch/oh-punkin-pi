# Handoff: Deterministic Bracket Identity, TUI Left-Gutter Visual, Cache Stability

**Author:** Carter Schonwald
**Date:** 2026-04-05T19:38 America/New_York
**Repo:** `/Users/carter/local_dev/dynamic_science/oh-punkin-pi`
**Branch:** `carter/bringin_home_punkinss`
**HEAD at session start:** `d3de81a6f`
**Session:** `14af2bc530c19c97` ("Deep Analysis Help Request")
**Uncommitted changes:** 8 files, +182/-26 lines, `bun check:ts` clean

---

## What was done

### Problem
The role-boundary system (`wrapUser`, `wrapToolResult`, `wrapSystem` in `packages/ai/src/role-boundary.ts`) generates `[user]{sigil nonce T=... { content } T=... H=hash nonce sigil}` bracket wrapping around every message in the LLM context. Previously, **sigils and nonces were re-rolled randomly on every `convertToLlm` call**. This caused:

1. **Cache-busting:** Every Anthropic API call saw different message text, defeating prompt caching entirely on all non-system content. With 5-minute TTL ("short") and messages changing every call, cache hit rate was ~0%.
2. **No TUI visibility:** The brackets existed only in the LLM text stream. The user never saw them.
3. **No persistence:** Session replay, compaction, log inspection all saw different brackets each time.

### Solution: Persisted `BracketId` on every message type

**Core type** (already existed):
```typescript
interface BracketId { readonly sigil: string; readonly nonce: string }
```

**Every message type** now carries `bracketId?: BracketId`:
- `UserMessage` (already had it)
- `ToolResultMessage` (added to `packages/ai/src/types.ts`)
- `BashExecutionMessage`, `PythonExecutionMessage`, `CustomMessage`, `HookMessage`, `FileMentionMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage` (added to `packages/coding-agent/src/session/messages.ts`)

**Generated once at creation, stored forever:**

| Message type | Generator | Codebook | Creation site |
|---|---|---|---|
| user | `generateUserBracketId()` | USER (nature words, emoji sigils) | `agent-session.ts prompt()` |
| toolResult | `generateToolResultBracketId()` | TOOL_RESULT (materials science, tool emojis) | `agent-loop.ts executeToolCalls` + `createAbortedToolResult` |
| bashExecution | `generateUserBracketId()` | USER | `agent-session.ts recordBashResult` |
| pythonExecution | `generateUserBracketId()` | USER | `agent-session.ts recordPythonResult` |
| custom | `generateUserBracketId()` | USER | `messages.ts createCustomMessage` |
| hookMessage | (legacy, rehydrated) | USER | session rehydration preserves stored |
| fileMention | `generateSystemBracketId()` | SYSTEM (infra words, box-drawing sigils) | `file-mentions.ts generateFileMentionMessages` |
| branchSummary | `generateSystemBracketId()` | SYSTEM | `messages.ts createBranchSummaryMessage` |
| compactionSummary | `generateSystemBracketId()` | SYSTEM | `messages.ts createCompactionSummaryMessage` |

**`convertToLlm` uses stored identity:** All `wrapUser(text, params)`, `wrapSystem(text, params)`, `wrapToolResult(text, params)` calls now pass `m.bracketId` as optional 3rd arg. When present, uses stored sigil/nonce. When absent (old sessions), falls back to random generation (backwards compat).

### TUI visual brackets (user messages)

`UserMessageComponent` renders a left-gutter visual bracket when `bracketId` is present:

```
┌ 🐉 copper-blaze-kelp T=2026-04-05T17:06:13 NYC turn:3
│  fix the build please
└ T=2026-04-05T17:08:38 NYC Δ2m25s H=a1b2c3d4e5f6 copper-blaze-kelp 🐉
```

- **Top line:** sigil + nonce + start timestamp (prev block end) + turn number
- **Bottom line:** end timestamp (submission) + Δ (end - start = floor-hold time) + SHA3 hash + nonce + sigil
- **Left gutter** `│ ` on content lines, dim colored
- **No right border** (avoids reflow)
- **NYC suffix** on timestamps (Carter's timezone, immediately readable)
- **Same sigil+nonce on both lines** for visual pair matching
- **OSC 133 zone markers** on outermost lines for terminal multiplexer integration

### Turn counter reset bug fix

**Bug:** `#refreshCarterKitHook()` calls `createCarterKitHook()` which initializes `currentTurn = 0`. On session resume/switch, turn counter reset to 0. `initializeTurnCounterFromEntries` existed but was never called, and searched for `entry.type === "turn_boundary"` which doesn't exist (turn boundaries stored as `type: "message"`).

**Fix:** After creating hook, scan `agent.state.messages` for turnStart/turnEnd messages, take max turn number, feed to `initializeTurnCounterFromEntries`.

### New exports from `role-boundary.ts`

- `sha3Trunc(content: string): string` — SHA3-256 truncated to 12 hex chars
- `formatTimestamp(ms: number): string` — full ISO 8601 in NYC timezone with offset
- `formatTimestampNYC(ms: number): string` — short format with "NYC" suffix for TUI
- `formatDeltaMs(ms: number): string` — human-readable duration (e.g. "2m25s", "1h3m")
- `generateUserBracketId(): BracketId`
- `generateToolResultBracketId(): BracketId`
- `generateSystemBracketId(): BracketId`

---

## Files changed (8)

| File | +/- | What |
|---|---|---|
| `packages/ai/src/types.ts` | +1 | `bracketId` on `ToolResultMessage` |
| `packages/ai/src/role-boundary.ts` | +63/-8 | Exported helpers, generators, optional bracketId param on wrap functions |
| `packages/agent/src/agent-loop.ts` | +3 | `bracketId` on both ToolResultMessage creation sites |
| `packages/coding-agent/src/session/messages.ts` | +31/-7 | `bracketId` on 7 message interfaces, generators in factory functions, all convertToLlm wrap calls pass bracketId |
| `packages/coding-agent/src/session/agent-session.ts` | +23/-1 | bracketId on user/bash/python messages, turn counter fix |
| `packages/coding-agent/src/utils/file-mentions.ts` | +2 | bracketId on FileMentionMessage |
| `packages/coding-agent/src/modes/components/user-message.ts` | +68/-4 | Left-gutter bracket rendering |
| `packages/coding-agent/src/modes/utils/ui-helpers.ts` | +17/-3 | Turn index tracking, prev timestamp tracking, bracket data passing |

---

## Not yet done (ordered by priority)

### 1. Old session migration (HIGH — cache stability)
Messages from sessions created before this change have no `bracketId`. `convertToLlm` falls back to random generation for them, which is cache-busting. Need a migration pass on session load: iterate messages, if no `bracketId`, generate and stamp one based on role. Should be a flag that defaults to on. Best location: in `#refreshCarterKitHook()` after the turn counter initialization, or in the session loading path after `agent.replaceMessages()`.

**This is the single most impactful remaining item** — without it, every existing session cache-busts on every API call for the entire message history.

### 2. TUI visual brackets for non-user messages (HIGH — visual completeness)
The `┌│└` gutter currently only renders in `UserMessageComponent`. Need it on:
- `ToolExecutionComponent` — tool results (streaming, collapse/expand)
- `AssistantMessageComponent` — assistant responses (streaming, thinking blocks)
- `BashExecutionComponent` — bash ! executions (streaming output)
- `PythonExecutionComponent` — python $ executions (streaming)
- `BranchSummaryMessageComponent` — branch summaries (static, collapsible)
- `CompactionSummaryMessageComponent` — compaction summaries (static, collapsible)
- `CustomMessageComponent` — extension messages

**Recommended approach:** Extract `applyBracketGutter(lines, params)` from `UserMessageComponent` into a shared `bracket-gutter.ts` utility. Each component's `render()` calls this as a final pass.

### 3. UI settings toggle (MEDIUM)
`enableBrackets: boolean` defaulting to `true` in settings schema. Controls TUI gutter rendering only — `convertToLlm` always uses stored bracketId regardless. Display toggle, not data toggle.

### 4. UiHelpers state initialization from history (MEDIUM)
`#turnIndex` and `#prevMessageEndTimestamp` reset to 0/undefined on session reload. Need initialization from message history in `renderSessionContext` — same class of bug as the turn counter reset.

### 5. AssistantMessage bracketId (MEDIUM)
`AssistantMessage` type (in `packages/ai/src/types.ts`) doesn't have `bracketId` field. Would be stamped in agent-session's turn_end handler. Needed for TUI assistant brackets and full determinism of assistant wrapping (if/when `wrapAssistant` is wired into convertToLlm — currently commented out due to echoing risk).

### 6. Cache retention default (LOW)
Currently `"short"` (5-minute TTL). With deterministic brackets, `"long"` (1-hour) is now viable since message content is stable. Consider changing default or adding a UI toggle. Env override: `PI_CACHE_RETENTION=long`.

### 7. Squiggle/CoT bracket positioning (LOW — design question)
Carter specified squiggle brackets should render AFTER the agent's turn closes, not inline during streaming. This is a rendering order change. Current behavior: squiggle tool results render inline. Deferred.

### 8. CoT disappearing after squiggle close (INVESTIGATE)
Carter observed reasoning text vanishing after `close_squiggle` tool calls. Possibly: thinking blocks being stripped between turns by context management, or `reifyThinkingAsSquiggle` interaction. Worth verifying squiggle content persists in subsequent LLM calls.

---

## Design decisions (recorded)

1. **Brackets always in LLM context** — `convertToLlm` always wraps with stored bracketId. UI setting only controls TUI gutter display.
2. **NYC timestamps in TUI** — offset dropped for readability, "NYC" suffix. Full ISO with offset preserved in JSONL and LLM context.
3. **Delta on bottom line** — `Δ = endTimestamp - startTimestamp`. For users: floor-hold time. For tools: execution duration. Same semantics, same position.
4. **Start timestamp for user messages** — previous block's end time (system-observable "your turn began"), NOT typing start (unknowable). End = submission time.
5. **No right border** — left gutter only, avoids terminal reflow.
6. **Messages are self-describing artifacts** — sigil+nonce = identity, hash = integrity, timestamps = temporal span. The LLM text is a rendering of stored fields, not the source of truth.
