# Subagent prompt-overhead feedback

Author: Carter Schonwald (via agent)
Date: 2026-04-19
Repo: `oh-punkin-pi`

## Context

While using the subagent/task path for a small editorial review swarm (multiple read-only nitpickers over a few markdown files), observed token usage looked wildly disproportionate to the actual intellectual work.

The concrete shape was:
- small prose-review tasks
- many parallel subagents
- modest result size per agent
- very large apparent token spend per subagent, on the order of ~100k–200k tokens

## Working diagnosis

This does not look like the reviewers themselves needed that much context or reasoning.
It looks like the harness is paying a large fixed prompt-prefix tax per subagent.

Likely contributors:
- base harness/system prompt stack
- developer/tool instructions
- tool schemas
- task context and assignment
- session/environment framing injected per subagent

In other words: the actual task was cheap, but orchestration/startup was expensive.

## Why this feels wrong

For tiny judgment tasks like:
- "read these 3 docs"
- "nitpick 5 lines each"
- "return complaints"

most of the cost should be cognition, not bootstrapping.

If each subagent effectively re-pays a huge static prompt stack, then small review swarms become pathological:
- fixed overhead dominates real work
- fanout multiplies the waste
- editorial/read-only swarms become much more expensive than they look

## Practical conclusion

The current subagent path appears overhead-heavy for small review tasks.
It may be acceptable for a few chunky subagents doing real code or research work.
It appears inefficient for swarms of tiny judgment agents.

## Hypothesis

This is at least partly harness jank / prompt inefficiency, not just unavoidable task cost.

More specifically:
- shared context does not appear to be amortized well across subagents
- large fixed prompt material is likely being repeated per agent
- the task model is fine for heavy work, but poor for many cheap reviewers

## Suggested directions

1. Reduce repeated prompt baggage for subagents.
   - compress or factor shared instructions
   - avoid reattaching giant tool/schema stacks when not needed

2. Make small review swarms cheaper.
   - support lighter-weight reviewer mode
   - or support shared-prefix / shared-context reuse across sibling subagents

3. Encourage fewer, sharper agents for small judgment work.
   - current ergonomics make "8 nitpickers" far more expensive than it appears

4. Improve observability.
   - show how much of subagent spend is fixed overhead vs actual generation/work

## Short version

The problem is not that nitpicking prose is intrinsically expensive.
The problem is that the current subagent path seems to multiply prompt-prefix overhead hard enough that tiny review swarms become silly.

That is either harness jank, or at least a harness design that is much too expensive for this task shape.
