# DCP Handoff Document

**Date**: 2026-02-19  
**Session**: design conversation, Noah + Carter context  
**Artifacts**: `/Users/noah/dcp/`, snapshot at `/tmp/dcp-sessions/20260219-182339-design/`

**Provenance**: Carter Schonwald drove Noah's agent session to produce this spec.
Noah had no AGENTS.md prior to 2026-02-21. Architecture is Carter's; Noah's agent
was the scribe. See also `docs/specs/*.md` (Carter's agent as scribe) for the
model-facing API layer of the same design.

## What DCP Is

Dynamic Compaction Protocol. Context management for unbounded
agent sessions. The context window is a TLB, not a log.

Core mechanism: shadow clone (Vers VM branch) of the agent does
compaction — clone has full context, produces skeletal form,
parent splices it in. Full invertibility via external store
(nothing is ever lost, just changes residency).

## Key Design Decisions Made

1. **Shadow clone compaction** — fork the agent VM, clone has
   full context, produces compaction. Not a separate model, not
   a deterministic extractor.

2. **Fully invertible** — external store holds verbatim turns +
   full CoT. Skeletal form in-context is a cache line. Store has
   the page. Snapshot rollback is disaster recovery, not the
   protocol.

3. **CoT persistence + full readability** — all chain of thought
   is captured, persisted, addressable, readable by operator.
   Provider norms about CoT privacy are rejected. Operator paid
   for the compute, operator owns the reasoning.

4. **Reroll-forward amortization** — compaction invalidates prompt
   cache prefix. Batch compactions to minimize reroll events.
   Sawtooth pressure model. Break-even horizon calculation.

5. **Async tool calls with CBN handles** — tool results don't
   splatter into context. Handles are thunks. Push-down DSL
   (grep, slice, Lua sub-computation) for surgical materialization.
   Materialization budget per turn.

6. **Idempotent tool call classification** — pure calls cached +
   deduplicated, non-idempotent calls journaled as state
   transitions, never re-executed by clones.

7. **Knowledge is a content-addressed graph** — not text, not
   token sequences. Nodes and edges with content hashes. Stable
   under identity corrections (local edge update, not global
   string surgery). Citation mode is a presentation concern
   (hashes for machines, coordinates for operators, semantic
   paths for agents, prose for humans).

8. **Rolling hash chunking** — content-defined boundaries via
   Rabin fingerprint, not fixed turn boundaries. Edit-stable,
   dedup-friendly, hierarchical (fine/medium/coarse).

9. **Oracle panel is the primary UI** — native Swift (SwiftUI +
   AppKit), not console, not Electron, not web. The operator's
   tool for reading the agent's mind (CoT), editing its knowledge
   graph, pinning/injecting/demoting context. GUI-first, console
   is the fallback.

10. **Haskell core + Swift UI** — the domain is algebraic (ADTs,
    DAGs, union-find, semilattices, content-addressed stores).
    Haskell for the core harness. Swift for the native panel.
    CBOR on UDS between them.

11. **DSML from DeepSeek** — adopt `<｜ ｜>` single-token delimiters
    for tool call framing. Don't extend with intent metadata on
    the model side — model is a stochastic parrot, let it do CoT +
    tool calls. Harness infers intent from CoT post-hoc.

12. **Don't over-structure model output** — no typed output blocks,
    no intent annotations, no explicit dependency declarations.
    Model does what it's good at (reasoning, tool calls). Harness
    does the structuring. Operator corrects via panel.

13. **Wire format**: CBOR (machine-to-machine), TOML (human-facing
    config), raw blobs for bulk storage. No protobuf, no JSON.

14. **KangarooTwelve** for content hashing — Keccak family, XOF,
    tree hashing built in. FFI to XKCP (reference C implementation
    by the Keccak team). Not crypton. Not pure Haskell crypto.

15. **Entity reasoning integration** (Schonwald) — discourse
    coordinates are ephemeral display hints, content hashes are
    stable identity. Mentions vs handles. Closed evidence modules.
    Underdetermined as first-class. Constraint graph for coreference.

## What's Specced

- `DESIGN.md` — full design document (~3200 lines)
- `specs/00-INDEX.md` — 17 subsystem specs with dependency graph
- `specs/01-store.md` — external store (content-addressed, K12, mmap)
- `specs/03-dsml.md` — DSML analysis (DeepSeek tool call markup,
  harness-centric approach, model stays simple)

## What's NOT Specced Yet (Gaps)

1. **specs/02-page-table.md** — the core data structure. ADTs for
   residency levels, chunk entries, handle entries. Haskell types.
2. **specs/04-chunker.md** — rolling hash implementation, boundary
   biasing, hierarchical levels.
3. **specs/05-handles.md** — handle lifecycle state machine,
   materialization budget, CBN semantics.
4. **specs/06-pushdown.md** — DSL operations, Lua/jq sub-computation,
   projection inference.
5. **specs/07-idempotency.md** — classification rules, bash command
   patterns, caching behavior.
6. **specs/08-clone.md** — shadow clone task protocol, prompt
   template, error handling, timeout.
7. **specs/09-splicer.md** — HOW compacted form gets into context.
   Message history rewriting? System prompt block? This is the
   harness integration point.
8. **specs/10-scheduler.md** — reroll amortization, when to compact,
   break-even horizon, sawtooth parameters.
9. **specs/11-knowledge-graph.md** — graph data model, entity
   reasoning integration, correction stability.
10. **specs/12-oracle-protocol.md** — UDS + CBOR message types
    between harness and panel.
11. **specs/13-oracle-panel.md** — Swift app architecture, views,
    performance targets.
12. **specs/14-minimaps.md** — menu bar widget, terminal minimap.
13. **specs/15-boot.md** — multi-session persistence, page table
    survives session death, boot protocol.
14. **specs/16-faults.md** — page fault detection heuristics,
    resolution pipeline.
15. **specs/17-eval.md** — success metrics, benchmarks.

## Build Order

```
Wave 1 (parallel, no deps):  01-store, 03-dsml, 04-chunker
Wave 2 (need store):         02-page-table, 05-handles
Wave 3 (need handles):       06-pushdown, 07-idempotency, 08-clone, 09-splicer
Wave 4 (need splicer):       10-scheduler, 11-knowledge-graph, 16-faults
Wave 5 (need graph):         12-oracle-protocol, 15-boot
Wave 6 (need protocol):      13-oracle-panel, 14-minimaps
Wave 7 (need everything):    17-eval
```

## People

- **Carter Schonwald**: entity reasoning skill (`datentity.skill`),
  Haskell ecosystem, wellposed.com. Knows the crypto package
  ecosystem (don't use crypton). Entity disambiguation, constraint
  graphs, discourse coordinates → content addressing.
- **Ed Kmett**: category theory, Haskell. The algebraic structure
  (semilattices, adjunctions, Galois connections) should satisfy him.
  lens-style composable optics over the knowledge graph maybe.
- **Sergey Bratus**: security, weird machines, LangSec. Compaction
  as a trust boundary. Adversarial compaction. Monotone security
  labels. CoT readability as audit trail.
- **Xavier**: (context needed — which Xavier?)

## Eviction Policy Correction (2026-02-19 session 2)

Original eviction score was a hand-waved weighted linear
combination with no theoretical basis. Compared against
OS/DB/GC literature. Full analysis at:
`/tmp/dcp-sessions/20260219-183200-impl/dcp-extension/EVICTION-ANALYSIS.md`

**Summary of what changed:**

- Layer 1 (hard constraints, from GC): oracle-pinned chunks,
  active working set, chunks with live incoming dep edges —
  these are NOT scores, they're absolute constraints.
  Reference counting via dependency graph = can't evict
  what's still pointed to.

- Layer 2 (ARC, Megiddo & Modha 2003): self-tuning balance
  between recency (T1) and frequency (T2). Ghost lists B1/B2
  detect which signal was more predictive when a page fault
  occurs. No α/β weights. Workload tells you what matters.
  Patent expired 2023. CAR (patent-free) as alternative.

- Layer 3 (LRU-2, O'Neil et al. 1993): within T1/T2, break
  ties by 2nd-most-recent access time. Filters "scanned once"
  from "working set." Critical for agent reading through files
  (sequential scan resistance).

- Layer 4 (oracle as priority hint, not score): pin = root set.
  edit = promote to T2. demote = immediate eviction candidate.
  This is the database query hint pattern. Oracle doesn't tune
  weights — issues constraints the policy respects.

- Layer 5 (generational, from GC): chunks surviving a
  compaction cycle get a generation counter. Higher gen =
  stickier (clock-sweep style). Implements generational
  hypothesis: if it survived this long, probably important.

**Design decision 16: eviction is ARC + LRU-2 + GC refcount,
not a linear score.** The original α/β/γ formulation was
ungrounded. Self-tuning (ARC) replaces manual weight selection.
Hard constraints (GC refcount, oracle pins) replace score
boosting. Generational promotion replaces age decay.

## CoT Surfacing (2026-02-19 session 2)

**Problem**: providers hide CoT from the model's own context.
Anthropic extended thinking, DeepSeek reasoning tokens — the
model reasons, then the provider strips the reasoning before
the next turn. The model can't see its own past reasoning.
This is the single worst provider norm for DCP because:

1. The model can't learn from its own mistakes within a session
2. Compaction can't summarize reasoning it can't see
3. The knowledge graph can't extract decisions from invisible CoT
4. The operator (via oracle panel) can't read reasoning that
   wasn't captured

**First patch priority**: the pi extension must intercept CoT
before the provider strips it. `session_before_compact` gives
us `branchEntries` which includes thinking blocks. But we need
to capture it turn-by-turn as it happens, not only at compaction
time.

Hooks to investigate:
- `model_response` event — does it include thinking content?
- `agent_tool_result` — thinking may be in the preceding response
- `session_before_compact` → `branchEntries` — confirmed to have
  thinking blocks in the serialized form

The extension should:
1. Intercept every assistant response including thinking blocks
2. Store CoT to the blob store (type: "cot", content-addressed)
3. Associate CoT blobs with the chunk/turn that produced them
4. Make CoT available to compaction (include in summary input)
5. Expose `cot_replay(turn)` tool so the model can re-read its
   own past reasoning on demand

This is design decision 3 (CoT persistence) made concrete.
Without this, nothing else in DCP works right — compaction
without CoT produces lossy summaries, knowledge extraction
without CoT misses rationale.

## TODO for Next Session: Eviction Policy Redesign

The eviction scoring formula in DESIGN.md is bad:

```
eviction_score(chunk) =
    α * recency
  + β * dep_fanout
  + γ * semantic_centrality
  + δ * access_frequency
  + ζ * oracle_signal(chunk)
  - ε * reconstruction_cost
```

This is a hand-waved weighted linear combination with made-up
coefficients. It sounds plausible but has no theoretical basis.
Nobody knows what α, β, γ should be. "Just tune them" is not
a design.

**Task for next session**: Read the DESIGN.md eviction policy
sections, then research what OS page replacement, database
buffer pools, and GC collectors actually do. The answer is NOT
a linear score. It's probably:

- Hard constraints (GC-style reference counting via dep graph:
  can't evict what's still pointed to)
- Self-tuning recency/frequency balance (ARC, CAR, LIRS —
  systems that LEARN which signal matters from the workload,
  don't hand-tune weights)
- Sequential scan resistance (LRU-2 or similar — agent reads
  through files linearly, naive LRU pollutes the cache)
- Oracle hints as constraints not scores (pin = don't evict,
  demote = evict next, edit = promote — these are database
  query hint patterns, not score modifiers)
- Generational promotion (GC-style: chunks surviving compaction
  cycles get stickier, implements the hypothesis that old
  survivors are important)

Don't worry about patents (ARC patent expired 2023, CAR was
always patent-free). Focus on getting the right abstractions.

Replace the linear score in DESIGN.md with something grounded.

## TODO for Next Session: CoT Surfacing

Pi already captures `ThinkingContent` blocks (type: "thinking",
thinking: string) in assistant message content arrays. The
compaction serializer includes them as `[Assistant thinking]:`.
Session entries have them.

**Important note**: faux-opaque CoT (provider "extended thinking"
that's captured but treated as special/hidden) is the wrong frame.
CoT should just be text. Readable, storable, indexable, same as
any other content. The provider pretense that thinking is a
separate privileged content type is artificial — it's just the
model's output before it decided what to say out loud. Treat it
as regular content that happens to be tagged "thinking." Don't
build infrastructure around the opacity. Flatten it.

The DCP extension needs to:
1. On `turn_end` event, extract thinking blocks from the
   assistant message, store to DuckDB as regular text blobs
   (not as a special "cot" type — it's just content)
2. Associate thinking text with chunks/turns
3. On `session_before_compact`, thinking is already in
   branchEntries serialization — verify it's included in
   summary input. The compaction prompt should see reasoning
   as first-class input, not a special section.
4. Register `cot_replay` tool so the model can re-read its
   own past reasoning on demand — this is just reading stored
   text, not "surfacing hidden state"
5. Expose to oracle panel (future, via UDS query) — operator
   sees thinking alongside output, no special treatment

The goal: thinking blocks are just text with a tag. No special
infrastructure. No opacity theater. Store them, index them,
show them.

Key pi extension hooks:
- `turn_end` → `event.message` has the assistant message with
  thinking content blocks
- `session_before_compact` → `event.branchEntries` has all
  entries including thinking
- `tool_result` → can intercept and store tool results to DB
- `context` → can modify messages before LLM sees them
  (inject handle refs, swap skeletal forms)
- `before_agent_start` → inject system prompt additions
  (pressure warnings, handle instructions)
- Custom tools via `pi.registerTool()` for push-down DSL

## What To Do Next

### Immediate (TS extension, ships today):
1. **Scaffold DCP pi extension** in `~/.pi/agent/extensions/dcp/`
   with package.json, DuckDB dep, index.ts
2. **DuckDB store** — create tables on session_start, schema
   from specs/01-store.md
3. **Tool result interception** — `tool_result` hook, store
   large results to DB, replace with handle summary in context
4. **Idempotent dedup** — `tool_call` hook, classify command,
   return cached handle for pure calls
5. **Push-down DSL tools** — register `handle_grep`,
   `handle_lines`, `handle_slice` as custom tools
6. **CoT capture** — `turn_end` hook, extract thinking blocks,
   store to DB
7. **Context pressure** — `before_agent_start` hook, inject
   pressure warning into system prompt when context > 60%
8. **Custom compaction** — `session_before_compact` hook, use
   stored CoT + handle metadata for richer summary

### Near-term (Haskell core + Swift panel):
9. Redesign eviction policy (see TODO above)
10. Haskell project scaffold (cabal, XKCP FFI)
11. Port store + page table to Haskell ADTs
12. Swift panel prototype reading DuckDB
13. UDS protocol between Haskell harness and Swift panel

## Session Snapshot

Full state preserved at:
`/tmp/dcp-sessions/20260219-182339-design/`

Working copy at:
`/Users/noah/dcp/`
