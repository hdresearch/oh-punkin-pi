# Handoff: Turn Bracket Prefill

**Author**: Carter Schonwald  
**Session**: 2026-02-24T17:18–17:57 EST  
**Branch**: `carter/converting/allthings`  
**Status**: Partial implementation, reverted to buildable state

---

## Summary

Implementing assistant turn bracketing to match user message format:
- User messages arrive wrapped: `[user]{sigil nonce T=timestamp turn:N {...} T=time H=hash nonce sigil}`
- Assistant messages should have same structure via prefill (model sees opening bracket) + system append (closing bracket with hash)

---

## Completed Work

### 1. Theme Embed Fix (DONE, UNTESTED)

**File**: `packages/coding-agent/src/modes/interactive/theme/theme.ts`

**Problem**: Binary copied to `~/.local/bin/` crashed with ENOENT looking for `theme/dark.json` relative to binary.

**Fix**: Embedded dark/light themes directly as TypeScript objects in `getBuiltinThemes()`. No filesystem access needed for builtin themes.

**Lines**: ~441-590 (replaced `fs.readFileSync` with inline theme JSON)

### 2. Turn Bracket Infrastructure (DONE)

**File**: `packages/coding-agent/src/core/carter_kit/turn-bracket.ts` (NEW)

Pure functions for bracket generation:
```typescript
interface TurnBracketState {
  sigils: { user: string; squiggle: string };
  nonces: { user: string; squiggle: string };
  turn: number;
  startTime: number;
  openTag: string;
}

mkOpenBracket(turn: number): TurnBracketState
mkCloseTag(state: TurnBracketState, content: string): string
wrapContent(state: TurnBracketState, content: string): string
```

### 3. Session Hook Extensions (DONE)

**File**: `packages/coding-agent/src/core/carter_kit/session-hook.ts`

Added to `CarterKitHook` interface and implementation:
- `turnStart(turnIndex: number): TurnBracketState`
- `currentBracket: TurnBracketState` (getter)
- `wrapAssistantContent(content: string): string`

---

## Reverted Work

The following changes were reverted because they attempted to inject prefill at the wrong layer:

1. **sdk.ts**: Tried to add prefill as `AgentMessage` in `transformContext`
2. **agent-session.ts**: Added `carterKitRef` to config, bracket wrapping in `message_end`

**Why it failed**: `transformContext` operates on typed `AgentMessage[]` which requires full `AssistantMessage` fields (api, provider, model, usage, stopReason). Prefill is a raw API concept—a partial assistant message that goes directly to Anthropic, not a domain message.

---

## Correct Approach

Prefill must be injected at the **provider/API layer**, not the agent message layer.

### Option A: Add prefill to stream options

1. Add `prefill?: string` to `StreamOptions` in `packages/ai/src/types.ts`
2. In `packages/ai/src/providers/anthropic.ts` `convertMessages()`:
   - If prefill provided, append `{ role: "assistant", content: prefill }` to messages
3. Generate bracket state in session layer, pass prefill string through stream call
4. On response, prepend the bracket to stored message content

### Option B: Provider-level hook

1. Add `assistantPrefill?: string` to `Context` type
2. Handle in `buildParams` or `convertMessages` in anthropic.ts
3. Same session-layer coordination for state

### Key Insight

The Anthropic API returns only the **continuation** after prefill—it doesn't include the prefilled text in the response. So:
1. Generate bracket, store state
2. Send bracket as prefill
3. On response completion, **prepend** stored bracket to the text
4. Compute hash, append closing bracket
5. Store fully bracketed message

---

## Reference: Anthropic Prefill

From `https://platform.claude.com/llms-full.txt`:

```python
messages=[
    {"role": "user", "content": "What is your favorite color?"},
    {"role": "assistant", "content": "As an AI assistant, I"}  # Prefill
]
```

- Prefill cannot end with trailing whitespace
- Not compatible with extended thinking mode
- Response continues from where prefill ends

---

## Files to Review

```
packages/coding-agent/src/modes/interactive/theme/theme.ts     # Theme embed (test this)
packages/coding-agent/src/core/carter_kit/turn-bracket.ts     # Pure bracket functions (keep)
packages/coding-agent/src/core/carter_kit/session-hook.ts     # Hook extensions (keep)
packages/ai/src/types.ts                                       # Add prefill option here
packages/ai/src/providers/anthropic.ts                         # Inject prefill here
```

---

## Test Plan

1. Build binary: `npm run build:binary --workspace=packages/coding-agent`
2. Copy to ~/.local/bin/: `cp builds/punkin ~/.local/bin/`
3. Run `punkin` — should not crash on theme load
4. For bracket feature: implement provider-level prefill, then test turn structure
